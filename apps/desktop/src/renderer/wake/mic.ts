/**
 * Wake microphone source (desktop adapter).
 *
 * The actual capture — one `getUserMedia`/`AudioContext` per device, contiguous
 * 16 kHz frames, ref-counted fan-out — now lives in the shared
 * `@nexus/voice-capture` mic graph, so wake listening, dictation and the level
 * meter share one stream per device instead of each opening their own.
 *
 * This module preserves the `WakeMicSource` shape the wake director was built
 * against, backed by the shared graph.
 *
 * TRUST: this never records to disk and never sends audio anywhere. Frames only
 * reach on-device detectors / the local-only transcriber.
 */

import { micGraph } from './mic-graph.js';

export { frameRms } from '@nexus/voice-capture';

export type WakeMicSource = {
  /** True while frames are actually being delivered. */
  readonly active: boolean;
  /** Human-safe reason the microphone is unavailable/erroring. */
  readonly message: string | null;
  /** Sample rate of the delivered frames (Hz). */
  readonly sampleRate: number;
  /** Begin delivering frames; resolves to false when it could not start. */
  start(handler: (frame: Float32Array) => void): Promise<boolean>;
  stop(): void;
};

export type WakeMicOptions = {
  /**
   * Specific input device to capture from (a `MediaDeviceInfo.deviceId`). Omitted
   * or `null` uses the OS default microphone. Used to listen for wake words on
   * 0..n extra microphones in addition to the primary dictation mic.
   */
  deviceId?: string | null;
  /** Preferred delivered frame size (default 512 samples ≈ 32ms @16 kHz). */
  frameSamples?: number;
  /** Preferred capture rate; the browser resamples the mic to this (default 16000). */
  preferredSampleRate?: number;
};

export function createWakeMic(opts: WakeMicOptions = {}): WakeMicSource {
  const preferredSampleRate = opts.preferredSampleRate ?? 16_000;
  const frameSamples = opts.frameSamples ?? 512;
  let handle: Awaited<ReturnType<ReturnType<typeof micGraph>['acquire']>> | null = null;
  let active = false;
  let message: string | null = null;
  let sampleRate = preferredSampleRate;

  return {
    get active() {
      return active;
    },
    get message() {
      return message;
    },
    get sampleRate() {
      return sampleRate;
    },
    async start(handler) {
      const acquired = await micGraph().acquire({
        deviceId: opts.deviceId ?? null,
        frameSamples,
        preferredSampleRate,
        onFrame: handler,
      });
      handle = acquired;
      active = acquired.active;
      sampleRate = acquired.sampleRate;
      message = active ? null : 'Microphone capture is unavailable on this device.';
      return active;
    },
    stop() {
      handle?.release();
      handle = null;
      active = false;
    },
  };
}
