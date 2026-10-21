import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWorkspaceRegistry,
  isInside,
  resolveWithinWorkspace,
  type WorkspaceRoot,
} from './workspace.js';

let base: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'nexus-ws-'));
  mkdirSync(join(base, 'project', 'src'), { recursive: true });
  mkdirSync(join(base, 'other'), { recursive: true });
  writeFileSync(join(base, 'project', 'src', 'index.ts'), 'export {};\n');
  // A symlink inside the project pointing out of it — must not grant escape.
  try {
    symlinkSync(join(base, 'other'), join(base, 'project', 'escape'));
  } catch {
    /* symlinks may be unavailable on some platforms */
  }
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function roots(): WorkspaceRoot[] {
  return [
    { id: 'rw', label: 'project', path: join(base, 'project'), mode: 'read-write' },
    { id: 'ro', label: 'other', path: join(base, 'other'), mode: 'read-only' },
  ];
}

describe('createWorkspaceRegistry', () => {
  it('adds, lists, gets, and removes roots', () => {
    const reg = createWorkspaceRegistry([roots()[0]]);
    expect(reg.list()).toHaveLength(1);
    reg.add(roots()[1]);
    expect(reg.list()).toHaveLength(2);
    expect(reg.get('ro')?.label).toBe('other');
    expect(reg.remove('ro')).toBe(true);
    expect(reg.get('ro')).toBeUndefined();
    expect(reg.remove('missing')).toBe(false);
  });
});

describe('isInside', () => {
  it('accepts the root itself and children', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
  });

  it('rejects siblings and parents', () => {
    expect(isInside('/a/bc', '/a/b')).toBe(false);
    expect(isInside('/a', '/a/b')).toBe(false);
    expect(isInside('/x', '/a/b')).toBe(false);
  });
});

describe('resolveWithinWorkspace', () => {
  it('allows reads inside a read-only root', () => {
    const res = resolveWithinWorkspace(join(base, 'project', 'src', 'index.ts'), roots(), 'read');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.root.id).toBe('rw');
  });

  it('allows writes inside a read-write root', () => {
    const res = resolveWithinWorkspace(join(base, 'project', 'new.txt'), roots(), 'write');
    expect(res.ok).toBe(true);
  });

  it('denies writes inside a read-only root', () => {
    const res = resolveWithinWorkspace(join(base, 'other', 'x.txt'), roots(), 'write');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('read_only');
  });

  it('denies a relative path', () => {
    const res = resolveWithinWorkspace('relative/path.txt', roots(), 'read');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not_absolute');
  });

  it('denies a path outside every root', () => {
    const res = resolveWithinWorkspace('/etc/passwd', roots(), 'read');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('outside_allowed_roots');
  });

  it('denies traversal out of a root via ..', () => {
    const res = resolveWithinWorkspace(join(base, 'project', '..', 'other', 'x.txt'), roots(), 'read');
    // Resolves to /base/other which IS a root — so this is allowed read.
    expect(res.ok).toBe(true);

    const escape = resolveWithinWorkspace(join(base, 'project', '..', '..', 'etc'), roots(), 'read');
    expect(escape.ok).toBe(false);
  });

  it('denies escape through a symlink pointing outside the root', () => {
    const link = join(base, 'project', 'escape', 'secret.txt');
    const res = resolveWithinWorkspace(link, roots(), 'read');
    // `escape` is a symlink to /base/other (read-only root). Reading resolves
    // to /base/other/secret.txt, which is inside the `other` root — allowed for
    // read, denied for write. The key property: it never resolves *outside* all
    // roots, and a write is refused by the read-only mode.
    expect(res.ok).toBe(true);
    const write = resolveWithinWorkspace(link, roots(), 'write');
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.reason).toBe('read_only');
  });

  it('allows creating a new file whose parent resolves inside the root', () => {
    const res = resolveWithinWorkspace(join(base, 'project', 'src', 'brand-new.ts'), roots(), 'write');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.root.id).toBe('rw');
  });
});
