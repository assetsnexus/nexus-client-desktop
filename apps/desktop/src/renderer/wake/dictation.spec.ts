import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDictation, type DictationCapture, type UtteranceSource } from './dictation.js';

/** A scriptable utterance source: push levels, stop returns a fixed blob. */
function makeSource(opts: { blobSize?: number } = {}) {
  let onLevel: ((level: number) => void) | null = null;
  let cancelled = false;
  const capture: DictationCapture = {
    stop: vi.fn(async () => new Blob([new Uint8Array(opts.blobSize ?? 8)])),
    cancel: vi.fn(() => {
      cancelled = true;
    }),
  };
  const source = {
    start: vi.fn(async (handler) => {
      onLevel = handler;
      return capture;
    }),
  } satisfies UtteranceSource;
  return {
    source,
    capture,
    feed: (level: number) => onLevel?.(level),
    wasCancelled: () => cancelled,
  };
}

/** Let the microtask queue drain so async settle/transcribe steps run. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('runDictation', () => {
  afterEach(() => vi.useRealTimers());

  it('ends the turn on trailing silence and returns the transcript', async () => {
    const { source, feed } = makeSource();
    const transcribe = vi.fn(async () => 'hello there');
    const session = runDictation({ source, transcribe, frameMs: 100, silenceMs: 200 });

    await flush();
    feed(0.5); // speech
    feed(0.01); // silence 100
    feed(0.01); // silence 200 -> end
    await expect(session.done).resolves.toBe('hello there');
    expect(transcribe).toHaveBeenCalledOnce();
    expect(source.start).toHaveBeenCalledOnce();
  });

  it('gives up when no speech is heard', async () => {
    const { source, feed } = makeSource();
    const transcribe = vi.fn(async () => 'nope');
    const session = runDictation({ source, transcribe, noSpeechMs: 200, frameMs: 100 });
    await flush();
    feed(0);
    feed(0);
    await expect(session.done).resolves.toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('returns null when transcription recognises nothing', async () => {
    const { source, feed } = makeSource();
    const session = runDictation({
      source,
      transcribe: async () => '   ',
      frameMs: 100,
      silenceMs: 100,
    });
    await flush();
    feed(0.4);
    feed(0);
    await expect(session.done).resolves.toBeNull();
  });

  it('caps a long utterance at maxMs', async () => {
    const { source, feed } = makeSource();
    const session = runDictation({
      source,
      transcribe: async () => 'long',
      frameMs: 100,
      maxMs: 300,
      silenceMs: 10_000,
    });
    await flush();
    feed(0.5);
    feed(0.5);
    feed(0.5); // hits 300ms cap
    await expect(session.done).resolves.toBe('long');
  });

  it('cancels without transcribing', async () => {
    const { source, capture, wasCancelled } = makeSource();
    const transcribe = vi.fn(async () => 'x');
    const session = runDictation({ source, transcribe });
    await flush();
    session.cancel();
    await expect(session.done).resolves.toBeNull();
    expect(wasCancelled()).toBe(true);
    expect(transcribe).not.toHaveBeenCalled();
    void capture;
  });

  it('resolves null when the microphone cannot start', async () => {
    const source = { start: vi.fn(async () => Promise.reject(new Error('no mic'))) } satisfies UtteranceSource;
    const session = runDictation({ source, transcribe: async () => 'x' });
    await expect(session.done).resolves.toBeNull();
  });

  it('finish() transcribes immediately', async () => {
    const { source } = makeSource();
    const session = runDictation({ source, transcribe: async () => 'now' });
    await flush();
    session.finish();
    await expect(session.done).resolves.toBe('now');
  });
});
