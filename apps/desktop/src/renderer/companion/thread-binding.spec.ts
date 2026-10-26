/**
 * Companion thread binding spec.
 *
 * The companion owns its own chat controller, so a wake's `conversationId` only
 * becomes an address once this window's store points at it. `reopenConversation`
 * alone never did that (it only flips the server-side status), which is how the
 * composer ended up sending with no conversation/room/contact and the shared
 * client bailed with "No conversation or room to send to". These specs pin the
 * binding contract: resume the wake's thread, resume the latest one when the wake
 * carried none, and never fabricate an id.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  bindCompanionThread,
  toRehydratedTurns,
  type CompanionThreadChat,
} from './thread-binding.js';

function fakeChat(over: {
  bound?: string | null;
  messages?: unknown[] | Error;
  newest?: { conversationId?: string } | Error;
} = {}) {
  let bound = over.bound ?? null;
  const calls: string[] = [];
  const rehydrated: Array<{ rows: unknown[]; conversationId: string }> = [];
  const chat: CompanionThreadChat = {
    getState: () => ({ conversationId: bound }),
    reopenConversation: vi.fn(async (id: string) => {
      calls.push(`reopen:${id}`);
    }),
    listMessages: vi.fn(async () => {
      calls.push('listMessages');
      if (over.messages instanceof Error) throw over.messages;
      return over.messages ?? [{ id: 'm1', role: 'assistant', content: 'hi' }];
    }),
    rehydrateTurns: (rows, opts) => {
      calls.push('rehydrateTurns');
      rehydrated.push({ rows, conversationId: opts.conversationId });
      bound = opts.conversationId;
    },
    openContact: vi.fn(async () => {
      calls.push('openContact');
      if (over.newest instanceof Error) throw over.newest;
      const id = over.newest?.conversationId ?? 'thread-latest';
      bound = id;
      return { conversationId: id };
    }),
  };
  return { chat, calls, rehydrated, boundNow: () => bound };
}

describe('bindCompanionThread', () => {
  it("binds the wake's conversation (not a new one) and loads its turns", async () => {
    const h = fakeChat({ bound: null });
    const binding = await bindCompanionThread(h.chat, {
      contactId: 'agent-1',
      conversationId: 'thread-wake',
    });
    expect(binding).toMatchObject({ conversationId: 'thread-wake', via: 'resume', loaded: true });
    // Nothing minted a thread: no openContact, and the store now holds the wake's id.
    expect(h.chat.openContact).not.toHaveBeenCalled();
    expect(h.boundNow()).toBe('thread-wake');
    expect(h.rehydrated[0]!.conversationId).toBe('thread-wake');
    expect(h.calls).toContain('reopen:thread-wake');
  });

  it('skips the round-trip when the window is already bound to that thread', async () => {
    const h = fakeChat({ bound: 'thread-wake' });
    const binding = await bindCompanionThread(h.chat, {
      contactId: 'agent-1',
      conversationId: 'thread-wake',
    });
    expect(binding).toMatchObject({ conversationId: 'thread-wake', loaded: true });
    expect(h.calls).toEqual([]);
  });

  it("resumes the contact's latest thread when the wake carried no conversation", async () => {
    const h = fakeChat({ bound: null, newest: { conversationId: 'thread-latest' } });
    const binding = await bindCompanionThread(h.chat, { contactId: 'agent-1' });
    expect(binding).toMatchObject({ conversationId: 'thread-latest', via: 'resume', loaded: false });
    expect(h.calls).toEqual(['openContact']);
  });

  it('falls back to the latest thread when the wake thread cannot be read', async () => {
    const h = fakeChat({
      bound: null,
      messages: new Error('not readable'),
      newest: { conversationId: 'thread-latest' },
    });
    const binding = await bindCompanionThread(h.chat, {
      contactId: 'agent-1',
      conversationId: 'thread-gone',
    });
    // The composer must still have a real address rather than none.
    expect(binding.conversationId).toBe('thread-latest');
    expect(h.calls).toContain('openContact');
  });

  it('returns no address when nothing could be bound (never an invented id)', async () => {
    const h = fakeChat({
      bound: null,
      messages: new Error('nope'),
      newest: new Error('no contacts'),
    });
    await expect(
      bindCompanionThread(h.chat, { contactId: 'agent-1', conversationId: 'thread-gone' }),
    ).rejects.toThrow('no contacts');
  });
});

describe('toRehydratedTurns', () => {
  it('maps region message rows onto the rehydrate shape', () => {
    const rows = toRehydratedTurns([
      {
        id: 'm1',
        role: 'user',
        text: 'hello',
        createdAt: '2026-01-01T00:00:00.000Z',
        senderId: 'u1',
        toolCalls: [{ id: 't1' }],
      },
      { id: 'm2', role: 'weird', content: 'answer' },
    ]);
    expect(rows[0]).toMatchObject({ id: 'm1', role: 'user', content: 'hello', senderId: 'u1' });
    expect(rows[1]).toMatchObject({ id: 'm2', role: 'assistant', content: 'answer' });
    expect(toRehydratedTurns([])).toEqual([]);
    expect(toRehydratedTurns(null as unknown as unknown[])).toEqual([]);
  });
});
