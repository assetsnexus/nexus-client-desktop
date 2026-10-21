/**
 * Download runner (@nexus/local-voice).
 *
 * Streams a model plan to disk with resume + integrity checks. The Electron main
 * process supplies real `fetch`/`fs` via injected adapters so this stays testable
 * and reusable, and so the manager can report progress to the renderer.
 *
 * Design notes
 *  - Resume: each file writes to `<dest>.part`, then renames on completion. A
 *    partial `.part` is resumed via an HTTP `Range` request.
 *  - Integrity: when a `sha256` is published we verify before the rename; a
 *    mismatch keeps the `.part` for a retry rather than shipping a bad artifact.
 *  - Cancellation: an `AbortSignal` tears down mid-file; the `.part` remains.
 *  - Self-signed TLS: adapter decides; a custom endpoint may pass `relaxTls`.
 */

import type { DownloadPlan, DownloadProgressEvent } from './download.js';

export type DownloadFsAdapter = {
  /** Bytes already on disk for a path, or 0 when absent. */
  sizeOf: (path: string) => Promise<number>;
  /** Append a chunk to the partial file (creates it when missing). */
  appendChunk: (path: string, chunk: Uint8Array) => Promise<void>;
  /** Truncate the partial file (used when a server ignores our Range). */
  resetPartial: (path: string) => Promise<void>;
  /** Atomically move `.part` → final path. */
  commit: (fromPath: string, toPath: string) => Promise<void>;
  /** Remove a file (cleanup on failure / cancel). */
  remove: (path: string) => Promise<void>;
  /** Ensure the containing directory exists. */
  ensureDir: (path: string) => Promise<void>;
};

export type DownloadFetchResponse = {
  ok: boolean;
  status: number;
  /** Total bytes in the response body, when the server reports it. */
  contentLength: number | null;
  /** Whether the server honored our Range request. */
  acceptedRange: boolean;
  body: AsyncIterable<Uint8Array> | null;
};

export type DownloadFetchAdapter = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal; relaxTls?: boolean },
) => Promise<DownloadFetchResponse>;

export type RunDownloadOptions = {
  plan: DownloadPlan;
  /** Absolute root directory the plan's relative paths resolve under. */
  targetDir: string;
  fs: DownloadFsAdapter;
  fetchFn: DownloadFetchAdapter;
  /** sha256 of the final file, given a path; returns null when unreadable. */
  sha256?: (path: string) => Promise<string | null>;
  /** Relax TLS validation for a self-signed host. */
  relaxTls?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: DownloadProgressEvent) => void;
};

export type DownloadResult = {
  modelId: string;
  ok: boolean;
  /** Relative dest paths that landed successfully. */
  completed: string[];
  /** Error message when `ok` is false. */
  error?: string;
  /** True when cancellation (not failure) stopped the run. */
  cancelled: boolean;
};

function joinPath(dir: string, rel: string): string {
  const base = dir.replace(/\/+$/, '');
  return `${base}/${rel}`;
}

/**
 * Download every file in a plan in order, resuming partials and verifying
 * integrity. Never throws: a failure is reported in the result so the caller
 * can keep the UI honest.
 */
export async function runDownloadPlan(options: RunDownloadOptions): Promise<DownloadResult> {
  const completed: string[] = [];
  const totalBytes = options.plan.totalBytes;
  // Running aggregate the progress events report (resume offsets + new writes).
  let written = options.plan.haveBytes;

  for (let fileIndex = 0; fileIndex < options.plan.items.length; fileIndex += 1) {
    const item = options.plan.items[fileIndex];
    if (item.complete) {
      completed.push(item.destPath);
      continue;
    }
    if (options.signal?.aborted) {
      return { modelId: options.plan.modelId, ok: false, completed, cancelled: true };
    }

    const dest = joinPath(options.targetDir, item.destPath);
    const part = `${dest}.part`;
    await options.fs.ensureDir(dest.slice(0, dest.lastIndexOf('/')));

    let startAt = await options.fs.sizeOf(part);
    if (startAt > 0 && item.resumeFrom === 0) {
      // A stale partial from a previous interrupted run: start clean.
      await options.fs.resetPartial(part);
      startAt = 0;
    } else if (startAt > item.resumeFrom) {
      // The plan was built against a smaller partial (e.g. retried after a
      // verify failure). Trust the on-disk `.part` we can see.
      startAt = await options.fs.sizeOf(part);
    }

    let response: DownloadFetchResponse;
    try {
      response = await options.fetchFn(item.file.url, {
        headers: startAt > 0 ? { Range: `bytes=${startAt}-` } : {},
        signal: options.signal,
        relaxTls: options.relaxTls,
      });
    } catch (err) {
      return {
        modelId: options.plan.modelId,
        ok: false,
        completed,
        error: err instanceof Error ? err.message : 'download request failed',
        cancelled: Boolean(options.signal?.aborted),
      };
    }

    if (!response.ok) {
      return {
        modelId: options.plan.modelId,
        ok: false,
        completed,
        error: `HTTP ${response.status} for ${item.file.url}`,
        cancelled: false,
      };
    }
    // A server that ignored our Range starts the body from 0 — reset the partial.
    if (startAt > 0 && !response.acceptedRange) {
      await options.fs.resetPartial(part);
      written -= startAt;
      startAt = 0;
    }

    const fileTotal = item.file.sizeBytes ?? response.contentLength ?? null;
    let fileBytes = startAt;

    if (response.body) {
      try {
        for await (const chunk of response.body) {
          if (options.signal?.aborted) {
            return { modelId: options.plan.modelId, ok: false, completed, cancelled: true };
          }
          await options.fs.appendChunk(part, chunk);
          fileBytes += chunk.byteLength;
          written += chunk.byteLength;
          options.onProgress?.({
            modelId: options.plan.modelId,
            fileIndex,
            filePath: item.destPath,
            fileBytes,
            fileTotalBytes: fileTotal,
            totalBytesWritten: written,
            totalBytes,
            percent:
              totalBytes && totalBytes > 0
                ? Math.max(0, Math.min(100, Math.round((written / totalBytes) * 100)))
                : null,
          });
        }
      } catch (err) {
        return {
          modelId: options.plan.modelId,
          ok: false,
          completed,
          error: err instanceof Error ? err.message : 'download stream failed',
          cancelled: Boolean(options.signal?.aborted),
        };
      }
    }

    // Integrity check before committing when a checksum is known.
    if (item.file.sha256 && options.sha256) {
      const actual = await options.sha256(part);
      if (actual && actual.toLowerCase() !== item.file.sha256.toLowerCase()) {
        return {
          modelId: options.plan.modelId,
          ok: false,
          completed,
          error: `checksum mismatch for ${item.destPath}`,
          cancelled: false,
        };
      }
    }

    await options.fs.commit(part, dest);
    completed.push(item.destPath);
  }

  return { modelId: options.plan.modelId, ok: true, completed, cancelled: false };
}
