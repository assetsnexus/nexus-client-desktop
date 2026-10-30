/**
 * Storage transfer manager (main process).
 *
 * Owns the byte-moving half of drag-and-drop storage transfers: recursing a
 * dropped directory, uploading one file at a time with **real** byte progress,
 * cancelling in flight, resolving download links, saving files to disk, and
 * staging temp files for an OS drag-out.
 *
 * Design notes:
 * - The renderer never reads file bytes. It hands over **absolute paths**
 *   (`webUtils.getPathForFile`), and main reads/streams them. That is what keeps
 *   a 200-file drop off the renderer heap.
 * - Progress is measured from the transport itself: for presign-PUT backends the
 *   body is a real `fs` read stream and we count the bytes the socket accepts,
 *   so the percentage is byte-accurate. For backends that only accept a single
 *   base64 command there is no byte granularity, so the result is explicitly
 *   flagged `indeterminate` instead of inventing a number.
 * - Concurrency is the renderer queue's job (bounded worker pool). This module
 *   is re-entrant: each `uploadOne` is independent and cancellable by id.
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { WebContents } from 'electron';
import {
  createStorageClient,
  unwrapEnvelope,
  type StorageCommandSender,
} from '@nexus/storage-browser';
import { createHttpsAgent } from '@nexus/node-core';
import { IPC } from '../shared/ipc.js';
import { detectPayloadError, expectedMimeForName, MARKUP_SCAN_BYTES } from './storage-payload-guard.js';
import type {
  StorageDownloadLink,
  StorageDropEntry,
  StorageDropExpansion,
  StorageDropFile,
  StorageSaveResult,
  StorageTransferMode,
  StorageTransferProgress,
  StorageTransferTransport,
  StorageUploadOneRequest,
  StorageUploadOneResult,
} from '../shared/ipc.js';

export type StorageTransferManagerOptions = {
  /** Resolve the authenticated region sender (from the auth manager). */
  getSender: () => Promise<{ send: StorageCommandSender }>;
  /** Region base URL for the non-presign proxy fallback. */
  getRegionUrl: () => string;
  /** The window that should receive progress pushes / own OS drag-outs. */
  getWebContents: () => WebContents | null;
  /** Custom CA / insecure local dev trust for presigned-URL hosts. */
  getTls?: () => { caPem?: string | null; allowInsecure?: boolean };
  /** Temp dir for drag-out staging (defaults to the OS temp dir). */
  tempDir?: string;
  /** Overridable for tests. */
  fetchFn?: typeof fetch;
  now?: () => number;
};

export type StorageTransferManager = ReturnType<typeof createStorageTransferManager>;

const DIRECTORY_MAX_FILES = 20_000;
const DRAG_DIR_NAME = 'nexus-storage-drag';
/** A staged drag copy older than this is an orphan and is swept away. */
const STAGED_MAX_AGE_MS = 60 * 60 * 1000;
/** Hard ceiling for an in-renderer preview, so a huge file cannot OOM us. */
export const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

/** One drag-out temp copy: its private directory and the file *inside* it. */
type StagedDrag = { dir: string; filePath: string };

export function createStorageTransferManager(options: StorageTransferManagerOptions) {
  const tempRoot = options.tempDir ?? join(process.env.TMPDIR || '/tmp', DRAG_DIR_NAME);
  /** In-flight transfers by renderer-supplied id, for cancellation. */
  const inFlight = new Map<string, AbortController>();
  /** Files staged for an OS drag-out, keyed by file id. */
  const staged = new Map<string, StagedDrag>();

  // A freshly started process cannot have a live OS drag, so anything left in
  // the staging root is debris from a crash/quit and is removed up front.
  pruneStagingRoot(tempRoot);

  const client = async () => {
    const sender = await options.getSender();
    return createStorageClient((command, payload) => sender.send(command, payload));
  };

  function sendProgress(progress: StorageTransferProgress): void {
    const wc = options.getWebContents();
    if (!wc || wc.isDestroyed()) return;
    try {
      wc.send(IPC.storageTransferProgress, progress);
    } catch {
      // A window closing mid-transfer must not fail the upload.
    }
  }

  // ─── directory expansion ──────────────────────────────────────────────────

  /**
   * Walk a dropped path list. Directories are recursed with `fs` (the renderer
   * has no path access); each directory entry carries its files with paths
   * relative to the directory root, so the renderer can preserve the tree as
   * prefixes.
   */
  function expandDrop(paths: string[]): StorageDropExpansion {
    const entries: StorageDropEntry[] = [];
    for (const raw of paths) {
      const p = String(raw ?? '').trim();
      if (!p) continue;
      let st;
      try {
        st = statSync(p);
      } catch {
        entries.push({ path: p, name: basename(p), isDirectory: false, sizeBytes: 0, error: 'unreadable' });
        continue;
      }
      if (!st.isDirectory()) {
        entries.push({ path: p, name: basename(p), isDirectory: false, sizeBytes: st.size });
        continue;
      }
      const walk = walkDirectory(p);
      entries.push({
        path: p,
        name: basename(p),
        isDirectory: true,
        sizeBytes: 0,
        children: walk.files,
        ...(walk.error ? { error: walk.error } : {}),
      });
    }
    return { entries };
  }

  function walkDirectory(root: string): { files: StorageDropFile[]; error?: string } {
    const files: StorageDropFile[] = [];
    let error: string | undefined;
    const visit = (dir: string): void => {
      if (files.length >= DIRECTORY_MAX_FILES) return;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch (err) {
        error = err instanceof Error ? err.message : 'unreadable directory';
        return;
      }
      for (const name of names) {
        if (files.length >= DIRECTORY_MAX_FILES) break;
        const abs = join(dir, name);
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          visit(abs);
        } else if (st.isFile()) {
          files.push({
            path: abs,
            relPath: relative(root, abs).split(sep).join('/'),
            sizeBytes: st.size,
          });
        }
      }
    };
    visit(root);
    return error ? { files, error } : { files };
  }

  // ─── single-file upload with honest progress ──────────────────────────────

  async function uploadOne(req: StorageUploadOneRequest): Promise<StorageUploadOneResult> {
    const controller = new AbortController();
    inFlight.set(req.transferId, controller);
    const mode: StorageTransferMode = req.mode ?? 'auto';
    const signal = controller.signal;

    try {
      const bytes = await readSourceSize(req.absPath);
      const targetFolderId = await resolveFolderId(req.workspaceId, req.folderId ?? null, req.prefix);
      const sender = await options.getSender();
      const send = (command: string, payload?: Record<string, unknown>) => sender.send(command, payload);

      // 1. upload-init decides the transport: it is the authoritative per-file
      //    presign-PUT signal, never guessed.
      const init = await uploadInit(send, {
        workspaceId: req.workspaceId,
        folderId: targetFolderId,
        name: req.name,
        contentType: req.contentType,
        sizeBytes: bytes,
      });

      // 2. presign-PUT path: stream the real file so progress is byte-accurate.
      if (init.presignPut && (mode === 'auto' || mode === 'stream')) {
        const putUrl = await presignPutUrl(send, {
          workspaceId: req.workspaceId,
          objectKey: init.storageKey,
          fileId: init.fileId,
          contentType: req.contentType,
          contentLength: bytes,
        });
        if (putUrl) {
          const sent = await streamPut({
            url: putUrl,
            absPath: req.absPath,
            contentType: req.contentType,
            sizeBytes: bytes,
            signal,
            tls: options.getTls?.(),
            onProgress: (sentBytes) =>
              sendProgress({
                transferId: req.transferId,
                sentBytes,
                totalBytes: bytes,
                indeterminate: false,
              }),
          });
          if (signal.aborted) return cancelledResult(req, 'stream', sent);
          const fileId = await completePresign(send, {
            fileId: init.fileId,
            sizeBytes: bytes,
            contentType: req.contentType,
          });
          return {
            transferId: req.transferId,
            ok: true,
            fileId: fileId || init.fileId,
            transport: 'stream',
            sentBytes: bytes,
            indeterminate: false,
            cancelled: false,
          };
        }
        // presign advertised but no URL: fall through to the base64 command.
      }

      // 3. base64 path: a single command cannot report byte granularity, so we
      //    say so plainly (indeterminate) rather than faking a percentage.
      sendProgress({
        transferId: req.transferId,
        sentBytes: 0,
        totalBytes: bytes,
        indeterminate: true,
      });
      if (signal.aborted) return cancelledResult(req, 'buffer', 0);
      const raw = readFileSync(req.absPath);
      const fileId = await completeBase64(send, { fileId: init.fileId, bytes: raw });
      if (signal.aborted) return cancelledResult(req, 'buffer', bytes);
      return {
        transferId: req.transferId,
        ok: true,
        fileId: fileId || init.fileId,
        transport: 'buffer',
        sentBytes: bytes,
        indeterminate: true,
        cancelled: false,
      };
    } catch (err) {
      if (signal.aborted) return cancelledResult(req, 'none', 0);
      return {
        transferId: req.transferId,
        ok: false,
        fileId: null,
        transport: 'none',
        sentBytes: 0,
        indeterminate: false,
        cancelled: false,
        error: err instanceof Error ? err.message : String(err ?? 'upload failed'),
      };
    } finally {
      inFlight.delete(req.transferId);
    }
  }

  function cancelledResult(
    req: StorageUploadOneRequest,
    transport: StorageTransferTransport,
    sentBytes: number,
  ): StorageUploadOneResult {
    return {
      transferId: req.transferId,
      ok: false,
      fileId: null,
      transport,
      sentBytes,
      indeterminate: false,
      cancelled: true,
    };
  }

  // ─── download / save ──────────────────────────────────────────────────────

  /** Presigned GET when the backend can sign, else the region `/files` proxy. */
  async function downloadLink(fileId: string): Promise<StorageDownloadLink> {
    const sender = await options.getSender();
    const raw = await sender.send('anx.storage.presign.get', { fileId });
    // A *failed* presign command is not the same as "the backend cannot sign".
    // Falling back to the region proxy URL on a failure would point at a path
    // the host may never answer, hanging a preview / drag-download forever
    // instead of reporting the error. Surface the failure and only use the
    // proxy when the backend genuinely returned no presigned url.
    assertOk(raw, 'anx.storage.presign.get');
    const body = unwrapEnvelope(raw);
    const url = typeof body.url === 'string' && body.url ? body.url : null;
    if (url) return { url, presigned: true };
    const base = options.getRegionUrl().replace(/\/+$/, '');
    return { url: `${base}/files/${encodeURIComponent(fileId)}`, presigned: false };
  }

  /**
   * Stream a file to an explicit path (never buffers it whole in memory).
   *
   * The bytes are validated against the file's name/declared type **before** the
   * temp file is moved into place, so a storage error body (an XML
   * `<Error><Code>NoSuchKey</Code>` document, an HTML gateway page, or a
   * mismatched/empty body) is never written to the user's disk as if it were the
   * real file. When the guard rejects the bytes nothing is left behind.
   */
  async function streamToPath(fileId: string, targetPath: string, expectedName?: string): Promise<number> {
    const { url } = await downloadLink(fileId);
    const fetchFn = options.fetchFn ?? fetch;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const declaredType = res.headers.get('content-type')?.split(';')[0]?.trim() || null;
    mkdirSync(dirname(targetPath), { recursive: true });
    const tmp = `${targetPath}.part-${randomUUID().slice(0, 8)}`;
    try {
      const body = res.body as unknown as AsyncIterable<Uint8Array> | null;
      if (!body || typeof (body as { pipe?: unknown }).pipe !== 'function' && !body[Symbol.asyncIterator]) {
        // A non-streaming fetch: fall back to a single buffer write.
        const buf = Buffer.from(await res.arrayBuffer());
        const verdict = detectPayloadError(buf, {
          expectedMime: expectedMimeForName(expectedName ?? ''),
          declaredType,
        });
        if (!verdict.ok) throw new Error(verdict.detail);
        await pipeline(async function* () {
          yield buf;
        }, createWriteStream(tmp));
        renameSync(tmp, targetPath);
        return buf.byteLength;
      }
      let written = 0;
      const head = Buffer.alloc(MARKUP_SCAN_BYTES);
      let headLen = 0;
      await pipeline(
        async function* () {
          for await (const chunk of body) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
            if (headLen < MARKUP_SCAN_BYTES) {
              const take = Math.min(MARKUP_SCAN_BYTES - headLen, buf.byteLength);
              buf.copy(head, headLen, 0, take);
              headLen += take;
            }
            written += buf.byteLength;
            yield buf;
          }
        },
        createWriteStream(tmp),
      );
      const verdict = detectPayloadError(head.subarray(0, headLen), {
        expectedMime: expectedMimeForName(expectedName ?? ''),
        declaredType,
      });
      if (!verdict.ok) throw new Error(verdict.detail);
      renameSync(tmp, targetPath);
      return written;
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best-effort: the temp file is never the user's target path
      }
      throw err;
    }
  }

  /**
   * Save one file via the native save dialog. `dialog` is injected indirectly by
   * the caller (main.ts owns the Electron dialog) so this module stays testable.
   */
  async function saveFile(
    fileId: string,
    suggestedName: string,
    choosePath: (name: string) => Promise<string | null>,
  ): Promise<StorageSaveResult> {
    let target: string | null;
    try {
      target = await choosePath(suggestedName);
    } catch (err) {
      return { saved: false, cancelled: false, path: null, bytes: 0, error: err instanceof Error ? err.message : 'save failed' };
    }
    if (!target) return { saved: false, cancelled: true, path: null, bytes: 0 };
    try {
      const bytes = await streamToPath(fileId, target, suggestedName);
      return { saved: true, cancelled: false, path: target, bytes };
    } catch (err) {
      return {
        saved: false,
        cancelled: false,
        path: target,
        bytes: 0,
        error: err instanceof Error ? err.message : 'save failed',
      };
    }
  }

  /** Save many files into a chosen directory, preserving each file's name. */
  async function saveFilesToDir(
    files: Array<{ fileId: string; name: string }>,
    chooseDir: () => Promise<string | null>,
  ): Promise<{ saved: number; cancelled: boolean; dir: string | null; error?: string }> {
    const dir = await chooseDir();
    if (!dir) return { saved: 0, cancelled: true, dir: null };
    let saved = 0;
    const errors: string[] = [];
    for (const file of files) {
      const safe = sanitizeFileName(file.name) || file.fileId;
      const target = uniqueTarget(dir, safe);
      try {
        await streamToPath(file.fileId, target, safe);
        saved += 1;
      } catch (err) {
        errors.push(`${file.name}: ${err instanceof Error ? err.message : 'failed'}`);
      }
    }
    return {
      saved,
      cancelled: false,
      dir,
      ...(errors.length ? { error: errors.join('; ') } : {}),
    };
  }

  // ─── OS drag-out ──────────────────────────────────────────────────────────

  /**
   * Download a file into app temp storage so it can be dragged to the OS.
   *
   * The staged copy must be a file **named exactly after the real file** inside
   * its own directory. `webContents.startDrag` hands the OS basename of `file`,
   * so staging as `<tmp>/<id>-<name>` (or a generic placeholder) makes the drop
   * land under the wrong name. A private dir per file also keeps same-named
   * files apart without ever renaming the dragged file.
   */
  async function prepareDrag(fileId: string, name: string): Promise<{ path: string | null; error?: string; name?: string }> {
    const existing = staged.get(fileId);
    if (existing && existsSync(existing.filePath)) return { path: existing.filePath, name: realDragName(name) };
    const realName = realDragName(name);
    const dir = join(tempRoot, `${fileId.slice(0, 8)}-${randomUUID().slice(0, 8)}`);
    const target = join(dir, realName);
    try {
      await streamToPath(fileId, target, realName);
      staged.set(fileId, { dir, filePath: target });
      return { path: target, name: realName };
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      return { path: null, error: err instanceof Error ? err.message : 'drag staging failed' };
    }
  }

  /**
   * Begin an OS drag from a staged temp file. Must run as close as possible to
   * the renderer's `dragstart`; the window's `webContents.startDrag` hands the
   * real file to the OS. `file` is the staged copy (its basename becomes the
   * dropped file name) and `icon` is the (platform-required) drag image.
   */
  function startDrag(
    fileId: string,
    driver: { startDrag: (item: { file: string; icon: unknown }) => void; icon: unknown },
  ): boolean {
    const entry = staged.get(fileId);
    if (!entry || !existsSync(entry.filePath)) return false;
    try {
      driver.startDrag({ file: entry.filePath, icon: driver.icon });
      return true;
    } catch {
      return false;
    }
  }

  /** The staged temp path for a file (null when it was never staged). */
  function stagedPathOf(fileId: string): string | null {
    return staged.get(fileId)?.filePath ?? null;
  }

  /** Remove a staged drag temp file + its directory (after `dragend`). */
  function releaseDrag(fileId: string): void {
    const entry = staged.get(fileId);
    if (!entry) return;
    staged.delete(fileId);
    try {
      rmSync(entry.dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  // ─── preview bytes ────────────────────────────────────────────────────────

  /**
   * Fetch a file's real bytes for an inline preview, base64-encoded.
   *
   * The renderer cannot reach the storage host itself (cross-origin presign URL,
   * hardened CSP), so main streams the bytes and hands back the content. Large
   * files are refused rather than buffered, and the resolved content type comes
   * from the download response (falling back to `fallbackType`) so the renderer
   * builds a correctly-typed `blob:` URL.
   */
  async function readBytesForPreview(
    fileId: string,
    opts: { maxBytes?: number; fallbackType?: string } = {},
  ): Promise<StoragePreviewBytes> {
    const maxBytes = opts.maxBytes ?? PREVIEW_MAX_BYTES;
    let url: string;
    try {
      ({ url } = await downloadLink(fileId));
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'preview link failed' };
    }
    const fetchFn = options.fetchFn ?? fetch;
    let res: Response;
    try {
      res = await fetchFn(url);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'preview fetch failed' };
    }
    if (!res.ok) return { ok: false, error: `preview fetch failed (${res.status})` };
    const declared = Number(res.headers.get('content-length'));
    const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() || opts.fallbackType || 'application/octet-stream';
    if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, tooLarge: true };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) return { ok: false, tooLarge: true };
    // Never hand an error body / mismatched or empty bytes to the renderer as if
    // it were the file — that is what turns into a broken <img> or a PDF viewer
    // rendering XML. Reject with a plain reason so the UI can say "unavailable".
    const verdict = detectPayloadError(buf, {
      expectedMime: opts.fallbackType,
      declaredType: contentType,
    });
    if (!verdict.ok) return { ok: false, error: verdict.detail };
    return { ok: true, base64: buf.toString('base64'), contentType, sizeBytes: buf.byteLength };
  }

  /** Stop one in-flight transfer, aborting its request. */
  function cancel(transferId: string): { transferId: string; cancelled: boolean } {
    const controller = inFlight.get(transferId);
    if (!controller) return { transferId, cancelled: false };
    controller.abort();
    return { transferId, cancelled: true };
  }

  /** True when any transfer is running (used by teardown). */
  function activeCount(): number {
    return inFlight.size;
  }

  /** Abort everything (sign-out / quit). */
  function abortAll(): void {
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
    for (const fileId of [...staged.keys()]) releaseDrag(fileId);
  }

  // ─── internals ────────────────────────────────────────────────────────────

  async function resolveFolderId(
    workspaceId: string,
    baseFolderId: string | null,
    prefix: string,
  ): Promise<string | null> {
    const segments = String(prefix ?? '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean);
    if (!segments.length) return baseFolderId;
    const c = await client();
    let parent = baseFolderId;
    for (const segment of segments) {
      const children = await c.folderList(workspaceId, parent ?? undefined);
      const match = children.find((f) => f.name === segment);
      parent = match ? match.id : (await c.createFolder({ workspaceId, name: segment, parentFolderId: parent })).id;
    }
    return parent;
  }

  async function readSourceSize(absPath: string): Promise<number> {
    try {
      return statSync(absPath).size;
    } catch {
      return 0;
    }
  }

  return {
    expandDrop,
    uploadOne,
    downloadLink,
    saveFile,
    saveFilesToDir,
    prepareDrag,
    startDrag,
    releaseDrag,
    readBytesForPreview,
    cancel,
    activeCount,
    abortAll,
    /** Test seam: the staged temp path for a file id. */
    _stagedPathOf: stagedPathOf,
    /** Test seam: the resolved folder id for a prefix (creating as needed). */
    _resolveFolderId: resolveFolderId,
    /** Test seam: the staging root this manager prunes and stages into. */
    _tempRoot: tempRoot,
  };
}

// ─── command helpers (narrow, typed) ────────────────────────────────────────

type Send = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;

type UploadInit = { fileId: string; storageKey: string | null; presignPut: boolean };

async function uploadInit(
  send: Send,
  input: { workspaceId: string; folderId: string | null; name: string; contentType: string; sizeBytes: number },
): Promise<UploadInit> {
  const payload: Record<string, unknown> = {
    workspaceId: input.workspaceId,
    originalName: input.name,
    contentType: input.contentType,
    module: 'storage-browser',
  };
  if (input.folderId) payload.folderId = input.folderId;
  if (input.sizeBytes > 0) payload.expectedSize = input.sizeBytes;
  const raw = await send('anx.file.upload-init', payload);
  assertOk(raw, 'anx.file.upload-init');
  const body = unwrapEnvelope(raw);
  return {
    fileId: str(body.fileId) ?? '',
    storageKey: str(body.storageKey),
    presignPut: body.presignPut === true,
  };
}

async function presignPutUrl(
  send: Send,
  input: { workspaceId: string; objectKey: string | null; fileId: string; contentType: string; contentLength: number },
): Promise<string | null> {
  if (!input.objectKey) return null;
  const raw = await send('anx.storage.presign.put', {
    workspaceId: input.workspaceId,
    objectKey: input.objectKey,
    fileId: input.fileId,
    contentType: input.contentType,
    contentLength: input.contentLength,
  });
  const body = unwrapEnvelope(raw);
  if (isFailed(raw)) return null;
  return str(body.url);
}

async function completePresign(
  send: Send,
  input: { fileId: string; sizeBytes: number; contentType: string },
): Promise<string | null> {
  const raw = await send('anx.file.upload-complete-presign', input);
  assertOk(raw, 'anx.file.upload-complete-presign');
  const body = unwrapEnvelope(raw);
  return str(body.fileId) ?? str(asRecord(body.file).fileId);
}

async function completeBase64(send: Send, input: { fileId: string; bytes: Buffer }): Promise<string | null> {
  const raw = await send('anx.file.upload-complete', {
    fileId: input.fileId,
    base64Data: input.bytes.toString('base64'),
  });
  assertOk(raw, 'anx.file.upload-complete');
  const body = unwrapEnvelope(raw);
  return str(body.fileId) ?? str(asRecord(body.file).fileId);
}

/**
 * Stream a file to a presigned URL and report bytes as the transport accepts
 * them. Uses `http`/`https` directly (not `fetch`) so the body is a real file
 * stream — that is where genuine progress comes from — and so a custom CA can
 * be honored for a self-signed presign host.
 */
function streamPut(input: {
  url: string;
  absPath: string;
  contentType: string;
  sizeBytes: number;
  signal: AbortSignal;
  tls?: { caPem?: string | null; allowInsecure?: boolean };
  onProgress: (sentBytes: number) => void;
}): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      reject(new Error('presign url is not a valid URL'));
      return;
    }
    const isHttps = url.protocol === 'https:';
    const send = isHttps ? httpsRequest : httpRequest;
    const agent = isHttps
      ? createHttpsAgent({ caPem: input.tls?.caPem ?? null, allowInsecure: input.tls?.allowInsecure === true })
      : undefined;
    let sent = 0;
    let settled = false;

    const req = send(
      url,
      {
        method: 'PUT',
        headers: {
          'content-type': input.contentType,
          'content-length': String(input.sizeBytes),
        },
        ...(agent ? { agent } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          if (status >= 200 && status < 300) resolvePromise(sent);
          else reject(new Error(`presigned PUT failed (${status}) ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`));
        });
      },
    );

    const onAbort = () => {
      req.destroy(new Error('aborted'));
    };
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener('abort', onAbort, { once: true });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    const stream = createReadStream(input.absPath);
    stream.on('error', (err) => req.destroy(err));
    stream.on('data', (chunk) => {
      sent += chunk.length;
      input.onProgress(sent);
    });
    stream.pipe(req);
  });
}

// ─── shared helpers ─────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function isFailed(raw: unknown): boolean {
  const r = asRecord(raw);
  if (r.ok === false) return true;
  const code = typeof r.responseCode === 'number' ? r.responseCode : null;
  return code != null && (code < 200 || code >= 300);
}

function assertOk(raw: unknown, command: string): void {
  const r = asRecord(raw);
  if (!isFailed(raw)) return;
  const errors = Array.isArray(r.errorObjects) ? r.errorObjects : [];
  const first = asRecord(errors[0]);
  const code = str(first.code) ?? (typeof r.code === 'string' ? r.code : undefined);
  const message = str(first.message) ?? str(r.message) ?? 'unknown error';
  throw new Error(`${command} failed${code ? ` (${code})` : ''}: ${message}`);
}

/** Keep a file name safe for the filesystem (no separators / traversal). */
function sanitizeFileName(name: string): string {
  return String(name ?? '')
    .replace(/[/\\\0]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 200);
}

/**
 * The basename the OS will see for a dragged file.
 *
 * It must be the *real* name with its extension: `startDrag` uses the basename
 * of the staged path. A name that has no basename of its own (empty, `.`, `..`,
 * or something that only reduced to separators) falls back to a neutral
 * placeholder so staging never writes outside the per-file directory.
 */
function realDragName(name: string): string {
  const raw = String(name ?? '').trim();
  const base = raw.split(/[/\\]/).pop() ?? '';
  const safe = sanitizeFileName(base);
  return safe && safe !== '.' && safe !== '..' ? safe : 'file';
}

/**
 * Delete everything under the drag-staging root at startup. No OS drag can
 * survive a process restart, so any leftover copy is an orphan from a crash or
 * a skipped `dragend`; removing it keeps the directory from growing forever.
 */
function pruneStagingRoot(root: string): void {
  if (!existsSync(root)) return;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - STAGED_MAX_AGE_MS;
  for (const name of names) {
    const abs = join(root, name);
    try {
      // Leave a copy an extremely long-lived process may still be dragging.
      if (statSync(abs).mtimeMs >= cutoff) continue;
      rmSync(abs, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/** A file's bytes resolved for an inline renderer preview. */
export type StoragePreviewBytes =
  | { ok: true; base64: string; contentType: string; sizeBytes: number }
  | { ok: false; error?: string; tooLarge?: boolean };

/** A non-colliding path inside `dir` (appends ` (n)` before the extension). */
function uniqueTarget(dir: string, name: string): string {
  const base = resolve(dir, name);
  if (!existsSync(base)) return base;
  const ext = extOf(name);
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  for (let i = 1; i < 1000; i += 1) {
    const candidate = resolve(dir, `${stem} (${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return resolve(dir, `${stem}-${randomUUID().slice(0, 8)}${ext}`);
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}
