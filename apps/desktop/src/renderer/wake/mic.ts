/**
 * Renderer microphone source for wake-word detection.
 *
 * One microphone stream, sampled into fixed frames and handed to the wake
 * director. Kept separate from `@nexus/wake-word`'s internal source so the
 * director can drive *many* detectors from a single captured stream, and so the
 * frame cadence is testable without a real browser.
 *
 * Frames are delivered **contiguously** (no dropped samples), which the
 * STT-phrase wake engine needs: it transcribes whole speech segments, so gaps
 * would corrupt the audio it sends to the local speech model. The preferred path
 * is a `ScriptProcessorNode` (ubiquitous in Electron's Chromium) with a fallback
 * to the older analyser polling loop. Capture is requested at 16 kHz so the
 * sample rate the STT engine reports matches what the model expects.
 *
 * TRUST: this never records to disk and never sends audio anywhere. Frames only
 * reach on-device detectors / the local-only transcriber.
 */

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

type AudioGlobals = {
  navigator?: {
    mediaDevices?: { getUserMedia?: (c: Record<string, unknown>) => Promise<MediaStream> };
  };
  AudioContext?: new (options?: { sampleRate?: number }) => AudioContext;
  webkitAudioContext?: new (options?: { sampleRate?: number }) => AudioContext;
};

export type WakeMicOptions = {
  /** Frames per second delivered to the detector (analyser fallback only; default 30). */
  framesPerSecond?: number;
  /** Samples per frame for the analyser fallback (default 512). */
  frameSamples?: number;
  /** Preferred capture rate; the browser resamples the mic to this (default 16000). */
  preferredSampleRate?: number;
  /**
   * Specific input device to capture from (a `MediaDeviceInfo.deviceId`). Omitted
   * or `null` uses the OS default microphone. Used to listen for wake words on
   * 0..n extra microphones in addition to the primary dictation mic.
   */
  deviceId?: string | null;
};

const DEFAULT_SAMPLE_RATE = 16_000;

export function createWakeMic(opts: WakeMicOptions = {}): WakeMicSource {
  const framesPerSecond = opts.framesPerSecond ?? 30;
  const frameSamples = opts.frameSamples ?? 512;
  const preferredSampleRate = opts.preferredSampleRate ?? DEFAULT_SAMPLE_RATE;
  const intervalMs = Math.max(10, Math.round(1000 / framesPerSecond));

  let active = false;
  let message: string | null = null;
  let sampleRate = preferredSampleRate;
  // ScriptProcessor path.
  let processor: ScriptProcessorNode | null = null;
  let sink: GainNode | null = null;
  // Analyser fallback path.
  let timer: ReturnType<typeof setInterval> | null = null;
  let analyser: AnalyserNode | null = null;
  let buffer: Float32Array | null = null;
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (processor) {
      processor.onaudioprocess = null;
      try {
        processor.disconnect();
      } catch {
        /* ignore */
      }
      processor = null;
    }
    try {
      sink?.disconnect();
    } catch {
      /* ignore */
    }
    sink = null;
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
    buffer = null;
    active = false;
  };

  /** Build an AudioContext, preferring the 16 kHz capture rate. */
  const makeContext = (Ctor: NonNullable<AudioGlobals['AudioContext']>): AudioContext => {
    try {
      const ctx = new Ctor({ sampleRate: preferredSampleRate });
      // Some backends ignore the hint; respect whatever they picked.
      sampleRate = Math.round(ctx.sampleRate) || preferredSampleRate;
      return ctx;
    } catch {
      const ctx = new Ctor();
      sampleRate = Math.round(ctx.sampleRate) || preferredSampleRate;
      return ctx;
    }
  };

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
      const g = globalThis as unknown as AudioGlobals;
      const mediaDevices = g.navigator?.mediaDevices;
      // Bind to `mediaDevices`: extracting the method first loses its `this`, and
      // Chromium throws "Illegal invocation" for a detached `getUserMedia` call.
      const getUserMedia = mediaDevices?.getUserMedia?.bind(mediaDevices);
      const Ctor = g.AudioContext || g.webkitAudioContext;
      if (!getUserMedia) {
        message = 'Microphone capture is unavailable on this device.';
        active = false;
        return false;
      }
      if (!Ctor) {
        message = 'Web Audio is unavailable for on-device wake detection.';
        active = false;
        return false;
      }
      try {
        stream = await getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            // A specific wake-listening microphone, or the OS default when unset.
            ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
          },
        });
        context = makeContext(Ctor);
        const source = context.createMediaStreamSource(stream);
        active = true;
        message = null;

        // Preferred: contiguous frames with no dropped samples.
        const createProcessor = (context as AudioContext).createScriptProcessor?.bind(context);
        if (typeof createProcessor === 'function') {
          processor = createProcessor(1024, 1, 1);
          processor.onaudioprocess = (event) => {
            if (!active) return;
            // Copy: the input buffer is reused between callbacks.
            const channel = event.inputBuffer.getChannelData(0);
            handler(new Float32Array(channel));
          };
          source.connect(processor);
          // A muted sink keeps the processor pulling without echoing to speakers.
          sink = context.createGain();
          sink.gain.value = 0;
          processor.connect(sink);
          sink.connect(context.destination);
          return true;
        }

        // Fallback: analyser polling (may drop samples between ticks).
        analyser = context.createAnalyser();
        analyser.fftSize = Math.max(256, frameSamples);
        source.connect(analyser);
        buffer = new Float32Array(analyser.fftSize);
        timer = setInterval(() => {
          if (!analyser || !buffer) return;
          analyser.getFloatTimeDomainData(buffer as Float32Array<ArrayBuffer>);
          handler(buffer as Float32Array);
        }, intervalMs);
        return true;
      } catch (err) {
        message = err instanceof Error ? err.message : 'Microphone access failed.';
        stop();
        return false;
      }
    },
    stop,
  };
}

/** Root-mean-square level of a frame (0..1-ish). */
export function frameRms(frame: Float32Array): number {
  if (!frame.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  return Math.sqrt(sum / frame.length);
}
