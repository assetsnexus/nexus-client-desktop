/**
 * Storage-reference format spec.
 *
 * A copied path must be a reference the region-side agents parse. The canonical
 * format lives in the agent helper
 * (`anx-inference/backend/src/inference/storage/storage-reference.util.ts`) as
 * `bfstorage://<workspaceId>/<fileIdOrObjectKey>`. These tests pin the client
 * twin to that exact shape so the two never drift, and pin the portal deep link
 * to the region's `formatStorageExplorerPath` shape.
 */
import { describe, expect, it } from 'vitest';
import {
  BF_STORAGE_REF_PREFIX,
  absoluteStorageExplorerUrl,
  formatStorageExplorerPath,
  formatStorageReference,
  isStorageReference,
  parseStorageReference,
} from './storage-reference.js';

describe('formatStorageReference', () => {
  it('uses the canonical bfstorage:// scheme the agents parse', () => {
    expect(BF_STORAGE_REF_PREFIX).toBe('bfstorage://');
    expect(formatStorageReference('w-acme', 'reports/q3.pdf')).toBe('bfstorage://w-acme/reports/q3.pdf');
  });

  it('accepts a key with or without a leading slash', () => {
    expect(formatStorageReference('w-acme', '/reports/q3.pdf')).toBe('bfstorage://w-acme/reports/q3.pdf');
    expect(formatStorageReference('w-acme', '//reports/q3.pdf')).toBe('bfstorage://w-acme/reports/q3.pdf');
  });

  it('uses the region file id when that is what the row carries', () => {
    expect(formatStorageReference('w-acme', 'f_01H8XYZ')).toBe('bfstorage://w-acme/f_01H8XYZ');
  });
});

describe('parseStorageReference', () => {
  it('round-trips a reference', () => {
    const ref = formatStorageReference('w-acme', 'reports/q3.pdf');
    expect(parseStorageReference(ref)).toEqual({ workspaceId: 'w-acme', fileOrObjectKey: 'reports/q3.pdf' });
  });

  it('keeps slashes inside the object key', () => {
    expect(parseStorageReference('bfstorage://w-acme/a/b/c.txt')?.fileOrObjectKey).toBe('a/b/c.txt');
  });

  it('tolerates surrounding whitespace and leading key slashes', () => {
    expect(parseStorageReference('  bfstorage://w-acme//a.txt  ')).toEqual({
      workspaceId: 'w-acme',
      fileOrObjectKey: 'a.txt',
    });
  });

  it('rejects anything that is not a storage reference', () => {
    expect(parseStorageReference('')).toBeNull();
    expect(parseStorageReference('https://region.example/files/a.txt')).toBeNull();
    expect(parseStorageReference('bfstorage://')).toBeNull();
    expect(parseStorageReference('bfstorage://w-acme')).toBeNull();
    expect(parseStorageReference('bfstorage://w-acme/')).toBeNull();
    expect(parseStorageReference('bfstorage:///a.txt')).toBeNull();
  });

  it('agrees with the agent helper on the prefix check', () => {
    expect(isStorageReference('bfstorage://w-acme/a.txt')).toBe(true);
    expect(isStorageReference('bfstorage://w-acme/')).toBe(false);
    expect(isStorageReference('/a.txt')).toBe(false);
  });
});

describe('portal deep link', () => {
  it('matches the region helper shape for a user surface', () => {
    expect(formatStorageExplorerPath('w-acme', 'f_123')).toBe('/user/storage/browser/w-acme?file=f_123');
  });

  it('prefers an explicit file id over the object key', () => {
    expect(formatStorageExplorerPath('w-acme', 'reports/q3.pdf', { fileId: 'f_123' })).toBe(
      '/user/storage/browser/w-acme?file=f_123',
    );
  });

  it('encodes the bucket id and the file parameter', () => {
    const path = formatStorageExplorerPath('w acme/x', 'reports/q3 & final.pdf');
    expect(path).toContain('/user/storage/browser/w%20acme%2Fx?');
    expect(path).toContain('file=reports%2Fq3+%26+final.pdf');
  });

  it('targets the org console surface on /b2b', () => {
    expect(formatStorageExplorerPath('w-acme', 'f_123', { surface: 'org' })).toBe(
      '/b2b/storage/browser/w-acme?file=f_123',
    );
  });

  it('builds an absolute URL only when a base URL is known', () => {
    expect(absoluteStorageExplorerUrl(null, 'w-acme', 'f_123')).toBeNull();
    expect(absoluteStorageExplorerUrl('   ', 'w-acme', 'f_123')).toBeNull();
    expect(absoluteStorageExplorerUrl('https://region.example/', 'w-acme', 'f_123')).toBe(
      'https://region.example/user/storage/browser/w-acme?file=f_123',
    );
  });
});
