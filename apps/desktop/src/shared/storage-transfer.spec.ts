import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  guessContentType,
  joinRelPath,
  normalizeRelPath,
  planDropUploads,
  posixBasename,
  posixDirname,
  prefixSegments,
  transferPercent,
  type DropNode,
  type WalkedFile,
} from './storage-transfer.js';

const file = (path: string, name: string, sizeBytes = 1): DropNode => ({
  path,
  name,
  isDirectory: false,
  sizeBytes,
});
const dir = (path: string, name: string): DropNode => ({ path, name, isDirectory: true });

describe('path helpers', () => {
  it('normalizes separators and redundant segments', () => {
    expect(normalizeRelPath('/a//b/./c')).toBe('a/b/c');
    expect(normalizeRelPath('a\\b\\c')).toBe('a/b/c');
    expect(normalizeRelPath('')).toBe('');
  });

  it('splits posix dirname/basename', () => {
    expect(posixDirname('a/b/c.png')).toBe('a/b');
    expect(posixBasename('a/b/c.png')).toBe('c.png');
    expect(posixDirname('bare.png')).toBe('');
    expect(posixBasename('bare.png')).toBe('bare.png');
  });

  it('joins without doubling separators', () => {
    expect(joinRelPath('a', 'b/c')).toBe('a/b/c');
    expect(joinRelPath('', 'b')).toBe('b');
    expect(joinRelPath('a', '')).toBe('a');
  });

  it('splits a folder prefix into segments', () => {
    expect(prefixSegments('photos/2024')).toEqual(['photos', '2024']);
    expect(prefixSegments('')).toEqual([]);
  });
});

describe('guessContentType', () => {
  it('maps common extensions and falls back to octet-stream', () => {
    expect(guessContentType('a.png')).toBe('image/png');
    expect(guessContentType('a.JPG')).toBe('image/jpeg');
    expect(guessContentType('noext')).toBe('application/octet-stream');
    expect(guessContentType('weird.xyz')).toBe('application/octet-stream');
  });
});

describe('planDropUploads', () => {
  it('plans a plain dropped file into the target folder prefix', () => {
    const plan = planDropUploads([file('/tmp/a.png', 'a.png', 2048)]);
    expect(plan.skipped).toEqual([]);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      absPath: '/tmp/a.png',
      name: 'a.png',
      prefix: '',
      relPath: 'a.png',
      sizeBytes: 2048,
      contentType: 'image/png',
    });
  });

  it('expands a dropped directory, preserving relative paths and nesting under its name', () => {
    const walked: WalkedFile[] = [
      { path: '/drop/photos/2024/a.png', relPath: '2024/a.png', sizeBytes: 10 },
      { path: '/drop/photos/b.txt', relPath: 'b.txt', sizeBytes: 20 },
    ];
    const plan = planDropUploads([dir('/drop/photos', 'photos')], { '/drop/photos': walked });

    expect(plan.entries).toHaveLength(2);
    const a = plan.entries.find((e) => e.name === 'a.png');
    const b = plan.entries.find((e) => e.name === 'b.txt');
    expect(a).toMatchObject({ prefix: 'photos/2024', relPath: 'photos/2024/a.png', contentType: 'image/png' });
    expect(b).toMatchObject({ prefix: 'photos', relPath: 'photos/b.txt', contentType: 'text/plain' });
  });

  it('reports an empty dropped directory as skipped, not silently ignored', () => {
    const plan = planDropUploads([dir('/drop/empty', 'empty')], { '/drop/empty': [] });
    expect(plan.entries).toEqual([]);
    expect(plan.skipped).toEqual([{ path: '/drop/empty', reason: 'empty-directory' }]);
  });

  it('deduplicates identical destinations across a mixed drop', () => {
    // Two dropped files that would land on the exact same workspace path.
    const plan = planDropUploads([
      file('/tmp/a.png', 'a.png', 5),
      file('/other/a.png', 'a.png', 7),
    ]);
    expect(plan.entries.filter((e) => e.relPath === 'a.png')).toHaveLength(1);
    expect(plan.entries[0].sizeBytes).toBe(5);
    expect(plan.skipped).toEqual([{ path: '/other/a.png', reason: 'duplicate' }]);
  });

  it('does not collide a folder drop with a same-named loose file (different prefixes)', () => {
    // A dropped folder `a.png` nests its contents under `a.png/`, so its files
    // have distinct relPaths from a loose top-level `a.png`.
    const walked: WalkedFile[] = [{ path: '/drop/a.png', relPath: 'a.png', sizeBytes: 5 }];
    const plan = planDropUploads(
      [file('/tmp/a.png', 'a.png', 9), dir('/drop', 'a.png')],
      { '/drop': walked },
    );
    expect(plan.entries.map((e) => e.relPath).sort()).toEqual(['a.png', 'a.png/a.png']);
    expect(plan.skipped).toEqual([]);
  });

  it('preserves deep trees across multiple dropped directories', () => {
    const plan = planDropUploads(
      [dir('/x/one', 'one'), dir('/x/two', 'two')],
      {
        '/x/one': [{ path: '/x/one/deep/nested/f.bin', relPath: 'deep/nested/f.bin', sizeBytes: 3 }],
        '/x/two': [{ path: '/x/two/g.txt', relPath: 'g.txt', sizeBytes: 4 }],
      },
    );
    expect(plan.entries.map((e) => e.relPath).sort()).toEqual(['one/deep/nested/f.bin', 'two/g.txt']);
  });
});

describe('formatBytes', () => {
  it('formats compactly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(-4)).toBe('0 B');
  });
});

describe('transferPercent', () => {
  it('returns a real percentage only with byte granularity', () => {
    expect(transferPercent(50, 100, false)).toBe(50);
    expect(transferPercent(100, 100, false)).toBe(100);
    expect(transferPercent(999, 100, false)).toBe(100);
  });

  it('returns null (indeterminate) when there is no byte count', () => {
    expect(transferPercent(0, 0, true)).toBeNull();
    expect(transferPercent(10, 0, false)).toBeNull();
    expect(transferPercent(10, 100, true)).toBeNull();
  });
});
