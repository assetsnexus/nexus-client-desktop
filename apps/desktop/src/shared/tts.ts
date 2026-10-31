/**
 * App-default text-to-speech preferences (shared, pure).
 *
 * The companion (and the "speak new messages" notification path) needs *some*
 * TTS model + voice when the addressed agent has no contact-level override of
 * its own. Rather than hardcoding a model, the user picks an app default from
 * the models their subscription entitles them to; this module holds that choice
 * and the small amount of capability logic the settings UI needs to present it
 * correctly.
 *
 * Everything here is Electron-free and region-free so the resolution rules are
 * unit-tested directly; the renderer/server calls live in `chat-core`.
 */

/** One summarised audio-model capability set the settings UI cares about. */
export type TtsModelCapabilitySummary = {
  /** Model exposes an OpenAI-style named voice list (`voice` = a name). */
  namedVoices: boolean;
  /** Model selects voices by `reference_id` (e.g. Fish Audio). */
  referenceId: boolean;
  /** Model can clone from a short WAV sample (`voice-cloning`). */
  supportsVoiceSample: boolean;
  /** Model speaks a streaming protocol (lower latency on live calls). */
  streaming: boolean;
  /** Model is multilingual (may expose per-language voices). */
  multilingual: boolean;
};

/**
 * Which voice-selection model a catalog model uses, from its capabilities.
 *
 * `reference_id` is the Fish-Audio style: the voice list is fetched live after
 * the model is chosen, and each voice is addressed by an opaque reference. The
 * catalog row for such a model ships `tts` + `voice-cloning` but **not** a
 * literal `reference_id` capability, so cloning support with no *explicit*
 * named-voice capability is the signal for this style. Everything else that
 * exposes plain voices uses OpenAI-style **names**.
 *
 * This is only a fallback: the authoritative signal is `voiceSelectMode` on the
 * live `anx.inference.tts.voices.list` response, which the picker prefers when
 * it has one. A model with neither capability is treated as "no voice selection"
 * rather than guessing.
 */
export function ttsVoiceSelectMode(
  capabilities: readonly string[] | null | undefined,
): 'reference_id' | 'name' | null {
  const caps = (capabilities ?? []).map((c) => String(c).toLowerCase());
  const has = (needle: string) => caps.some((c) => c === needle || c.includes(needle));
  if (has('reference_id') || has('reference-id')) return 'reference_id';
  if (has('named_voice') || has('named-voice')) return 'name';
  // Cloning without a named-voice list is the Fish-Audio shape (reference ids).
  if (has('voice-cloning') || has('voice_cloning') || has('voice-clone')) return 'reference_id';
  if (has('tts')) return 'name';
  return null;
}

/**
 * Summarise the capabilities a settings row shows. The badge set is deliberately
 * small and factual: it tells the user which models can be voice-cloned from a
 * WAV sample, which speak streaming, and how their voices are addressed — the
 * three things that actually change what the controls below the picker do.
 */
export function summarizeTtsCapabilities(
  capabilities: readonly string[] | null | undefined,
): TtsModelCapabilitySummary {
  const caps = (capabilities ?? []).map((c) => String(c).toLowerCase());
  const has = (needle: string) => caps.some((c) => c === needle || c.includes(needle));
  return {
    namedVoices: ttsVoiceSelectMode(caps) === 'name',
    referenceId: ttsVoiceSelectMode(caps) === 'reference_id',
    supportsVoiceSample: has('voice-cloning') || has('voice_cloning') || has('voice-clone'),
    streaming: has('tts_stream'),
    multilingual: has('multilingual'),
  };
}

/** True when a model can be cloned from the user's short WAV voice sample. */
export function ttsModelSupportsVoiceSample(
  capabilities: readonly string[] | null | undefined,
): boolean {
  return summarizeTtsCapabilities(capabilities).supportsVoiceSample;
}

/**
 * The app default TTS choice. `modelId`/`voiceId` are null until the user picks;
 * `enabled` gates whether the auto-voice/speak paths may use it at all.
 */
export type AppDefaultTtsSettings = {
  /**
   * When true, an agent with no voice of its own may speak with this default.
   * Off by default so nothing is spoken without the user asking for it.
   */
  enabled: boolean;
  /** Catalog TTS model id, or null for "no app default". */
  modelId: string | null;
  /** Voice preset / reference id for `modelId`, or null for the model's default. */
  voiceId: string | null;
  /**
   * Optional WAV clone sample for a `voice-cloning` model, so the app default can
   * be a cloned voice rather than only a catalog preset. Null when none is set;
   * ignored unless the selected model advertises `voice-cloning`.
   */
  voiceSampleRef: { bucketId: string; objectKey: string } | null;
  /** Transcript of {@link voiceSampleRef}; improves clone quality when present. */
  voiceSampleTranscript: string | null;
};

export const DEFAULT_APP_DEFAULT_TTS: AppDefaultTtsSettings = {
  enabled: false,
  modelId: null,
  voiceId: null,
  voiceSampleRef: null,
  voiceSampleTranscript: null,
};

/** Non-empty trimmed string, or null. */
function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Coerce a persisted/patched voice-sample ref. Both `bucketId` and `objectKey`
 * are required for the region to resolve the object, so a partial ref is dropped
 * rather than sent as a broken upload.
 */
function cleanSampleRef(
  raw: unknown,
): { bucketId: string; objectKey: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const bucketId = clean(value.bucketId);
  const objectKey = clean(value.objectKey);
  return bucketId && objectKey ? { bucketId, objectKey } : null;
}

/**
 * Coerce a persisted/patched app-default TTS block. A voice without a model is
 * meaningless (the voice list belongs to a model), so it is dropped; the sample
 * likewise needs a model to be cloned by. A disabled block keeps its model/voice
 * so re-enabling restores the user's pick.
 */
export function normalizeAppDefaultTts(raw: unknown): AppDefaultTtsSettings {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const modelId = clean(value.modelId);
  const voiceSampleRef = modelId ? cleanSampleRef(value.voiceSampleRef) : null;
  return {
    enabled: value.enabled === true,
    modelId,
    voiceId: modelId ? clean(value.voiceId) : null,
    voiceSampleRef,
    voiceSampleTranscript: voiceSampleRef ? clean(value.voiceSampleTranscript) : null,
  };
}

/**
 * Resolve the model/voice an agent with **no** override should speak with.
 * Returns null when the app default is off or unset, so callers fall through to
 * their other fallbacks instead of speaking with a half-configured default.
 *
 * The input is structural (not the full settings type) because the caller often
 * holds only the fields it read; every optional field defaults to "unset".
 */
export function resolveAppDefaultTts(
  settings:
    | (Partial<AppDefaultTtsSettings> & { enabled?: boolean; modelId?: string | null })
    | null
    | undefined,
): {
  modelId: string;
  voiceId: string | null;
  voiceSampleRef: { bucketId: string; objectKey: string } | null;
  voiceSampleTranscript: string | null;
} | null {
  if (!settings?.enabled || !settings.modelId) return null;
  return {
    modelId: settings.modelId,
    voiceId: settings.voiceId ?? null,
    voiceSampleRef: settings.voiceSampleRef ?? null,
    voiceSampleTranscript: settings.voiceSampleTranscript ?? null,
  };
}
