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

  it('supersedes a lingering review session so a later wake still opens the agent', async () => {
    // The bug: the first session held the lock until its inactivity timeout, so
    // every wake in between was dropped and the agent window "only opened once".
    const h = makeRouter({
      getSettings: () => settings({ reviewBeforeSend: true, submitPhrases: ['submit'] }),
      dictate: scripted(['draft one submit', 'draft two submit']),
    });
    await h.router.route(target);
    await flush();
    expect(h.presented).toHaveLength(1);
    expect(h.router.getSession()?.status).toBe('review');
    // A second wake arrives while the review bar is still up: it must present.
    await h.router.route(target);
    await flush();
    expect(h.presented).toHaveLength(2);
  });

  it('ignores the same utterance arriving twice while a route is in flight', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const present = vi.fn(() => gate);
    const h = makeRouter({ present });
    const first = h.router.route(target);
    // Runs before `present` resolves, so this is the same wake on another mic.
    await h.router.route(target);
    release();
    await first;
    expect(present).toHaveBeenCalledTimes(1);
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

  it('routes to the companion window when companionOnWake is set, even in chat mode', async () => {
    const h = makeRouter({
      getSettings: () => settings({ activationMode: 'chat', companionOnWake: true }),
      transcriptionIsCloud: () => true,
      present: async (mode) => {
        h.presented.push({ mode, target: null });
        return { dictate: false };
      },
    });
    await h.router.route(target);
    await flush();
    // The one-click companion link wins over both the configured mode and the
    // cloud-forces-widget rule (the companion owns its own realtime voice).
    expect(h.presented[0]!.mode).toBe('companion');
  });

  it('delegates setBuffer to the live session', async () => {
    const gate: { resolve: (v: string | null) => void } = { resolve: () => {} };
    const dictate = vi.fn(
      () => new Promise<string | null>((resolve) => (gate.resolve = resolve)),
    );
    const h = makeRouter({
      getSettings: () => settings({ activationMode: 'widget', reviewBeforeSend: false }),
      dictate,
    });
    await h.router.route(target);
    await flush();
    h.router.setBuffer('typed instead');
    expect(h.router.getSession()?.buffer).toBe('typed instead');
    await h.router.submit();
    expect(h.sent).toEqual([{ contactId: 'contact-1', text: 'typed instead' }]);
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

  it('sends the recorded audio batch as a voice message and concludes the session', async () => {
    const sentAudio: Array<{ contactId: string }> = [];
    const h = makeRouter({
      getSettings: () => settings({ reviewBeforeSend: false, submitPhrases: [] }),
      dictate: scripted(['one two']),
      sendAudio: async (input) => {
        sentAudio.push(input);
        return true;
      },
    });
    await h.router.route(target);
    await flush();
    // The turn recorded audio in parallel with the transcript.
    expect(h.router.getSession()?.batchAvailable).toBe(false);
    await h.router.submitAudio();
    expect(sentAudio).toEqual([{ contactId: 'contact-1' }]);
    expect(h.sent).toEqual([]);
    expect(h.states[h.states.length - 1]).toBe('idle');
  });

  it('keeps the review surface when there was no audio to send', async () => {
    const h = makeRouter({
      getSettings: () => settings({ reviewBeforeSend: true, submitPhrases: ['submit'] }),
      dictate: scripted(['draft the reply submit']),
      sendAudio: async () => false,
    });
    await h.router.route(target);
    await flush();
    await h.router.submitAudio();
    expect(h.router.getSession()?.status).toBe('review');
    expect(h.sent).toEqual([]);
  });

  it('re-transcribes the retained audio and replaces the buffer for review', async () => {
    const retranscribe = vi.fn(async () => 'cloud heard this');
    const h = makeRouter({
      getSettings: () => settings({ reviewBeforeSend: true, submitPhrases: ['submit'] }),
      dictate: scripted(['bad local words submit']),
      retranscribe,
    });
    await h.router.route(target);
    await flush();
    expect(h.router.getSession()?.buffer).toBe('bad local words');
    await h.router.retranscribe();
    expect(retranscribe).toHaveBeenCalledTimes(1);
    expect(h.router.getSession()?.buffer).toBe('cloud heard this');
    await h.router.submit();
    expect(h.sent).toEqual([{ contactId: 'contact-1', text: 'cloud heard this' }]);
  });

  it('is a harmless no-op when retranscribe is not wired up', async () => {
    const h = makeRouter({
      getSettings: () => settings({ reviewBeforeSend: true, submitPhrases: ['submit'] }),
      dictate: scripted(['keep me submit']),
    });
    await h.router.route(target);
    await flush();
    await expect(h.router.retranscribe()).resolves.toBeUndefined();
    expect(h.router.getSession()?.buffer).toBe('keep me');
  });

  it('mirrors the parallel audio-batch progress into the session while capturing', async () => {
    vi.useFakeTimers();
    try {
      const h = makeRouter({
        getSettings: () => settings({ reviewBeforeSend: true, submitPhrases: [] }),
        dictate: scripted(['still talking']),
        batchProgress: () => ({ durationMs: 1_240, chunks: 2 }),
      });
      await h.router.route(target);
      await vi.advanceTimersByTimeAsync(300);
      // The router polls `batchProgress` on a 250ms timer, so the widget can show
      // "Audio batch · 1.2s recorded" while the user is still speaking.
      expect(h.router.getSession()?.batchDurationMs).toBe(1_240);
      expect(h.router.getSession()?.batchChunks).toBe(2);
      expect(h.router.getSession()?.batchAvailable).toBe(true);
      h.router.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
