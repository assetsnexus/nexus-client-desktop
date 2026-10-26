/**
 * Wake thread binding spec.
 *
 * A wake must resume the agent's latest conversation, not mint a new one each
 * time — and it must never hand the session an empty address, which is what
 * surfaced to the user as "No conversation or room to send to". These specs pin
 * both halves: one thread resumed without ever reaching `create`, exactly one
 * created when none exists, and a send that carries the wake's conversation id.
 */

import { describe, expect, it, vi } from 'vitest';
import { bindWakeThread, resolveWakeSendConversationId } from './thread-binding.js';

/** A fake controller recording which resume/create call ran. */
function fakeChat(
  over: {
    latest?: { conversationId: string; created?: boolean } | Error;
    contact?: { conversationId?: string } | Error;
    storeConversationId?: string | null;
  } = {},
) {
  const calls: string[] = [];
  const openLatestOpts: Array<{ createIfMissing?: boolean } | undefined> = [];
  const openLatest = vi.fn(async (_contact: { id: string }, opts?: { createIfMissing?: boolean }) => {
    calls.push('openLatest');
    openLatestOpts.push(opts);
    if (over.latest instanceof Error) throw over.latest;
    return over.latest ?? { conversationId: 'thread-latest', created: false };
  });
  const openContact = vi.fn(async () => {
    calls.push('openContact');
    if (over.contact instanceof Error) throw over.contact;
    return over.contact ?? { conversationId: 'thread-created' };
  });
  return {
    calls,
    openLatest,
    openLatestOpts,
    openContact,
    chat: {
      openLatest,
      openContact,
      getState: () => ({ conversationId: over.storeConversationId ?? null }),
    },
  };
}

describe('bindWakeThread', () => {
  it('resumes the latest active conversation and never creates another', async () => {
    const h = fakeChat({ latest: { conversationId: 'thread-latest', created: false } });
    const binding = await bindWakeThread(h.chat, 'agent-1');
    expect(binding).toEqual({ conversationId: 'thread-latest', via: 'resume' });
    expect(h.calls).toEqual(['openLatest']);
    expect(h.openContact).not.toHaveBeenCalled();
  });

  it('looks the thread up without allowing a create', async () => {
    const h = fakeChat({ latest: { conversationId: 'thread-latest', created: false } });
    await bindWakeThread(h.chat, 'agent-1');
    // The resume must be a pure lookup: for an agent the viewer does not own, a
    // create from this path is denied and would fail the whole wake.
    expect(h.openLatestOpts).toEqual([{ createIfMissing: false }]);
  });

  it('binds through openContact (which creates the one thread) when there is none', async () => {
    const h = fakeChat({ latest: { conversationId: '', created: false } });
    const binding = await bindWakeThread(h.chat, 'agent-1');
    expect(binding).toEqual({ conversationId: 'thread-created', via: 'create' });
    expect(h.calls).toEqual(['openLatest', 'openContact']);
  });

  it('falls back to openContact (which resumes the same thread) when the lookup fails', async () => {
    const h = fakeChat({
      latest: new Error('conversations.list unavailable'),
      contact: { conversationId: 'thread-latest' },
    });
    const binding = await bindWakeThread(h.chat, 'agent-1');
    // Crucially: an address, not null — a bare `catch {}` here is what left the
    // companion unaddressed and produced the send preflight failure.
    expect(binding).toEqual({ conversationId: 'thread-latest', via: 'create' });
    expect(h.calls).toEqual(['openLatest', 'openContact']);
  });

  it('uses the store id when the fallback resolves nothing itself', async () => {
    const h = fakeChat({
      latest: new Error('boom'),
      contact: {},
      storeConversationId: 'thread-from-store',
    });
    const binding = await bindWakeThread(h.chat, 'agent-1');
    expect(binding.conversationId).toBe('thread-from-store');
  });

  it('returns no address when both paths fail instead of inventing an id', async () => {
    const h = fakeChat({ latest: new Error('a'), contact: new Error('b') });
    const binding = await bindWakeThread(h.chat, 'agent-1');
    expect(binding).toEqual({ conversationId: null, via: 'none' });
  });

  it('does not call the region for a blank contact', async () => {
    const h = fakeChat();
    expect(await bindWakeThread(h.chat, '   ')).toEqual({ conversationId: null, via: 'none' });
    expect(h.calls).toEqual([]);
  });
});

describe('resolveWakeSendConversationId', () => {
  it('prefers the wake-bound thread over a moved-on store', () => {
    expect(resolveWakeSendConversationId('thread-wake', 'thread-other')).toBe('thread-wake');
  });

  it('falls back to the store when the wake never bound one', () => {
    expect(resolveWakeSendConversationId(null, 'thread-store')).toBe('thread-store');
    expect(resolveWakeSendConversationId('   ', 'thread-store')).toBe('thread-store');
  });

  it('yields undefined (not an empty string) when neither is known', () => {
    expect(resolveWakeSendConversationId(null, null)).toBeUndefined();
    expect(resolveWakeSendConversationId(undefined, undefined)).toBeUndefined();
  });
});
