import { describe, expect, it, vi } from 'vitest';
import { createWakeSession, type SessionState } from './session.js';
import type { QueuedUtterance } from './transcript.js';

/**
 * A scripted dictation source: each call to `dictate` resolves the next burst and
 * streams a partial first. `null` simulates a turn where nothing was heard.
 */
function scriptedDictation(script: Array<string | null>) {
  const calls: Array<(text: string) => void> = [];
  const dictate = vi.fn(async (onPartial: (text: string) => void) => {
    calls.push(onPartial);
    const next = script.shift();
    if (next === undefined || next === null) {
      onPartial('');
      return null;
    }
    onPartial(next.slice(0, Math.max(1, next.length - 1)));
    return next;
  });
  return { dictate, calls };
}

/** A short pause, well under the default 60s timeout. */
const shortPause = 5_000;

function makeSession(
  over: Partial<Parameters<typeof createWakeSession>[0]> = {},
  script: Array<string | null> = [],
) {
  let clock = 1_000;
  const queued: QueuedUtterance[] = [];
  const sent: Array<{ agentId: string | null; text: string }> = [];
  const states: SessionState[] = [];
  let idSeq = 0;
  const { dictate } = scriptedDictation(script);
  const session = createWakeSession({
    mode: 'chat',
    reviewBeforeSend: true,
    submitPhrases: ['submit'],
    unsentPolicy: 'discard',
    timeoutMs: 60_000,
    agents: [],
    dictate,
    send: async (input) => {
      sent.push(input);
    },
    enqueue: (entry) => {
      queued.push(entry);
    },
    onStateChange: (s) => states.push(s),
    now: () => clock,
    newId: () => `utt-${++idSeq}`,
    ...over,
  });
  return {
    session,
    queued,
    sent,
    states,
    dictate,
    advance: (ms: number) => {
      clock += ms;
    },
    last: () => states[states.length - 1]!,
  };
}

/** Let the microtask queue drain so the awaited dictation resolves. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createWakeSession', () => {
  it('sends immediately when review is off and a submit phrase is spoken', async () => {
    const h = makeSession({ reviewBeforeSend: false }, ['book a table submit']);
    h.session.start();
    await flush();
    expect(h.sent).toEqual([{ agentId: null, text: 'book a table' }]);
    expect(h.last().status).toBe('submitted');
  });

  it('holds for review when a submit phrase is spoken', async () => {
    const h = makeSession({}, ['book a table submit']);
    h.session.start();
    await flush();
    expect(h.sent).toEqual([]);
    expect(h.last().status).toBe('review');
    expect(h.last().buffer).toBe('book a table');
  });

  it('accumulates multiple bursts, streaming a live preview', async () => {
    const h = makeSession({}, ['first sentence', 'second sentence', 'and submit']);
    h.session.start();
    await flush();
    expect(h.sent).toEqual([]);
    expect(h.last().status).toBe('review');
    expect(h.last().buffer).toBe('first sentence second sentence and');
    // A partial was streamed for each burst before its final text landed.
    expect(h.states.some((s) => s.partial.length > 0)).toBe(true);
  });

  it('strips the submit phrase and keeps only the instruction', async () => {
    const h = makeSession({}, ['do the thing SUBMIT!']);
    h.session.start();
    await flush();
    expect(h.last().buffer).toBe('do the thing');
  });

  it('routes a name-addressed utterance to that agent', async () => {
    const h = makeSession(
      {
        agents: [
          { contactId: 'bob', name: 'Bob' },
          { contactId: 'nova', name: 'Nova' },
        ],
      },
      ['Bob, draft the email submit'],
    );
    h.session.start();
    await flush();
    expect(h.last().target.agentId).toBe('bob');
    expect(h.last().buffer).toBe('draft the email');
  });

  it('seeds the session target from the wake binding', async () => {
    const h = makeSession(
      { initialTarget: { agentId: 'a1', agentName: 'Jarvis', phrase: 'Hey Jarvis' } },
      ['half a thought'],
    );
    h.session.start();
    await flush();
    expect(h.last().target.agentId).toBe('a1');
  });

  it('submits the accumulated buffer on a manual submit', async () => {
    const h = makeSession({ reviewBeforeSend: false }, ['just some words']);
    h.session.start();
    await flush();
    // No submit phrase: the session keeps listening, so the buffer is held.
    expect(h.last().status).toBe('listening');
    expect(h.last().buffer).toBe('just some words');
    await h.session.submit();
    expect(h.sent).toEqual([{ agentId: null, text: 'just some words' }]);
  });

  it('discards an unsubmitted buffer on timeout under the discard policy', async () => {
    const h = makeSession({ unsentPolicy: 'discard' }, ['maybe later']);
    h.session.start();
    await flush();
    h.advance(60_000);
    await h.session.timeout();
    expect(h.queued).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.last().status).toBe('discarded');
  });

  it('queues an unsubmitted buffer on timeout under the queue policy', async () => {
    const h = makeSession({ unsentPolicy: 'queue' }, ['maybe later']);
    h.session.start();
    await flush();
    h.advance(60_000);
    await h.session.timeout();
    expect(h.queued).toHaveLength(1);
    expect(h.queued[0]).toMatchObject({ agentId: null, text: 'maybe later', id: 'utt-1' });
    expect(h.last().status).toBe('queued');
  });

  it('does not time out before the limit', async () => {
    const h = makeSession({ unsentPolicy: 'queue' }, ['still talking']);
    h.session.start();
    await flush();
    h.advance(shortPause);
    await h.session.timeout();
    expect(h.queued).toEqual([]);
    expect(h.last().status).not.toBe('queued');
  });

  it('never auto-sends on timeout, even with review off', async () => {
    const h = makeSession({ reviewBeforeSend: false, unsentPolicy: 'discard' }, ['half a thought']);
    h.session.start();
    await flush();
    h.advance(60_000);
    await h.session.timeout();
    expect(h.sent).toEqual([]);
    expect(h.last().status).toBe('discarded');
  });

  it('cancels without sending or queueing', async () => {
    const h = makeSession({ unsentPolicy: 'queue' }, ['never mind']);
    h.session.start();
    await flush();
    h.session.cancel();
    expect(h.sent).toEqual([]);
    expect(h.queued).toEqual([]);
    expect(h.last().status).toBe('discarded');
  });

  it('ends the session when a dictation turn hears nothing', async () => {
    const h = makeSession({}, [null]);
    h.session.start();
    await flush();
    expect(h.last().status).toBe('listening');
    expect(h.last().buffer).toBe('');
    // A later timeout discards the empty buffer.
    h.advance(60_000);
    await h.session.timeout();
    expect(h.queued).toEqual([]);
    expect(h.last().status).toBe('discarded');
  });

  it('surfaces a dictation failure as an error state', async () => {
    const h = makeSession({
      dictate: async () => {
        throw new Error('mic denied');
      },
    });
    h.session.start();
    await flush();
    expect(h.last().status).toBe('error');
    expect(h.last().message).toContain('mic denied');
  });

  it('folds the live partial into the buffer on submit (visible text is sent)', async () => {
    // A dictation turn that never resolves: only the partial is available, which
    // is exactly the widget case where the field showed text but Send was empty.
    const dictate = vi.fn(
      (onPartial: (text: string) => void) => new Promise<string | null>(() => onPartial('live partial')),
    );
    const h = makeSession({ reviewBeforeSend: false, dictate });
    h.session.start();
    await flush();
    expect(h.last().partial).toBe('live partial');
    expect(h.last().buffer).toBe('');
    await h.session.submit();
    expect(h.sent).toEqual([{ agentId: null, text: 'live partial' }]);
  });

  it('replaces the buffer with user-edited text and clears the partial', async () => {
    const h = makeSession({ reviewBeforeSend: false }, ['original words']);
    h.session.start();
    await flush();
    h.session.setBuffer('edited by hand');
    expect(h.last().buffer).toBe('edited by hand');
    expect(h.last().partial).toBe('');
    await h.session.submit();
    expect(h.sent).toEqual([{ agentId: null, text: 'edited by hand' }]);
  });

  it('ignores a submit on an already-completed session', async () => {
    const h = makeSession({ reviewBeforeSend: false }, ['go submit']);
    h.session.start();
    await flush();
    await h.session.submit();
    expect(h.sent).toHaveLength(1);
  });

  it('tracks the parallel audio batch and exposes it as available', async () => {
    const h = makeSession({}, ['one two']);
    h.session.start();
    await flush();
    expect(h.last().batchAvailable).toBe(false);
    h.session.setBatch({ durationMs: 1_480, chunks: 2 });
    expect(h.last().batchDurationMs).toBe(1_480);
    expect(h.last().batchChunks).toBe(2);
    expect(h.last().batchAvailable).toBe(true);
    // Empty progress is not offered as an audio message.
    h.session.setBatch({ durationMs: 0, chunks: 0 });
    expect(h.last().batchAvailable).toBe(false);
  });

  it('sends the recorded audio as a voice message and ends the session', async () => {
    const sendAudio = vi.fn(async () => true);
    const h = makeSession({ reviewBeforeSend: false, sendAudio }, ['one two']);
    h.session.start();
    await flush();
    h.session.setBatch({ durationMs: 900, chunks: 1 });
    await h.session.submitAudio();
    expect(sendAudio).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual([]);
    expect(h.last().status).toBe('submitted');
    expect(h.last().sendingAudio).toBe(false);
  });

  it('surfaces a no-audio send as a non-fatal message and keeps the turn open', async () => {
    const sendAudio = vi.fn(async () => false);
    const h = makeSession({ reviewBeforeSend: false, sendAudio }, ['one two']);
    h.session.start();
    await flush();
    await h.session.submitAudio();
    expect(h.last().status).not.toBe('submitted');
    expect(h.last().message).toBe('There was no audio to send.');
  });

  it('surfaces a failed audio send without throwing away the transcript path', async () => {
    const sendAudio = vi.fn(async () => {
      throw new Error('upload failed');
    });
    const h = makeSession({ reviewBeforeSend: false, sendAudio }, ['one two']);
    h.session.start();
    await flush();
    await h.session.submitAudio();
    expect(h.last().status).not.toBe('submitted');
    expect(h.last().message).toContain('upload failed');
  });

  it('re-transcribes over the retained audio and replaces the committed buffer', async () => {
    const retranscribe = vi.fn(async () => 'cloud heard this');
    const h = makeSession({ reviewBeforeSend: true, retranscribe }, ['bad local words submit']);
    h.session.start();
    await flush();
    expect(h.last().buffer).toBe('bad local words');
    await h.session.retranscribe();
    expect(retranscribe).toHaveBeenCalledTimes(1);
    expect(h.last().buffer).toBe('cloud heard this');
    expect(h.last().retranscribing).toBe(false);
    // Still editable then sendable.
    await h.session.submit();
    expect(h.sent).toEqual([{ agentId: null, text: 'cloud heard this' }]);
  });

  it('exposes a pending re-transcribe state while the cloud pass runs', async () => {
    let resolveText: (v: string | null) => void = () => {};
    const retranscribe = vi.fn(() => new Promise<string | null>((r) => (resolveText = r)));
    const h = makeSession({ reviewBeforeSend: true, retranscribe }, ['words submit']);
    h.session.start();
    await flush();
    const pending = h.session.retranscribe();
    expect(h.last().retranscribing).toBe(true);
    resolveText('done');
    await pending;
    expect(h.last().retranscribing).toBe(false);
    expect(h.last().buffer).toBe('done');
  });

  it('keeps the original text when the re-transcribe recognises nothing', async () => {
    const retranscribe = vi.fn(async () => null);
    const h = makeSession({ reviewBeforeSend: true, retranscribe }, ['keep me submit']);
    h.session.start();
    await flush();
    await h.session.retranscribe();
    expect(h.last().buffer).toBe('keep me');
    expect(h.last().message).toContain('keeping the transcript');
    expect(h.last().retranscribing).toBe(false);
  });

  it('keeps the original text when the re-transcribe fails', async () => {
    const retranscribe = vi.fn(async () => {
      throw new Error('region unreachable');
    });
    const h = makeSession({ reviewBeforeSend: true, retranscribe }, ['keep me submit']);
    h.session.start();
    await flush();
    await h.session.retranscribe();
    expect(h.last().buffer).toBe('keep me');
    expect(h.last().message).toContain('region unreachable');
    expect(h.last().retranscribing).toBe(false);
  });

  it('is a no-op when the session has no retranscribe hook', async () => {
    const h = makeSession({ reviewBeforeSend: true }, ['words submit']);
    h.session.start();
    await flush();
    await h.session.retranscribe();
    expect(h.last().buffer).toBe('words');
    expect(h.last().retranscribing).toBe(false);
  });

  it('does not re-transcribe while a capture turn is still in flight', async () => {
    const retranscribe = vi.fn(async () => 'nope');
    // A dictation turn that never resolves keeps the session in `listening`.
    const dictate = vi.fn(
      (onPartial: (text: string) => void) => new Promise<string | null>(() => onPartial('live')),
    );
    const h = makeSession({ reviewBeforeSend: false, dictate, retranscribe }, []);
    h.session.start();
    await flush();
    expect(h.last().status).toBe('listening');
    await h.session.retranscribe();
    expect(retranscribe).not.toHaveBeenCalled();
    expect(h.last().retranscribing).toBe(false);
  });

  it('ignores a re-transcribe on an already-completed session', async () => {
    const retranscribe = vi.fn(async () => 'nope');
    const h = makeSession({ reviewBeforeSend: false, retranscribe }, ['go submit']);
    h.session.start();
    await flush();
    await h.session.retranscribe();
    expect(retranscribe).not.toHaveBeenCalled();
  });
});
