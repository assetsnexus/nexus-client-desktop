/**
 * Renderer utterance source (desktop adapter).
 *
 * Delegates to the shared `@nexus/voice-capture` preview source over the app's
 * single microphone stream graph, so a dictation turn and the wake detector no
 * longer open separate `getUserMedia` streams on the same device. The SDK source
 * also records a parallel audio batch and can prepend a pre-roll prefix.
 *
 * TRUST: nothing is persisted or transmitted here. The captured audio is handed
 * straight to the transcriber / batch path; this module never logs or stores it.
 */

import { createPreviewSource, type PreviewSource } from '@nexus/voice-capture';
import { micGraph } from './mic-graph.js';
import type { UtteranceSource } from './dictation.js';

export type UtteranceSourceOptions = {
  /** Input device to capture from; null/omitted = the OS default microphone. */
  deviceId?: string | null;
  /** Audio captured before the wake fired, prepended to the utterance. */
  prefix?: Float32Array | null;
  /** Keep a rolling pre-roll while idle (ms; 0 disables). */
  preRollMs?: number;
  /** Record the parallel audio batch (default true). */
  recordBatch?: boolean;
};

/**
 * Create an utterance source over the shared mic graph. When the caller needs the
 * audio batch (the wake widget's "send as voice" fallback) it should keep the
 * returned `PreviewSource` and read `batch()` / `finishBatch()` from it.
 */
export function createPreviewUtteranceSource(options: UtteranceSourceOptions = {}): PreviewSource {
  return createPreviewSource({
    graph: micGraph(),
    deviceId: options.deviceId ?? null,
    prefix: options.prefix ?? null,
    preRollMs: options.preRollMs,
    recordBatch: options.recordBatch,
  });
}

/**
 * Backwards-compatible source for callers that only need the capture (enrolment,
 * the settings live test). Recording the batch is unnecessary there, so it is
 * disabled to keep memory small.
 */
export function createUtteranceSource(options: UtteranceSourceOptions = {}): UtteranceSource {
  return createPreviewUtteranceSource({ ...options, recordBatch: false });
}
