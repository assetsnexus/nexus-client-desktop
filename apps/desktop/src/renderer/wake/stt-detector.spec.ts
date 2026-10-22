import { describe, expect, it, vi } from 'vitest';
import { createSttPhraseDetector, createSttPhraseHub } from './stt-detector.js';

/** Feed `frames` of a constant amplitude through the hub/one detector. */
function feed(
  push: (frame: Float32Array, at: number) => { fired: boolean; confidence: number | null },
  opts: { frames: number; amplitude: number; size?: number; startAt?: number },
): { fired: boolean; confidence: number | null } {
  const size = opts.size ?? 512;
  let fired = false;
  let confidence: number | null = null;
  for (let i = 0; i < opts.frames; i++) {
    const frame = new Float32Array(size).fill(opts.amplitude);
    const result = push(frame, (opts.startAt ?? 0) + i * 20);
    if (result.fired) {
      fired = true;
      confidence = result.confidence;
    }
  }
  return { fired, confidence };
}

describe('createSttPhraseHub', () => {
  it('transcribes a speech segment and fires the addressed phrase', async () => {
    const transcribe = vi.fn(async () => 'Bob, do this');
    const hub = createSttPhraseHub({ transcribe, sampleRate: 16_000 });
    const det = createSttPhraseDetector({ phrase: 'bob', hub });

    // Speech, then trailing silence to close the segment.
    feed((f, at) => det.push({ frame: f, at }), { frames: 30, amplitude: 0.2 });
    feed((f, at) => det.push({ frame: f, at }), { frames: 30, amplitude: 0, startAt: 1000 });
    // The transcription is async; give the microtask queue a turn.
    await Promise.resolve();
    await Promise.resolve();

    expect(transcribe).toHaveBeenCalledTimes(1);
    const result = feed((f, at) => det.push({ frame: f, at }), { frames: 1, amplitude: 0, startAt: 5000 });
    expect(result.fired).toBe(true);
  });

  it('does not fire for an unrelated transcript', async () => {
    const transcribe = vi.fn(async () => 'totally unrelated speech');
    const hub = createSttPhraseHub({ transcribe, sampleRate: 16_000 });
    const det = createSttPhraseDetector({ phrase: 'bob', hub });

    feed((f, at) => det.push({ frame: f, at }), { frames: 30, amplitude: 0.2 });
    feed((f, at) => det.push({ frame: f, at }), { frames: 30, amplitude: 0, startAt: 1000 });
    await Promise.resolve();
    await Promise.resolve();

    const result = feed((f, at) => det.push({ frame: f, at }), { frames: 5, amplitude: 0, startAt: 5000 });
    expect(result.fired).toBe(false);
  });

  it('never transcribes silence-only audio', async () => {
    const transcribe = vi.fn(async () => 'should not be called');
    const hub = createSttPhraseHub({ transcribe, sampleRate: 16_000 });
    const det = createSttPhraseDetector({ phrase: 'bob', hub });

    feed((f, at) => det.push({ frame: f, at }), { frames: 200, amplitude: 0 });
    await Promise.resolve();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('transcribes once per segment for many phrases (shared hub)', async () => {
    const transcribe = vi.fn(async () => 'hey bob please');
    const hub = createSttPhraseHub({ transcribe, sampleRate: 16_000 });
    const detectors = ['bob', 'alice', 'carol'].map((phrase) =>
      createSttPhraseDetector({ phrase, hub }),
    );
    expect(hub.size).toBe(3);

    // The director feeds the same frame to every armed detector.
    const pushAll = (frame: Float32Array, at: number) =>
      detectors.map((d) => d.push({ frame, at }));
    const anyFired = (results: { fired: boolean }[]) => results.some((r) => r.fired);

    for (let i = 0; i < 30; i++) {
      pushAll(new Float32Array(512).fill(0.2), i * 20);
    }
    for (let i = 0; i < 30; i++) {
      pushAll(new Float32Array(512).fill(0), 1000 + i * 20);
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(transcribe).toHaveBeenCalledTimes(1);
    // Only the addressed phrase ('bob') fires.
    expect(anyFired(pushAll(new Float32Array(512).fill(0), 5000))).toBe(true);
  });

  it('segments a frame once even when many detectors see it', async () => {
    const transcribe = vi.fn(async () => 'nothing relevant');
    const hub = createSttPhraseHub({ transcribe, sampleRate: 16_000 });
    const detectors = ['a', 'b', 'c', 'd'].map((p) => createSttPhraseDetector({ phrase: p, hub }));

    // The SAME frame object is pushed to every detector (as the director does).
    const frame = new Float32Array(512).fill(0.2);
    for (const d of detectors) d.push({ frame, at: 0 });
    // With the de-dup guard, total buffered audio equals ONE frame, not four, so
    // a single following silence closes a very short segment that is discarded
    // by the min-length rule — no transcription for 4x-duplicated audio.
    const silence = new Float32Array(512).fill(0);
    for (let i = 0; i < 60; i++) for (const d of detectors) d.push({ frame: silence, at: 100 + i * 20 });
    await Promise.resolve();
    await Promise.resolve();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('dispose() removes a phrase from the hub', () => {
    const hub = createSttPhraseHub({ transcribe: async () => null, sampleRate: 16_000 });
    const det = createSttPhraseDetector({ phrase: 'bob', hub });
    expect(hub.size).toBe(1);
    det.dispose();
    expect(hub.size).toBe(0);
  });

  it('survives a transcription failure without crashing', async () => {
    const onError = vi.fn();
    const transcribe = vi.fn(async () => {
      throw new Error('local server down');
    });
    const hub = createSttPhraseHub({ transcribe, sampleRate: 16_000, onError });
    const det = createSttPhraseDetector({ phrase: 'bob', hub });

    feed((f, at) => det.push({ frame: f, at }), { frames: 30, amplitude: 0.2 });
    feed((f, at) => det.push({ frame: f, at }), { frames: 30, amplitude: 0, startAt: 1000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalled();
    expect(feed((f, at) => det.push({ frame: f, at }), { frames: 1, amplitude: 0 }).fired).toBe(false);
  });

  it('honours setSampleRate so segment timing stays honest', async () => {
    const transcribe = vi.fn(async () => 'bob');
    const hub = createSttPhraseHub({ transcribe, sampleRate: 16_000 });
    const det = createSttPhraseDetector({ phrase: 'bob', hub });
    hub.setSampleRate(8_000);

    // At 8 kHz, 512-sample frames are 64 ms each, so 8 frames (>300 ms min)
    // already counts as a segment once silenced.
    feed((f, at) => det.push({ frame: f, at }), { frames: 8, amplitude: 0.2 });
    feed((f, at) => det.push({ frame: f, at }), { frames: 10, amplitude: 0, startAt: 1000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(transcribe).toHaveBeenCalled();
  });
});
