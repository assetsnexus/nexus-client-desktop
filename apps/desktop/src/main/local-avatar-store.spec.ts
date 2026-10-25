import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalAvatarStore } from './local-avatar-store.js';

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'local-avatars-'));
  const path = join(dir, 'local-avatars.json');
  const libraryDir = join(dir, 'avatar-library');
  return { store: createLocalAvatarStore({ filePath: path, libraryDir }), path, libraryDir, dir };
}

/** Write a fake model file (content is irrelevant to the store). */
function makeModel(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.from('glTF-fake-bytes'));
  return path;
}

describe('createLocalAvatarStore', () => {
  it('starts empty and copies a picked model into the library', () => {
    const { store, libraryDir } = makeStore();
    expect(store.get()).toEqual({ avatars: [], contactMappings: {} });

    const source = makeModel(join(libraryDir, '..'), 'Aria.VRM');
    const next = store.addFile(source);
    expect(next.avatars).toHaveLength(1);
    const entry = next.avatars[0]!;
    expect(entry).toMatchObject({ id: 'aria', label: 'Aria', kind: 'vrm', fileName: 'Aria.VRM' });
    // The copy lives in the library dir, not the original path.
    expect(entry.filePath.startsWith(libraryDir)).toBe(true);
    expect(existsSync(entry.filePath)).toBe(true);
    expect(existsSync(source)).toBe(true);
  });

  it('rejects a non-model file and a duplicate', () => {
    const { store, dir } = makeStore();
    const notes = makeModel(dir, 'notes.txt');
    expect(() => store.addFile(notes)).toThrow(/\.vrm or \.glb/);

    const model = makeModel(dir, 'Aria.vrm');
    store.addFile(model);
    expect(() => store.addFile(model)).toThrow(/already in your library/);
    expect(store.get().avatars).toHaveLength(1);
  });

  it('gives colliding ids a numeric suffix', () => {
    const { store, dir } = makeStore();
    store.addFile(makeModel(dir, 'Aria.vrm'));
    const next = store.addFile(makeModel(dir, 'Aria.glb'));
    expect(next.avatars.map((a) => a.id)).toEqual(['aria', 'aria-2']);
  });

  it('removes an entry and deletes its copied file', () => {
    const { store, dir } = makeStore();
    const next = store.addFile(makeModel(dir, 'Aria.vrm'));
    const copied = next.avatars[0]!.filePath;
    const out = store.remove('aria');
    expect(out.avatars).toEqual([]);
    expect(existsSync(copied)).toBe(false);
  });

  it('stores a per-contact mapping and refuses an unknown avatar', () => {
    const { store, dir } = makeStore();
    store.addFile(makeModel(dir, 'Aria.vrm'));
    expect(store.setContactMapping('agent-a', 'aria').contactMappings).toEqual({ 'agent-a': 'aria' });
    expect(() => store.setContactMapping('agent-b', 'ghost')).toThrow(/not in your library/);
    expect(store.setContactMapping('agent-a', null).contactMappings).toEqual({});
  });

  it('drops an entry whose file vanished instead of offering a dead model', () => {
    const { store, dir, libraryDir } = makeStore();
    const next = store.addFile(makeModel(dir, 'Aria.vrm'));
    store.setContactMapping('agent-a', next.avatars[0]!.id);
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(next.avatars[0]!.filePath, { force: true });
    expect(existsSync(libraryDir)).toBe(true);
    const read = store.get();
    expect(read.avatars).toEqual([]);
    expect(read.contactMappings).toEqual({});
  });

  it('recovers from a corrupt file without throwing', () => {
    const { store, path } = makeStore();
    store.get();
    writeFileSync(path, '{ not json');
    expect(store.get()).toEqual({ avatars: [], contactMappings: {} });
    // A subsequent write repairs the file.
    const model = join(path, '..', 'Aria.vrm');
    writeFileSync(model, 'glTF');
    store.addFile(model);
    expect(JSON.parse(readFileSync(path, 'utf8')).avatars).toHaveLength(1);
  });
});
