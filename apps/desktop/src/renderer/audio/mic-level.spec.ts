import { describe, expect, it, vi } from 'vitest';
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

/** Fake Web Audio: a stream, an analyser reporting a fixed level, and a timer. */
function makeFakeGlobals(level = 0.1) {
  const tracks = [{ stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  const analyser = {
    fftSize: 0,
    getFloatTimeDomainData: (buf: Float32Array) => buf.fill(level),
    disconnect: vi.fn(),
  };
  const context = {
    createMediaStreamSource: () => ({ connect: vi.fn() }),
    createAnalyser: () => analyser,
    close: vi.fn(),
  };
  const getUserMedia = vi.fn(async () => stream);
  return {
    tracks,
    globals: {
      navigator: { mediaDevices: { getUserMedia } },
      AudioContext: function AudioContextMock() {
        return context;
      } as unknown as new () => AudioContext,
    } as unknown as import('./mic-level.js').MicLevelGlobals,
    getUserMedia,
    context,
  };
}

describe('startMicLevel', () => {
  it('emits boosted levels on each tick and stops cleanly', async () => {
    const fake = makeFakeGlobals(0.1);
    let tick: (() => void) | null = null;
    const levels: number[] = [];
    const handle = await startMicLevel(
      { onLevel: (l) => levels.push(l) },
      {
        globals: fake.globals,
        setIntervalImpl: (fn) => {
          tick = fn;
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearIntervalImpl: vi.fn(),
      },
    );
    expect(handle.active).toBe(true);
    tick!();
    // 0.1 RMS boosted by displayLevel's 3.2 factor.
    expect(levels.at(-1)).toBeCloseTo(0.32);
    handle.stop();
    expect(handle.active).toBe(false);
    expect(fake.tracks[0]!.stop).toHaveBeenCalled();
  });

  it('requests a specific device when given one', async () => {
    const fake = makeFakeGlobals();
    await startMicLevel(
      { onLevel: vi.fn(), deviceId: 'mic-2' },
      { globals: fake.globals, setIntervalImpl: () => 1 as never, clearIntervalImpl: vi.fn() },
    );
    expect(fake.getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({ deviceId: { exact: 'mic-2' } }),
    });
  });

  it('degrades silently when the mic cannot open', async () => {
    const globals = {
      navigator: {
        mediaDevices: { getUserMedia: vi.fn(async () => { throw new Error('denied'); }) },
      },
      AudioContext: function AudioContextMock() {} as unknown as new () => AudioContext,
    } as unknown as import('./mic-level.js').MicLevelGlobals;
    const handle = await startMicLevel({ onLevel: vi.fn() }, { globals });
    expect(handle.active).toBe(false);
    expect(() => handle.stop()).not.toThrow();
  });
});
