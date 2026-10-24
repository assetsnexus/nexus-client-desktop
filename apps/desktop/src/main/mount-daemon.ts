/**
 * Mount daemon (Phase 3, main process).
 *
 * Makes a Nexus storage bucket (or one of its sub-directories) appear as a local
 * directory. Two delivery modes:
 *
 *  - `kernel` — supervises a native FUSE/WinFsp/macFUSE helper (`nexus-mount`)
 *    when it is installed. The helper owns the kernel mount; the daemon passes
 *    it the session config over a control file.
 *  - `mirror` — a dependency-free fallback that materializes the bucket sub-dir
 *    into the mountpoint from the region and refreshes it on an interval. This
 *    is what runs when the native helper is absent, so the "bucket sub-dir is a
 *    local dir" experience still works everywhere.
 *
 * The region never exposes object-store credentials: every read goes through a
 * short-TTL single-object presign (or the region proxy), via the shared
 * `@nexus/storage-browser` client.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  createStorageClient,
  normalizeMountSession,
  resolveFolderIdByPath,
  sessionDriver,
  validateMountSessions,
  type MountCapabilities,
  type MountSession,
  type MountSessionInput,
  type StorageCommandSender,
} from '@nexus/storage-browser';
import type {
  MountCapabilitiesRow,
  MountSessionInput as IpcMountSessionInput,
  MountSessionRow,
  MountSnapshot,
} from '../shared/ipc.js';

export type MountDaemonOptions = {
  getSender: () => Promise<{ send: StorageCommandSender }>;
  getRegionUrl: () => string;
  /**
   * Current session token for the native helper. Written to a 0600 file beside
   * the config (never inlined into it) so a kernel helper can authenticate
   * without the Electron process proxying every read.
   */
  getToken?: () => Promise<string | null>;
  /** Overridable for tests. */
  filePath?: string;
  baseDir?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
  newId?: () => string;
  /** Override the helper probe (tests). */
  helperName?: string;
};

export type MountDaemon = ReturnType<typeof createMountDaemon>;

const REFRESH_MS = 30_000;

export function createMountDaemon(options: MountDaemonOptions) {
  const filePath = options.filePath ?? join(app.getPath('userData'), 'mount-sessions.json');
  const baseDir = options.baseDir ?? join(app.getPath('userData'), 'mounts');
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => `mnt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  const helperName = options.helperName ?? 'nexus-mount';

  const children = new Map<string, ChildProcess>();
  const refreshers = new Map<string, NodeJS.Timeout>();
  let capabilities: MountCapabilities = probeCapabilities();

  // ─── capability probe ─────────────────────────────────────────────────────

  function probeCapabilities(): MountCapabilities {
    const platform = process.platform;
    const driver = sessionDriver(platform);
    const helperPath = resolveHelperPath();
    return { platform, driver, helperPresent: helperPath != null, helperPath };
  }

  /**
   * Locate the native helper: the copy staged next to the packaged app (both
   * asar-unpacked and dev layouts), then the user's PATH. The staged copy wins
   * so a packaged build does not depend on PATH.
   */
  function resolveHelperPath(): string | null {
    const exe = process.platform === 'win32' ? `${helperName}.exe` : helperName;
    const rel = join('dist-native', `${process.platform}-${process.arch}`, exe);
    const appPath = app.getAppPath?.() ?? process.cwd();
    const candidates = [
      // Packaged: resources/app.asar.unpacked/dist-native/...
      appPath.includes('app.asar')
        ? join(appPath.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1'), rel)
        : null,
      // Dev / electron-builder output next to the app.
      join(appPath, rel),
      join(process.resourcesPath ?? appPath, 'app.asar.unpacked', rel),
    ].filter((p): p is string => p != null);
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return which(helperName);
  }

  function refreshCapabilities(): MountCapabilities {
    capabilities = probeCapabilities();
    return capabilities;
  }

  // ─── persistence ──────────────────────────────────────────────────────────

  function readSessions(): MountSession[] {
    if (!existsSync(filePath)) return [];
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      return Array.isArray(raw) ? (raw as MountSession[]) : [];
    } catch {
      return [];
    }
  }

  function writeSessions(sessions: MountSession[]): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(sessions, null, 2), 'utf8');
  }

  function patchSession(id: string, patch: Partial<MountSession>): MountSession | null {
    const sessions = readSessions();
    let updated: MountSession | null = null;
    const next = sessions.map((s) => {
      if (s.id !== id) return s;
      updated = { ...s, ...patch, updatedAt: now().toISOString() };
      return updated;
    });
    if (updated) writeSessions(next);
    return updated;
  }

  // ─── region + materialize ─────────────────────────────────────────────────

  async function client() {
    const sender = await options.getSender();
    return createStorageClient((command, payload) => sender.send(command, payload));
  }

  /** Resolve the binding's sub-dir to a folder id (or the bucket root). */
  async function resolveFolderId(c: Awaited<ReturnType<typeof client>>, s: MountSession): Promise<string | null> {
    if (s.remoteFolderId != null) return s.remoteFolderId;
    const folders = await c.folderTree(s.workspaceId);
    const resolved = resolveFolderIdByPath(s.remoteFolderPath, folders);
    return 'folderId' in resolved ? resolved.folderId : null;
  }

  /**
   * Materialize the bucket sub-dir into the mountpoint: download every remote
   * file that is missing or stale locally. Read-only sessions never upload.
   * Returns the number of files written.
   */
  async function materialize(s: MountSession): Promise<number> {
    const c = await client();
    const folders = await c.folderTree(s.workspaceId);
    const targetFolderId = await resolveFolderId(c, s);

    const items = await collectFiles(c, s.workspaceId, targetFolderId, folders);
    mkdirSync(s.mountpoint, { recursive: true });
    let written = 0;
    for (const item of items) {
      const target = join(s.mountpoint, item.relPath);
      if (existsSync(target)) continue;
      mkdirSync(dirname(target), { recursive: true });
      const bytes = await c.downloadBytes({
        fileId: item.fileId,
        regionBaseUrl: options.getRegionUrl(),
        fetchFn: options.fetchFn,
      });
      writeFileSync(target, bytes);
      written += 1;
    }
    return written;
  }

  async function collectFiles(
    c: Awaited<ReturnType<typeof client>>,
    workspaceId: string,
    targetFolderId: string | null,
    folders: Array<{ id: string; name: string; parentFolderId: string | null }>,
  ): Promise<Array<{ relPath: string; fileId: string }>> {
    const items: Array<{ relPath: string; fileId: string }> = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const res = await c.listBucketFiles({ workspaceId, limit: 500, cursor });
      for (const f of res.items) {
        if (f.status === 'deleted') continue;
        if (!isUnder(f.folderId, targetFolderId, folders)) continue;
        const prefix = pathOf(f.folderId, folders, targetFolderId);
        items.push({ relPath: prefix ? `${prefix}/${f.name}` : f.name, fileId: f.id });
      }
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return items;
  }

  // ─── session lifecycle ────────────────────────────────────────────────────

  async function startSession(id: string): Promise<MountSnapshot> {
    const s = readSessions().find((x) => x.id === id);
    if (!s) return snapshot();
    patchSession(id, { state: 'starting', error: null });
    try {
      mkdirSync(s.mountpoint, { recursive: true });
      if (s.delivery === 'kernel' && capabilities.helperPresent) {
        startKernelHelper(s);
        patchSession(id, { state: 'mounted', error: null });
      } else {
        await materialize(s);
        startMirrorRefresh(s);
        patchSession(id, {
          state: s.delivery === 'kernel' ? 'degraded' : 'mounted',
          error: s.delivery === 'kernel' ? 'native helper unavailable; mirroring instead' : null,
        });
      }
    } catch (err) {
      patchSession(id, { state: 'error', error: err instanceof Error ? err.message : String(err) });
    }
    return snapshot();
  }

  function startKernelHelper(s: MountSession): void {
    if (!capabilities.helperPath) throw new Error('native mount helper not found');
    const configPath = join(baseDir, `${sanitizeId(s.id)}.helper.json`);
    const tokenPath = join(baseDir, `${sanitizeId(s.id)}.token`);
    mkdirSync(dirname(configPath), { recursive: true });
    // The helper config is the contract with `nexus-mount` (see
    // `native/nexus-mount/src/config.rs`). Field names are snake_case there; we
    // emit snake_case at the edge so the Rust structs stay idiomatic.
    const regionUrl = options.getRegionUrl();
    const config = {
      mountpoint: s.mountpoint,
      workspace_id: s.workspaceId,
      remote_folder_id: s.remoteFolderId,
      remote_folder_path: s.remoteFolderPath,
      read_only: s.mode === 'read-only',
      cache_dir: s.cacheDir,
      journal_path: s.journalPath,
      region_url: regionUrl,
      token_path: tokenPath,
      volume_name: s.volumeName,
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    // Write the token separately with owner-only permissions. Missing/stale
    // tokens are tolerated: the helper can run until it needs one, then exit
    // with a clear error rather than serving unauthenticated reads.
    void (async () => {
      try {
        const token = (await options.getToken?.()) ?? null;
        if (token) {
          writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
        }
      } catch {
        /* the helper reports a missing token itself */
      }
    })();

    const child = spawn(capabilities.helperPath, [configPath], { stdio: 'ignore' });
    child.on('exit', (code) => {
      children.delete(s.id);
      patchSession(s.id, {
        state: code === 0 ? 'stopped' : 'error',
        error: code === 0 ? null : `mount helper exited with code ${code}`,
      });
    });
    children.set(s.id, child);
  }

  function startMirrorRefresh(s: MountSession): void {
    if (refreshers.has(s.id)) return;
    const timer = setInterval(() => {
      const current = readSessions().find((x) => x.id === s.id);
      if (!current || current.state !== 'mounted') return;
      void materialize(current).catch(() => {
        /* transient; the next tick retries */
      });
    }, REFRESH_MS);
    timer.unref?.();
    refreshers.set(s.id, timer);
  }

  async function stopSession(id: string): Promise<MountSnapshot> {
    const child = children.get(id);
    if (child) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      children.delete(id);
    }
    const timer = refreshers.get(id);
    if (timer) {
      clearInterval(timer);
      refreshers.delete(id);
    }
    patchSession(id, { state: 'stopped', error: null });
    return snapshot();
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  async function addSession(input: IpcMountSessionInput): Promise<MountSnapshot> {
    refreshCapabilities();
    const sessions = readSessions();
    const { session, warnings } = normalizeMountSession(input as MountSessionInput, {
      id: newId(),
      baseDir,
      caps: capabilities,
      now,
    });
    const next = [...sessions, session];
    const issues = validateMountSessions(next).filter((i) => i.id === session.id);
    if (issues.length) throw new Error(issues.map((i) => i.message).join('; '));
    // Surface capability warnings to the caller through the session error field
    // so the UI can explain a mirror fallback without a separate channel.
    if (warnings.length) session.error = warnings.join('; ');
    writeSessions(next);
    return snapshot();
  }

  async function removeSession(id: string): Promise<MountSnapshot> {
    await stopSession(id);
    writeSessions(readSessions().filter((s) => s.id !== id));
    return snapshot();
  }

  async function snapshot(): Promise<MountSnapshot> {
    refreshCapabilities();
    const sessions = readSessions();
    const names = await workspaceNames();
    return {
      capabilities: toCapsRow(capabilities),
      sessions: sessions.map((s) => toRow(s, names.get(s.workspaceId) ?? null)),
    };
  }

  async function workspaceNames(): Promise<Map<string, string>> {
    try {
      const c = await client();
      const rows = await c.listWorkspaces();
      return new Map(rows.map((w) => [w.id, w.name]));
    } catch {
      return new Map();
    }
  }

  function dispose(): void {
    for (const timer of refreshers.values()) clearInterval(timer);
    refreshers.clear();
    for (const child of children.values()) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    children.clear();
    // Best-effort: release any materialized mirror dirs we created. Mirror
    // sessions are plain directories whose contents we copied, so removal must be
    // recursive — a non-recursive `rmSync` throws EISDIR on any non-empty mount
    // and, because this runs from the app's `before-quit`/dispose path, that
    // rejection surfaced as "A JavaScript error occurred in the main process"
    // during shutdown. Never let cleanup failure escape here.
    for (const s of readSessions()) {
      if (s.state !== 'mounted') continue;
      try {
        rmSync(s.mountpoint, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* best effort — the mount root is re-materialized on next start */
      }
    }
  }

  return {
    snapshot,
    addSession,
    removeSession,
    startSession,
    stopSession,
    dispose,
    capabilities: () => capabilities,
    _readSessions: readSessions,
    _materialize: materialize,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function toCapsRow(caps: MountCapabilities): MountCapabilitiesRow {
  return {
    platform: caps.platform,
    driver: caps.driver,
    helperPresent: caps.helperPresent,
    helperPath: caps.helperPath,
    delivery: caps.helperPresent ? 'kernel' : 'mirror',
    warnings: caps.helperPresent
      ? []
      : [`native ${caps.driver} helper not found; using the mirror daemon`],
  };
}

function toRow(s: MountSession, workspaceName: string | null): MountSessionRow {
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    workspaceName,
    remoteFolderId: s.remoteFolderId,
    remoteFolderPath: s.remoteFolderPath,
    mountpoint: s.mountpoint,
    mode: s.mode,
    delivery: s.delivery,
    state: s.state,
    cacheDir: s.cacheDir,
    journalPath: s.journalPath,
    volumeName: s.volumeName,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    error: s.error,
  };
}

function sanitizeId(id: string): string {
  return String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session';
}

/** Synchronous PATH lookup for the native helper (no shell). */
function which(name: string): string | null {
  const path = process.env.PATH ?? '';
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE').split(';') : [''];
  for (const dir of path.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function isUnder(
  folderId: string | null,
  targetFolderId: string | null,
  folders: Array<{ id: string; parentFolderId: string | null }>,
): boolean {
  if (targetFolderId == null) return true;
  let cur = folderId;
  const guard = new Set<string>();
  while (cur) {
    if (cur === targetFolderId) return true;
    if (guard.has(cur)) return false;
    guard.add(cur);
    cur = folders.find((f) => f.id === cur)?.parentFolderId ?? null;
  }
  return false;
}

function pathOf(
  folderId: string | null,
  folders: Array<{ id: string; name: string; parentFolderId: string | null }>,
  stopAt: string | null,
): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [];
  let cur = folderId;
  const guard = new Set<string>();
  while (cur && cur !== stopAt && !guard.has(cur)) {
    guard.add(cur);
    const f = byId.get(cur);
    if (!f) break;
    parts.unshift(f.name);
    cur = f.parentFolderId;
  }
  return parts.join('/');
}
