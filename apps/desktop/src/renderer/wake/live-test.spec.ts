import { describe, expect, it, vi } from 'vitest';
import { createWakeLiveTest, liveTestBinding } from './live-test.js';
import type { WakeDetector } from './engine.js';
import type { WakeMicSource } from './mic.js';
import type { WakeBindingResolution } from '../../shared/ipc.js';

function makeMic() {
  let handler: ((frame: Float32Array) => void) | null = null;
  let active = false;
  const mic: WakeMicSource & { feed: (rms: number) => void } = {
    get active() {
      return active;
    },
    message: null,
    sampleRate: 16_000,
    async start(next) {
      handler = next;
      active = true;
      return true;
    },
    stop() {
      active = false;
      handler = null;
    },
    feed(rms) {
      handler?.(new Float32Array(64).fill(rms));
    },
  };
  return mic;
}

/** A detector that fires on a loud frame, like the real one but deterministic. */
function loudDetector(): WakeDetector {
  return {
    id: 'test',
    detecting: true,
    reset: vi.fn(),
    push: ({ frame }) => ({ fired: frame.some((v) => v > 0.8), confidence: 0.9 }),
  };
}

function resolution(): WakeBindingResolution {
  return {
    binding: liveTestBinding({ phrase: 'Hey Jarvis', modelId: 'catalog:x', sensitivity: 0.5 }),
    engineKind: 'builtin',
    armed: true,
    modelBytes: new Uint8Array([1]),
    customSampleFingerprint: null,
    transcribeLocally: false,
    unavailableReason: null,
  };
}

describe('liveTestBinding', () => {
  it('builds a stable, unpersisted binding for the tested phrase', () => {
    const b = liveTestBinding({ phrase: '  Hey Jarvis ', modelId: 'catalog:x', sensitivity: 0.4 });
    expect(b.id).toBe('test:hey jarvis');
    expect(b.phrase).toBe('Hey Jarvis');
    expect(b.agentId).toBeNull();
    expect(b.enabled).toBe(true);
  });
});

describe('createWakeLiveTest', () => {
  it('refuses to arm without a phrase', async () => {
    const test = createWakeLiveTest({ phrase: '   ', modelId: 'catalog:x', sensitivity: 0.5 });
    expect(await test.start()).toBe(false);
  });

  it('reports unavailable when the binding cannot be armed', async () => {
    const onState = vi.fn();
    const test = createWakeLiveTest({
      phrase: 'Hey Jarvis',
      modelId: null,
      sensitivity: 0.5,
      createMic: () => makeMic(),
      onState,
      resolve: async () => null,
    });
    expect(await test.start()).toBe(false);
    expect(onState).toHaveBeenCalledWith('unavailable');
  });

  it('lights up when the detector fires', async () => {
    const mic = makeMic();
    const onState = vi.fn();
    const levels: number[] = [];
    const test = createWakeLiveTest({
      phrase: 'Hey Jarvis',
      modelId: 'catalog:x',
      sensitivity: 0.5,
      createMic: () => mic,
      build: async () => loudDetector(),
      resolve: async () => resolution(),
      onState,
      onLevel: (l) => levels.push(l),
    });
    expect(await test.start()).toBe(true);
    expect(test.listening).toBe(true);
    expect(onState).toHaveBeenCalledWith('listening');
    mic.feed(0.9);
    expect(onState).toHaveBeenCalledWith('fired');
    expect(levels.length).toBeGreaterThan(0);
    await test.stop();
    expect(test.listening).toBe(false);
  });

  it('does not fire twice for one utterance', async () => {
    const mic = makeMic();
    const onState = vi.fn();
    const test = createWakeLiveTest({
      phrase: 'Hey Jarvis',
      modelId: 'catalog:x',
      sensitivity: 0.5,
      createMic: () => mic,
      build: async () => loudDetector(),
      resolve: async () => resolution(),
      onState,
    });
    await test.start();
    mic.feed(0.9);
    mic.feed(0.9);
    expect(onState.mock.calls.filter(([s]) => s === 'fired')).toHaveLength(1);
  });

  it('reports unavailable when no detector can be built', async () => {
    const onState = vi.fn();
    const test = createWakeLiveTest({
      phrase: 'Hey Jarvis',
      modelId: 'catalog:x',
      sensitivity: 0.5,
      createMic: () => makeMic(),
      build: async () => null,
      resolve: async () => resolution(),
      onState,
    });
    expect(await test.start()).toBe(false);
    expect(onState).toHaveBeenCalledWith('unavailable');
  });
});
