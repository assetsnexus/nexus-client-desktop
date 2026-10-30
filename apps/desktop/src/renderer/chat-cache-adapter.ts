/**
 * Renderer-side `ChatCacheAdapter` backed by the main-process chat cache.
 *
 * The main process owns the byte bound + LRU; this is a thin IPC bridge that the
 * chat panel injects into `createNexusChat`. Every method is failure-tolerant:
 * a bridge that predates the feature (or a momentarily unavailable handler)
 * degrades to an in-memory no-op rather than throwing into the chat path, which
 * is exactly what `ChatCacheStore` expects (writes are quota-safe).
 */

import type { ChatCacheAdapter } from '@nexus/chat-core';
import { bridge, callBridge, hasBridgeMethod } from './bridge.js';

/** Fallback used when the running preload has no chat-cache channels yet. */
const memory = new Map<string, string>();

function available(): boolean {
  return hasBridgeMethod(bridge, 'chatCacheGet');
}

export function createDesktopChatCacheAdapter(): ChatCacheAdapter {
  return {
    async get(key) {
      if (!available()) return memory.get(key) ?? null;
      return (await callBridge<string | null>(bridge, 'chatCacheGet', null, key)) ?? null;
    },
    async set(key, value) {
      if (!available()) {
        memory.set(key, value);
        return;
      }
      await callBridge<void>(bridge, 'chatCacheSet', undefined, key, value);
    },
    async delete(key) {
      if (!available()) {
        memory.delete(key);
        return;
      }
      await callBridge<void>(bridge, 'chatCacheDelete', undefined, key);
    },
    async keys() {
      if (!available()) return [...memory.keys()];
      return (await callBridge<string[]>(bridge, 'chatCacheKeys', [])) ?? [];
    },
  };
}

/** Read cache stats for the settings panel (zeros when the preload is older). */
export async function readDesktopChatCacheStats() {
  return callBridge(bridge, 'chatCacheStats', {
    bytes: 0,
    maxBytes: 0,
    entries: 0,
    evictions: 0,
  });
}

/** Persist the byte cap; main re-trims and returns fresh stats. */
export async function setDesktopChatCacheMaxBytes(maxBytes: number) {
  return callBridge(bridge, 'chatCacheSetMaxBytes', {
    bytes: 0,
    maxBytes,
    entries: 0,
    evictions: 0,
  }, maxBytes);
}

/** Wipe every cached entry (logout / identity switch / "Clear cache"). */
export async function clearDesktopChatCache(): Promise<void> {
  await callBridge<void>(bridge, 'chatCacheClear', undefined);
}

export default createDesktopChatCacheAdapter;
