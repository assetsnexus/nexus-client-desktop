/**
 * The companion's display-label precedence — **never a raw internal id**.
 *
 * Mirrors the product-wide rule in `@nexus/chat-core` (`resolveConversationLabel`)
 * so the desktop companion cannot fork a second naming rule: a human-readable
 * name (the region's `displayTitle`, then a stored `name`/`title`, then an
 * `agentName` / `contact.name`) wins, and a neutral literal is the floor. A raw
 * id — `contactId`, `conversationId`, `agentId`, or a `1792316062792-nm26u6zve`
 * region id — is *never* a label. `looksLikeInternalId` is the exact predicate
 * the chat clients use to reject one, so the id-shape rule is shared rather than
 * re-derived here.
 *
 * Pure (no Electron, no DOM), so it is unit-tested directly and can be imported
 * by the companion renderer (header + tool windows), `ChatHost` (popout launch
 * params) and the main process (OS window title) without a second copy.
 */
import { looksLikeInternalId } from '@nexus/chat-core';

/** Shown when no human-readable name is available (the neutral literal). */
export const COMPANION_FALLBACK_LABEL = 'Companion';

/** First candidate that is a non-empty, non-id label; `''` when none qualifies. */
function firstSafeLabel(candidates: ReadonlyArray<string | null | undefined>): string {
  for (const candidate of candidates) {
    const text = typeof candidate === 'string' ? candidate.trim() : '';
    if (!text) continue;
    // A raw internal id (`1792316062792-nm26u6zve`, a UUID, a Mongo ObjectId) is
    // an address, not a name — skip it and keep looking (never render it).
    if (looksLikeInternalId(text)) continue;
    return text;
  }
  return '';
}

/**
 * Resolve the label a person should read for an agent/contact/room.
 *
 * Pass candidates highest-priority first (e.g. `displayTitle, name, agentName`).
 * Returns {@link COMPANION_FALLBACK_LABEL} when nothing human-readable is left.
 */
export function resolveCompanionLabel(
  ...candidates: ReadonlyArray<string | null | undefined>
): string {
  return firstSafeLabel(candidates) || COMPANION_FALLBACK_LABEL;
}

/**
 * Like {@link resolveCompanionLabel} but returns `null` (not the literal) when
 * nothing human-readable exists — for launch params, where a null `title` means
 * "let the receiver resolve one" rather than a baked-in placeholder.
 */
export function resolveCompanionLabelOrNull(
  ...candidates: ReadonlyArray<string | null | undefined>
): string | null {
  return firstSafeLabel(candidates) || null;
}

/** True when `value` may be shown as a human label (non-empty, not an id). */
export function isUsableCompanionLabel(value: unknown): boolean {
  return firstSafeLabel([typeof value === 'string' ? value : null]) !== '';
}
