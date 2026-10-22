/**
 * Wake-word voice-sample enrolment (renderer).
 *
 * The optional "record my own phrase" path: capture a short sample, decode it to
 * mono PCM on-device, and derive the compact non-invertible fingerprint the
 * custom-sample detector uses. Only the fingerprint is kept — raw audio is
 * discarded immediately and never leaves the machine.
 *
 * TRUST: enrolment is local-only. The returned fingerprint is a log-energy
 * envelope (non-invertible), stored in the wake settings; the recorded audio is
 * never uploaded, logged, or persisted.
 */

import type { UtteranceSource } from './dictation.js';

type DecodeGlobals = {
  AudioContext?: new () => AudioContext;
  webkitAudioContext?: new () => AudioContext;
};

type Fingerprint = {
  envelope: Float32Array;
  frames: number;
  sampleRate: number;
  hopSamples: number;
};

/** Lazily import `@nexus/wake-word` so it stays out of the default bundle. */
async function fingerprintPcm(
  pcm: Float32Array,
  opts: { sampleRate?: number; hopSamples?: number },
): Promise<Fingerprint> {
  const mod = (await import('@nexus/wake-word')) as {
    fingerprintPcm: (pcm: Float32Array, opts?: { sampleRate?: number; hopSamples?: number }) => Fingerprint;
  };
  return mod.fingerprintPcm(pcm, opts);
}

/** Encode a float32 envelope as little-endian base64 (matches the main decoder). */
export function encodeFingerprintEnvelope(envelope: Float32Array): string {
  const bytes = new Uint8Array(envelope.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < envelope.length; i++) view.setFloat32(i * 4, envelope[i]!, true);
  // `btoa` needs a binary string; chunk to avoid blowing the call stack.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode an audio blob to mono PCM at the context's native rate. */
export async function decodeToMono(blob: Blob): Promise<Float32Array> {
  const g = globalThis as unknown as DecodeGlobals;
  const Ctor = g.AudioContext || g.webkitAudioContext;
  if (!Ctor) throw new Error('Web Audio is unavailable for voice enrolment.');
  const context = new Ctor();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const channels = buffer.numberOfChannels;
    const length = buffer.length;
    const mono = new Float32Array(length);
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i]! += data[i]! / channels;
    }
    return mono;
  } finally {
    try {
      void context.close?.();
    } catch {
      /* ignore */
    }
  }
}

export type EnrollmentResult = {
  /** Base64 log-mel envelope to persist in `sampleFingerprint`. */
  fingerprint: string;
  frames: number;
  sampleRate: number;
  hopSamples: number;
};

/**
 * Record one sample from `source`, then fingerprint it. `stop` is called when the
 * caller finishes recording (e.g. the user releases the record button).
 */
export async function enrollFromCapture(
  blob: Blob,
  opts: { sampleRate?: number; hopSamples?: number } = {},
): Promise<EnrollmentResult | null> {
  const pcm = await decodeToMono(blob);
  if (!pcm.length) return null;
  const fp = await fingerprintPcm(pcm, opts);
  return {
    fingerprint: encodeFingerprintEnvelope(fp.envelope),
    frames: fp.frames,
    sampleRate: fp.sampleRate,
    hopSamples: fp.hopSamples,
  };
}

/**
 * A simple start/finish enrolment session for the settings UI: `start` opens the
 * microphone, `finish` stops it and returns the fingerprint (or null when the
 * recording was empty). Audio is decoded and discarded inside `finish`.
 */
export type EnrollmentSession = {
  finish: () => Promise<EnrollmentResult | null>;
  cancel: () => void;
};

export async function startEnrollment(source: UtteranceSource): Promise<EnrollmentSession> {
  const capture = await source.start(() => {});
  let settled = false;
  return {
    async finish() {
      if (settled) return null;
      settled = true;
      try {
        const blob = await capture.stop();
        if (!blob.size) return null;
        return await enrollFromCapture(blob);
      } catch {
        return null;
      }
    },
    cancel() {
      if (settled) return;
      settled = true;
      capture.cancel();
    },
  };
}
