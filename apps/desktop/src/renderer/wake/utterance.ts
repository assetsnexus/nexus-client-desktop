/**
 * Renderer microphone utterance source.
 *
 * One microphone stream serves both needs of a dictation turn: `MediaRecorder`
 * produces the audio blob to transcribe, and an `AnalyserNode` reports the input
 * level so the session can end the turn on trailing silence.
 *
 * TRUST: nothing is persisted or transmitted here. The blob is handed straight
 * to the transcriber; this module never logs or stores audio.
 */

import { frameRms } from './mic.js';
import type { DictationCapture, UtteranceSource } from './dictation.js';

type AudioGlobals = {
  navigator?: {
    mediaDevices?: { getUserMedia?: (c: Record<string, unknown>) => Promise<MediaStream> };
  };
  AudioContext?: new () => AudioContext;
  webkitAudioContext?: new () => AudioContext;
  MediaRecorder?: typeof MediaRecorder;
};

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || 'audio/webm';
}

/** Sample cadence for the level meter (~25fps). */
const LEVEL_INTERVAL_MS = 40;

/**
 * How often `MediaRecorder` flushes a chunk. Small enough that a live preview has
 * fresh audio, large enough not to spam the encoder.
 */
const SNAPSHOT_TIMESLICE_MS = 700;

/**
 * Open one utterance. `onLevel` is called with a 0..1-ish RMS per frame until the
 * capture stops. The returned handle stops (returns the blob) or cancels.
 */
export function createUtteranceSource(): UtteranceSource {
  return {
    async start(onLevel): Promise<DictationCapture> {
      const g = globalThis as unknown as AudioGlobals;
      const getUserMedia = g.navigator?.mediaDevices?.getUserMedia;
      if (!getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('This device cannot record audio.');
      }
      const stream = await getUserMedia({ audio: true });

      // Level metering on the same stream (analyser only; no second capture).
      let timer: ReturnType<typeof setInterval> | null = null;
      let context: AudioContext | null = null;
      let analyser: AnalyserNode | null = null;
      const Ctor = g.AudioContext || g.webkitAudioContext;
      if (Ctor) {
        try {
          context = new Ctor();
          const source = context.createMediaStreamSource(stream);
          analyser = context.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          const buffer = new Float32Array(analyser.fftSize);
          timer = setInterval(() => {
            if (!analyser) return;
            analyser.getFloatTimeDomainData(buffer as Float32Array<ArrayBuffer>);
            onLevel(frameRms(buffer) * 3);
          }, LEVEL_INTERVAL_MS);
        } catch {
          // Metering is best-effort; a failed analyser must not block recording.
        }
      }

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(
        stream,
        MediaRecorder.isTypeSupported(mimeType) ? { mimeType } : undefined,
      );
      const chunks: Blob[] = [];
      let mime = mimeType;
      recorder.ondataavailable = (event) => {
        if (event.data.size) {
          chunks.push(event.data);
          mime = event.data.type || mime;
        }
      };
      const stopped = new Promise<Blob>((resolve, reject) => {
        recorder.onerror = () => reject(new Error('Recording failed.'));
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || mime }));
      });
      // A timeslice makes the recorder emit chunk events as it goes, so a live
      // preview can read what has been captured *so far* (see `snapshot`).
      recorder.start(SNAPSHOT_TIMESLICE_MS);

      const teardown = () => {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        try {
          analyser?.disconnect();
        } catch {
          /* ignore */
        }
        analyser = null;
        try {
          void context?.close?.();
        } catch {
          /* ignore */
        }
        context = null;
        try {
          stream.getTracks().forEach((track) => track.stop());
        } catch {
          /* ignore */
        }
      };

      return {
        stop: async () => {
          if (recorder.state !== 'inactive') recorder.stop();
          const blob = await stopped;
          teardown();
          return blob;
        },
        cancel: () => {
          chunks.length = 0;
          if (recorder.state !== 'inactive') recorder.stop();
          teardown();
        },
        /**
         * A copy of the audio captured so far, for the live STT preview. Does not
         * end the turn; returns null before any chunk has arrived.
         */
        snapshot: async () => {
          if (!chunks.length) return null;
          return new Blob([...chunks], { type: mime });
        },
      };
    },
  };
}
