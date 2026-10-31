/**
 * Notification push bridge (main process).
 *
 * Region-node exposes a **device-scoped** ntfy topic via
 * `anx.notification.subscription.token` (`{ baseUrl, topic, token }`), and the
 * push payload carries an **opaque** `notificationId` — never content. This
 * module subscribes to that topic over SSE and, on every ping, asks the caller to
 * refresh the inbox + raise an OS card from the fetched row.
 *
 * Runs in the main process (Node), so it uses `fetch` streaming rather than the
 * renderer `EventSource`: the token is a bearer header and must never appear in a
 * URL, a log line, or the renderer.
 *
 * All networking is injectable so the SSE block parsing + reconnect policy are
 * unit-tested without a live ntfy.
 */

import type { InboxSender } from './notification-inbox.js';

const MIN_RECONNECT_MS = 3_000;
const MAX_RECONNECT_MS = 60_000;
/** A 5xx minting failure backs off for a while instead of hammering the region. */
const TOKEN_UNAVAILABLE_COOLDOWN_MS = 5 * 60_000;

export type PushPing = {
  /** Opaque id carried by a generic notification ping, when present. */
  notificationId: string | null;
  /** The raw `type` field, e.g. `notification`; null when the body was opaque. */
  type: string | null;
};

/** Injectable fetch stream pieces so the parser/policy are testable. */
export type SseFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
}>;

export type NotificationPushOptions = {
  getSender: () => Promise<InboxSender>;
  /** Called on every ping with the (possibly absent) opaque id. */
  onPing: (ping: PushPing) => void;
  /** Region command timeouts are irrelevant here; the default is fine. */
  fetchImpl?: SseFetch;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Suppress console output in tests. */
  logger?: { warn: (...args: unknown[]) => void };
};

export type NotificationPush = ReturnType<typeof createNotificationPush>;

/**
 * Extract the routing-relevant fields from one SSE `data:` payload.
 *
 * ntfy sends either a plain JSON object or (rarely) a bare string. The payload
 * is content-free by contract, so only ids/types are read — never logged.
 */
export function parsePushPayload(raw: string): PushPing | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'keepalive') return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      const id = typeof rec.notificationId === 'string' ? rec.notificationId : null;
      const type = typeof rec.type === 'string' ? rec.type : null;
      return { notificationId: id, type };
    }
    return { notificationId: null, type: null };
  } catch {
    // A non-JSON ping still counts as "something happened": refresh only.
    return { notificationId: null, type: null };
  }
}

/**
 * Split a growing SSE buffer into complete blocks, returning the blocks and the
 * unconsumed remainder. Blocks are separated by a blank line.
 */
export function splitSseBlocks(buffer: string): { blocks: string[]; rest: string } {
  const blocks: string[] = [];
  let rest = buffer;
  for (;;) {
    const sep = rest.indexOf('\n\n');
    if (sep < 0) break;
    blocks.push(rest.slice(0, sep));
    rest = rest.slice(sep + 2);
  }
  return { blocks, rest };
}

/** Read every `data:` line from one SSE block, joined (multi-line data). */
export function dataFromSseBlock(block: string): string {
  const lines = block.split('\n');
  const parts: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) parts.push(line.slice(5).replace(/^ /, ''));
  }
  return parts.join('\n');
}

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

export function createNotificationPush(options: NotificationPushOptions) {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as SseFetch);
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));

  let stopped = true;
  let starting = false;
  let controller: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let tokenUnavailableUntil = 0;

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    const exp = Math.min(MAX_RECONNECT_MS, MIN_RECONNECT_MS * Math.pow(2, reconnectAttempt));
    reconnectAttempt += 1;
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      void openConnection();
    }, exp);
  }

  function closeConnection(): void {
    if (controller) {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
      controller = null;
    }
  }

  async function openConnection(): Promise<void> {
    if (stopped) return;

    const wallClock = now();
    if (wallClock < tokenUnavailableUntil) {
      scheduleReconnect();
      return;
    }

    closeConnection();

    let subscription: { baseUrl?: string; topic?: string; token?: string };
    try {
      const sender = await options.getSender();
      const res = await sender.send('anx.notification.subscription.token', {});
      if (res.responseCode < 200 || res.responseCode >= 300) {
        if (res.responseCode >= 500) tokenUnavailableUntil = now() + TOKEN_UNAVAILABLE_COOLDOWN_MS;
        scheduleReconnect();
        return;
      }
      subscription = (res.responseObject ?? {}) as typeof subscription;
    } catch {
      // No session yet, or the region is unreachable: retry without logging the token.
      scheduleReconnect();
      return;
    }

    tokenUnavailableUntil = 0;
    const baseUrl = subscription.baseUrl;
    const topic = subscription.topic;
    const token = subscription.token;
    if (!baseUrl || !topic || !token) {
      scheduleReconnect();
      return;
    }

    const url = `${trimSlashes(baseUrl)}/${encodeURIComponent(topic)}/sse`;
    const abort = new AbortController();
    controller = abort;

    try {
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        closeConnection();
        scheduleReconnect();
        return;
      }

      reconnectAttempt = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (stopped) break;
        buffer += decoder.decode(value, { stream: true });
        const { blocks, rest } = splitSseBlocks(buffer);
        buffer = rest;
        for (const block of blocks) {
          const data = dataFromSseBlock(block);
          const ping = parsePushPayload(data);
          if (ping) options.onPing(ping);
        }
      }
    } catch {
      // Abort (stop) or transport failure: fall through to the reconnect policy.
    } finally {
      if (controller === abort) controller = null;
      if (!stopped) scheduleReconnect();
    }
  }

  return {
    /** Idempotent: start the subscription (no-op when already running). */
    async start(): Promise<void> {
      if (starting || !stopped) return;
      stopped = false;
      starting = true;
      try {
        await openConnection();
      } finally {
        starting = false;
      }
    },

    stop(): void {
      stopped = true;
      reconnectAttempt = 0;
      tokenUnavailableUntil = 0;
      if (reconnectTimer) {
        clearTimer(reconnectTimer);
        reconnectTimer = null;
      }
      closeConnection();
    },

    /** Whether a connection is believed live (for the settings/diagnostics UI). */
    isRunning(): boolean {
      return !stopped;
    },
  };
}
