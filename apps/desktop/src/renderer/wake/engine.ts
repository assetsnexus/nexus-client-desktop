/**
 * Renderer-side wake detector construction.
 *
 * `@nexus/wake-word` needs a Web Audio microphone path, which only exists in the
 * renderer, so detectors are built here rather than in main. Main supplies the
 * installed ONNX bytes (it owns the models directory) or the enrolled sample
 * fingerprint; this module turns them into a detector that the shared audio
 * director drives from one microphone stream.
 *
 * We deliberately build *detectors* (not full engines) because the director owns
 * a single microphone and feeds every armed binding from it — one engine per
 * binding would open one `getUserMedia` stream each.
 *
 * TRUST: this only constructs on-device detectors. It never authenticates and
 * never sends audio anywhere.
 */

import type { WakeBindingResolution } from '../../shared/ipc.js';
import {
  createSttPhraseDetector,
  type SttPhraseHub,
  type SttTranscribeFn,
} from './stt-detector.js';

/** Minimal detector surface from `@nexus/wake-word`. */
export type WakeDetector = {
  readonly id: string;
  /** True when this detector can genuinely fire (a stub is always false). */
  readonly detecting: boolean;
  reset(): void;
  push(input: { frame: Float32Array; at: number }): { fired: boolean; confidence: number | null };
  /** Release any shared resources (e.g. an STT-phrase subscription). */
  dispose?: () => void;
};

/** Minimal ONNX runtime surface `@nexus/wake-word` consumes. */
type OnnxRuntimeLike = {
  InferenceSession: {
    create(bytes: Uint8Array): Promise<{
      run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | number[] }>>;
    }>;
  };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
};

/** The subset of `@nexus/wake-word` the renderer uses. */
type WakeModule = {
  createOnnxDetector: (opts: {
    id: string;
    modelBytes: Uint8Array;
    runtime: unknown;
    threshold?: number;
  }) => WakeDetector;
  createCustomSampleDetector: (opts: {
    id?: string;
    fingerprint: { envelope: Float32Array; frames: number; sampleRate: number; hopSamples: number };
    threshold?: number;
  }) => WakeDetector;
  createStubDetector: (opts?: { id?: string }) => WakeDetector;
};

/** Lazily import the ONNX runtime; null when it is not installed. */
export async function loadOnnxRuntime(): Promise<OnnxRuntimeLike | null> {
  try {
    const mod = (await import('onnxruntime-web')) as unknown as OnnxRuntimeLike;
    return mod?.InferenceSession ? mod : null;
  } catch {
    return null;
  }
}

/** Lazily import `@nexus/wake-word`; null when it is not installed. */
export async function loadWakeModule(): Promise<WakeModule | null> {
  try {
    const mod = (await import('@nexus/wake-word')) as unknown as Partial<WakeModule>;
    return typeof mod?.createOnnxDetector === 'function' ? (mod as WakeModule) : null;
  } catch {
    return null;
  }
}

/** Map a 0..1 sensitivity onto a detector threshold (higher = easier to fire). */
export function sensitivityToThreshold(sensitivity: number, base: number): number {
  const s = Math.min(1, Math.max(0, sensitivity));
  return Math.min(0.99, Math.max(0.05, base - (s - 0.5) * 0.4));
}

function toFloat32(envelope: number[] | Float32Array, frames: number): Float32Array {
  if (envelope instanceof Float32Array) return envelope;
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = envelope[i] ?? 0;
  return out;
}

/**
 * Build a detector for one armed binding. Returns null when the required
 * artifact is missing (model not installed / runtime absent) or the package is
 * unavailable, so the caller shows an honest "not available" state.
 *
 * `buildDetector` has no `stt_phrase` branch on purpose: STT detection needs a
 * segmentation/transcription hub scoped to the microphone stream, so it is built
 * through {@link buildDetectorWithStt} with the per-stream hub the director owns.
 * Calling this with an `stt_phrase` resolution returns null rather than silently
 * degrading.
 */
export async function buildDetector(
  resolution: WakeBindingResolution,
): Promise<WakeDetector | null> {
  if (resolution.engineKind === 'stt_phrase') return null;
  const mod = await loadWakeModule();
  if (!mod) return null;
  const binding = resolution.binding;

  if (resolution.engineKind === 'custom_sample') {
    const wire = resolution.customSampleFingerprint;
    if (!wire || !wire.frames) return null;
    return mod.createCustomSampleDetector({
      id: `custom:${binding.id}`,
      fingerprint: {
        envelope: toFloat32(wire.envelope, wire.frames),
        frames: wire.frames,
        sampleRate: wire.sampleRate,
        hopSamples: wire.hopSamples,
      },
      threshold: sensitivityToThreshold(binding.sensitivity, 0.82),
    });
  }

  if (!resolution.modelBytes?.length) return null;
  const runtime = await loadOnnxRuntime();
  if (!runtime) return null;
  return mod.createOnnxDetector({
    id: `builtin:${binding.modelId ?? binding.id}`,
    modelBytes: resolution.modelBytes,
    runtime,
    threshold: sensitivityToThreshold(binding.sensitivity, 0.5),
  });
}

/**
 * STT-phrase detector construction, given a per-microphone hub.
 *
 * `getHub` returns the hub for the microphone stream the detector belongs to.
 * One hub segments and transcribes once per speech segment and dispatches to
 * every registered phrase, so auto-mapping many agents does not multiply the
 * transcription work. It must be scoped **per stream**: a hub holds one
 * segmentation buffer, and feeding it frames from several microphones would
 * interleave their audio into a corrupt segment that never transcribes.
 */
export type SttDetectorDeps = {
  getHub: (sampleRate: number, groupKey: string) => SttPhraseHub;
};

/**
 * Build a detector for a binding, using the shared STT hub for `stt_phrase`
 * bindings and delegating everything else to {@link buildDetector}. Returns null
 * when the binding cannot be armed (e.g. the hub cannot transcribe), so the
 * director shows an honest "not available" state instead of a dead listener.
 */
export async function buildDetectorWithStt(
  resolution: WakeBindingResolution,
  deps: SttDetectorDeps,
  sampleRate = 16_000,
  groupKey = 'primary',
): Promise<WakeDetector | null> {
  if (resolution.engineKind !== 'stt_phrase') return buildDetector(resolution);
  const phrase = resolution.binding.phrase?.trim();
  if (!phrase) return null;
  const hub = deps.getHub(sampleRate, groupKey);
  return createSttPhraseDetector({
    id: `stt:${resolution.binding.id}`,
    phrase,
    hub,
  });
}

/** Convenience: the transcribe function signature the hub expects. */
export type { SttTranscribeFn };
