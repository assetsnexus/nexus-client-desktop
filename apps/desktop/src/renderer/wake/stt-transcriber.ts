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
 * `pickWakeTranscriber`/`resolveWakeTranscriber` honour the user's configured
 * `sttEngine` ({@link WakeEngineSetting}) using the *same* policy the "streaming to
 * the cloud" banner uses (`dictationTranscribesInCloud`), so the engine that runs
 * and the surface the user sees can never disagree. When the configured engine is
 * not ready it falls back to whichever engine *is*, and reports that in the label.
 * A caller that passes no settings keeps the legacy "local first" preference.
 */

import type { Transcriber } from '@nexus/voice-capture';
import { rankSttModels } from './transcribe.js';
import { bridge } from '../bridge.js';
import { dictationTranscribesInCloud } from '../../shared/wake.js';

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

/** The user's configured wake-dictation engine (mirrors `LocalVoiceSettings.sttEngine`). */
export type WakeEngineSetting = 'cloud' | 'local';

/**
 * The engine capability inputs the picker needs. Kept as plain data (rather than
 * reading the bridge inside the picker) so the resolution stays unit-testable and
 * so the *same* value feeds {@link dictationTranscribesInCloud} that decides the
 * "streaming to the cloud" banner — the engine that runs and the surface the user
 * sees can never disagree.
 */
export type WakeEngineInput = {
  sttEngine: WakeEngineSetting;
  /** True when a local STT model is installed. */
  localSttAvailable: boolean;
  /** True when a custom (self-hosted) STT endpoint is configured. */
  customSttEndpoint: boolean;
};

/** The picker's result: the transcriber plus enough to label the UI honestly. */
export type WakeTranscriberPick = {
  transcriber: Transcriber;
  /** True when the configured engine was not usable and the other one was chosen. */
  fallback: boolean;
  /** Human label reflecting the *actual* engine used ("On-device" / "Region inference"). */
  label: string;
};

/** The display label for a chosen engine id (matches the existing UI copy). */
export function engineLabelFor(id: string): string {
  return id === 'local' ? 'On-device' : 'Region inference';
}

/**
 * Resolve the engine a wake dictation should use.
 *
 * Precedence is driven by {@link dictationTranscribesInCloud} (the single source
 * of truth also used for the cloud-streaming banner):
 *  - `sttEngine: 'cloud'` ⇒ cloud (the user's explicit choice);
 *  - `sttEngine: 'local'` ⇒ local when a model is installed or a custom endpoint
 *    is configured, else cloud (an un-installed local engine can only fall back).
 *
 * The chosen engine is then checked for readiness; if it is not ready but the
 * other engine is, the other is used and `fallback` is set (the label reflects
 * it). "Fallback" also covers the case where the effective engine already
 * differs from the user's literal `sttEngine` choice (e.g. `local` selected but
 * no model installed ⇒ cloud). When neither is ready the chosen engine is
 * returned, so the caller surfaces a real error rather than silently doing
 * nothing.
 */
export async function resolveWakeTranscriber(input: {
  phrases: PhraseSource;
  cloud: CloudDeps;
  /** Omit to keep the legacy "local first, else cloud" preference. */
  engine?: WakeEngineInput;
}): Promise<WakeTranscriberPick> {
  const local = createLocalTranscriber(input.phrases);
  const cloud = createCloudTranscriber(input.cloud);
  const ready = async (t: Transcriber): Promise<boolean> =>
    (await t.status?.().catch(() => ({ ready: false })))?.ready === true;

  if (!input.engine) {
    // Legacy callers: prefer the on-device engine when it reports ready.
    if (await ready(local)) return { transcriber: local, fallback: false, label: engineLabelFor('local') };
    if (await ready(cloud)) return { transcriber: cloud, fallback: false, label: engineLabelFor('cloud') };
    return { transcriber: local, fallback: false, label: engineLabelFor('local') };
  }

  // `dictationTranscribesInCloud` is the single source of truth: it folds
  // "local selected" together with "a local engine actually exists" (model or
  // custom endpoint), so the engine we attempt matches the streaming banner.
  const wantsCloud = dictationTranscribesInCloud({
    sttEngine: input.engine.sttEngine,
    localSttAvailable: input.engine.localSttAvailable,
    customSttEndpoint: input.engine.customSttEndpoint,
  });
  let chosen = wantsCloud ? cloud : local;
  // The effective engine already differs from the user's literal choice (local
  // selected but nothing local installed ⇒ cloud): that is a fallback too.
  let fallback = chosen.id !== input.engine.sttEngine;

  if (!(await ready(chosen))) {
    const other = chosen.id === 'local' ? cloud : local;
    if (await ready(other)) {
      // The chosen engine was not ready; the other one is. Say so in the label.
      chosen = other;
      fallback = true;
    }
    // Neither ready: keep `chosen` so a real failure is reported.
  }

  return {
    transcriber: chosen,
    fallback,
    label: fallback ? `${engineLabelFor(chosen.id)} (fallback)` : engineLabelFor(chosen.id),
  };
}

/**
 * Backward-compatible wrapper: the transcriber only. Prefer
 * {@link resolveWakeTranscriber} when the caller needs the fallback label.
 */
export async function pickWakeTranscriber(input: {
  phrases: PhraseSource;
  cloud: CloudDeps;
  engine?: WakeEngineInput;
}): Promise<Transcriber> {
  return (await resolveWakeTranscriber(input)).transcriber;
}
