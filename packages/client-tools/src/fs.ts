/**
 * Sandboxed file tools.
 *
 * All access goes through {@link resolveWithinWorkspace}, so `..` and symlink
 * escapes are rejected before any syscall. Writes carry a revision guard
 * (mtimeMs + sha256) so a stale edit fails instead of clobbering — mirroring the
 * region's `expectedSha256` / `ifMatchRevision` optimistic-concurrency idea.
 */

import { createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { resolveWithinWorkspace, type WorkspaceRoot } from './workspace.js';

export type FileRevision = {
  mtimeMs: number;
  sha256: string;
  sizeBytes: number;
};

export type FileOpResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function readRevision(absPath: string): FileRevision | null {
  if (!existsSync(absPath)) return null;
  const stat = statSync(absPath);
  const content = readFileSync(absPath);
  return { mtimeMs: stat.mtimeMs, sha256: hashContent(content), sizeBytes: stat.size };
}

export type ReadFileOptions = {
  roots: WorkspaceRoot[];
  maxBytes?: number;
};

const DEFAULT_MAX_BYTES = 512 * 1024;

export function readFile(
  target: string,
  options: ReadFileOptions,
): FileOpResult<{ content: string; revision: FileRevision }> {
  const sandbox = resolveWithinWorkspace(target, options.roots, 'read');
  if (!sandbox.ok) return { ok: false, reason: sandbox.message };
  if (!existsSync(sandbox.realPath)) return { ok: false, reason: 'file not found' };

  const stat = statSync(sandbox.realPath);
  const max = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (stat.size > max) {
    return { ok: false, reason: `file exceeds ${max} bytes (${stat.size})` };
  }
  const content = readFileSync(sandbox.realPath, 'utf8');
  return {
    ok: true,
    value: {
      content,
      revision: {
        mtimeMs: stat.mtimeMs,
        sha256: hashContent(content),
        sizeBytes: stat.size,
      },
    },
  };
}

export type WriteFileOptions = {
  roots: WorkspaceRoot[];
  /** When set, the on-disk file must match this revision or the write fails. */
  expectedRevision?: FileRevision | null;
  /** When true, refuse to overwrite an existing file. */
  createOnly?: boolean;
};

export function writeFile(
  target: string,
  content: string,
  options: WriteFileOptions,
): FileOpResult<{ revision: FileRevision }> {
  const sandbox = resolveWithinWorkspace(target, options.roots, 'write');
  if (!sandbox.ok) return { ok: false, reason: sandbox.message };

  const existing = readRevision(sandbox.realPath);
  if (options.createOnly && existing) {
    return { ok: false, reason: 'file already exists (createOnly)' };
  }
  if (options.expectedRevision && existing) {
    if (existing.sha256 !== options.expectedRevision.sha256) {
      return { ok: false, reason: 'stale revision: file changed on disk' };
    }
  } else if (options.expectedRevision && !existing) {
    return { ok: false, reason: 'expected revision provided but file does not exist' };
  }

  mkdirSync(dirname(sandbox.realPath), { recursive: true });
  writeFileSync(sandbox.realPath, content, 'utf8');
  return { ok: true, value: { revision: readRevision(sandbox.realPath)! } };
}

export type EditFileOptions = WriteFileOptions & {
  oldText: string;
  newText: string;
};

/**
 * Exact-string replace. Fails when `oldText` is missing or ambiguous (appears
 * more than once), forcing the caller to be precise rather than clobbering.
 */
export function editFile(
  target: string,
  options: EditFileOptions,
): FileOpResult<{ revision: FileRevision }> {
  const read = readFile(target, { roots: options.roots });
  if (!read.ok) return { ok: false, reason: read.reason };

  if (options.expectedRevision && read.value.revision.sha256 !== options.expectedRevision.sha256) {
    return { ok: false, reason: 'stale revision: file changed on disk' };
  }

  const occurrences = read.value.content.split(options.oldText).length - 1;
  if (occurrences === 0) return { ok: false, reason: 'oldText not found' };
  if (occurrences > 1) {
    return { ok: false, reason: `oldText is ambiguous (${occurrences} matches)` };
  }

  const next = read.value.content.replace(options.oldText, options.newText);
  return writeFile(target, next, {
    roots: options.roots,
    expectedRevision: { ...read.value.revision },
  });
}

export function deleteFile(target: string, options: { roots: WorkspaceRoot[] }): FileOpResult<true> {
  const sandbox = resolveWithinWorkspace(target, options.roots, 'write');
  if (!sandbox.ok) return { ok: false, reason: sandbox.message };
  if (!existsSync(sandbox.realPath)) return { ok: false, reason: 'file not found' };
  return { ok: true, value: true };
}
