/**
 * Wake dictation transcribers (renderer).
 *
 * Two `Transcriber`s behind the shared `@nexus/voice-capture` contract, so the
 * dictation pipeline does not care where the text comes from:
 *
 *  - **local** — the on-device engine in the main process (`wakeTranscribeLocal`
 *    over IPC: whisper.cpp or the faster-whisper GPU server). Audio never leaves
 *    the machine, and phrases bias the decoder so agent names are recognised.
 *  - **cloud** — the region inference STT workload the user is entitled to, via
 *    `@nexus/chat-core`'s `transcribeOrNull` (the same path a manual dictation
 *    uses, under the user's own token).
 *
 * `pickTranscriber` prefers the local engine when it reports ready, so a user with
 * a GPU engine installed gets the fast/private path automatically.
 */

import type { Transcriber } from '@nexus/voice-capture';
import { rankSttModels } from './transcribe.js';
import { bridge } from '../bridge.js';

/** Phrases to bias the local decoder toward (agent names, aliases). */
export type PhraseSource = () => string[];

type CloudDeps = {
  listModels: () => Promise<{ models: Array<Record<string, unknown>> }>;
  client: unknown;
};

/**
 * On-device transcriber backed by the main process. Only ever transcribes
 * locally — main refuses a non-local target, so this cannot silently stream the
 * user's speech to a remote host.
 */
export function createLocalTranscriber(phrases: PhraseSource): Transcriber {
  return {
    id: 'local',
    leavesDevice: false,
    async status() {
      try {
        const status = await bridge.wakeSttStatus();
        return {
          ready: status.ready,
          label: status.modelLabel || status.backend || 'On-device',
          reason: status.reason,
        };
      } catch {
        return { ready: false, label: 'On-device', reason: 'Local speech engine unavailable.' };
      }
    },
    async transcribe(input) {
      // The local engine consumes raw PCM; `transcribePcm` is passed the samples
      // directly by the dictation controller, so this Blob path is only used when
      // a caller hands us a blob (e.g. the audio-batch fallback).
      if (!input.pcm || !input.sampleRate) {
        return transcribeBlobLocally(input.blob, phrases());
      }
      const text = await bridge.wakeTranscribeLocal({
        pcm: input.pcm,
        sampleRate: input.sampleRate,
        phrases: phrases(),
      });
      return text?.trim() ? text.trim() : null;
    },
  };
}

/** Decode a WAV/WebM blob to PCM and run the local engine (fallback path). */
async function transcribeBlobLocally(blob: Blob, phrases: string[]): Promise<string | null> {
  const pcm = await decodeBlobToPcm(blob);
  if (!pcm) return null;
  const text = await bridge.wakeTranscribeLocal({
    pcm: pcm.samples,
    sampleRate: pcm.sampleRate,
    phrases,
  });
  return text?.trim() ? text.trim() : null;
}

/** Decode an audio Blob to mono PCM via Web Audio (best-effort). */
async function decodeBlobToPcm(
  blob: Blob,
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
  const g = globalThis as unknown as {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  const Ctor = g.AudioContext || g.webkitAudioContext;
  if (!Ctor) return null;
  const context = new Ctor();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const length = buffer.length;
    const mono = new Float32Array(length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i]! += data[i]! / buffer.numberOfChannels;
    }
    return { samples: mono, sampleRate: buffer.sampleRate };
  } catch {
    return null;
  } finally {
    try {
      void context.close?.();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Region cloud transcriber. Resolves an entitled Whisper model and posts the
 * audio to the inference STT workload; audio leaves the device (so the UI keeps
 * its "streaming to the cloud" banner visible).
 */
export function createCloudTranscriber(deps: CloudDeps): Transcriber {
  return {
    id: 'cloud',
    leavesDevice: true,
    async status() {
      try {
        const catalog = await deps.listModels();
        const [modelId] = rankSttModels(catalog.models ?? []);
        return { ready: Boolean(modelId), label: 'Region inference', reason: modelId ? null : 'No speech model is entitled.' };
      } catch {
        return { ready: false, label: 'Region inference', reason: 'Could not reach region inference.' };
      }
    },
    async transcribe(input) {
      const catalog = await deps.listModels();
      const [modelId] = rankSttModels(catalog.models ?? []);
      if (!modelId) return null;
      const { transcribeOrNull } = await import('@nexus/chat-core');
      const result = await transcribeOrNull(deps.client as never, {
        modelId,
        audioBlob: input.blob,
      });
      const text = result.text?.trim();
      return text ? text : null;
    },
  };
}

/**
 * Choose the transcriber for a wake dictation: prefer the on-device engine when
 * it is ready, else the region cloud. Returns the local one even when not ready
 * if no cloud model exists, so the caller surfaces a real error rather than
 * silently doing nothing.
 */
export async function pickWakeTranscriber(input: {
  phrases: PhraseSource;
  cloud: CloudDeps;
}): Promise<Transcriber> {
  const local = createLocalTranscriber(input.phrases);
  const cloud = createCloudTranscriber(input.cloud);
  const localStatus = await local.status?.().catch(() => ({ ready: false, label: 'On-device' }));
  if (localStatus?.ready) return local;
  const cloudStatus = await cloud.status?.().catch(() => ({ ready: false, label: 'Region inference' }));
  if (cloudStatus?.ready) return cloud;
  // Nothing ready: return local so a real failure is reported (and no audio is
  // streamed to the cloud without the user having a working, entitled path).
  return local;
}
