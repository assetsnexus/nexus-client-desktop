/**
 * Wake-word live detection test (renderer).
 *
 * The settings panel needs a way to check that the microphone, the chosen model,
 * and the phrase actually work together *before* the user relies on them. This
 * module arms exactly the same detector the director would (`buildDetector` over a
 * resolved binding) against a local microphone and reports a live level + a
 * "would have fired" signal.
 *
 * It is deliberately separate from the director: a test must not register a
 * binding, must not report state to main, and must never route anywhere. It only
 * listens and lights up.
 *
 * TRUST: nothing here authenticates, dispatches, or leaves the machine. Audio is
 * never recorded or uploaded — frames go straight into an on-device detector.
 */

import type { WakeBindingResolution } from '../../shared/ipc.js';
import type { WakeWordBinding } from '../../shared/wake.js';
import { buildDetectorWithStt, type WakeDetector } from './engine.js';
import { createSttPhraseHub, type SttPhraseHub } from './stt-detector.js';
import { createWakeMic, type WakeMicSource } from './mic.js';

export type WakeLiveTestState = 'idle' | 'listening' | 'fired' | 'unavailable';

export type WakeLiveTest = {
  /** True while the test is actually listening. */
  readonly listening: boolean;
  /** Begin the test; resolves false when it could not arm. */
  start(): Promise<boolean>;
  stop(): Promise<void>;
};

export type WakeLiveTestOptions = {
  /** The phrase being tested (only used to resolve a binding). */
  phrase: string;
  /** The on-device model id to arm, or null for a model-less custom sample. */
  modelId: string | null;
  /** Detection sensitivity, matching the settings slider. */
  sensitivity: number;
  /** Live 0..1-ish input level for the meter. */
  onLevel?: (level: number) => void;
  /** State transitions (`fired` when the phrase was recognised). */
  onState?: (state: WakeLiveTestState) => void;
  /** Microphone source, injectable for tests. */
  createMic?: () => WakeMicSource;
  /** Detector builder, injectable for tests. */
  build?: (resolution: WakeBindingResolution) => Promise<WakeDetector | null>;
  /** Binding resolver, injectable for tests. */
  resolve?: (binding: unknown) => Promise<WakeBindingResolution | null>;
};

/** Build the synthetic binding the test resolves bytes for (never persisted). */
export function liveTestBinding(options: Pick<WakeLiveTestOptions, 'phrase' | 'modelId' | 'sensitivity'>) {
  return {
    id: `test:${options.phrase.trim().toLowerCase()}`,
    phrase: options.phrase.trim(),
    agentId: null,
    agentName: null,
    modelId: options.modelId,
    sensitivity: options.sensitivity,
    enabled: true,
    sampleRef: null,
    sampleFingerprint: null,
  };
}

export function createWakeLiveTest(options: WakeLiveTestOptions): WakeLiveTest {
  const mic = (options.createMic ?? (() => createWakeMic()))();
  // The test builds the same detector the director would: an STT-phrase binding
  // (a speech model chosen) gets a local hub, everything else a direct detector.
  const sttHubRef: { hub: SttPhraseHub | null } = { hub: null };
  const build =
    options.build ??
    ((resolution: WakeBindingResolution) =>
      buildDetectorWithStt(
        resolution,
        {
          // The live test drives a single microphone, so one hub is enough.
          getHub: (sampleRate) =>
            (sttHubRef.hub ??= createSttPhraseHub({
              sampleRate,
              transcribe: (pcm, rate) => {
                // Local-only via main; never the region (see wake-stt.ts).
                return import('../bridge.js').then(({ bridge }) =>
                  bridge.wakeTranscribeLocal({ pcm, sampleRate: rate }),
                );
              },
            })),
        },
        mic.sampleRate,
      ));
  // Imported lazily so this module stays importable outside a browser (tests,
  // SSR) — the bridge touches `window` at import time.
  const resolve =
    options.resolve ??
    (async (binding: unknown) => {
      const { bridge } = await import('../bridge.js');
      return bridge.wakeResolveBinding(binding as WakeWordBinding);
    });
  let detector: WakeDetector | null = null;
  let fired = false;

  const setState = (state: WakeLiveTestState) => options.onState?.(state);

  return {
    get listening() {
      return mic.active;
    },
    async start() {
      if (!options.phrase.trim()) return false;
      fired = false;
      const binding = liveTestBinding(options);
      const resolution = await resolve(binding).catch(() => null);
      if (!resolution || !resolution.armed) {
        setState('unavailable');
        return false;
      }
      detector = await build(resolution).catch(() => null);
      if (!detector || !detector.detecting) {
        detector = null;
        setState('unavailable');
        return false;
      }
      const started = await mic.start((frame) => {
        options.onLevel?.(frameLevel(frame));
        if (!detector || fired) return;
        try {
          const result = detector.push({ frame, at: Date.now() });
          if (result.fired) {
            fired = true;
            setState('fired');
          }
        } catch {
          // A detector must never crash the test loop.
        }
      });
      setState(started ? 'listening' : 'unavailable');
      if (started) sttHubRef.hub?.setSampleRate(mic.sampleRate);
      return started;
    },
    async stop() {
      mic.stop();
      sttHubRef.hub?.reset();
      detector?.dispose?.();
      detector = null;
      sttHubRef.hub = null;
      setState('idle');
    },
  };
}

/** Square-wave-ish level for the meter (mirrors the director's *3 boost). */
function frameLevel(frame: Float32Array): number {
  if (!frame.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  return Math.min(1, Math.sqrt(sum / frame.length) * 3);
}
