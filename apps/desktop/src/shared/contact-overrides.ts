/**
 * Per-agent overrides (shared, pure).
 *
 * A few companion behaviours are genuinely per-agent, and the user should not
 * have to change a global setting to give one agent a different treatment:
 *
 *  - **placement**: where *this* agent's companion window appears (the global
 *    `companionPlacement` stays the default for every agent that has no
 *    override);
 *  - **open-on-message**: whether an unattended message from *this* agent pops
 *    its companion (tri-state: `undefined` = inherit the global switch).
 *
 * Everything else that varies per agent already has its own store — the avatar
 * library mapping (`local-avatar-store`), the wake aliases (`WakeSettings.agentAliases`),
 * and the reply voice (`anx.agents.contact-tts.*` on the contact). This module is
 * therefore deliberately small: it holds only the two settings that had nowhere
 * else to live, keyed by chat contact id.
 *
 * The whole block is normalized field-by-field on every read, so a hand-edited
 * settings file (or a contact id that never existed) can never produce an invalid
 * mode or an orphaned entry.
 */

import {
  COMPANION_PLACEMENT_MODES,
  type CompanionPlacementMode,
} from './companion-placement.js';

/** Overrides for one agent/contact. Absent keys mean "inherit the global value". */
export type ContactOverride = {
  /** Companion spawn placement for this agent, overriding the global mode. */
  placementMode?: CompanionPlacementMode;
  /** Pop this agent's companion on an unattended message (`undefined` = inherit). */
  openCompanionOnMessage?: boolean;
};

/** contactId → override. Contacts with no overrides are omitted. */
export type ContactOverrides = Record<string, ContactOverride>;

function isPlacementMode(value: unknown): value is CompanionPlacementMode {
  return (
    typeof value === 'string' &&
    (COMPANION_PLACEMENT_MODES as readonly string[]).includes(value)
  );
}

/** Coerce one entry; returns null when nothing usable remains (drop the key). */
export function normalizeContactOverride(raw: unknown): ContactOverride | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const next: ContactOverride = {};
  if (isPlacementMode(rec.placementMode)) next.placementMode = rec.placementMode;
  if (typeof rec.openCompanionOnMessage === 'boolean') {
    next.openCompanionOnMessage = rec.openCompanionOnMessage;
  }
  return Object.keys(next).length ? next : null;
}

/** Coerce a persisted/patched overrides map, dropping empty/unknown entries. */
export function normalizeContactOverrides(raw: unknown): ContactOverrides {
  if (!raw || typeof raw !== 'object') return {};
  const out: ContactOverrides = {};
  for (const [contactId, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(contactId).trim();
    if (!key) continue;
    const entry = normalizeContactOverride(value);
    if (entry) out[key] = entry;
  }
  return out;
}

/** The override for one contact, or an empty object when none is set. */
export function contactOverrideFor(
  overrides: ContactOverrides | null | undefined,
  contactId: string | null | undefined,
): ContactOverride {
  if (!overrides || !contactId) return {};
  return overrides[contactId] ?? {};
}

/**
 * The placement mode a contact should use: its own override when set, else the
 * global mode. Kept here (rather than in the window manager) so both the main
 * process and any UI preview read the same rule.
 */
export function placementModeForContact(input: {
  overrides: ContactOverrides | null | undefined;
  contactId: string | null | undefined;
  globalMode: CompanionPlacementMode;
}): CompanionPlacementMode {
  return contactOverrideFor(input.overrides, input.contactId).placementMode ?? input.globalMode;
}

/**
 * Whether an unattended message from this contact should open its companion.
 * A per-agent `false` wins over a global `true` (explicit opt-out); otherwise the
 * global switch decides.
 */
export function shouldOpenCompanionForContact(input: {
  overrides: ContactOverrides | null | undefined;
  contactId: string | null | undefined;
  globalOpen: boolean;
}): boolean {
  const override = contactOverrideFor(input.overrides, input.contactId).openCompanionOnMessage;
  return override === undefined ? input.globalOpen : override;
}
