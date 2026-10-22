import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createSyncManager } from './sync-manager.js';

// The manager imports `electron` only for `app.getPath`; stub it for tests.
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
}));

const dirs: string[] = [];
function tmpFile(name: string): string {
  const d = mkdtempSync(join(tmpdir(), 'nexus-sync-'));
  dirs.push(d);
  return join(d, name);
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * A fake region that serves one workspace with a folder tree and a couple of
 * files, plus an in-memory byte store for downloads. Enough to exercise the
 * real reconcile + IO path end to end.
 */
function fakeSender(files: Array<{ id: string; name: string; folderId: string | null; size: number; bytes: string; revision?: number }>) {
  const folders = [
    { id: 'root', name: 'Projects', parentFolderId: null },
    { id: 'clients', name: 'Clients', parentFolderId: 'root' },
  ];
  const uploads: Array<{ name: string; folderId: string | null }> = [];
  const deletes: string[] = [];
  const send = vi.fn(async (command: string, payload: Record<string, unknown> = {}) => {
    switch (command) {
      case 'anx.storage.workspace.list':
        return { ok: true, data: { items: [{ _id: 'w1', name: 'Team' }] } };
      case 'anx.storage.workspace.folder.list':
        return { ok: true, data: { items: folders } };
      case 'anx.storage.workspace.folder.create':
        return { ok: true, data: { folder: { _id: `new-${payload.name}`, name: payload.name } } };
      case 'anx.storage.bucket.trash-file':
        deletes.push(String(payload.fileId));
        return { ok: true, data: {} };
      case 'anx.storage.bucket.list-files':
        return {
          ok: true,
          data: {
            items: files.map((f) => ({
              _id: f.id,
              originalName: f.name,
              sizeBytes: f.size,
              folderId: f.folderId,
              status: 'ready',
              createdAt: '2026-01-01T00:00:00.000Z',
              revisionNo: f.revision ?? 1,
            })),
          },
        };
      case 'anx.storage.presign.get':
        return { ok: true, data: { url: `mem://${payload.fileId}` } };
      case 'anx.file.upload-init':
        uploads.push({
          name: String(payload.originalName ?? ''),
          folderId: (payload.folderId as string) ?? null,
        });
        return { ok: true, data: { fileId: 'u1', storageKey: null, presignPut: false } };
      case 'anx.file.upload-complete':
        return { ok: true, data: { fileId: 'u1', name: payload.originalName } };
      default:
        return { ok: true, data: {} };
    }
  });
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    const id = String(url).replace('mem://', '');
    const f = files.find((x) => x.id === id);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(f?.bytes ?? '').buffer,
    } as unknown as Response;
  });
  return { send, fetchFn, uploads, deletes };
}

function manager(sender: ReturnType<typeof fakeSender>, filePath: string) {
  let counter = 0;
  return createSyncManager({
    getSender: async () => ({ send: sender.send as never }),
    getRegionUrl: () => 'https://region.test',
    fetchFn: sender.fetchFn,
    filePath,
    now: () => new Date('2026-03-01T00:00:00.000Z'),
    newId: () => `b${++counter}`,
  });
}

describe('sync manager — binding lifecycle', () => {
  it('adds, lists, patches and removes bindings, persisting them', async () => {
    const sender = fakeSender([]);
    const filePath = tmpFile('bindings.json');
    const m = manager(sender, filePath);

    const added = await m.addBinding({
      name: 'Clients',
      workspaceId: 'w1',
      remoteFolderId: 'clients',
      remoteFolderPath: '/Projects/Clients',
      localDir: '/tmp/nexus/clients',
      mode: 'two-way',
    });
    expect(added.bindings).toHaveLength(1);
    expect(added.bindings[0].workspaceName).toBe('Team');
    expect(existsSync(filePath)).toBe(true);

    const updated = await m.updateBinding('b1', { mode: 'download-only' });
    expect(updated.bindings[0].mode).toBe('download-only');

    const removed = await m.removeBinding('b1');
    expect(removed.bindings).toHaveLength(0);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual([]);
  });

  it('rejects a colliding local directory', async () => {
    const sender = fakeSender([]);
    const m = manager(sender, tmpFile('bindings.json'));
    await m.addBinding({ name: 'A', workspaceId: 'w1', localDir: '/same', remoteFolderId: 'x' });
    await expect(
      m.addBinding({ name: 'B', workspaceId: 'w1', localDir: '/same', remoteFolderId: 'y' }),
    ).rejects.toThrow(/local directory/i);
  });

  it('lists remote folders with materialized paths under root', async () => {
    const sender = fakeSender([]);
    const m = manager(sender, tmpFile('bindings.json'));
    const folders = await m.listRemoteFolders('w1');
    expect(folders.map((f) => f.path).sort()).toEqual(['/Projects', '/Projects/Clients']);
  });
});

describe('sync manager — run', () => {
  it('pushes local-only files to the matching remote folder', async () => {
    const sender = fakeSender([]);
    const bindingsPath = tmpFile('bindings.json');
    const localDir = mkdtempSync(join(tmpdir(), 'nexus-local-'));
    dirs.push(localDir);
    writeFileSync(join(localDir, 'note.txt'), 'hello');

    const m = manager(sender, bindingsPath);
    await m.addBinding({
      name: 'Clients',
      workspaceId: 'w1',
      remoteFolderId: 'clients',
      remoteFolderPath: '/Projects/Clients',
      localDir,
      mode: 'two-way',
    });

    const run = await m.runBinding('b1');
    expect(run.status).toBe('ok');
    expect(run.summary.upload).toBe(1);
    expect(sender.uploads).toEqual([{ name: 'note.txt', folderId: 'clients' }]);
  });

  it('pulls remote-only files into the local dir', async () => {
    const sender = fakeSender([
      { id: 'f1', name: 'remote.txt', folderId: 'clients', size: 5, bytes: 'world' },
    ]);
    const localDir = mkdtempSync(join(tmpdir(), 'nexus-local-'));
    dirs.push(localDir);
    const m = manager(sender, tmpFile('bindings.json'));
    await m.addBinding({
      name: 'Clients',
      workspaceId: 'w1',
      remoteFolderId: 'clients',
      remoteFolderPath: '/Projects/Clients',
      localDir,
      mode: 'two-way',
    });

    const run = await m.runBinding('b1');
    expect(run.summary.download).toBe(1);
    expect(readFileSync(join(localDir, 'remote.txt'), 'utf8')).toBe('world');
  });

  it('ignores remote files outside the bound sub-dir', async () => {
    const sender = fakeSender([
      { id: 'f1', name: 'deep.txt', folderId: 'clients', size: 3, bytes: 'abc' },
      { id: 'f2', name: 'elsewhere.txt', folderId: null, size: 3, bytes: 'xyz' },
    ]);
    const localDir = mkdtempSync(join(tmpdir(), 'nexus-local-'));
    dirs.push(localDir);
    const m = manager(sender, tmpFile('bindings.json'));
    await m.addBinding({
      name: 'Clients',
      workspaceId: 'w1',
      remoteFolderId: 'clients',
      remoteFolderPath: '/Projects/Clients',
      localDir,
      mode: 'download-only',
    });

    const run = await m.runBinding('b1');
    expect(run.summary.download).toBe(1);
    expect(existsSync(join(localDir, 'deep.txt'))).toBe(true);
    expect(existsSync(join(localDir, 'elsewhere.txt'))).toBe(false);
  });

  it('honours local excludes', async () => {
    const sender = fakeSender([]);
    const localDir = mkdtempSync(join(tmpdir(), 'nexus-local-'));
    dirs.push(localDir);
    mkdirSync(join(localDir, 'node_modules'), { recursive: true });
    writeFileSync(join(localDir, 'node_modules', 'dep.js'), 'x');
    writeFileSync(join(localDir, 'keep.txt'), 'k');

    const m = manager(sender, tmpFile('bindings.json'));
    await m.addBinding({
      name: 'Clients',
      workspaceId: 'w1',
      remoteFolderId: 'clients',
      localDir,
      mode: 'upload-only',
      exclude: ['node_modules'],
    });

    const run = await m.runBinding('b1');
    expect(run.summary.upload).toBe(1);
    expect(sender.uploads.map((u) => u.name)).toEqual(['keep.txt']);
  });

  it('reports an error run when the region call fails', async () => {
    const sender = fakeSender([]);
    sender.send.mockImplementation(async (command: string) => {
      if (command === 'anx.storage.bucket.list-files') throw new Error('region down');
      return { ok: true, data: { items: [] } };
    });
    const m = manager(sender, tmpFile('bindings.json'));
    await m.addBinding({ name: 'A', workspaceId: 'w1', localDir: '/tmp/x', remoteFolderId: 'clients' });
    const run = await m.runBinding('b1');
    expect(run.status).toBe('error');
    expect(run.error).toMatch(/region down/);
  });
});

describe('sync manager — delete tracking (state file proof)', () => {
  it('does not delete on first sighting, then deletes remotely after a local removal', async () => {
    const sender = fakeSender([
      { id: 'f1', name: 'doc.txt', folderId: 'clients', size: 4, bytes: 'data', revision: 1 },
    ]);
    const localDir = mkdtempSync(join(tmpdir(), 'nexus-local-'));
    dirs.push(localDir);
    const m = manager(sender, tmpFile('bindings.json'));
    await m.addBinding({
      name: 'Clients',
      workspaceId: 'w1',
      remoteFolderId: 'clients',
      remoteFolderPath: '/Projects/Clients',
      localDir,
      mode: 'two-way',
    });

    // Pass 1: remote-only file is downloaded and recorded in the state file.
    const first = await m.runBinding('b1');
    expect(first.summary.download).toBe(1);
    expect(sender.deletes).toEqual([]);

    // Remove it locally; pass 2 should now delete it remotely (proven synced).
    rmSync(join(localDir, 'doc.txt'));
    const second = await m.runBinding('b1');
    expect(second.summary['delete-remote']).toBe(1);
    expect(sender.deletes).toEqual(['f1']);
  });

  it('refuses to delete remotely when the remote changed since last sync', async () => {
    const sender = fakeSender([
      { id: 'f1', name: 'doc.txt', folderId: 'clients', size: 4, bytes: 'data', revision: 1 },
    ]);
    const localDir = mkdtempSync(join(tmpdir(), 'nexus-local-'));
    dirs.push(localDir);
    const m = manager(sender, tmpFile('bindings.json'));
    await m.addBinding({
      name: 'Clients',
      workspaceId: 'w1',
      remoteFolderId: 'clients',
      localDir,
      mode: 'two-way',
    });
    await m.runBinding('b1'); // records revision 1

    // Remote advances the revision, then the local copy disappears.
    rmSync(join(localDir, 'doc.txt'));
    const files = [{ id: 'f1', name: 'doc.txt', folderId: 'clients', size: 4, bytes: 'data', revision: 5 }];
    sender.send.mockImplementation(async (command: string) => {
      if (command === 'anx.storage.workspace.folder.list') return { ok: true, data: { items: [
        { id: 'root', name: 'Projects', parentFolderId: null },
        { id: 'clients', name: 'Clients', parentFolderId: 'root' },
      ] } };
      if (command === 'anx.storage.bucket.list-files') {
        return { ok: true, data: { items: files.map((f) => ({
          _id: f.id, originalName: f.name, sizeBytes: f.size, folderId: f.folderId,
          status: 'ready', createdAt: '2026-01-01T00:00:00.000Z', revisionNo: f.revision,
        })) } };
      }
      return { ok: true, data: {} };
    });

    const run = await m.runBinding('b1');
    expect(run.summary['delete-remote']).toBe(0);
    expect(run.conflicts.some((c) => /remote changed/.test(c.reason))).toBe(true);
  });

  it('persists the state file next to the bindings file', async () => {
    const sender = fakeSender([
      { id: 'f1', name: 'a.txt', folderId: 'clients', size: 1, bytes: 'a', revision: 2 },
    ]);
    const localDir = mkdtempSync(join(tmpdir(), 'nexus-local-'));
    dirs.push(localDir);
    const bindingsPath = tmpFile('bindings.json');
    const m = manager(sender, bindingsPath);
    await m.addBinding({ name: 'A', workspaceId: 'w1', remoteFolderId: 'clients', localDir, mode: 'download-only' });
    await m.runBinding('b1');
    const statePath = join(dirname(bindingsPath), 'sync-state', 'b1.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(state.entries['a.txt'].remoteRevision).toBe(2);
  });
});
