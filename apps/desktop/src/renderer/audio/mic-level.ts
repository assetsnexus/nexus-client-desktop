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

import { frameRms } from '@nexus/voice-capture';
import { micGraph } from '../wake/mic-graph.js';

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

export type MicLevelDeps = {
  /** Injectable level interval for tests. */
  setIntervalImpl?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalImpl?: (handle: ReturnType<typeof setInterval>) => void;
};

/**
 * Subscribe to a device's level and report it until stopped. Failure is silent
 * (levels simply stay at zero) so a missing mic never breaks the bar.
 *
 * The audio comes from the app's shared microphone stream graph, so the meter
 * piggybacks on the wake detector's stream (one `getUserMedia` per device)
 * instead of opening its own. The meter only needs the newest level, so frames
 * are consumed as they arrive and no ring buffer is kept here.
 */
export async function startMicLevel(
  options: MicLevelOptions,
  deps: MicLevelDeps = {},
): Promise<MicLevelHandle> {
  const fps = options.framesPerSecond ?? 30;
  const intervalMs = Math.max(16, Math.round(1000 / fps));
  const setIntervalImpl = deps.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl = deps.clearIntervalImpl ?? ((h) => clearInterval(h));

  let active = false;
  let latest = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const handle = await micGraph().acquire({
    deviceId: options.deviceId ?? null,
    onFrame: (frame) => {
      latest = displayLevel(frameRms(frame));
    },
  });
  active = handle.active;
  if (active) {
    timer = setIntervalImpl(() => options.onLevel(latest), intervalMs);
  }

  return {
    stop() {
      active = false;
      if (timer) {
        clearIntervalImpl(timer);
        timer = null;
      }
      handle.release();
    },
    get active() {
      return active;
    },
  };
}
