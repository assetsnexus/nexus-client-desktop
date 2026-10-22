/**
 * Multi-sync manager (Phase 3, main process).
 *
 * Links Nexus storage **bucket sub-directories** to **local directories** and
 * keeps them in step. Multiple syncs run in parallel: each binding is one
 * bucket-subdir <-> local-dir link with its own mode, conflict policy, interval
 * and excludes.
 *
 * All decision logic lives in `@nexus/storage-browser` (`sync-model` +
 * `sync-engine`) and is unit-tested; this module owns the IO: walking the local
 * tree, calling `anx.storage.*` through the authenticated sender, writing/reading
 * files, and the background scheduler.
 *
 * Safety: a path missing on one side is treated as a *create*, never a delete,
 * so a wiped local dir cannot erase the bucket. Explicit deletes only happen
 * when the mode is two-way and the other side is the source of truth.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { app } from 'electron';
import {
  addSyncBinding,
  createStorageClient,
  emptySyncState,
  isExcluded,
  planDeletions,
  reconcile,
  recordSyncState,
  removeSyncBinding,
  resolveFolderIdByPath,
  updateSyncBinding,
  validateSyncBindings,
  type BindingIssue,
  type LocalEntry,
  type RemoteEntry,
  type StorageCommandSender,
  type SyncAction,
  type SyncBinding,
  type SyncBindingInput,
  type SyncState,
} from '@nexus/storage-browser';
import type {
  StorageRemoteFolderRow,
  StorageSyncBindingInput,
  StorageSyncBindingRow,
  StorageSyncRunResult,
  StorageSyncState,
} from '../shared/ipc.js';

export type SyncManagerOptions = {
  getSender: () => Promise<{ send: StorageCommandSender }>;
  getRegionUrl: () => string;
  /** Overridable for tests. */
  filePath?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
  /** Id generator (uuid by default; injectable for tests). */
  newId?: () => string;
};

export type SyncManager = ReturnType<typeof createSyncManager>;

const TICK_MS = 15_000;

export function createSyncManager(options: SyncManagerOptions) {
  const filePath = options.filePath ?? join(app.getPath('userData'), 'sync-bindings.json');
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

  const lastRuns: Record<string, StorageSyncRunResult> = {};
  const running = new Set<string>();
  let scheduler: NodeJS.Timeout | null = null;

  // ─── persistence ──────────────────────────────────────────────────────────

  function readBindings(): SyncBinding[] {
    if (!existsSync(filePath)) return [];
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      if (!Array.isArray(raw)) return [];
      return raw.filter(isBindingLike);
    } catch {
      return [];
    }
  }

  function writeBindings(bindings: SyncBinding[]): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(bindings, null, 2), 'utf8');
  }

  // ─── sync state (delete-tracking proof + revision watermark) ──────────────

  function stateDir(): string {
    return join(dirname(filePath), 'sync-state');
  }

  function stateFilePath(bindingId: string): string {
    return join(stateDir(), `${sanitizeId(bindingId)}.json`);
  }

  function readSyncState(bindingId: string): SyncState {
    const p = stateFilePath(bindingId);
    if (!existsSync(p)) return emptySyncState(bindingId);
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as SyncState;
      return raw && typeof raw === 'object' && raw.entries ? raw : emptySyncState(bindingId);
    } catch {
      return emptySyncState(bindingId);
    }
  }

  function writeSyncState(state: SyncState): void {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(stateFilePath(state.bindingId), JSON.stringify(state, null, 2), 'utf8');
  }

  // ─── region helpers ───────────────────────────────────────────────────────

  async function client() {
    const sender = await options.getSender();
    return createStorageClient((command, payload) => sender.send(command, payload));
  }

  /** Resolve a sub-dir path to a folder id (creating missing segments). */
  async function ensureRemoteFolder(
    c: Awaited<ReturnType<typeof client>>,
    workspaceId: string,
    remotePath: string,
  ): Promise<string | null> {
    const folders = await c.folderTree(workspaceId);
    const resolved = resolveFolderIdByPath(remotePath, folders);
    if ('folderId' in resolved) return resolved.folderId;

    // Create the missing segments from the deepest existing ancestor down.
    let parent: string | null = resolveExistingParent(remotePath, folders);
    let acc = currentPathOf(parent, folders);
    for (const segment of resolved.missingAt) {
      const created = await c.createFolder({ workspaceId, name: segment, parentFolderId: parent });
      parent = created.id;
      acc = `${acc === '/' ? '' : acc}/${segment}`;
    }
    return parent;
  }

  /** List remote files under a binding's sub-dir, as entries relative to it. */
  async function listRemoteEntries(binding: SyncBinding): Promise<RemoteEntry[]> {
    const c = await client();
    const folders = await c.folderTree(binding.workspaceId);
    let targetFolderId = binding.remoteFolderId;
    if (targetFolderId == null) {
      const resolved = resolveFolderIdByPath(binding.remoteFolderPath, folders);
      targetFolderId = 'folderId' in resolved ? resolved.folderId : null;
    }

    // Paginate the whole workspace, then keep files inside the sub-dir.
    const items: Awaited<ReturnType<typeof c.listBucketFiles>>['items'] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const res = await c.listBucketFiles({
        workspaceId: binding.workspaceId,
        limit: 500,
        cursor,
      });
      items.push(...res.items);
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }

    return items
      .filter((f) => f.status !== 'deleted')
      .filter((f) => isUnderFolder(f.folderId, targetFolderId, folders))
      .map((f) => {
        const folderPath = pathOfFolder(f.folderId, folders, targetFolderId);
        const relPath = folderPath ? `${folderPath}/${f.name}` : f.name;
        return {
          relPath,
          kind: 'file' as const,
          size: f.sizeBytes ?? 0,
          mtimeMs: f.createdAt ? Date.parse(f.createdAt) || 0 : 0,
          hash: null,
          fileId: f.id,
          revision: f.revisionNo ?? null,
        };
      })
      .filter((e) => !isExcluded(e.relPath, binding.exclude));
  }

  // ─── local walk ───────────────────────────────────────────────────────────

  function walkLocal(root: string, exclude: string[]): LocalEntry[] {
    const out: LocalEntry[] = [];
    if (!existsSync(root)) return out;
    const visit = (dir: string) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const abs = join(dir, name);
        const relPath = relative(root, abs).split(sep).join('/');
        if (isExcluded(relPath, exclude)) continue;
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          out.push({ relPath, kind: 'dir', size: 0, mtimeMs: st.mtimeMs });
          visit(abs);
        } else if (st.isFile()) {
          out.push({ relPath, kind: 'file', size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    };
    visit(root);
    return out;
  }

  // ─── execution ────────────────────────────────────────────────────────────

  function safeLocalTarget(root: string, relPath: string): string | null {
    const abs = resolve(root, relPath);
    const rootAbs = resolve(root);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null;
    return abs;
  }

  async function executeActions(
    binding: SyncBinding,
    actions: SyncAction[],
  ): Promise<{ ok: number; failed: Array<{ relPath: string; error: string }> }> {
    const c = await client();
    let ok = 0;
    const failed: Array<{ relPath: string; error: string }> = [];
    const remoteFolderId = binding.remoteFolderId ?? null;

    for (const action of actions) {
      const target = safeLocalTarget(binding.localDir, action.relPath);
      if (!target) {
        failed.push({ relPath: action.relPath, error: 'path escapes the sync root' });
        continue;
      }
      try {
        switch (action.kind) {
          case 'mkdir-local':
            mkdirSync(target, { recursive: true });
            break;
          case 'mkdir-remote':
            await ensureRemoteFolder(c, binding.workspaceId, joinRemote(binding.remoteFolderPath, action.relPath));
            break;
          case 'download': {
            if (!action.fileId) {
              failed.push({ relPath: action.relPath, error: 'no remote file id' });
              continue;
            }
            const relDir = dirname(target);
            mkdirSync(relDir, { recursive: true });
            const bytes = await c.downloadBytes({
              fileId: action.fileId,
              regionBaseUrl: options.getRegionUrl(),
              fetchFn: options.fetchFn,
            });
            writeFileSync(target, bytes);
            break;
          }
          case 'upload': {
            const bytes = new Uint8Array(readFileSync(target));
            await c.upload({
              workspaceId: binding.workspaceId,
              folderId: remoteFolderId,
              name: basename(action.relPath),
              contentType: guessContentType(action.relPath),
              bytes,
              fetchFn: options.fetchFn,
            });
            break;
          }
          case 'delete-local': {
            // Only emitted with proof from the state file (previously synced).
            if (existsSync(target)) rmSync(target, { force: true });
            break;
          }
          case 'delete-remote': {
            if (!action.fileId) {
              failed.push({ relPath: action.relPath, error: 'no remote file id for delete' });
              continue;
            }
            await c.deleteFile(action.fileId);
            break;
          }
          case 'conflict':
          case 'skip':
            break;
          default:
            break;
        }
        ok += 1;
      } catch (err) {
        failed.push({ relPath: action.relPath, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { ok, failed };
  }

  // ─── one sync pass ────────────────────────────────────────────────────────

  async function runBinding(id: string): Promise<StorageSyncRunResult> {
    const binding = readBindings().find((b) => b.id === id) ?? null;
    const startedAt = now().toISOString();
    if (!binding) {
      return {
        bindingId: id,
        status: 'error',
        startedAt,
        finishedAt: now().toISOString(),
        summary: {},
        actions: [],
        conflicts: [],
        error: 'binding not found',
      };
    }
    if (running.has(id)) {
      return { ...emptyRun(id, startedAt), status: 'running', error: 'already running' };
    }
    running.add(id);
    try {
      mkdirSync(binding.localDir, { recursive: true });
      const local = walkLocal(binding.localDir, binding.exclude);
      const remote = await listRemoteEntries(binding);
      const state = readSyncState(id);
      const result = reconcile(local, remote, {
        mode: binding.mode,
        conflictPolicy: binding.conflictPolicy,
      });

      // Delete tracking: only paths the state file proves were previously
      // synced on both sides are eligible, so a wiped dir can't erase a bucket.
      const deletions = planDeletions(state, local, remote, {
        mode: binding.mode,
        conflictPolicy: binding.conflictPolicy,
      });

      // Files list is needed so download/upload can resolve file ids.
      const executable = [
        ...result.actions.filter(
          (a) => a.kind !== 'skip' && a.kind !== 'conflict' && a.kind !== 'delete-local' && a.kind !== 'delete-remote',
        ),
        ...deletions.deleteLocal,
        ...deletions.deleteRemote,
      ];
      const exec = await executeActions(binding, executable);

      // Advance the state for paths that now exist on both sides, drop rows for
      // paths this pass deleted, and keep unresolved conflicts so they can be
      // re-surfaced. Never claim a row for a first-sighting delete.
      const deletedPaths = [
        ...deletions.deleteLocal.map((a) => a.relPath),
        ...deletions.deleteRemote.map((a) => a.relPath),
      ];
      const nextState = recordSyncState(state, { local, remote, deleted: deletedPaths, now });
      writeSyncState(nextState);

      const conflicts = [...result.conflicts, ...deletions.conflicts];
      const summary = { ...result.summary };
      summary['delete-local'] = deletions.deleteLocal.length;
      summary['delete-remote'] = deletions.deleteRemote.length;
      summary.conflict = conflicts.length;

      const run: StorageSyncRunResult = {
        bindingId: id,
        status: exec.failed.length ? 'error' : 'ok',
        startedAt,
        finishedAt: now().toISOString(),
        summary,
        actions: [...result.actions, ...deletions.deleteLocal, ...deletions.deleteRemote].map(toActionRow),
        conflicts: conflicts.map(toActionRow),
        error: exec.failed.length ? `${exec.failed.length} action(s) failed` : null,
      };
      lastRuns[id] = run;
      return run;
    } catch (err) {
      const run: StorageSyncRunResult = {
        ...emptyRun(id, startedAt),
        status: 'error',
        finishedAt: now().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      };
      lastRuns[id] = run;
      return run;
    } finally {
      running.delete(id);
    }
  }

  async function runAll(): Promise<StorageSyncState> {
    const bindings = readBindings().filter((b) => b.enabled);
    // Sequential: avoid hammering the region and keep conflicts deterministic.
    for (const b of bindings) {
      await runBinding(b.id);
    }
    return state();
  }

  // ─── scheduler ────────────────────────────────────────────────────────────

  function start() {
    if (scheduler) return;
    scheduler = setInterval(() => {
      const bindings = readBindings();
      const due = bindings.filter((b) => {
        if (!b.enabled || b.intervalSeconds <= 0) return false;
        const last = lastRuns[b.id];
        const lastAt = last?.finishedAt ? Date.parse(last.finishedAt) : 0;
        return now().getTime() - lastAt >= b.intervalSeconds * 1000;
      });
      for (const b of due) void runBinding(b.id);
    }, TICK_MS);
    // Do not keep the event loop alive just for sync polling.
    scheduler.unref?.();
  }

  function stop() {
    if (scheduler) {
      clearInterval(scheduler);
      scheduler = null;
    }
  }

  // ─── IPC surface ──────────────────────────────────────────────────────────

  async function state(): Promise<StorageSyncState> {
    const bindings = readBindings();
    const workspaceNames = await workspaceNameMap();
    return {
      bindings: bindings.map((b) => toRow(b, workspaceNames.get(b.workspaceId) ?? null)),
      lastRuns,
      schedulerRunning: scheduler != null,
    };
  }

  async function workspaceNameMap(): Promise<Map<string, string>> {
    try {
      const c = await client();
      const rows = await c.listWorkspaces();
      return new Map(rows.map((w) => [w.id, w.name]));
    } catch {
      return new Map();
    }
  }

  async function listRemoteFolders(workspaceId: string): Promise<StorageRemoteFolderRow[]> {
    const c = await client();
    const folders = await c.folderTree(workspaceId);
    return folders
      .map((f) => ({ id: f.id, name: f.name, path: pathOfFolder(f.id, folders, null), parentFolderId: f.parentFolderId }))
      .map((f) => ({ ...f, path: `/${f.path}`.replace(/\/+/g, '/') }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async function addBinding(input: StorageSyncBindingInput): Promise<StorageSyncState> {
    const bindings = readBindings();
    const res = addSyncBinding(bindings, input as SyncBindingInput, { id: newId(), now });
    assertNoIssues(res.issues, res.binding.id);
    writeBindings(res.bindings);
    return state();
  }

  async function setBinding(id: string, patch: Partial<StorageSyncBindingInput>): Promise<StorageSyncState> {
    const bindings = readBindings();
    const existing = bindings.find((b) => b.id === id);
    if (!existing) throw new Error('sync binding not found');
    const { binding } = updateSyncBinding(existing, patch as Partial<SyncBindingInput>, now);
    const next = bindings.map((b) => (b.id === id ? binding : b));
    assertNoIssues(validateSyncBindings(next), id);
    writeBindings(next);
    return state();
  }

  async function removeBinding(id: string): Promise<StorageSyncState> {
    writeBindings(removeSyncBinding(readBindings(), id));
    delete lastRuns[id];
    // Drop the delete-tracking proof for this binding too.
    try {
      rmSync(stateFilePath(id), { force: true });
    } catch {
      // best-effort
    }
    return state();
  }

  function assertNoIssues(issues: BindingIssue[], bindingId: string): void {
    const mine = issues.filter((i) => i.bindingId === bindingId);
    if (mine.length) {
      throw new Error(mine.map((i) => i.message).join('; '));
    }
  }

  return {
    start,
    stop,
    state,
    listRemoteFolders,
    addBinding,
    updateBinding: setBinding,
    removeBinding,
    runBinding,
    runAll,
    /** Test seam: reconcile a binding without IO side effects. */
    _readBindings: readBindings,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function emptyRun(bindingId: string, startedAt: string): StorageSyncRunResult {
  return {
    bindingId,
    status: 'idle',
    startedAt,
    finishedAt: startedAt,
    summary: {},
    actions: [],
    conflicts: [],
    error: null,
  };
}

function toActionRow(a: SyncAction) {
  return { kind: a.kind, relPath: a.relPath, reason: a.reason, resolution: a.resolution };
}

function toRow(b: SyncBinding, workspaceName: string | null): StorageSyncBindingRow {
  return {
    id: b.id,
    name: b.name,
    workspaceId: b.workspaceId,
    workspaceName,
    remoteFolderId: b.remoteFolderId,
    remoteFolderPath: b.remoteFolderPath,
    localDir: b.localDir,
    mode: b.mode,
    conflictPolicy: b.conflictPolicy,
    enabled: b.enabled,
    intervalSeconds: b.intervalSeconds,
    exclude: b.exclude,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

function isBindingLike(v: unknown): v is SyncBinding {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return typeof b.id === 'string' && typeof b.workspaceId === 'string' && typeof b.localDir === 'string';
}

function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

/** Make a binding id safe for a filename (ids are opaque, may contain separators). */
function sanitizeId(id: string): string {
  return String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'binding';
}

function joinRemote(base: string, rel: string): string {
  const b = base === '/' ? '' : base.replace(/\/+$/g, '');
  const r = String(rel ?? '').replace(/^\/+/g, '');
  return `${b}/${r}`.replace(/\/{2,}/g, '/');
}

function currentPathOf(folderId: string | null, folders: Array<{ id: string; parentFolderId: string | null; name: string }>): string {
  return pathOfFolder(folderId, folders, null) || '/';
}

function resolveExistingParent(
  path: string,
  folders: Array<{ id: string; parentFolderId: string | null; name: string }>,
): string | null {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean);
  let parent: string | null = null;
  for (const segment of segments) {
    const match = folders.find((f) => (f.parentFolderId ?? null) === parent && f.name === segment);
    if (!match) break;
    parent = match.id;
  }
  return parent;
}

/** Full `/a/b` path of a folder id, given the flat list. */
function pathOfFolder(
  folderId: string | null,
  folders: Array<{ id: string; parentFolderId: string | null; name: string }>,
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

/** True when `folderId` is the target folder or nested under it. */
function isUnderFolder(
  folderId: string | null,
  targetFolderId: string | null,
  folders: Array<{ id: string; parentFolderId: string | null }>,
): boolean {
  if (targetFolderId == null) return true; // bucket root: everything
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

function guessContentType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    html: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    ts: 'text/typescript',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    zip: 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
}
