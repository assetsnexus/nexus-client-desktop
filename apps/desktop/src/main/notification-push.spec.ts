import { describe, expect, it, vi } from 'vitest';
import {
  createNotificationPush,
  dataFromSseBlock,
  parsePushPayload,
  splitSseBlocks,
} from './notification-push.js';
import type { InboxSender } from './notification-inbox.js';

const encoder = new TextEncoder();

/** A fake SSE response that yields the given chunks then ends. */
function sseResponse(chunks: string[], opts: { ok?: boolean; status?: number } = {}) {
  let i = 0;
  const body = {
    getReader() {
      return {
        async read() {
          if (i >= chunks.length) return { done: true as const };
          const value = encoder.encode(chunks[i++]);
          return { done: false as const, value };
        },
      };
    },
  };
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    body: body as never,
  };
}

function senderFor(subscription: Record<string, unknown>) {
  const sent: string[] = [];
  const sender: InboxSender = {
    async send(command) {
      sent.push(command);
      return { responseCode: 200, responseObject: subscription };
    },
  };
  return { sender, sent };
}

const silent = { warn: vi.fn() };

describe('parsePushPayload', () => {
  it('reads the opaque notificationId and type', () => {
    expect(parsePushPayload(JSON.stringify({ action: 'poll', type: 'notification', notificationId: 'n1' }))).toEqual({
      notificationId: 'n1',
      type: 'notification',
    });
  });

  it('returns a content-free ping for a non-JSON body', () => {
    expect(parsePushPayload('something happened')).toEqual({ notificationId: null, type: null });
    expect(parsePushPayload('')).toBeNull();
    expect(parsePushPayload('keepalive')).toBeNull();
  });

  it('treats a bare JSON scalar as an empty ping', () => {
    expect(parsePushPayload('42')).toEqual({ notificationId: null, type: null });
  });
});

describe('SSE block framing', () => {
  it('splits complete blocks and keeps the remainder', () => {
    const { blocks, rest } = splitSseBlocks('data: a\n\ndata: b\n\ndata: partial');
    expect(blocks).toEqual(['data: a', 'data: b']);
    expect(rest).toBe('data: partial');
  });

  it('joins multi-line data fields', () => {
    expect(dataFromSseBlock('event: message\ndata: {"a":1,\ndata: "b":2}')).toBe('{"a":1,\n"b":2}');
  });
});

describe('createNotificationPush', () => {
  it('fetches the subscription token and pings on each SSE data block', async () => {
    const pings: Array<{ notificationId: string | null }> = [];
    const { sender } = senderFor({ baseUrl: 'https://push.example.com/ntfy', topic: 'dev-1', token: 'tok' });
    const push = createNotificationPush({
      getSender: async () => sender,
      onPing: (p) => pings.push(p),
      fetchImpl: async () =>
        sseResponse([
          'data: {"action":"poll","type":"notification","notificationId":"n1"}\n\n',
          'data: {"action":"poll","type":"notification","notificationId":"n2"}\n\n',
        ]),
      logger: silent,
    });
    await push.start();
    // The stream ends -> a reconnect is scheduled; wait a microtask so the pings flush.
    await Promise.resolve();
    expect(pings.map((p) => p.notificationId)).toEqual(['n1', 'n2']);
    push.stop();
    expect(push.isRunning()).toBe(false);
  });

  it('sends the bearer token as a header, never in the URL', async () => {
    const urls: string[] = [];
    const headers: Array<Record<string, string>> = [];
    const { sender } = senderFor({ baseUrl: 'https://push.example.com', topic: 'dev-1', token: 'secret-token' });
    const push = createNotificationPush({
      getSender: async () => sender,
      onPing: () => undefined,
      fetchImpl: async (url, init) => {
        urls.push(url);
        headers.push(init.headers);
        return sseResponse([]);
      },
      logger: silent,
    });
    await push.start();
    push.stop();
    expect(urls[0]).toBe('https://push.example.com/dev-1/sse');
    expect(urls[0]).not.toContain('secret-token');
    expect(headers[0].Authorization).toBe('Bearer secret-token');
  });

  it('does nothing when the subscription response is missing fields', async () => {
    const onPing = vi.fn();
    const { sender } = senderFor({ topic: 'dev-1' });
    const push = createNotificationPush({
      getSender: async () => sender,
      onPing,
      fetchImpl: async () => sseResponse([]),
      logger: silent,
    });
    await push.start();
    push.stop();
    expect(onPing).not.toHaveBeenCalled();
  });

  it('is idempotent and reconnect-safe on stop', async () => {
    const { sender } = senderFor({ baseUrl: 'https://push.example.com', topic: 'dev-1', token: 'tok' });
    const push = createNotificationPush({
      getSender: async () => sender,
      onPing: () => undefined,
      fetchImpl: async () => sseResponse([]),
      logger: silent,
    });
    await push.start();
    await push.start();
    push.stop();
    push.stop();
    expect(push.isRunning()).toBe(false);
  });
});
