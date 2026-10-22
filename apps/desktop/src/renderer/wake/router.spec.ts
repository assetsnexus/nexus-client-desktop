import { describe, expect, it, vi } from 'vitest';
import { createWakeChatRouter } from './router.js';
import { DEFAULT_WAKE_SETTINGS } from '../../shared/wake.js';
import type { WakeSettings } from '../../shared/wake.js';
import type { QueuedUtterance } from '../../shared/wake.js';

const target = { agentId: 'contact-1', contactId: 'contact-1', agentName: 'Jarvis', phrase: 'Hey Jarvis' };

function settings(over: Partial<WakeSettings> = {}): WakeSettings {
  return { ...DEFAULT_WAKE_SETTINGS, enabled: true, ...over };
}

/** A dictation stub that resolves each scripted burst in turn and streams a partial. */
function scripted(script: Array<string | null>) {
  return vi.fn(async (onPartial: (text: string) => void) => {
    const next = script.shift();
    if (next == null) return null;
    onPartial(next.slice(0, Math.max(1, next.length - 1)));
    return next;
  });
}

function makeRouter(over: Partial<Parameters<typeof createWakeChatRouter>[0]> = {}) {
  const presented: Array<{ mode: string; target: unknown }> = [];
  const sent: Array<{ contactId: string; text: string }> = [];
  const queued: QueuedUtterance[] = [];
  const states: string[] = [];
  const sessions: unknown[] = [];
  const router = createWakeChatRouter({
    getSettings: () => settings({ reviewBeforeSend: false }),
    present: async (mode, t) => {
      presented.push({ mode, target: t });
    },
    dictate: scripted([]),
    send: async (input) => {
      sent.push(input);
    },
    enqueue: (entry) => {
      queued.push(entry);
    },
    onStateChange: (s) => states.push(s),
    onSessionChange: (s) => sessions.push(s),
    timeoutPollMs: 0,
    ...over,
  });
  return { router, presented, sent, queued, states, sessions };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createWakeChatRouter', () => {
  it('forces the visible widget (not the configured chat) when transcription is cloud', async () => {
    const h = makeRouter({
      getSettings: () => settings({ activationMode: 'chat', reviewBeforeSend: true }),
      transcriptionIsCloud: () => true,
      dictate: scripted(['hello there']),
    });
    await h.router.route(target);
    await flush();
    // The user asked for `chat`, but cloud audio must never be invisible.
    expect(h.presented[0]!.mode).toBe('widget');
    expect(h.sessions.some((s) => (s as { cloudTranscription?: boolean })?.cloudTranscription)).toBe(
      true,
    );
  });

  it('keeps the configured mode when transcription is on-device', async () => {
    const h = makeRouter({
      getSettings: () => settings({ activationMode: 'chat', reviewBeforeSend: true }),
      transcriptionIsCloud: () => false,
      dictate: scripted(['hello there']),
    });
    await h.router.route(target);
    await flush();
    expect(h.presented[0]!.mode).toBe('chat');
    const session = h.sessions.find(Boolean) as { cloudTranscription?: boolean };
    expect(session.cloudTranscription).toBe(false);
  });

  it('treats a failing cloud probe as on-device (no false streaming alarm)', async () => {
    const h = makeRouter({
      getSettings: () => settings({ activationMode: 'chat' }),
      transcriptionIsCloud: () => {
        throw new Error('capabilities unavailable');
      },
      dictate: scripted(['hi']),
    });
    await h.router.route(target);
    await flush();
    expect(h.presented[0]!.mode).toBe('chat');
  });

  it('presents for the configured mode and sends on a spoken submit phrase', async () => {
    const h = makeRouter({
      getSettings: () =>
        settings({ activationMode: 'widget', reviewBeforeSend: false, submitPhrases: ['submit'] }),
      dictate: scripted(['turn on the lights submit']),
    });
    await h.router.route(target);
    await flush();
    expect(h.presented[0]!.mode).toBe('widget');
    expect(h.sent).toEqual([{ contactId: 'contact-1', text: 'turn on the lights' }]);
    expect(h.states).toContain('sending');
  });

  it('does not send when nothing was heard', async () => {
    const h = makeRouter({ dictate: scripted([null]) });
    await h.router.route(target);
    await flush();
    expect(h.sent).toEqual([]);
  });

  it('keeps listening (no submit) until a manual submit', async () => {
    const h = makeRouter({
      getSettings: () => settings({ reviewBeforeSend: false, submitPhrases: [] }),
      dictate: scripted(['just some words']),
    });
    await h.router.route(target);
    await flush();
    expect(h.sent).toEqual([]);
    await h.router.submit();
    expect(h.sent).toEqual([{ contactId: 'contact-1', text: 'just some words' }]);
  });

  it('holds for review and sends only on an explicit submit', async () => {
    const h = makeRouter({
      getSettings: () => settings({ reviewBeforeSend: true, submitPhrases: ['submit'] }),
      dictate: scripted(['draft the reply submit']),
    });
    await h.router.route(target);
    await flush();
    expect(h.sent).toEqual([]);
    expect(h.states).toContain('review');
    await h.router.submit();
    expect(h.sent).toEqual([{ contactId: 'contact-1', text: 'draft the reply' }]);
  });

  it('passes the submit phrases from settings to the session', async () => {
    const h = makeRouter({
      getSettings: () =>
        settings({ reviewBeforeSend: true, submitPhrases: ['go now'] }),
      dictate: scripted(['file it go now']),
    });
    await h.router.route(target);
    await flush();
    await h.router.submit();
    expect(h.sent).toEqual([{ contactId: 'contact-1', text: 'file it' }]);
  });

  it('routes a name-addressed utterance to that agent', async () => {
    const h = makeRouter({
      getSettings: () => settings({ reviewBeforeSend: true, submitPhrases: ['submit'] }),
      listAgents: () => [
        { contactId: 'bob', name: 'Bob' },
        { contactId: 'nova', name: 'Nova' },
      ],
      dictate: scripted(['Bob, summarize it submit']),
    });
    await h.router.route(target);
    await flush();
    await h.router.submit();
    expect(h.sent[0]!.contactId).toBe('bob');
    expect(h.sent[0]!.text).toBe('summarize it');
  });

  it('queues an unsubmitted transcript on timeout under the queue policy', async () => {
    let clock = 1_000;
    const h = makeRouter({
      getSettings: () => settings({ unsentPolicy: 'queue', activationTimeoutSeconds: 10 }),
      dictate: scripted(['half a thought']),
      now: () => clock,
    });
    await h.router.route(target);
    await flush();
    await h.router.timeout(); // did not elapse -> no-op
    expect(h.queued).toEqual([]);
    clock += 10_000;
    await h.router.timeout();
    expect(h.queued).toHaveLength(1);
    expect(h.queued[0]).toMatchObject({ agentId: 'contact-1', text: 'half a thought' });
  });

  it('surfaces an error without throwing and releases the lock', async () => {
    const onError = vi.fn();
    const h = makeRouter({
      present: async () => {
        throw new Error('agent is unavailable');
      },
      onError,
    });
    await h.router.route(target);
    expect(onError).toHaveBeenCalledWith('agent is unavailable');
    // The lock was released: a second route is accepted.
    await h.router.route(target);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('ignores a second activation while one is in flight', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const present = vi.fn(() => gate);
    const h = makeRouter({ present });
    const first = h.router.route(target);
    await h.router.route({ ...target, contactId: 'other' });
    release();
    await first;
    expect(present).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight session and clears the surface', async () => {
    const h = makeRouter({ dictate: scripted(['never mind']) });
    await h.router.route(target);
    await flush();
    h.router.cancel();
    expect(h.sent).toEqual([]);
    expect(h.sessions[h.sessions.length - 1]).toBeNull();
  });

  it('reports the idle state once a session concludes', async () => {
    const h = makeRouter({ dictate: scripted(['done']) });
    await h.router.route(target);
    await flush();
    h.router.cancel();
    expect(h.states[h.states.length - 1]).toBe('idle');
  });

  it('skips dictation when the surface runs its own voice (companion)', async () => {
    const dictate = scripted(['never used']);
    const present = vi.fn(async () => ({ dictate: false }));
    const h = makeRouter({
      getSettings: () => settings({ activationMode: 'companion' }),
      present,
      dictate,
    });
    await h.router.route(target);
    await flush();
    expect(dictate).not.toHaveBeenCalled();
    expect(h.router.getSession()).toBeNull();
    // The lock is released so the next wake can route.
    await h.router.route(target);
    expect(present).toHaveBeenCalledTimes(2);
  });
});
