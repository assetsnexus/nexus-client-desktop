/**
 * Renderer-side listing cache for the storage explorer.
 *
 * Switching workspaces (or view mode / search) re-lists a bucket. Re-fetching
 * on every switch leaves the pane blank for a round trip — and worse, if the
 * previous response lands late it paints the *old* workspace's rows under the
 * new workspace's header. This cache fixes both: a previously seen listing is
 * painted instantly, and the network result is keyed so a stale response can
 * never be mistaken for the current view.
 *
 * Deliberately tiny and in-memory: no persistence, no cross-window sharing, no
 * invalidation framework. The cache is keyed by the identity context that owns
 * the workspace (`personal` or `org:<id>`), the workspace id, the folder, the
 * view mode and the search query — so two identities that both expose a
 * workspace with the same id never read each other's rows, and a trash listing
 * never shadows the active one.
 */

import type { StoragePage } from '../../shared/ipc.js';

/** How long a listing is served without hitting the network again. */
export const LISTING_CACHE_TTL_MS = 30_000;

/** Upper bound on retained listings; the oldest write is evicted first. */
export const LISTING_CACHE_MAX_ENTRIES = 40;

export type ListingViewMode = 'active' | 'trash';

export type ListingKeyParts = {
  /** Identity context owning the workspace; `undefined`/empty means personal. */
  identityKey?: string | null;
  workspaceId: string;
  /** Folder being listed; `null`/omitted means the workspace root. */
  folderId?: string | null;
  view: ListingViewMode;
  search?: string | null;
};

/**
 * Stable cache key for one listing. Search is trimmed and lower-cased so a
 * whitespace/case-only change reuses the same entry; an empty search and an
 * absent search are the same listing.
 */
export function listingCacheKey(parts: ListingKeyParts): string {
  const identity = parts.identityKey?.trim() || 'personal';
  const search = (parts.search ?? '').trim().toLowerCase();
  return [identity, parts.workspaceId, parts.folderId ?? '', parts.view, search].join('::');
}

export type CachedListing = {
  page: StoragePage;
  fetchedAt: number;
};

/**
 * Bounded LRU-ish map of listing results. Reads refresh recency so the entries
 * a user keeps returning to survive eviction.
 */
export class StorageListingCache {
  private readonly entries = new Map<string, CachedListing>();

  constructor(
    private readonly maxEntries: number = LISTING_CACHE_MAX_ENTRIES,
    private readonly ttlMs: number = LISTING_CACHE_TTL_MS,
  ) {}

  /**
   * Side-effect-free lookup: returns the cached listing without touching LRU
   * recency. Safe to call during render, where `read`'s map reordering would be
   * an unsafe mutation.
   */
  peek(key: string): CachedListing | null {
    return this.entries.get(key) ?? null;
  }

  /** Cached listing for `key`, or `null`. `fresh` means "no revalidate needed". */
  read(key: string, now: number = Date.now()): (CachedListing & { fresh: boolean }) | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    // Re-insert to mark as most recently used.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return { ...hit, fresh: now - hit.fetchedAt < this.ttlMs };
  }

  write(key: string, page: StoragePage, now: number = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { page, fetchedAt: now });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Drop one listing (the Refresh action busts only the current view). */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
