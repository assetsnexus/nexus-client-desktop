/**
 * Wake-word configuration contract (shared by main + renderer).
 *
 * A wake word maps a spoken phrase to an agent, an on-device model, and an
 * optional recorded voice sample used to enrol a `custom_sample` detector.
 *
 * TRUST INVARIANTS (mirror `@nexus/wake-word`): a wake word is not
 * authentication. It only opens a voice session / dictation for the mapped agent
 * and can never satisfy 2FA / SCA / biometric approval / device trust, nor
 * trigger or approve a command. All detection is on-device.
 */

/** One wake-word → agent mapping. */
export type WakeWordBinding = {
  /** Stable local id. */
  id: string;
  /** The spoken phrase shown to the user (e.g. "Hey Jarvis"). */
  phrase: string;
  /** Chat contact id of the agent this word activates. */
  agentId: string | null;
  /** Display name of that agent, for the settings row. */
  agentName: string | null;
  /** Installed wake-model id (`catalog:…`); null = not chosen yet. */
  modelId: string | null;
  /** Detection sensitivity 0..1 (engine-specific mapping). */
  sensitivity: number;
  /** Whether this binding is armed. */
  enabled: boolean;
  /**
   * Optional recorded voice sample, stored by opaque ref in the private store.
   * Used to train a `custom_sample` detector on-device. Never uploaded.
   */
  sampleRef: string | null;
  /**
   * Device-local `custom_sample` fingerprint (base64 log-mel envelope). Derived
   * from a recorded sample at enrolment; non-invertible and never uploaded. When
   * present it takes precedence over `sampleRef`, so the detector needs no fetch.
   */
  sampleFingerprint: string | null;
};

/**
 * What a wake does:
 * - `chat` — open the agent's conversation and dictate into its composer;
 * - `widget` — show a small overlay (waveform + live transcript + agent avatar)
 *   without opening the chat;
 * - `companion` — open the agent's immersive companion window in voice mode.
 */
export type WakeActivationMode = 'chat' | 'widget' | 'companion';
/**
 * What happens to a captured transcript that was never submitted before the
 * timeout: `discard` drops it, `queue` keeps it for review next time.
 */
export type WakeUnsentPolicy = 'discard' | 'queue';
/**
 * `blocklist` (default) auto-maps every agent except those listed; `whitelist`
 * auto-maps only the listed agents.
 */
export type WakeAutoMapMode = 'blocklist' | 'whitelist';

export const WAKE_ACTIVATION_MODES: readonly WakeActivationMode[] = [
  'chat',
  'widget',
  'companion',
];

/** Default spoken phrases the settings UI suggests for submit-on-speak. */
export const SUGGESTED_SUBMIT_PHRASES = ['submit', 'answer now', 'send it', 'over'];

/** Unsubmitted-transcript timeout bounds, seconds. */
export const WAKE_TIMEOUT_MIN_SECONDS = 10;
export const WAKE_TIMEOUT_MAX_SECONDS = 30 * 60;
export const WAKE_TIMEOUT_DEFAULT_SECONDS = 60;

/**
 * Behaviour defaults for every existing user: keep the current "open chat and
 * dictate" behaviour, but add the safer review-before-send step and a 1-minute
 * discard, so an accidental background activation can never auto-send. Auto-map
 * is on by default (each agent's chat name is a candidate wake word) but is only
 * armed once wake listening itself is switched on; the derived words still need a
 * chosen/installed model, exactly like a manual one.
 */
export const DEFAULT_WAKE_BEHAVIOR = {
  activationMode: 'chat' as WakeActivationMode,
  reviewBeforeSend: true,
  submitPhrases: [] as string[],
  unsentPolicy: 'discard' as WakeUnsentPolicy,
  activationTimeoutSeconds: WAKE_TIMEOUT_DEFAULT_SECONDS,
  autoMapAgents: true,
  autoMapMode: 'blocklist' as WakeAutoMapMode,
  autoMapIds: [] as string[],
  /**
   * Model used for auto-mapped agents. An agent is mapped to its own *name*,
   * which no fixed-phrase keyword model can match, so this is normally a speech
   * (STT) model that transcribes on-device and matches the phrase as text.
   */
  autoMapModelId: null as string | null,
};

export type WakeSettings = {
  /** Master switch for on-device wake listening. */
  enabled: boolean;
  bindings: WakeWordBinding[];
  /** What a wake does (see {@link WakeActivationMode}). */
  activationMode: WakeActivationMode;
  /**
   * When true (default), a finished transcript is placed in the composer/
   * dictation buffer for review and is **not** sent automatically. The realtime
   * voice-call path is always auto regardless of this flag.
   */
  reviewBeforeSend: boolean;
  /**
   * 0..n spoken phrases that end a turn and submit it (e.g. "submit",
   * "answer now"). Matched case-insensitively at the end of a transcript; the
   * phrase itself is stripped before sending. Empty = only manual submit.
   */
  submitPhrases: string[];
  /** What to do with a transcript that was never submitted before the timeout. */
  unsentPolicy: WakeUnsentPolicy;
  /** Seconds before an unsubmitted wake transcript hits the unsent policy. */
  activationTimeoutSeconds: number;
  /**
   * Auto-map every agent to a wake word equal to its chat name. Off leaves only
   * the manually configured {@link WakeSettings.bindings}.
   */
  autoMapAgents: boolean;
  /** Blocklist (default) vs whitelist for auto-mapping. */
  autoMapMode: WakeAutoMapMode;
  /** Agent ids (chat contact ids) excluded by / included in auto-mapping. */
  autoMapIds: string[];
  /**
   * Model id every auto-mapped agent binding uses. Because an agent is mapped to
   * its own name, this should be a speech (STT) model — a fixed-phrase keyword
   * model can never match an arbitrary name. Null = auto-mapped agents are inert.
   */
  autoMapModelId: string | null;
};

/**
 * One mappable agent for the wake settings picker. A trimmed projection of the
 * region virtual-employee rows — the picker only needs an id, a label, and
 * whether the caller may configure it.
 */
export type WakeAgentRow = {
  /** Chat contact id used when routing a wake (`anx.communicate` contact id). */
  contactId: string;
  virtualEmployeeId: string;
  agentId: string | null;
  name: string;
  /** True for an owned employee (from `virtual-employees.list`). */
  canConfigure: boolean;
};

export const DEFAULT_WAKE_SETTINGS: WakeSettings = {
  enabled: false,
  bindings: [],
  ...DEFAULT_WAKE_BEHAVIOR,
};

/** Clamp a sensitivity value into the valid 0..1 range. */
export function clampSensitivity(value: unknown, fallback = 0.5): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(1, Math.max(0, n));
}

/** Normalize one submit phrase: trimmed, non-empty, lowercased for matching. */
export function normalizeSubmitPhrase(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.toLowerCase() : null;
}

/** Coerce a submit-phrase list: strings only, deduped, order preserved. */
export function normalizeSubmitPhrases(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const phrase = normalizeSubmitPhrase(entry);
    if (!phrase || seen.has(phrase)) continue;
    seen.add(phrase);
    out.push(phrase);
  }
  return out;
}

/** Clamp the unsubmitted-transcript timeout into its valid range, in seconds. */
export function clampWakeTimeout(value: unknown, fallback = WAKE_TIMEOUT_DEFAULT_SECONDS): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(WAKE_TIMEOUT_MAX_SECONDS, Math.max(WAKE_TIMEOUT_MIN_SECONDS, Math.round(n)));
}

function normaliseBinding(raw: unknown, index: number): WakeWordBinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const phrase = typeof r.phrase === 'string' ? r.phrase.trim() : '';
  if (!phrase) return null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    id: str(r.id) ?? `wake-${index}-${phrase.toLowerCase().replace(/\s+/g, '-')}`,
    phrase,
    agentId: str(r.agentId),
    agentName: str(r.agentName),
    modelId: str(r.modelId),
    sensitivity: clampSensitivity(r.sensitivity),
    enabled: r.enabled !== false,
    sampleRef: str(r.sampleRef),
    sampleFingerprint: str(r.sampleFingerprint),
  };
}

/**
 * Coerce one untrusted binding (e.g. one sent back over IPC to arm a detector).
 * Exported so the main process validates the renderer's payload exactly like a
 * persisted file, rather than trusting it.
 */
export function normalizeWakeBinding(raw: unknown, index = 0): WakeWordBinding | null {
  return normaliseBinding(raw, index);
}

/** Coerce an untrusted persisted blob into valid wake settings. */
export function normalizeWakeSettings(raw: unknown): WakeSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawBindings = Array.isArray(r.bindings) ? r.bindings : [];
  const bindings: WakeWordBinding[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawBindings.length; i++) {
    const binding = normaliseBinding(rawBindings[i], i);
    if (!binding || seen.has(binding.id)) continue;
    seen.add(binding.id);
    bindings.push(binding);
  }
  return {
    enabled: r.enabled === true,
    bindings,
    activationMode: WAKE_ACTIVATION_MODES.includes(r.activationMode as WakeActivationMode)
      ? (r.activationMode as WakeActivationMode)
      : DEFAULT_WAKE_BEHAVIOR.activationMode,
    reviewBeforeSend:
      typeof r.reviewBeforeSend === 'boolean'
        ? r.reviewBeforeSend
        : DEFAULT_WAKE_BEHAVIOR.reviewBeforeSend,
    submitPhrases: normalizeSubmitPhrases(r.submitPhrases),
    unsentPolicy:
      r.unsentPolicy === 'queue' || r.unsentPolicy === 'discard'
        ? r.unsentPolicy
        : DEFAULT_WAKE_BEHAVIOR.unsentPolicy,
    activationTimeoutSeconds: clampWakeTimeout(r.activationTimeoutSeconds),
    autoMapAgents:
      typeof r.autoMapAgents === 'boolean' ? r.autoMapAgents : DEFAULT_WAKE_BEHAVIOR.autoMapAgents,
    autoMapMode:
      r.autoMapMode === 'whitelist' || r.autoMapMode === 'blocklist'
        ? r.autoMapMode
        : DEFAULT_WAKE_BEHAVIOR.autoMapMode,
    autoMapIds: normalizeIdList(r.autoMapIds),
    autoMapModelId: typeof r.autoMapModelId === 'string' ? r.autoMapModelId : null,
  };
}

/** Coerce an untrusted string-id list: trimmed, non-empty, deduped, in order. */
function normalizeIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of raw) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** True when a binding is fully configured and can actually be armed. */
/**
 * True when the binding has everything the *binding itself* can supply (enabled,
 * a chosen model, or a recorded sample). Install / server readiness is checked
 * later by main, which alone knows the catalog and the local STT target.
 */
export function bindingIsArmed(binding: WakeWordBinding, engineKind?: WakeEngineKind): boolean {
  return bindingUnavailableReason(binding, engineKind) === null;
}

/** One queued (unsubmitted) wake transcript, surfaced the next time chat opens. */
export type QueuedUtterance = {
  id: string;
  /** Agent the utterance was addressed to, when known. */
  agentId: string | null;
  agentName: string | null;
  text: string;
  /** When it was captured (epoch ms). */
  at: number;
  /** The wake phrase that opened the session, if any. */
  phrase: string | null;
};

/** Cap the queue so an unattended microphone cannot grow it without bound. */
export const MAX_QUEUED_UTTERANCES = 20;

/**
 * Whether wake-triggered *dictation* will transcribe in the cloud (audio leaves
 * the device). The user configured `local`, but a local engine only exists when
 * a model is installed (or a custom local endpoint is set); otherwise the
 * dictation falls back to region inference. The UI uses this to decide whether a
 * visible "streaming to the cloud" surface must be forced up.
 */
export function dictationTranscribesInCloud(input: {
  sttEngine: 'cloud' | 'local';
  localSttAvailable: boolean;
  customSttEndpoint: boolean;
}): boolean {
  if (input.sttEngine === 'cloud') return true;
  return !(input.localSttAvailable || input.customSttEndpoint);
}

/** Push a new queued utterance, keeping the newest {@link MAX_QUEUED_UTTERANCES}. */
export function enqueueUtterance(
  queue: readonly QueuedUtterance[],
  entry: QueuedUtterance,
): QueuedUtterance[] {
  return [...queue.filter((q) => q.id !== entry.id), entry].slice(-MAX_QUEUED_UTTERANCES);
}

/** Drop one queued utterance by id. */
export function dequeueUtterance(
  queue: readonly QueuedUtterance[],
  id: string,
): QueuedUtterance[] {
  return queue.filter((q) => q.id !== id);
}

/** Coerce an untrusted persisted queue into valid entries. */
export function normalizeUtteranceQueue(raw: unknown): QueuedUtterance[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: QueuedUtterance[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const text = typeof r.text === 'string' ? r.text.trim() : '';
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : '';
    if (!text || !id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      agentId: typeof r.agentId === 'string' && r.agentId ? r.agentId : null,
      agentName: typeof r.agentName === 'string' && r.agentName ? r.agentName : null,
      text,
      at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0,
      phrase: typeof r.phrase === 'string' && r.phrase ? r.phrase : null,
    });
  }
  return out.slice(-MAX_QUEUED_UTTERANCES);
}

/**
 * The detector kind a binding should use:
 * - `custom_sample` — an enrolled voice sample trains a correlation detector;
 * - `stt_phrase` — a locally-installed STT model transcribes gated speech and the
 *   phrase is matched as text (works for ANY phrase, e.g. an agent's name);
 * - `builtin` — a fixed-phrase keyword model (openWakeWord) that only fires on
 *   the phrase it was trained for.
 *
 * The binding alone cannot tell `builtin` from `stt_phrase`: that depends on the
 * *kind of the chosen model*, which only the main process's catalog knows. Main
 * therefore reports the final kind in its resolution; this helper is the
 * binding-only fallback (sample ⇒ custom, otherwise builtin).
 */
export type WakeEngineKind = 'builtin' | 'custom_sample' | 'stt_phrase';

export function bindingEngineKind(binding: WakeWordBinding): 'builtin' | 'custom_sample' {
  return binding.sampleFingerprint || binding.sampleRef ? 'custom_sample' : 'builtin';
}

/**
 * Explains why a binding cannot currently be armed, or null when it is ready.
 * Mirrors the reasoning the settings UI shows so main and renderer agree.
 *
 * `engineKind` (from main) refines the reason for an STT-phrase binding, whose
 * only requirement is a chosen model — the install check happens in main.
 */
export function bindingUnavailableReason(
  binding: WakeWordBinding,
  engineKind?: WakeEngineKind,
): string | null {
  if (!binding.enabled) return 'This wake word is turned off.';
  const kind = engineKind ?? bindingEngineKind(binding);
  // A custom-sample detector needs the sample only, not a keyword model.
  if (kind === 'custom_sample') return null;
  if (!binding.modelId) return 'Choose a wake-word model first.';
  return null;
}

/**
 * True when a model label names one of the heavy Whisper builds (`large`,
 * `turbo`, `medium`). Wake gating only spots a short phrase, so a large model
 * makes on-device recognition lag speech (a 574 MB turbo build took ~30s per
 * utterance on a CPU-only box); the settings UI uses this to point the user at a
 * small model instead of leaving "it's slow" unexplained.
 */
export function isLargeWakeModel(label: string | null | undefined): boolean {
  const text = (label ?? '').toLowerCase();
  return /large|turbo|medium/.test(text);
}
