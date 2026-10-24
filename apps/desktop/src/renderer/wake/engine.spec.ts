import { describe, expect, it, vi } from 'vitest';
import type { WakeBindingResolution } from '../../shared/ipc.js';
import { buildDetectorWithStt, type SttDetectorDeps } from './engine.js';
import type { SttPhraseHub } from './stt-detector.js';

function sttResolution(id: string, phrase: string): WakeBindingResolution {
  return {
    binding: {
      id,
      phrase,
      aliases: [],
      sensitivity: 0.5,
      enabled: true,
      agentId: null,
      agentName: null,
      modelId: null,
      sampleRef: null,
      sampleFingerprint: null,
    },
    engineKind: 'stt_phrase',
    armed: true,
    modelBytes: null,
    customSampleFingerprint: null,
    transcribeLocally: true,
    unavailableReason: null,
  };
}

/** A hub that records the phrases registered against it. */
function recordingHub() {
  const registered: string[] = [];
  const hub: SttPhraseHub = {
    get size() {
      return registered.length;
    },
    register(phrase) {
      registered.push(phrase);
      return {
        poll: () => ({ fired: false, confidence: null }),
        dispose: () => {
          const i = registered.indexOf(phrase);
          if (i >= 0) registered.splice(i, 1);
        },
      };
    },
    process: () => {},
    setSampleRate: () => {},
    reset: () => {},
  };
  return { hub, registered };
}

describe('buildDetectorWithStt', () => {
  it('scopes the hub per microphone stream, never sharing one buffer', async () => {
    const primary = recordingHub();
    const second = recordingHub();
    const hubs = new Map<string, SttPhraseHub>([
      ['primary', primary.hub],
      ['device:mic-2', second.hub],
    ]);
    const getHub = vi.fn((_rate: number, groupKey: string) => hubs.get(groupKey)!);
    const deps: SttDetectorDeps = { getHub };

    const a = await buildDetectorWithStt(sttResolution('a', 'hey bob'), deps, 16_000, 'primary');
    const b = await buildDetectorWithStt(sttResolution('a', 'hey bob'), deps, 16_000, 'device:mic-2');

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Each mic registered the phrase against its OWN hub...
    expect(primary.registered).toEqual(['hey bob']);
    expect(second.registered).toEqual(['hey bob']);
    // ...and the hub was requested with the stream key, not a shared singleton.
    expect(getHub.mock.calls.map((c) => c[1])).toEqual(['primary', 'device:mic-2']);
  });

  it('builds every stt_phrase detector against the same hub within one stream', async () => {
    const stream = recordingHub();
    const getHub = vi.fn((_rate: number, _groupKey: string) => stream.hub);
    const deps: SttDetectorDeps = { getHub };

    await buildDetectorWithStt(sttResolution('a', 'hey bob'), deps, 16_000, 'primary');
    await buildDetectorWithStt(sttResolution('b', 'hey eve'), deps, 16_000, 'primary');

    // One hub, both phrases: a single segmentation + transcription pass serves all.
    expect(stream.registered).toEqual(['hey bob', 'hey eve']);
    expect(getHub).toHaveBeenCalledTimes(2);
    expect(new Set(getHub.mock.calls.map((c) => c[1]))).toEqual(new Set(['primary']));
  });

  it('defaults to the primary stream when no group key is given', async () => {
    const stream = recordingHub();
    const getHub = vi.fn(() => stream.hub);
    await buildDetectorWithStt(sttResolution('a', 'hey bob'), { getHub });
    expect(getHub).toHaveBeenCalledWith(16_000, 'primary');
  });

  it('returns null for an stt_phrase binding with a blank phrase', async () => {
    const stream = recordingHub();
    const getHub = vi.fn(() => stream.hub);
    const detector = await buildDetectorWithStt(sttResolution('a', '   '), { getHub }, 16_000, 'primary');
    expect(detector).toBeNull();
    expect(stream.registered).toEqual([]);
  });
});
