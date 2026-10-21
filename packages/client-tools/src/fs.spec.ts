import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { editFile, hashContent, readFile, readRevision, writeFile } from './fs.js';
import type { WorkspaceRoot } from './workspace.js';

let base: string;
let roots: WorkspaceRoot[];
let roRoots: WorkspaceRoot[];

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'nexus-fs-'));
  roots = [{ id: 'rw', label: 'rw', path: base, mode: 'read-write' }];
  roRoots = [{ id: 'ro', label: 'ro', path: base, mode: 'read-only' }];
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('hashContent', () => {
  it('is stable and content-sensitive', () => {
    expect(hashContent('a')).toBe(hashContent('a'));
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });
});

describe('readFile', () => {
  it('reads a file with its revision', () => {
    const p = join(base, 'a.txt');
    writeFileSync(p, 'hello');
    const res = readFile(p, { roots });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.content).toBe('hello');
      expect(res.value.revision.sha256).toBe(hashContent('hello'));
    }
  });

  it('refuses a missing file', () => {
    const res = readFile(join(base, 'nope.txt'), { roots });
    expect(res.ok).toBe(false);
  });

  it('refuses a path outside the roots', () => {
    const res = readFile('/etc/hostname', { roots });
    expect(res.ok).toBe(false);
  });

  it('refuses a file over the size cap', () => {
    const p = join(base, 'big.txt');
    writeFileSync(p, 'x'.repeat(100));
    const res = readFile(p, { roots, maxBytes: 10 });
    expect(res.ok).toBe(false);
  });
});

describe('writeFile', () => {
  it('writes a new file inside a read-write root', () => {
    const p = join(base, 'sub', 'n.txt');
    const res = writeFile(p, 'data', { roots });
    expect(res.ok).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('data');
  });

  it('refuses to write inside a read-only root', () => {
    const res = writeFile(join(base, 'ro.txt'), 'x', { roots: roRoots });
    expect(res.ok).toBe(false);
  });

  it('honours createOnly', () => {
    const p = join(base, 'exists.txt');
    writeFileSync(p, 'orig');
    const res = writeFile(p, 'new', { roots, createOnly: true });
    expect(res.ok).toBe(false);
  });

  it('rejects a stale revision', () => {
    const p = join(base, 'rev.txt');
    writeFileSync(p, 'v1');
    const rev = readRevision(p)!;
    writeFileSync(p, 'v2'); // someone else changed it
    const res = writeFile(p, 'v3', { roots, expectedRevision: rev });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('stale');
  });

  it('accepts a matching revision', () => {
    const p = join(base, 'rev2.txt');
    writeFileSync(p, 'v1');
    const rev = readRevision(p)!;
    const res = writeFile(p, 'v2', { roots, expectedRevision: rev });
    expect(res.ok).toBe(true);
  });
});

describe('editFile', () => {
  it('replaces a unique string', () => {
    const p = join(base, 'edit.txt');
    writeFileSync(p, 'const a = 1;\n');
    const res = editFile(p, { roots, oldText: '= 1', newText: '= 2' });
    expect(res.ok).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('const a = 2;\n');
  });

  it('refuses an ambiguous replacement', () => {
    const p = join(base, 'dup.txt');
    writeFileSync(p, 'x\nx\n');
    const res = editFile(p, { roots, oldText: 'x', newText: 'y' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('ambiguous');
  });

  it('refuses when oldText is absent', () => {
    const p = join(base, 'absent.txt');
    writeFileSync(p, 'abc');
    const res = editFile(p, { roots, oldText: 'zzz', newText: 'y' });
    expect(res.ok).toBe(false);
  });

  it('rejects a stale edit', () => {
    const p = join(base, 'stale-edit.txt');
    writeFileSync(p, 'one');
    const rev = readRevision(p)!;
    writeFileSync(p, 'two');
    const res = editFile(p, { roots, oldText: 'two', newText: 'three', expectedRevision: rev });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('stale');
  });
});
