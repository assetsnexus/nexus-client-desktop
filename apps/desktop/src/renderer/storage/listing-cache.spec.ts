/**
 * Listing-cache unit spec.
 *
 * The cache exists so switching workspaces paints instantly instead of blanking,
 * without ever letting one identity/workspace/folder/view read another's rows.
 * These tests pin the keying rules (identity + workspace + folder + view +
 * search), the TTL/freshness contract the explorer uses to decide "hydrate only"
 * vs "hydrate then revalidate", and the bounded eviction + bust behaviour.
 */
import { describe, expect, it } from 'vitest';
import {
  LISTING_CACHE_MAX_ENTRIES,
  LISTING_CACHE_TTL_MS,
  StorageListingCache,
  listingCacheKey,
  type ListingKeyParts,
} from './listing-cache.js';
import type { StoragePage } from '../../shared/ipc.js';

const page = (total: number): StoragePage => ({
  items: [],
  total,
  nextCursor: null,
  encryptionSummary: {},
});

const base: ListingKeyParts = {
  identityKey: 'org:org-acme',
  workspaceId: 'w-acme',
  folderId: null,
  view: 'active',
  search: '',
};

describe('listingCacheKey', () => {
  it('keys by identity, workspace, folder, view and search', () => {
    const key = listingCacheKey(base);
    expect(key).toBe('org:org-acme::w-acme::::active::');
  });

  it('separates the personal identity from an org identity for the same workspace id', () => {
    expect(listingCacheKey({ ...base, identityKey: undefined })).not.toBe(listingCacheKey(base));
    expect(listingCacheKey({ ...base, identityKey: null })).toBe(
      listingCacheKey({ ...base, identityKey: undefined }),
    );
  });

  it('separates workspaces, folders, views and searches', () => {
    const key = listingCacheKey(base);
    expect(listingCacheKey({ ...base, workspaceId: 'w-beta' })).not.toBe(key);
    expect(listingCacheKey({ ...base, folderId: 'f-1' })).not.toBe(key);
    expect(listingCacheKey({ ...base, view: 'trash' })).not.toBe(key);
    expect(listingCacheKey({ ...base, search: 'invoice' })).not.toBe(key);
  });

  it('normalises whitespace and case in the search term', () => {
    expect(listingCacheKey({ ...base, search: '  Invoice ' })).toBe(
      listingCacheKey({ ...base, search: 'invoice' }),
    );
    expect(listingCacheKey({ ...base, search: '   ' })).toBe(listingCacheKey(base));
  });
});

describe('StorageListingCache', () => {
  it('returns a fresh hit within the TTL and marks it for instant hydration', () => {
    const cache = new StorageListingCache();
    const key = listingCacheKey(base);
    cache.write(key, page(3), 1_000);

    const hit = cache.read(key, 1_000 + LISTING_CACHE_TTL_MS - 1);
    expect(hit?.page.total).toBe(3);
    expect(hit?.fresh).toBe(true);
  });

  it('returns a stale hit after the TTL so the caller revalidates in the background', () => {
    const cache = new StorageListingCache();
    const key = listingCacheKey(base);
    cache.write(key, page(7), 1_000);

    const hit = cache.read(key, 1_000 + LISTING_CACHE_TTL_MS);
    expect(hit?.page.total).toBe(7);
    expect(hit?.fresh).toBe(false);
  });

  it('misses on an unseen key', () => {
    const cache = new StorageListingCache();
    expect(cache.read(listingCacheKey(base))).toBeNull();
  });

  it('busts exactly one key so Refresh reloads only the current view', () => {
    const cache = new StorageListingCache();
    const key = listingCacheKey(base);
    const other = listingCacheKey({ ...base, workspaceId: 'w-beta' });
    cache.write(key, page(1));
    cache.write(other, page(2));

    expect(cache.delete(key)).toBe(true);
    expect(cache.delete(key)).toBe(false);
    expect(cache.read(key)).toBeNull();
    expect(cache.read(other)?.page.total).toBe(2);
  });

  it('evicts the least recently used entry past its bound', () => {
    const cache = new StorageListingCache(2);
    const a = listingCacheKey({ ...base, workspaceId: 'w-a' });
    const b = listingCacheKey({ ...base, workspaceId: 'w-b' });
    const c = listingCacheKey({ ...base, workspaceId: 'w-c' });
    cache.write(a, page(1));
    cache.write(b, page(2));
    // Reading `a` makes `b` the eviction candidate.
    expect(cache.read(a)).not.toBeNull();
    cache.write(c, page(3));

    expect(cache.size).toBe(2);
    expect(cache.read(a)).not.toBeNull();
    expect(cache.read(b)).toBeNull();
    expect(cache.read(c)).not.toBeNull();
  });

  it('clear() empties every listing', () => {
    const cache = new StorageListingCache();
    cache.write(listingCacheKey(base), page(1));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.read(listingCacheKey(base))).toBeNull();
  });

  it('keeps a sensible default bound', () => {
    expect(LISTING_CACHE_MAX_ENTRIES).toBeGreaterThanOrEqual(10);
    expect(LISTING_CACHE_TTL_MS).toBeGreaterThanOrEqual(5_000);
  });
});
