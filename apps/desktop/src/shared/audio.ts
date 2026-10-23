/**
 * Audio device preferences (inputs + outputs).
 *
 * Kept in the shared layer (not renderer-only) so the main process can persist it
 * with the rest of the UI settings and both processes validate the same shape.
 *
 * Two independent concerns:
 *  - **output**: which speaker agent speech goes to by default, and which *other*
 *    speakers the user allows an agent to redirect to (or broadcast across). The
 *    agent reaches those through client tools.
 *  - **input**: the single microphone used for the user's speech-to-text, plus
 *    0..n additional microphones that also listen for wake words so a phrase
 *    spoken near any of them activates the agent.
 *
 * Device ids are opaque Chromium MediaDeviceInfo ids (or `null` for the OS
 * default). They are stored as-is; a device that disappears simply becomes
 * "unavailable" in the UI rather than being silently dropped.
 */

export type AudioOutputSettings = {
  /** Preferred speaker for agent speech; `null` = the OS default output. */
  primaryOutputId: string | null;
  /** Extra speakers the agent may switch to / broadcast on. */
  allowedOutputIds: string[];
};

export type AudioInputSettings = {
  /** Microphone used for the user's speech-to-text dictation; `null` = default. */
  primaryInputId: string | null;
  /** Additional microphones that listen for wake words; may be empty. */
  wakeInputIds: string[];
};

export type AudioSettings = {
  output: AudioOutputSettings;
  input: AudioInputSettings;
};

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  output: { primaryOutputId: null, allowedOutputIds: [] },
  input: { primaryInputId: null, wakeInputIds: [] },
};

/** A device id is either a non-empty string or the OS default (`null`). */
function normalizeDeviceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** De-duplicate a device-id list, dropping blanks and the default sentinel. */
function normalizeDeviceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const id = normalizeDeviceId(entry);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Coerce a persisted/patched audio block, dropping any unknown keys. */
export function normalizeAudioSettings(raw: unknown): AudioSettings {
  if (!raw || typeof raw !== 'object') {
    return {
      output: { ...DEFAULT_AUDIO_SETTINGS.output, allowedOutputIds: [] },
      input: { ...DEFAULT_AUDIO_SETTINGS.input, wakeInputIds: [] },
    };
  }
  const rec = raw as Record<string, unknown>;
  const output = (rec.output && typeof rec.output === 'object' ? rec.output : {}) as Record<
    string,
    unknown
  >;
  const input = (rec.input && typeof rec.input === 'object' ? rec.input : {}) as Record<
    string,
    unknown
  >;
  const primaryOutputId = normalizeDeviceId(output.primaryOutputId);
  const allowedOutputIds = normalizeDeviceIds(output.allowedOutputIds).filter(
    (id) => id !== primaryOutputId,
  );
  return {
    output: { primaryOutputId, allowedOutputIds },
    input: {
      primaryInputId: normalizeDeviceId(input.primaryInputId),
      wakeInputIds: normalizeDeviceIds(input.wakeInputIds),
    },
  };
}

/** Where an agent asked speech to go. */
export type AudioOutputTarget = 'primary' | 'all' | string;

/**
 * Resolve an agent's output request to the concrete device ids that are allowed.
 *
 * - `primary` → the configured primary (empty list = let the OS default apply).
 * - `all` → the primary plus every allow-listed speaker (de-duplicated).
 * - a device id → that device **only if** it is the primary or allow-listed;
 *   anything else resolves to an empty list (refused) so an agent can never
 *   hijack a speaker the user did not permit.
 */
export function resolveOutputTargets(
  settings: AudioSettings,
  target: AudioOutputTarget,
): string[] {
  const primary = settings.output.primaryOutputId;
  const allowed = settings.output.allowedOutputIds;
  if (target === 'primary') return primary ? [primary] : [];
  if (target === 'all') {
    const out: string[] = [];
    if (primary) out.push(primary);
    for (const id of allowed) if (!out.includes(id)) out.push(id);
    return out;
  }
  const requested = normalizeDeviceId(target);
  if (!requested) return [];
  if (requested === primary || allowed.includes(requested)) return [requested];
  return [];
}

/** True when the user has permitted the agent any redirection at all. */
export function hasAgentOutputTargets(settings: AudioSettings): boolean {
  return Boolean(settings.output.primaryOutputId) || settings.output.allowedOutputIds.length > 0;
}
