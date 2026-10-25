/**
 * STT-phrase wake detection (renderer).
 *
 * A dedicated keyword model can only ever fire on the fixed phrase it was
 * trained for. To wake on *any* phrase — most importantly an agent's own name —
 * this engine listens the way a person would: it segments speech with the shared
 * energy VAD, transcribes each segment **on-device**, and matches the phrase as
 * text.
 *
 * The segmentation itself lives in `@nexus/voice-capture` (`createSegmenter`) and
 * the phrase matching in its shared `phrase` helpers, so this module is the thin
 * wake-specific glue: one transcription per segment dispatched to many phrases,
 * with a per-phrase cooldown.
 *
 * Design notes:
 *  - **Local-only.** Transcription is injected (see `wake-stt.ts` in main, which
 *    refuses any non-local target). A wake must never stream audio to the cloud;
 *    see `WAKE_WORD_TRUST.audioLeavesDeviceBeforeWake`.
 *  - **One transcription, many phrases.** The hub segments and transcribes once
 *    per speech segment and dispatches the transcript to every registered
 *    phrase, so auto-mapping N agents does not mean N transcriptions per segment.
 *  - **Never blocks the audio loop.** Transcription is async; a match is queued
 *    and drained on a later frame, exactly like the ONNX detector.
 *
 * Pure of Electron/React so the segmentation + match policy is unit-testable.
 */

import {
  createSegmenter,
  isPlausibleSpeechTranscript,
  transcriptAddressesPhrase,
} from '@nexus/voice-capture';

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
  /**
   * A finalized segment produced no usable text (silence, or a transcript the
   * no-speech gate rejected). Lets the UI clear a stale caption at the segment
   * boundary instead of letting old words linger — the caption is "what was just
   * heard", so a fresh empty segment must reset it (optional).
   */
  onEmptySegment?: () => void;
  /** A transcription failure (non-fatal), for logging (optional). */
  onError?: (err: unknown) => void;
  /**
   * Allow single-word utterances (default true). A wake phrase is often one
   * word ("Xeni"), so the hub keeps them unless the caller opts out.
   */
  allowSingleWord?: boolean;
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
  const cooldownMs = options.cooldownMs ?? 1_500;
  const entries: Entry[] = [];
  /**
   * A finalized segment waiting to be transcribed (kept tiny + serial). The
   * segment's speech duration rides along so the no-speech gate can tell a real
   * short utterance from noise the model rendered a few words from.
   */
  const queue: Array<{ pcm: Float32Array; speechMs: number }> = [];
  let inFlight = false;
  /** De-dup so the same frame fed to many detectors is segmented once. */
  let lastFrame: Float32Array | null = null;
  let lastAt = -1;
  /**
   * The authoritative sample rate, tracked here as well as on the segmenter: the
   * mic may pick a rate other than the one requested, and the transcribed WAV
   * must be labelled with the real rate or the model misreads the speech.
   */
  let currentRate = Math.max(8000, Math.round(options.sampleRate) || 16_000);

  const segmenter = createSegmenter({
    sampleRate: options.sampleRate,
    silenceLevel: options.silenceLevel,
    silenceMs: options.silenceMs,
    minSpeechMs: options.minSpeechMs,
    maxSegmentMs: options.maxSegmentMs,
    onSegment: (segment) => {
      queue.push({ pcm: segment.pcm, speechMs: segment.speechMs });
      void drain();
    },
  });

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
        const { pcm, speechMs } = queue.shift()!;
        let transcript: string | null = null;
        try {
          transcript = await options.transcribe(pcm, currentRate);
        } catch (err) {
          options.onError?.(err);
        }
        // Engine-agnostic no-speech gate: a local engine may be whisper.cpp (no
        // `no_speech_threshold`) or an older spawn, so the wake path must still
        // refuse filler/single-letter/repetition decodes of silence — otherwise a
        // phantom transcript is (a) shown as if heard and (b) matched as a wake.
        const usable =
          transcript !== null &&
          isPlausibleSpeechTranscript(transcript, {
            speechMs,
            allowSingleWord: options.allowSingleWord ?? true,
          });
        if (!usable || transcript === null) {
          // A segment that yielded nothing is still a boundary: clear any stale
          // caption so it never lingers as if it were just heard.
          options.onEmptySegment?.();
          continue;
        }
        dispatch(transcript);
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
      if (!rate) return;
      currentRate = rate;
      segmenter.setSampleRate(rate);
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
      segmenter.push(frame, at);
    },
    reset() {
      segmenter.reset();
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
