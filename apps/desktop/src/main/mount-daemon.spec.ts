import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMountDaemon } from './mount-daemon.js';

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
}));

const dirs: string[] = [];
let helperPathToRestore: string | undefined;
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  if (helperPathToRestore !== undefined) {
    process.env.PATH = helperPathToRestore;
    helperPathToRestore = undefined;
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Region fake: one workspace, a Clients sub-dir with one file, byte store. */
function fakeSender(files: Array<{ id: string; name: string; folderId: string | null; bytes: string }>) {
  const folders = [
    { id: 'root', name: 'Projects', parentFolderId: null },
    { id: 'clients', name: 'Clients', parentFolderId: 'root' },
  ];
  const send = vi.fn(async (command: string, payload: Record<string, unknown> = {}) => {
    switch (command) {
      case 'anx.storage.workspace.list':
        return { ok: true, data: { items: [{ _id: 'w1', name: 'Team' }] } };
      case 'anx.storage.workspace.folder.list':
        return { ok: true, data: { items: folders } };
      case 'anx.storage.bucket.list-files':        return {
          ok: true,
          data: {
            items: files.map((f) => ({
              _id: f.id,
              originalName: f.name,
              sizeBytes: f.bytes.length,
              folderId: f.folderId,
              status: 'ready',
              createdAt: '2026-01-01T00:00:00.000Z',
              revisionNo: 1,
            })),
          },
        };
      case 'anx.storage.presign.get':
        return { ok: true, data: { url: `mem://${payload.fileId}` } };
      default:
        return { ok: true, data: {} };
    }
  });
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    const id = String(url).replace('mem://', '');
    const f = files.find((x) => x.id === id);
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(f?.bytes ?? '').buffer } as unknown as Response;
  });
  return { send, fetchFn };
}

function daemon(sender: ReturnType<typeof fakeSender>, filePath: string, baseDir: string) {
  let counter = 0;
  return createMountDaemon({
    getSender: async () => ({ send: sender.send as never }),
    getRegionUrl: () => 'https://region.test',
    fetchFn: sender.fetchFn,
    filePath,
    baseDir,
    now: () => new Date('2026-03-01T00:00:00.000Z'),
    newId: () => `m${++counter}`,
    helperName: 'definitely-not-installed-nexus-mount',
  });
}

describe('mount daemon — sessions', () => {
  it('adds a session, falls back to mirror delivery, and lists it', async () => {
    const sender = fakeSender([]);
    const snapDir = tmpDir('nexus-mount-');
    const d = daemon(sender, join(snapDir, 'sessions.json'), join(snapDir, 'mounts'));

    const after = await d.addSession({ workspaceId: 'w1', remoteFolderId: 'clients', remoteFolderPath: '/Projects/Clients', mountpoint: '/mnt/nexus-clients' });
    expect(after.sessions).toHaveLength(1);
    expect(after.sessions[0].delivery).toBe('mirror');
    expect(after.capabilities.helperPresent).toBe(false);
    expect(after.sessions[0].error).toMatch(/mirror/);
    expect(existsSync(join(snapDir, 'sessions.json'))).toBe(true);
  });

  it('rejects a duplicate mountpoint', async () => {
    const sender = fakeSender([]);
    const snapDir = tmpDir('nexus-mount-');
    const d = daemon(sender, join(snapDir, 'sessions.json'), join(snapDir, 'mounts'));
    await d.addSession({ workspaceId: 'w1', mountpoint: '/mnt/dup' });
    await expect(d.addSession({ workspaceId: 'w1', mountpoint: '/mnt/dup' })).rejects.toThrow(/mountpoint/);
  });
});

describe('mount daemon — materialize', () => {
  it('materializes the bound sub-dir into the mountpoint on start', async () => {
    const sender = fakeSender([
      { id: 'f1', name: 'brief.txt', folderId: 'clients', bytes: 'hello' },
      { id: 'f2', name: 'elsewhere.txt', folderId: null, bytes: 'nope' },
    ]);
    const snapDir = tmpDir('nexus-mount-');
    const mountpoint = join(tmpDir('nexus-mp-'), 'clients');
    const d = daemon(sender, join(snapDir, 'sessions.json'), join(snapDir, 'mounts'));

    await d.addSession({ workspaceId: 'w1', remoteFolderId: 'clients', mountpoint, mode: 'read-only' });
    const started = await d.startSession('m1');
    expect(started.sessions[0].state).toBe('mounted');
    expect(existsSync(join(mountpoint, 'brief.txt'))).toBe(true);
    expect(readFileSync(join(mountpoint, 'brief.txt'), 'utf8')).toBe('hello');
    // Files outside the bound sub-dir are not materialized.
    expect(existsSync(join(mountpoint, 'elsewhere.txt'))).toBe(false);
    await d.stopSession('m1');
  });

  it('marks the session errored when the region is unreachable', async () => {
    const sender = fakeSender([]);
    sender.send.mockImplementation(async (command: string) => {
      if (command === 'anx.storage.workspace.folder.list') throw new Error('region down');
      return { ok: true, data: { items: [] } };
    });
    const snapDir = tmpDir('nexus-mount-');
    const d = daemon(sender, join(snapDir, 'sessions.json'), join(snapDir, 'mounts'));
    await d.addSession({ workspaceId: 'w1', mountpoint: join(tmpDir('nexus-mp-'), 'c') });
    const snap = await d.startSession('m1');
    expect(snap.sessions[0].state).toBe('error');
    expect(snap.sessions[0].error).toMatch(/region down/);
  });
});

describe('mount daemon — native helper contract', () => {
  it('writes a snake_case config + a 0600 token file when a helper is present', async () => {
    const sender = fakeSender([]);
    const snapDir = tmpDir('nexus-mount-');
    const baseDir = join(snapDir, 'mounts');
    const helperDir = tmpDir('nexus-helper-');
    writeFileSync(join(helperDir, 'nexus-mount'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const origPath = process.env.PATH;
    process.env.PATH = `${helperDir}${process.platform === 'win32' ? ';' : ':'}${origPath ?? ''}`;

    let counter = 0;
    const d = createMountDaemon({
      getSender: async () => ({ send: sender.send as never }),
      getRegionUrl: () => 'https://region.test',
      getToken: async () => 'tok-123',
      fetchFn: sender.fetchFn,
      filePath: join(snapDir, 'sessions.json'),
      baseDir,
      now: () => new Date('2026-03-01T00:00:00.000Z'),
      newId: () => `m${++counter}`,
      helperName: 'nexus-mount',
    });
    helperPathToRestore = origPath;

    const snap = await d.addSession({
      workspaceId: 'w1',
      remoteFolderId: 'clients',
      remoteFolderPath: '/Projects/Clients',
      mountpoint: join(tmpDir('nexus-mp-'), 'clients'),
      mode: 'read-only',
    });
    expect(snap.capabilities.helperPresent).toBe(true);

    // Starting the session launches the helper and writes its config.
    await d.startSession('m1');
    const started = await d.snapshot();
    expect(started.sessions[0].delivery).toBe('kernel');

    // The config the Rust `nexus-mount` crate parses (see native/nexus-mount/config.rs).
    const configPath = join(baseDir, 'm1.helper.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config).toMatchObject({
      mountpoint: expect.stringContaining('clients'),
      workspace_id: 'w1',
      remote_folder_id: 'clients',
      remote_folder_path: '/Projects/Clients',
      read_only: true,
      region_url: 'https://region.test',
      volume_name: expect.any(String),
    });
    expect(config.token_path).toBe(join(baseDir, 'm1.token'));
    // The token is never inlined into the config.
    expect(JSON.stringify(config)).not.toContain('tok-123');

    await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(config.token_path, 'utf8')).toBe('tok-123');
  });
});
