/**
 * STT-phrase wake detection (renderer).
 *
 * A dedicated keyword model can only ever fire on the fixed phrase it was
 * trained for. To wake on *any* phrase — most importantly an agent's own name —
 * this engine listens the way a person would: it segments speech with a simple
 * energy VAD, transcribes each segment **on-device**, and matches the phrase as
 * text.
 *
 * Design notes:
 *  - **Local-only.** Transcription is injected (see `wake-stt.ts` in main, which
 *    refuses any non-local target). A wake must never stream audio to the cloud;
 *    see `WAKE_WORD_TRUST.audioLeavesDeviceBeforeWake`.
 *  - **One transcription, many phrases.** The hub segments and transcribes once
 *    per speech segment and dispatches the transcript to every registered
 *    phrase, so auto-mapping N agents does not mean N transcriptions per segment.
 *    The director feeds the same frame to every armed detector, so the hub
 *    de-duplicates by frame identity.
 *  - **Never blocks the audio loop.** Transcription is async; a match is queued
 *    and drained on a later frame, exactly like the ONNX detector.
 *
 * Pure of Electron/React so the segmentation + match policy is unit-testable.
 */

import { transcriptAddressesPhrase } from '../../shared/wake-phrase.js';

export type SttTranscribeFn = (pcm: Float32Array, sampleRate: number) => Promise<string | null>;

export type SttPhraseSubscription = {
  /** Drain a queued match for this phrase, if the last transcript addressed it. */
  poll(): { fired: boolean; confidence: number | null };
  /** Stop receiving matches (called when a detector is disposed). */
  dispose(): void;
};

export type SttPhraseHubOptions = {
  /** Transcribe one speech segment on-device. */
  transcribe: SttTranscribeFn;
  /** Frame sample rate (Hz). */
  sampleRate: number;
  /** RMS at/below which a frame counts as silence (default 0.012). */
  silenceLevel?: number;
  /** Trailing silence that ends a segment, ms (default 500). */
  silenceMs?: number;
  /** Ignore segments shorter than this, ms (default 300). */
  minSpeechMs?: number;
  /** Hard cap on one segment, ms (default 8000). */
  maxSegmentMs?: number;
  /** After a phrase fires, ignore repeats for this long, ms (default 1500). */
  cooldownMs?: number;
  /** Live transcript of an accepted segment, for UI feedback (optional). */
  onTranscript?: (text: string) => void;
  /** A transcription failure (non-fatal), for logging (optional). */
  onError?: (err: unknown) => void;
};

export type SttPhraseHub = {
  /** Register a phrase to watch for; returns a per-phrase match handle. */
  register(phrase: string): SttPhraseSubscription;
  /** Feed one audio frame. Safe to call repeatedly for the same frame. */
  process(frame: Float32Array, at: number): void;
  /**
   * Update the capture rate. The microphone may pick a rate other than the one
   * requested (the OS can ignore the hint), so the director calls this once the
   * stream is live to keep segment timing — and the WAV the model sees — honest.
   */
  setSampleRate(sampleRate: number): void;
  /** Drop buffered audio and pending matches. */
  reset(): void;
  /** Number of live subscriptions (0 = the hub is idle). */
  readonly size: number;
};

type Entry = {
  phrase: string;
  pending: boolean;
  cooldownUntil: number;
};

/**
 * Create the shared segmentation + transcription hub. Callers register one entry
 * per phrase and feed frames from the same microphone stream.
 */
export function createSttPhraseHub(options: SttPhraseHubOptions): SttPhraseHub {
  let sampleRate = Math.max(8000, Math.round(options.sampleRate) || 16_000);
  const silenceLevel = options.silenceLevel ?? 0.012;
  const silenceMs = options.silenceMs ?? 500;
  const minSpeechMs = options.minSpeechMs ?? 300;
  const maxSegmentMs = options.maxSegmentMs ?? 8_000;
  const cooldownMs = options.cooldownMs ?? 1_500;

  const entries: Entry[] = [];
  /** Frames of the in-progress segment (pre-allocated chunks, no per-frame copy). */
  let segment: Float32Array[] = [];
  let segmentSamples = 0;
  let speechMs = 0;
  let trailingSilenceMs = 0;
  let sawSpeech = false;
  /** A finalized segment waiting to be transcribed (kept tiny + serial). */
  const queue: Float32Array[] = [];
  let inFlight = false;
  /** De-dup so the same frame fed to many detectors is segmented once. */
  let lastFrame: Float32Array | null = null;
  let lastAt = -1;

  const frameMs = (samples: number) => (samples / sampleRate) * 1000;

  function concatSegment(): Float32Array {
    const out = new Float32Array(segmentSamples);
    let offset = 0;
    for (const chunk of segment) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function finalizeSegment(): void {
    if (sawSpeech && speechMs >= minSpeechMs && segmentSamples > 0) {
      queue.push(concatSegment());
    }
    segment = [];
    segmentSamples = 0;
    speechMs = 0;
    trailingSilenceMs = 0;
    sawSpeech = false;
    void drain();
  }

  function dispatch(transcript: string): void {
    const text = transcript.trim();
    if (!text) return;
    options.onTranscript?.(text);
    const now = Date.now();
    for (const entry of entries) {
      if (entry.pending) continue;
      if (now < entry.cooldownUntil) continue;
      if (!transcriptAddressesPhrase(text, entry.phrase)) continue;
      entry.pending = true;
      entry.cooldownUntil = now + cooldownMs;
    }
  }

  async function drain(): Promise<void> {
    if (inFlight || queue.length === 0) return;
    inFlight = true;
    try {
      while (queue.length > 0) {
        const pcm = queue.shift()!;
        let transcript: string | null = null;
        try {
          transcript = await options.transcribe(pcm, sampleRate);
        } catch (err) {
          options.onError?.(err);
        }
        if (transcript) dispatch(transcript);
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    get size() {
      return entries.length;
    },
    setSampleRate(next: number) {
      const rate = Math.max(8000, Math.round(next) || 0);
      if (rate) sampleRate = rate;
    },
    register(phrase: string): SttPhraseSubscription {
      const entry: Entry = { phrase, pending: false, cooldownUntil: 0 };
      entries.push(entry);
      return {
        poll() {
          if (!entry.pending) return { fired: false, confidence: null };
          entry.pending = false;
          // STT reports no calibrated confidence; the phrase matched as text.
          return { fired: true, confidence: null };
        },
        dispose() {
          const idx = entries.indexOf(entry);
          if (idx >= 0) entries.splice(idx, 1);
        },
      };
    },
    process(frame: Float32Array, at: number) {
      // The director feeds one frame to every armed detector; segment it once.
      if (frame === lastFrame && at === lastAt) return;
      lastFrame = frame;
      lastAt = at;
      if (entries.length === 0 || !frame.length) return;
      // Local energy gate — no model runs on silence.
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
      const rms = Math.sqrt(sum / frame.length);
      const ms = frameMs(frame.length);
      if (rms > silenceLevel) {
        sawSpeech = true;
        speechMs += ms;
        trailingSilenceMs = 0;
        segment.push(frame.slice());
        segmentSamples += frame.length;
        if (speechMs >= maxSegmentMs) finalizeSegment();
        return;
      }
      if (!sawSpeech) return;
      trailingSilenceMs += ms;
      segment.push(frame.slice());
      segmentSamples += frame.length;
      if (trailingSilenceMs >= silenceMs) finalizeSegment();
    },
    reset() {
      segment = [];
      segmentSamples = 0;
      speechMs = 0;
      trailingSilenceMs = 0;
      sawSpeech = false;
      queue.length = 0;
      lastFrame = null;
      lastAt = -1;
      for (const entry of entries) entry.pending = false;
    },
  };
}

export type SttPhraseDetectorOptions = {
  id?: string;
  /** The phrase to wake on (matched as whole words in the transcript). */
  phrase: string;
  hub: SttPhraseHub;
};

/**
 * A `WakeWordDetector` backed by the shared STT-phrase hub. `sensitivity` is not
 * used for matching (the text decides), so it is accepted only for interface
 * symmetry with the other detectors.
 */
export function createSttPhraseDetector(opts: SttPhraseDetectorOptions): {
  id: string;
  detecting: boolean;
  reset(): void;
  push(input: { frame: Float32Array; at: number }): { fired: boolean; confidence: number | null };
  dispose(): void;
} {
  const sub = opts.hub.register(opts.phrase);
  return {
    id: opts.id ?? `stt:${opts.phrase}`,
    // Genuinely detecting: the hub transcribes on-device and matches text.
    detecting: true,
    reset() {
      opts.hub.reset();
    },
    push({ frame, at }) {
      opts.hub.process(frame, at);
      return sub.poll();
    },
    dispose() {
      sub.dispose();
    },
  };
}
