/**
 * Main-process durable chat cache (file-backed, byte-bounded).
 *
 * The renderer's chat panel injects this as its `ChatCacheAdapter` through the
 * `nexus:chat-cache:*` IPC channels. It holds **metadata only** — conversation
 * list rows and short turn previews — never message bodies (those are refetched
 * via the delta on open). At-rest protection here is the OS user profile: the
 * file lives under `userData` and is only readable by the signed-in OS user
 * (unlike the portal, which has no OS account boundary and encrypts with a
 * device key).
 *
 * The byte bound is configurable (`ChatCacheSettings.maxBytes`, default 100 MiB)
 * and enforced with LRU eviction by last-touch. The pure bound math lives in
 * `shared/chat-cache.ts`; this file only adds the filesystem + the settings
 * file, mirroring `main/audit-store.ts`.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_CHAT_CACHE_SETTINGS,
  normalizeChatCacheSettings,
  selectChatCacheRetained,
  type ChatCacheSettings,
  type ChatCacheStats,
} from '../shared/chat-cache.js';
import type { Logger } from './logger.js';

type PersistedEntry = {
  /** Opaque serialized value (a JSON string from `chat-core`). */
  value: string;
  /** Epoch ms of the last read/write, for LRU ordering. */
  touched: number;
};

type PersistedFile = {
  settings: ChatCacheSettings;
  entries: Record<string, PersistedEntry>;
};

export type ChatCacheStore = {
  /** Read one entry; `null` when absent or expired. Touches LRU order. */
  get(key: string): string | null;
  /** Insert/replace one entry, then enforce the byte bound. */
  set(key: string, value: string): void;
  /** Drop one entry (archive / delete / invalidation). */
  delete(key: string): void;
  /** Every key currently held (prefix-filtered by the caller when needed). */
  keys(): string[];
  /** Wipe every entry, keeping the settings. */
  clear(): void;
  getSettings(): ChatCacheSettings;
  setSettings(patch: Partial<ChatCacheSettings>): ChatCacheSettings;
  stats(): ChatCacheStats;
  /** Absolute path of the backing file (display only). */
  filePath(): string;
};

export type ChatCacheStoreOptions = {
  /** Absolute path to the JSON file. Defaults to `<cwd>/chat-cache/chat-cache.json`. */
  filePath?: string;
  /** Initial settings; a persisted block overrides it when present. */
  settings?: Partial<ChatCacheSettings>;
  /** Per-entry TTL in ms. Defaults to 7 days (matches `chat-core`). */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  logger?: Logger;
};

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function readFile(path: string): PersistedFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PersistedFile>;
    if (!raw || typeof raw !== 'object') return null;
    const entries: Record<string, PersistedEntry> = {};
    const source = raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
    for (const [key, value] of Object.entries(source)) {
      const entry = value as Partial<PersistedEntry> | null;
      if (!entry || typeof entry.value !== 'string') continue;
      entries[key] = { value: entry.value, touched: Number(entry.touched) || 0 };
    }
    return { settings: normalizeChatCacheSettings(raw.settings), entries };
  } catch {
    return null;
  }
}

export function createChatCacheStore(options: ChatCacheStoreOptions = {}): ChatCacheStore {
  const filePath = options.filePath ?? join(process.cwd(), 'chat-cache', 'chat-cache.json');
  const log = options.logger?.child('chat-cache');
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());

  const loaded = readFile(filePath);
  let settings: ChatCacheSettings = loaded
    ? loaded.settings
    : normalizeChatCacheSettings(options.settings);
  let entries: Record<string, PersistedEntry> = loaded?.entries ?? {};

  const persist = (): void => {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      // A JSONL-free single object keeps the read trivial; the bytes are bounded
      // by `enforceBudget` before every write, so this cannot grow unbounded.
      writeFileSync(filePath, JSON.stringify({ settings, entries }), 'utf8');
    } catch (err) {
      // A failed write must never throw into the chat path — the in-memory map
      // still serves this run.
      log?.warn('chat cache persist failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const isExpired = (entry: PersistedEntry, ts: number): boolean =>
    ttlMs > 0 && ts - entry.touched > ttlMs;

  let evictions = 0;

  /** Drop expired entries, then evict least-recently-touched until within budget. */
  const enforceBudget = (keepKey?: string): void => {
    const ts = now();
    const rows: Array<{ key: string; touched: number; bytes: number }> = [];
    for (const [key, entry] of Object.entries(entries)) {
      if (isExpired(entry, ts)) {
        evictions += 1;
        delete entries[key];
        continue;
      }
      rows.push({ key, touched: entry.touched, bytes: entry.value.length });
    }
    if (settings.maxBytes > 0) {
      const { kept, evicted } = selectChatCacheRetained(rows, settings.maxBytes, {
        keepKeys: keepKey ? [keepKey] : undefined,
      });
      if (evicted > 0) {
        evictions += evicted;
        const keep = new Set(kept.map((row) => row.key));
        for (const row of rows) {
          if (!keep.has(row.key)) delete entries[row.key];
        }
      }
    }
  };

  // Bound whatever was loaded from disk (the settings may have shrunk).
  const before = Object.keys(entries).length;
  enforceBudget();
  if (Object.keys(entries).length !== before) {
    persist();
    log?.info('chat cache trimmed on load', { entries: Object.keys(entries).length });
  }

  const store: ChatCacheStore = {
    get(key) {
      const entry = entries[key];
      if (!entry) return null;
      if (isExpired(entry, now())) {
        delete entries[key];
        persist();
        return null;
      }
      entry.touched = now();
      return entry.value;
    },
    set(key, value) {
      entries[key] = { value: String(value), touched: now() };
      enforceBudget(key);
      persist();
    },
    delete(key) {
      if (!(key in entries)) return;
      delete entries[key];
      persist();
    },
    keys: () => Object.keys(entries),
    clear() {
      entries = {};
      persist();
    },
    getSettings: () => ({ ...settings }),
    setSettings(patch) {
      settings = normalizeChatCacheSettings({ ...settings, ...patch });
      enforceBudget();
      persist();
      log?.info('chat cache settings updated', { settings });
      return { ...settings };
    },
    stats: () => ({
      bytes: Object.values(entries).reduce((sum, entry) => sum + entry.value.length, 0),
      maxBytes: settings.maxBytes,
      entries: Object.keys(entries).length,
      evictions,
    }),
    filePath: () => filePath,
  };

  return store;
}

/** On-disk size in bytes (0 when absent). Used by the settings UI display. */
export function chatCacheFileSize(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

export { DEFAULT_CHAT_CACHE_SETTINGS };
export type { ChatCacheSettings, ChatCacheStats };
