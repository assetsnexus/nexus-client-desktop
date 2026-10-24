/**
 * Wake-turn audio recorder (renderer).
 *
 * A wake turn can contain several VAD-separated bursts ("Xeni … do the thing").
 * The live STT preview is captured per burst, but the fallback audio batch must
 * span the *whole* turn so the user gets one voice message, not one per sentence.
 *
 * This records from the shared microphone graph for the lifetime of a turn —
 * segmenting speech with the SDK VAD and concatenating the chunks into a single
 * audio batch — and is seeded with the pre-roll prefix so the utterance is not
 * clipped. It shares the graph, so it opens no extra `getUserMedia` stream.
 *
 * TRUST: audio is kept in memory only, never persisted or transmitted here. It is
 * handed to the transcriber or attached as a voice message when the user asks.
 */

import {
  createAudioBatchRecorder,
  createSegmenter,
  type AudioBatch,
  type MicStreamHandle,
} from '@nexus/voice-capture';
import { micGraph } from './mic-graph.js';

export type WakeTurnRecorder = {
  /** Accumulated batch duration, ms (0 before any speech). */
  readonly durationMs: number;
  /** Number of VAD bursts folded into the batch. */
  readonly chunks: number;
  /** True once the batch holds audio. */
  readonly hasAudio: boolean;
  /** Current progress, in the shape the session/UI expects. */
  progress(): { durationMs: number; chunks: number };
  /** The batch recorded so far, without ending the recording. */
  snapshot(): AudioBatch | null;
  /** Stop recording and return the batch (or null when nothing was captured). */
  finish(): AudioBatch | null;
  /** Stop recording (idempotent). */
  stop(): void;
};

/**
 * Begin recording a wake turn. `prefix` is the pre-roll audio captured before
 * the wake phrase (avoiding a clipped first syllable).
 */
export async function startWakeTurnRecording(
  prefix?: Float32Array | null,
): Promise<WakeTurnRecorder> {
  const sampleRate = 16_000;
  const batch = createAudioBatchRecorder({ sampleRate });
  if (prefix && prefix.length) {
    batch.append({ pcm: prefix, durationMs: (prefix.length / sampleRate) * 1000 });
  }
  const segmenter = createSegmenter({
    sampleRate,
    onSegment: (segment) => {
      batch.append({
        pcm: segment.pcm,
        durationMs: (segment.pcm.length / sampleRate) * 1000,
      });
    },
  });

  // The graph may have picked a rate other than 16 kHz; keep the segmenter honest
  // so its timing (and the batch duration) matches the real capture.
  const handle: MicStreamHandle = await micGraph().acquire({
    frameSamples: 512,
    preferredSampleRate: sampleRate,
    onFrame: (frame) => segmenter.push(frame, Date.now()),
  });
  segmenter.setSampleRate(handle.sampleRate);

  let stopped = false;
  return {
    get durationMs() {
      return batch.durationMs;
    },
    get chunks() {
      return batch.chunks;
    },
    get hasAudio() {
      return batch.hasAudio;
    },
    progress: () => ({ durationMs: batch.durationMs, chunks: batch.chunks }),
    snapshot: () => batch.snapshot(),
    finish() {
      if (!stopped) {
        stopped = true;
        segmenter.flush();
        handle.release();
      }
      return batch.finish();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      handle.release();
    },
  };
}
