/**
 * Wake-word auto-mapping (shared, pure).
 *
 * Auto-mapping derives a wake word from each agent's *chat name*, so a user with
 * many agents does not have to type a phrase per agent. Because a list of every
 * agent is rarely what you want to be listening for, the default is a
 * **blocklist**: every agent is mapped except the ones the user excludes. A
 * whitelist mode instead maps only the listed agents.
 *
 * Only enabled agents are mapped, and the derived phrase is de-duplicated against
 * the manual bindings so a hand-written "Hey Jarvis" is never shadowed. This is a
 * pure transform over plain rows so it is fully unit-testable.
 *
 * TRUST: an auto-mapped wake carries exactly the same (non-)authority as a manual
 * one — it opens a conversation and dictates. It never authenticates.
 */

import {
  bindingPhrases,
  mergeBindingAliases,
  type WakeAgentRow,
  type WakeAutoMapMode,
  type WakeWordBinding,
} from './wake.js';

/** Default sensitivity for a derived phrase (the engine base is 0.5). */
const AUTO_SENSITIVITY = 0.5;

/**
 * Normalize a name into a speakable phrase: collapse whitespace and drop a
 * trailing role/qualifier in parentheses, e.g. `"Bob (support)"` -> `"Bob"`.
 * Returns null when nothing speakable remains.
 */
export function phraseFromAgentName(name: string): string | null {
  const withoutParen = (name ?? '').replace(/\s*[([{].*?[)\]}]\s*$/g, ' ');
  const cleaned = withoutParen.replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

/** Stable, collision-free id for a derived binding. */
export function autoBindingId(contactId: string): string {
  return `auto:${contactId}`;
}

/** True when an agent should be auto-mapped under the current mode. */
export function agentIsAutoMapped(
  contactId: string,
  mode: WakeAutoMapMode,
  ids: readonly string[],
): boolean {
  const listed = ids.includes(contactId);
  return mode === 'blocklist' ? !listed : listed;
}

/**
 * Build the effective binding list: the manual bindings plus a derived binding
 * for every auto-mapped agent. A manual binding always wins for a given phrase
 * or agent, so enabling auto-map never overrides an explicit choice.
 *
 * Derived bindings are returned last so the UI renders the user's own entries
 * first. Existing derived bindings for a still-mapped agent are preserved (so a
 * chosen model / sensitivity survives), keyed by their stable id.
 */
export function withAutoMappedBindings(input: {
  manual: readonly WakeWordBinding[];
  agents: readonly WakeAgentRow[];
  autoMap: boolean;
  mode: WakeAutoMapMode;
  ids: readonly string[];
  /** Case-insensitive phrases already spoken for; derived ones must not collide. */
  reservedPhrases?: readonly string[];
  /** Previously derived bindings, so the user's per-agent tweaks survive. */
  existing?: readonly WakeWordBinding[];
  /**
   * Global nicknames per phrase (see {@link WakeSettings.agentAliases}). Folding
   * them onto a derived binding here means an auto-mapped agent fires on its
   * nickname too, without the user having to hand-write a binding for it.
   */
  agentAliases?: Record<string, string[]>;
  /**
   * Model every derived binding uses. An agent is mapped to its own name, which
   * only a speech (STT) model can match — a fixed-phrase keyword model never can.
   * Null leaves derived bindings un-armed (the UI shows what to pick).
   */
  defaultModelId?: string | null;
}): WakeWordBinding[] {
  const manual = [...input.manual];
  if (!input.autoMap) return manual;

  const takenPhrases = new Set(
    [
      // A manual binding reserves both its primary phrase and every alias
      // (including global nicknames), so a derived agent name can never shadow
      // (or be shadowed by) a nickname.
      ...manual.flatMap((b) =>
        bindingPhrases({ phrase: b.phrase, aliases: mergeBindingAliases(b, input.agentAliases) }),
      ),
      ...(input.reservedPhrases ?? []),
    ]
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean),
  );
  const takenAgents = new Set(manual.map((b) => b.agentId).filter((id): id is string => Boolean(id)));
  const existingById = new Map((input.existing ?? []).map((b) => [b.id, b]));

  const derived: WakeWordBinding[] = [];
  for (const agent of input.agents) {
    if (!agent.contactId) continue;
    if (!agentIsAutoMapped(agent.contactId, input.mode, input.ids)) continue;
    if (takenAgents.has(agent.contactId)) continue;

    const phrase = phraseFromAgentName(agent.name);
    if (!phrase) continue;
    const key = phrase.toLowerCase();
    if (takenPhrases.has(key)) continue;
    takenPhrases.add(key);
    takenAgents.add(agent.contactId);

    const id = autoBindingId(agent.contactId);
    const prior = existingById.get(id);
    derived.push({
      id,
      phrase,
      // A derived binding inherits any aliases the user added to it previously
      // *and* the global nicknames for its phrase, so per-agent nicknames both
      // survive a recompute and work without a hand-written binding.
      aliases: mergeBindingAliases(
        { phrase, aliases: prior?.aliases ?? [] },
        input.agentAliases,
      ),
      agentId: agent.contactId,
      agentName: agent.name,
      modelId: prior?.modelId ?? input.defaultModelId ?? null,
      sensitivity: prior?.sensitivity ?? AUTO_SENSITIVITY,
      enabled: prior?.enabled ?? true,
      sampleRef: prior?.sampleRef ?? null,
      sampleFingerprint: prior?.sampleFingerprint ?? null,
    });
  }
  return [...manual, ...derived];
}

/** True when a binding was derived by auto-mapping (so the UI can mark it). */
export function isAutoBinding(binding: WakeWordBinding): boolean {
  return binding.id.startsWith('auto:');
}
