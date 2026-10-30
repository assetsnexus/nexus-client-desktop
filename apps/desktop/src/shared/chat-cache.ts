/**
 * Desktop durable chat-cache settings — shared types + **pure** helpers.
 *
 * The chat cache stores conversation-list metadata plus short turn previews so a
 * reload renders instantly and only the delta is refetched. The bytes live in a
 * main-process file store (`main/chat-cache-store.ts`); the renderer only ever
 * reaches it through the `nexus:chat-cache:*` IPC channels. Everything here is
 * dependency-free (no `electron`, no `node:fs`) so the bounds math and coercion
 * are unit-testable and identical on both sides of IPC.
 */

export const BYTES_PER_MIB = 1024 * 1024;

/** Ceilings offered by the settings UI. `0` disables the bound (unbounded). */
export const CHAT_CACHE_MAX_MIB_CHOICES = [25, 50, 100, 250, 500, 0] as const;

/** Default cap: 100 MiB, matching the plan / `chat-core` default. */
export const DEFAULT_CHAT_CACHE_MAX_BYTES = 100 * BYTES_PER_MIB;

/** Default per-entry TTL, matching `chat-core` (7 days). */
export const DEFAULT_CHAT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ChatCacheSettings = {
  /** Keep the store under this many bytes, evicting least-recently-used first. `0` = unbounded. */
  maxBytes: number;
};

export const DEFAULT_CHAT_CACHE_SETTINGS: ChatCacheSettings = {
  maxBytes: DEFAULT_CHAT_CACHE_MAX_BYTES,
};

/**
 * Coerce a persisted/patched settings block field-by-field, so a hand-edited
 * settings file can never disable the bound with garbage.
 */
export function normalizeChatCacheSettings(raw: unknown): ChatCacheSettings {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const n = typeof value.maxBytes === 'number' ? value.maxBytes : Number(value.maxBytes);
  const maxBytes =
    Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_CHAT_CACHE_SETTINGS.maxBytes;
  return { maxBytes };
}

export type ChatCacheStats = {
  /** Bytes currently persisted. */
  bytes: number;
  /** Configured cap in bytes (`0` = unbounded). */
  maxBytes: number;
  /** Live entry count. */
  entries: number;
  /** Entries dropped by the byte bound since the store loaded. */
  evictions: number;
};

export type ChatCacheKeyConflict = {
  key: string;
  bytes: number;
};

/**
 * Decide which entries survive a byte bound. Oldest-touched first, pure and
 * deterministic. `0` `maxBytes` keeps everything (unbounded).
 */
export function selectChatCacheRetained<T extends { touched: number; bytes?: number }>(
  entries: readonly T[],
  maxBytes: number,
  opts?: { keepKeys?: readonly string[] },
): { kept: T[]; evicted: number; bytes: number } {
  const keep = opts?.keepKeys ? new Set(opts.keepKeys) : null;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return {
      kept: [...entries],
      evicted: 0,
      bytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
    };
  }
  // Newest-touched first so we keep the freshest entries within budget.
  const ordered = [...entries].sort((a, b) => b.touched - a.touched);
  const kept: T[] = [];
  let total = 0;
  for (const entry of ordered) {
    const size = entry.bytes ?? 0;
    // A newly written entry is always kept even if it alone exceeds the cap
    // (otherwise a single large value could never be cached at all).
    if (keep && entry && typeof entry === 'object' && 'key' in entry) {
      const key = String((entry as unknown as { key: unknown }).key);
      if (keep.has(key)) {
        kept.push(entry);
        total += size;
        continue;
      }
    }
    if (total + size > maxBytes) continue;
    kept.push(entry);
    total += size;
  }
  return { kept, evicted: entries.length - kept.length, bytes: total };
}
