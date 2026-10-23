/**
 * Live microphone level meter (renderer).
 *
 * Powers the bottom-bar soundwave: a short ring buffer of recent RMS levels so
 * the UI can draw a scrolling waveform, not just a single bar. Deliberately
 * separate from the wake director — the meter must work even when wake listening
 * is off — and dependency-injected so its buffering / smoothing / gating is
 * unit-testable without a microphone.
 *
 * TRUST: this never records to disk and never sends audio anywhere; it only
 * derives a level for display and holds the newest numbers in memory.
 */

import { frameRms } from '../wake/mic.js';

/** Number of samples kept for the scrolling waveform. */
export const WAVEFORM_BUCKETS = 32;

/** A fixed-length ring of recent levels (0..1), newest last. */
export type Waveform = number[];

/** Append a level, keeping at most `WAVEFORM_BUCKETS` entries. Pure. */
export function pushWaveform(prev: Waveform, level: number): Waveform {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
  const next = prev.length >= WAVEFORM_BUCKETS ? prev.slice(prev.length - WAVEFORM_BUCKETS + 1) : prev.slice();
  next.push(clamped);
  return next;
}

/** All-zero waveform (silence) for the initial state. */
export function emptyWaveform(): Waveform {
  return new Array<number>(WAVEFORM_BUCKETS).fill(0);
}

/**
 * Emphasise quiet speech for display: a raw RMS of ~0.05 is "someone talking" but
 * nearly invisible on a bar chart, so scale with a soft knee and clamp to 1.
 */
export function displayLevel(rms: number): number {
  const boosted = rms * 3.2;
  return Math.min(1, Math.max(0, boosted));
}

export type MicLevelHandle = {
  stop(): void;
  readonly active: boolean;
};

export type MicLevelOptions = {
  /** Called with each new level (0..1) as it is measured. */
  onLevel: (level: number) => void;
  /** Input device to meter; `null` = OS default. */
  deviceId?: string | null;
  /** Frames per second (default 30). */
  framesPerSecond?: number;
};

/** Minimal Web Audio surface used here (injectable for tests). */
export type MicLevelGlobals = {
  navigator?: { mediaDevices?: { getUserMedia?: (c: Record<string, unknown>) => Promise<MediaStream> } };
  AudioContext?: new () => AudioContext;
  webkitAudioContext?: new () => AudioContext;
};

export type MicLevelDeps = {
  globals?: MicLevelGlobals;
  /** Injectable analyser interval for tests. */
  setIntervalImpl?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalImpl?: (handle: ReturnType<typeof setInterval>) => void;
};

/**
 * Open a short-lived microphone stream and report levels until stopped. Failure
 * is silent (levels simply stay at zero) so a missing mic never breaks the bar.
 */
export async function startMicLevel(
  options: MicLevelOptions,
  deps: MicLevelDeps = {},
): Promise<MicLevelHandle> {
  const g = (deps.globals ?? (globalThis as unknown as MicLevelGlobals));
  const mediaDevices = g.navigator?.mediaDevices;
  const getUserMedia = mediaDevices?.getUserMedia?.bind(mediaDevices);
  const Ctor = g.AudioContext || g.webkitAudioContext;
  const setIntervalImpl = deps.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl = deps.clearIntervalImpl ?? ((h) => clearInterval(h));
  const fps = options.framesPerSecond ?? 30;
  const intervalMs = Math.max(16, Math.round(1000 / fps));

  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let active = false;

  const stop = () => {
    active = false;
    if (timer) {
      clearIntervalImpl(timer);
      timer = null;
    }
    try {
      analyser?.disconnect();
    } catch {
      /* ignore */
    }
    analyser = null;
    try {
      stream?.getTracks?.().forEach((track) => track.stop());
    } catch {
      /* ignore */
    }
    stream = null;
    try {
      void context?.close?.();
    } catch {
      /* ignore */
    }
    context = null;
  };

  if (!getUserMedia || !Ctor) return { stop, get active() { return false; } };
  try {
    stream = await getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
      },
    });
    context = new Ctor();
    const source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    active = true;
    timer = setIntervalImpl(() => {
      if (!analyser) return;
      analyser.getFloatTimeDomainData(buffer as Float32Array<ArrayBuffer>);
      options.onLevel(displayLevel(frameRms(buffer)));
    }, intervalMs);
  } catch {
    stop();
    active = false;
  }

  return {
    stop,
    get active() {
      return active;
    },
  };
}
