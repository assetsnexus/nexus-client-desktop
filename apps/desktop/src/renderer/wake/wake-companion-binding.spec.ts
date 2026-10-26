/**
 * Wake → companion binding spec (router + thread binding together).
 *
 * This mirrors the host wiring in `ChatHost` — `present()` binds the agent's
 * latest conversation and returns `{ dictate: true }`, `send()` addresses the
 * wake-bound thread — so the two bugs stay pinned end to end:
 *
 *  - BUG 1: a companion presentation must still start the continuous dictation
 *    capture (a `dictate: false` return aborted the router before any capture, so
 *    the companion opened with no STT ever running);
 *  - BUG 2: the send must carry the conversation the wake resumed, and a wake for
 *    an agent with history must not allocate a second conversation.
 */

import { describe, expect, it, vi } from 'vitest';
import { createWakeChatRouter } from './router.js';
import { bindWakeThread, resolveWakeSendConversationId } from './thread-binding.js';
import { DEFAULT_WAKE_SETTINGS, type WakeSettings } from '../../shared/wake.js';

const target = {
  agentId: 'agent-1',
  contactId: 'agent-1',
  agentName: 'Razail',
  phrase: 'Hey Razail',
};

function settings(over: Partial<WakeSettings> = {}): WakeSettings {
  return {
    ...DEFAULT_WAKE_SETTINGS,
    enabled: true,
    // A companion wake is dictation by default; `submit` is a spoken command.
    companionOnWake: true,
    reviewBeforeSend: false,
    submitPhrases: ['submit'],
    ...over,
  };
}

/**
 * Wire the router exactly as `ChatHost` does, given a fake chat controller whose
 * resume either finds an existing thread or (with `existing: false`) has none.
 */
function harness(input: {
  existing: boolean;
  dictateBursts: Array<string | null>;
}) {
  const conversationIdRef: { current: string | null } = { current: null };
  const created: string[] = [];
  const sent: Array<{ contactId: string; text: string; conversationId?: string }> = [];
  const presented: Array<{ mode: string; conversationId: string | null; dictate: boolean }> = [];
  let storeConversationId: string | null = null;

  const chat = {
    /** Pure lookup (`createIfMissing: false`) — must never mint a thread. */
    async openLatest(_contact: { id: string }, opts?: { createIfMissing?: boolean }) {
      if (input.existing) return { conversationId: 'thread-existing', created: false };
      return opts?.createIfMissing === false
        ? { conversationId: '', created: false }
        : { conversationId: 'thread-created', created: true };
    },
    async openContact() {
      // The resume-or-create fallback: one thread, exactly when none exists.
      created.push('openContact');
      return { conversationId: 'thread-created' };
    },
    getState: () => ({ conversationId: storeConversationId }),
  };

  const bursts = [...input.dictateBursts];
  const dictate = vi.fn(async (onPartial: (text: string) => void) => {
    const next = bursts.shift();
    if (next == null) return null;
    onPartial(next);
    return next;
  });

  const router = createWakeChatRouter({
    getSettings: () => settings(),
    transcriptionIsCloud: () => false,
    present: async (mode) => {
      // Same order as the host: bind first, then present, then ask for dictation.
      const binding = await bindWakeThread(chat, target.contactId);
      const conversationId = binding.conversationId ?? chat.getState().conversationId ?? null;
      if (conversationId) {
        conversationIdRef.current = conversationId;
        storeConversationId = conversationId;
      }
      presented.push({ mode, conversationId, dictate: true });
      return { dictate: true };
    },
    dictate,
    send: async ({ contactId, text }) => {
      sent.push({
        contactId,
        text,
        conversationId: resolveWakeSendConversationId(conversationIdRef.current, storeConversationId),
      });
    },
    enqueue: () => undefined,
    timeoutPollMs: 0,
  });

  return { router, presented, sent, created, dictate, conversationIdRef };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
/** The submit phrase sends from a `void` task, so give it a few macrotasks. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await flush();
};

describe('wake → companion binding', () => {
  it('resumes the latest thread, starts dictation, and sends to that thread', async () => {
    const h = harness({ existing: true, dictateBursts: ['hello there submit'] });
    await h.router.route(target);
    await settle();

    expect(h.presented).toEqual([
      { mode: 'companion', conversationId: 'thread-existing', dictate: true },
    ]);
    // BUG 1: the companion presentation must not skip the capture.
    expect(h.dictate).toHaveBeenCalled();
    // BUG 2: the send carries the resumed conversation, not nothing.
    expect(h.sent).toEqual([
      { contactId: 'agent-1', text: 'hello there', conversationId: 'thread-existing' },
    ]);
    // And no second thread was minted for an agent that already had one.
    expect(h.created).toEqual([]);
  });

  it('creates exactly one thread for an agent with no history and binds it', async () => {
    const h = harness({ existing: false, dictateBursts: ['first ever submit'] });
    await h.router.route(target);
    await settle();
    expect(h.presented[0]!.conversationId).toBe('thread-created');
    expect(h.sent).toEqual([
      { contactId: 'agent-1', text: 'first ever', conversationId: 'thread-created' },
    ]);
    // Exactly one allocation: the lookup found nothing, so the resume-or-create
    // fallback ran once — a wake never forks beyond that.
    expect(h.created).toEqual(['openContact']);
  });

  it('keeps the capture running across bursts until the submit phrase', async () => {
    const h = harness({ existing: true, dictateBursts: ['one', 'two submit', 'never used'] });
    await h.router.route(target);
    await settle();
    // Continuous local STT: the capture is re-entered for each burst and only
    // stops once the buffer matches a submit phrase (the third burst is unused).
    expect(h.dictate).toHaveBeenCalledTimes(2);
    expect(h.sent[0]?.text).toBe('one two');
  });

  it('remembers the bound thread for the session, not just the presentation', async () => {
    const h = harness({ existing: true, dictateBursts: ['spoken submit'] });
    await h.router.route(target);
    await settle();
    // `ChatHost.send` reads this ref, so a re-pointed chat store cannot make the
    // mirrored companion composer send into the wrong thread (or none).
    expect(h.conversationIdRef.current).toBe('thread-existing');
    expect(h.sent[0]?.conversationId).toBe('thread-existing');
  });
});
