/**
 * Wake pre-roll buffer (renderer).
 *
 * The moment a wake phrase fires, the user is already mid-sentence — the name is
 * the first thing they said. A capture that only starts on the trigger would clip
 * the beginning. This module keeps a rolling ~800ms of the primary microphone
 * (fed from the same shared mic graph the detectors use) so a dictation turn can
 * prepend the audio that arrived just *before* the wake.
 *
 * The buffer is module-scope because it must survive across components and be
 * read at capture-start time, which happens outside React.
 */

import { createPreRollBuffer, type PreRollBuffer } from '@nexus/voice-capture';
import { micGraph } from './mic-graph.js';

/** How much preceding audio to keep (ms). */
export const WAKE_PRE_ROLL_MS = 800;

let buffer: PreRollBuffer | null = null;
let release: (() => void) | null = null;

function ensureBuffer(): PreRollBuffer {
  if (!buffer) buffer = createPreRollBuffer({ ms: WAKE_PRE_ROLL_MS, sampleRate: 16_000 });
  return buffer;
}

/**
 * Begin filling the pre-roll from the primary microphone. Idempotent; the
 * subscription shares the detectors' stream (no extra `getUserMedia`).
 */
export async function primeWakePreRoll(): Promise<void> {
  if (release) return;
  const preRoll = ensureBuffer();
  const handle = await micGraph().acquire({
    frameSamples: 512,
    onFrame: (frame) => preRoll.push(frame),
  });
  release = () => handle.release();
}

/** Stop filling the pre-roll and drop its audio. */
export function stopWakePreRoll(): void {
  release?.();
  release = null;
  buffer?.clear();
}

/**
 * Take the buffered prefix (oldest first) and empty the buffer. Returns null when
 * nothing was buffered, so a capture can tell "no pre-roll" from "silence".
 */
export function drainWakePreRoll(): Float32Array | null {
  return ensureBuffer().drain();
}
