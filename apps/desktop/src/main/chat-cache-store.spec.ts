import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatCacheStore } from './chat-cache-store.js';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-cache-'));
  filePath = join(dir, 'chat-cache.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createChatCacheStore — round trip', () => {
  it('persists a value and reads it back', () => {
    const store = createChatCacheStore({ filePath });
    store.set('nexus:chat-cache:v1:list:u1', '{"rows":[]}');
    expect(store.get('nexus:chat-cache:v1:list:u1')).toBe('{"rows":[]}');
    expect(store.keys()).toEqual(['nexus:chat-cache:v1:list:u1']);
  });

  it('survives a reload (new store instance reads the file)', () => {
    const first = createChatCacheStore({ filePath });
    first.set('nexus:chat-cache:v1:thread:u1:c1', '{"turns":[]}');
    const second = createChatCacheStore({ filePath });
    expect(second.get('nexus:chat-cache:v1:thread:u1:c1')).toBe('{"turns":[]}');
  });

  it('deletes and clears', () => {
    const store = createChatCacheStore({ filePath });
    store.set('a', '1');
    store.set('b', '2');
    store.delete('a');
    expect(store.keys()).toEqual(['b']);
    store.clear();
    expect(store.keys()).toEqual([]);
    expect(store.stats().bytes).toBe(0);
  });
});

describe('createChatCacheStore — byte bound', () => {
  it('evicts least-recently-used entries when over the cap', () => {
    let clock = 1000;
    const store = createChatCacheStore({
      filePath,
      settings: { maxBytes: 20 },
      now: () => (clock += 1),
    });
    store.set('old', 'x'.repeat(10));
    store.set('mid', 'y'.repeat(10));
    // Touch 'old' so 'mid' becomes the least-recently-used.
    store.get('old');
    store.set('new', 'z'.repeat(10));
    const keys = store.keys().sort();
    expect(keys).toContain('new');
    expect(keys).toContain('old');
    expect(keys).not.toContain('mid');
    expect(store.stats().evictions).toBeGreaterThan(0);
  });

  it('setting a smaller cap re-trims immediately', () => {
    const store = createChatCacheStore({ filePath, settings: { maxBytes: 1000 } });
    store.set('a', 'x'.repeat(100));
    store.set('b', 'y'.repeat(100));
    const stats = store.setSettings({ maxBytes: 150 });
    expect(stats.maxBytes).toBe(150);
    expect(store.keys().length).toBe(1);
  });

  it('reports stats', () => {
    const store = createChatCacheStore({ filePath, settings: { maxBytes: 1000 } });
    store.set('a', 'hello');
    const stats = store.stats();
    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBe(5);
    expect(stats.maxBytes).toBe(1000);
  });
});

describe('createChatCacheStore — TTL', () => {
  it('drops an entry past its TTL on read', () => {
    let clock = 1_000;
    const store = createChatCacheStore({ filePath, ttlMs: 100, now: () => clock });
    store.set('a', 'value');
    clock += 50;
    expect(store.get('a')).toBe('value');
    // A read refreshes last-touch, so the TTL is measured from the last access.
    clock += 150;
    expect(store.get('a')).toBeNull();
  });
});
