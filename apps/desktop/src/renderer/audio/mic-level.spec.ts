import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The meter now rides the app's shared microphone stream graph (one
 * `getUserMedia` per device, shared with the wake detector + dictation) instead
 * of opening its own stream, so it is the *graph* — not `getUserMedia` — that is
 * faked here. `acquire` captures the subscriber so the test can push frames.
 */
const acquire = vi.fn();
vi.mock('../wake/mic-graph.js', () => ({
  micGraph: () => ({ acquire }),
}));

import {
  WAVEFORM_BUCKETS,
  displayLevel,
  emptyWaveform,
  pushWaveform,
  startMicLevel,
} from './mic-level.js';

describe('pushWaveform', () => {
  it('appends and clamps to 0..1', () => {
    expect(pushWaveform([0.1], 0.5)).toEqual([0.1, 0.5]);
    expect(pushWaveform([0.1], 2)[1]).toBe(1);
    expect(pushWaveform([0.1], -1)[1]).toBe(0);
    expect(pushWaveform([0.1], NaN)[1]).toBe(0);
  });

  it('keeps at most WAVEFORM_BUCKETS, dropping the oldest', () => {
    let wf = emptyWaveform();
    for (let i = 0; i < WAVEFORM_BUCKETS + 5; i++) wf = pushWaveform(wf, i / 100);
    expect(wf).toHaveLength(WAVEFORM_BUCKETS);
    expect(wf.at(-1)).toBeCloseTo((WAVEFORM_BUCKETS + 4) / 100);
  });

  it('does not mutate the previous waveform', () => {
    const prev = [0.2, 0.3];
    const next = pushWaveform(prev, 0.4);
    expect(prev).toEqual([0.2, 0.3]);
    expect(next).toEqual([0.2, 0.3, 0.4]);
  });
});

describe('displayLevel', () => {
  it('boosts quiet speech and clamps loud input', () => {
    expect(displayLevel(0)).toBe(0);
    expect(displayLevel(0.05)).toBeCloseTo(0.16);
    expect(displayLevel(1)).toBe(1);
  });
});

/** Fake the shared graph: capture the subscriber + the release spy. */
function makeFakeGraph(level = 0.1, active = true) {
  const release = vi.fn();
  let onFrame: ((frame: Float32Array) => void) | null = null;
  acquire.mockImplementation(async (opts: { onFrame: (frame: Float32Array) => void }) => {
    onFrame = opts.onFrame;
    return { sampleRate: 16_000, frameSamples: 512, active, release };
  });
  return {
    release,
    push: () => onFrame?.(new Float32Array(512).fill(level)),
    acquire,
  };
}

describe('startMicLevel', () => {
  beforeEach(() => {
    acquire.mockReset();
  });

  it('emits boosted levels on each tick and stops cleanly', async () => {
    const graph = makeFakeGraph(0.1);
    let tick: (() => void) | null = null;
    const levels: number[] = [];
    const handle = await startMicLevel(
      { onLevel: (l) => levels.push(l) },
      {
        setIntervalImpl: (fn) => {
          tick = fn;
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearIntervalImpl: vi.fn(),
      },
    );
    expect(handle.active).toBe(true);
    graph.push();
    tick!();
    // 0.1 RMS boosted by displayLevel's 3.2 factor.
    expect(levels.at(-1)).toBeCloseTo(0.32);
    handle.stop();
    expect(handle.active).toBe(false);
    expect(graph.release).toHaveBeenCalled();
  });

  it('requests a specific device (shared graph) when given one', async () => {
    const graph = makeFakeGraph();
    const handle = await startMicLevel(
      { onLevel: vi.fn(), deviceId: 'mic-2' },
      { setIntervalImpl: () => 1 as never, clearIntervalImpl: vi.fn() },
    );
    expect(graph.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'mic-2' }),
    );
    handle.stop();
  });

  it('degrades silently when the mic cannot open', async () => {
    const graph = makeFakeGraph(0.1, false);
    const handle = await startMicLevel({ onLevel: vi.fn() });
    expect(handle.active).toBe(false);
    expect(() => handle.stop()).not.toThrow();
    expect(graph.release).toHaveBeenCalled();
  });
});
