/**
 * Camera panel model (Phase 7c).
 *
 * Owns the local webcam `MediaStream` and projects it onto a `<video>` element.
 * Pure/headless so it is unit-testable without a DOM: `attach`/`detach` just call
 * the injected element's `srcObject` setter. The captured stream is the same
 * object the room transport publishes — this module never re-captures.
 */

import type { MediaStreamLike } from '@nexus/meetings-core';

/** Minimal `<video>` subset the camera surface drives. */
export type CameraSink = {
  srcObject: unknown;
  muted?: boolean;
  playsInline?: boolean;
  play?: () => Promise<void> | void;
};

/** Attach a stream to a video sink (mirrors the local feed). Muted by default to avoid echo. */
export function attachCameraStream(stream: MediaStreamLike, sink: CameraSink): void {
  sink.srcObject = stream;
  sink.muted = true;
  sink.playsInline = true;
  try {
    const played = sink.play?.();
    if (played && typeof (played as Promise<void>).catch === 'function') {
      void (played as Promise<void>).catch(() => {
        /* autoplay may be blocked until a user gesture */
      });
    }
  } catch {
    /* element not ready */
  }
}

/** Detach the stream (stop is the caller's job via `stopMediaStream`). */
export function detachCameraStream(sink: CameraSink | null | undefined): void {
  if (!sink) return;
  sink.srcObject = null;
}

/**
 * True when the local participant is publishing video on the room session.
 * Kept here so the video tab and the roster badge read the same predicate.
 */
export function localVideoEnabled(local: { video: boolean; screensharing: boolean }): boolean {
  return local.video || local.screensharing;
}
