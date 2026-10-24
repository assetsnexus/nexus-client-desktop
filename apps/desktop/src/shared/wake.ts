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
  /**
   * 0..n alternate phrases that activate the *same* agent (e.g. the nickname
   * "Zeni" for "Xeni"). Match by on-device speech recognition, aliases work for
   * any phrase the engine's model can transcribe; they are normalized, deduped,
   * and never collide with the primary phrase. Empty = no aliases.
   */
  aliases: string[];
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

/**
 * How a wake turn captures audio. Both modes share one microphone stream:
 * - `live`  — stream an on-device STT preview into the field (no audio batch);
 * - `batch` — record an audio batch and send it as a voice message (cloud/custom
 *   STT), with no live preview;
 * - `both`  — do both in parallel (default), so the user can send either the
 *   transcript or the recording.
 */
export type WakeCaptureMode = 'live' | 'batch' | 'both';

export const WAKE_CAPTURE_MODES: readonly WakeCaptureMode[] = ['live', 'batch', 'both'];

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
  /**
   * When true, a wake word opens the referenced agent in the immersive companion
   * window in **voice mode** (and its realtime voice session owns dictation).
   * Independent of {@link WakeActivationMode} so the widget's one-click toggle can
   * turn it on without disturbing the mode the user picked. Default off.
   */
  companionOnWake: false,
  /**
   * Dual-mode capture (live STT preview + parallel audio batch) so the user can
   * send either the transcript or the recording. `both` is the default; `live`
   * skips the audio batch, `batch` skips the live preview.
   */
  captureMode: 'both' as WakeCaptureMode,
  reviewBeforeSend: true,
  submitPhrases: [] as string[],
  unsentPolicy: 'discard' as WakeUnsentPolicy,
  activationTimeoutSeconds: WAKE_TIMEOUT_DEFAULT_SECONDS,
  autoMapAgents: true,
  autoMapMode: 'blocklist' as WakeAutoMapMode,
  autoMapIds: [] as string[],
  /**
   * Nicknames keyed by the phrase they belong to (lowercased), e.g.
   * `{ xeni: ['Zeni'] }`. Applied to *every* binding whose phrase matches —
   * including auto-mapped agents, which are derived at runtime and therefore
   * have nowhere else to persist an alias.
   */
  agentAliases: {} as Record<string, string[]>,
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
   * When true, a wake opens the referenced agent in the companion window in
   * voice mode, regardless of {@link activationMode}. Surfaced as a one-click
   * link in the listening widget as well as the settings panel. Default off.
   */
  companionOnWake: boolean;
  /**
   * How a wake turn captures audio: `live` (on-device STT preview only), `batch`
   * (audio batch only), or `both` (parallel — the default). See
   * {@link WakeCaptureMode}.
   */
  captureMode: WakeCaptureMode;
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
  /**
   * Nicknames per agent, keyed by the (lowercased) phrase they wake — e.g.
   * `{ xeni: ['Zeni'] }`. Aliases configured on a *manual* binding live on the
   * binding itself ({@link WakeWordBinding.aliases}); this map is the one place
   * an alias can be attached to an auto-mapped agent, whose binding is derived
   * on every arm and therefore has nothing stable to hold it. Both are merged
   * when a binding is armed, so a nickname wakes either kind of agent.
   */
  agentAliases: Record<string, string[]>;
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

/** Cap on alternate phrases per binding, so one agent cannot arm unbounded detectors. */
export const MAX_WAKE_ALIASES = 8;

/**
 * Normalize one alias phrase: trimmed, whitespace-collapsed, and rejected when
 * it is empty or simply repeats the primary phrase (an alias must add a *new*
 * phrase, not duplicate the one already spoken for).
 */
export function normalizeAliasPhrase(raw: unknown, primary: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === (primary ?? '').trim().toLowerCase()) return null;
  return trimmed;
}

/**
 * Coerce a binding's alias list: strings only, trimmed, deduped (case-insensitive),
 * order preserved, and never equal to the primary phrase. Bounded so a runaway
 * list cannot bloat the persisted settings or arm an unreasonable number of
 * detectors for one agent.
 */
export function normalizeAliasList(raw: unknown, primary: string): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>([(primary ?? '').trim().toLowerCase()]);
  for (const entry of raw) {
    const alias = normalizeAliasPhrase(entry, primary);
    if (!alias) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
    if (out.length >= MAX_WAKE_ALIASES) break;
  }
  return out;
}

/** Normalize the phrase key used by {@link WakeSettings.agentAliases}. */
export function aliasKey(phrase: string | null | undefined): string {
  return (phrase ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Coerce the untrusted `agentAliases` map: string keys (normalized), alias
 * values normalized against the key phrase, deduped and bounded per phrase.
 */
export function normalizeAgentAliases(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const phrase = aliasKey(key);
    if (!phrase) continue;
    // The key is itself a phrase, so normalize aliases against it: an alias may
    // never simply repeat the phrase it is a nickname for.
    const aliases = normalizeAliasList(value, phrase);
    if (aliases.length) out[phrase] = aliases;
  }
  return out;
}

/**
 * Aliases configured globally for a phrase (see {@link WakeSettings.agentAliases}).
 * Exposed so the settings UI and tests can read one phrase's nicknames without
 * knowing the key shape.
 */
export function aliasesForPhrase(
  agentAliases: Record<string, string[]> | undefined,
  phrase: string | null | undefined,
): string[] {
  if (!agentAliases) return [];
  return agentAliases[aliasKey(phrase)] ?? [];
}

/**
 * Merge a binding's own aliases with the aliases configured for its phrase in
 * settings. Order is binding-first (an inline alias is more specific), both are
 * normalized, deduped case-insensitively, and bounded by {@link MAX_WAKE_ALIASES}.
 * This is what the arm loop uses, so a nickname reaches both manual and derived
 * (auto-mapped) bindings.
 */
export function mergeBindingAliases(
  binding: Pick<WakeWordBinding, 'phrase' | 'aliases'>,
  agentAliases?: Record<string, string[]>,
): string[] {
  const combined = [...(binding.aliases ?? []), ...aliasesForPhrase(agentAliases, binding.phrase)];
  return normalizeAliasList(combined, binding.phrase);
}

/**
 * Every phrase a binding should arm: its primary phrase plus any aliases, in
 * order. The arm loop registers one detector per phrase, all mapped to the same
 * agent, so a nickname wakes the agent exactly like its name does.
 */
export function bindingPhrases(binding: Pick<WakeWordBinding, 'phrase' | 'aliases'>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null | undefined) => {
    const value = (raw ?? '').trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };
  push(binding.phrase);
  for (const alias of binding.aliases ?? []) push(alias);
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
    aliases: normalizeAliasList(r.aliases, phrase),
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
    companionOnWake:
      typeof r.companionOnWake === 'boolean'
        ? r.companionOnWake
        : DEFAULT_WAKE_BEHAVIOR.companionOnWake,
    captureMode: WAKE_CAPTURE_MODES.includes(r.captureMode as WakeCaptureMode)
      ? (r.captureMode as WakeCaptureMode)
      : DEFAULT_WAKE_BEHAVIOR.captureMode,
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
    agentAliases: normalizeAgentAliases(r.agentAliases),
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
 * Resolve which surface a wake should target. Single source of truth shared by
 * the renderer router (which opens the surface) and main (which decides whether
 * to foreground the main window — a companion wake must **not**, so only the
 * addressed agent's companion pops forward).
 *
 * Precedence:
 *  - `companionOnWake` wins: the immersive companion owns the session (and, being
 *    its own surface, is the one path that does not stream dictation to cloud STT);
 *  - cloud transcription forces the compact **widget** so the streaming is always
 *    visible, even if the user configured "open chat" / "companion";
 *  - otherwise the user's configured {@link WakeSettings.activationMode}.
 */
export function resolveWakeActivationMode(input: {
  activationMode: WakeActivationMode;
  companionOnWake: boolean;
  cloudTranscription: boolean;
}): WakeActivationMode {
  if (input.companionOnWake) return 'companion';
  if (input.cloudTranscription) return 'widget';
  return input.activationMode;
}

/**
 * Companion-first focus policy. A wake that resolves to **companion** mode must
 * not force the main window forward — only the addressed agent's companion should
 * pop forward. Main can decide this from persisted settings alone (it cannot run
 * the renderer's cloud-transcription probe synchronously), so an explicit
 * `companion` mode or the one-click `companionOnWake` link both count.
 *
 * A companion-mode wake still raises the main window when the mapped agent has no
 * open companion window yet (there is nothing else to pop forward).
 */
export function wakeRaisesMainWindow(input: {
  settings: Pick<WakeSettings, 'activationMode' | 'companionOnWake'>;
  /** Whether the mapped agent already has an open companion window. */
  companionOpen: boolean;
}): boolean {
  const wantsCompanion =
    input.settings.companionOnWake || input.settings.activationMode === 'companion';
  return !(wantsCompanion && input.companionOpen);
}

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
