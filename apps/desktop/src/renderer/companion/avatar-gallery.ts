/**
 * Companion avatar gallery (pure helpers).
 *
 * The companion window shows one agent at full bleed. This module owns the
 * *selection* policy for what fills that stage:
 *
 *  - a **VRM** model when one is available for the agent (its configured
 *    `presence.vrmUrl`, or a verified/public row from the avatar catalog), and
 *  - a **profile image** fallback (the contact's `avatarUrl`);
 *
 * and lets the user switch between them like a small gallery. All functions here
 * are pure so the fallback + selection + persistence logic is unit tested without
 * Electron, React, or a region connection.
 *
 * Persistence reuses the same `ParticipantPresenceV1` shape the rest of the chat
 * surface writes for VRM selection (`mergeParticipantPresenceV1`), and stores the
 * *mode* (vrm vs image) in a tiny local key keyed by contact id.
 */

import {
  mergeParticipantPresenceV1,
  type ParticipantPresenceV1,
} from '@nexus/chat-core';

/** The presence fields the gallery reads (read defensively — the shape is loose). */
export type CompanionPresenceLike = {
  /** Presence doc version (loose — the gallery never validates it). */
  v?: unknown;
  vrmUrl?: unknown;
  vrmAssetId?: unknown;
  vrmValidationStatus?: unknown;
};

function readPresenceString(presence: CompanionPresenceLike | null | undefined, key: 'vrmUrl'): string | null {
  const value = presence ? presence[key] : undefined;
  return typeof value === 'string' && value.trim() ? value : null;
}

function readPresenceStringOrNull(
  presence: CompanionPresenceLike | null | undefined,
  key: 'vrmAssetId' | 'vrmValidationStatus',
): string | null {
  const value = presence ? presence[key] : undefined;
  return typeof value === 'string' ? value : null;
}

/** What a gallery tile represents. */
export type CompanionAvatarKind = 'vrm' | 'image';

export type CompanionAvatarChoice = {
  /** Stable id: `image:<contactId>` | `presence:vrm` | `vrm:<assetId>`. */
  id: string;
  kind: CompanionAvatarKind;
  label: string;
  /** VRM/manifest URL (kind `vrm`) or picture URL (kind `image`); null when unusable. */
  url: string | null;
  /** Catalog asset id when the choice came from `anx.inference.avatar-assets.list`. */
  assetId?: string | null;
  /**
   * Catalog validation status, carried into presence as `vrmValidationStatus`.
   * The character kit refuses to HTTP-fetch a non-platform VRM without it
   * (`avatar-asset-gate.ts` → `missing_validation_status`), so this must travel
   * with the selection.
   */
  validationStatus?: string | null;
};

/** The subset of a catalog row the gallery reads (matches the region public view). */
export type CompanionAvatarAsset = {
  id: string;
  kind?: string | null;
  url?: string | null;
  validationStatus?: string | null;
  visibility?: string | null;
  ownerId?: string | null;
  name?: string | null;
};

export type CompanionAvatarContact = {
  id: string;
  name: string;
  avatarUrl?: string | null;
};

/** True for catalog kinds that describe a 3D avatar model rather than an animation or picture. */
export function isAvatarModelKind(kind: string | null | undefined): boolean {
  // `vrma`/`manifest` are *gesture* packs (animation clips), never avatars —
  // the catalog maps them to gesture fields, not `vrmUrl`
  // (`presencePatchFromCatalogAsset`). Absent kind defaults to `vrm` (the
  // region's own default) so a legacy row without a kind still renders.
  const k = (kind ?? 'vrm').toLowerCase();
  return k === 'vrm';
}

/** True for catalog kinds that describe a 2D avatar portrait. */
export function isPictureAssetKind(kind: string | null | undefined): boolean {
  const k = (kind ?? '').toLowerCase();
  return k === 'picture' || k === 'image' || k === 'portrait';
}

/**
 * Build the ordered gallery for an agent:
 *  1. the profile image (always available as a fallback when the contact has one),
 *  2. the agent's configured VRM (`presence.vrmUrl`), then
 *  3. every usable catalog avatar row — 3D VRM models and 2D portraits.
 *
 * Gesture packs (`vrma`/`manifest`) are deliberately excluded: the region maps
 * those to animation clips, not avatars. Duplicate URLs are collapsed, and
 * blob:/data: model URLs are rejected (a `blob:` URL is per-session and must
 * never be persisted — same rule the config sheet enforces).
 */
export function buildAvatarChoices(input: {
  contact: CompanionAvatarContact | null;
  presence?: CompanionPresenceLike | null;
  assets?: CompanionAvatarAsset[] | null;
}): CompanionAvatarChoice[] {
  const choices: CompanionAvatarChoice[] = [];
  const seenVrmUrls = new Set<string>();

  const pushVrm = (choice: CompanionAvatarChoice) => {
    if (!choice.url || choice.url.startsWith('blob:') || choice.url.startsWith('data:')) return;
    if (seenVrmUrls.has(choice.url)) return;
    seenVrmUrls.add(choice.url);
    choices.push(choice);
  };

  if (input.contact?.avatarUrl) {
    choices.push({
      id: `image:${input.contact.id}`,
      kind: 'image',
      label: 'Profile image',
      url: input.contact.avatarUrl,
    });
  }

  const configuredVrm = readPresenceString(input.presence, 'vrmUrl');
  if (configuredVrm) {
    pushVrm({
      id: 'presence:vrm',
      kind: 'vrm',
      label: 'Agent avatar (3D)',
      url: configuredVrm,
      assetId: readPresenceStringOrNull(input.presence, 'vrmAssetId'),
      validationStatus: readPresenceStringOrNull(input.presence, 'vrmValidationStatus'),
    });
  }

  for (const asset of input.assets ?? []) {
    if (!asset || !asset.url) continue;
    if (isPictureAssetKind(asset.kind)) {
      choices.push({
        id: `image:${asset.id}`,
        kind: 'image',
        label: asset.name || 'Profile image',
        url: asset.url,
      });
      continue;
    }
    if (!isAvatarModelKind(asset.kind)) continue; // gesture packs (vrma/manifest) are not avatars
    pushVrm({
      id: `vrm:${asset.id}`,
      kind: 'vrm',
      label: asset.name || 'Catalog model',
      url: asset.url,
      assetId: asset.id,
      validationStatus: asset.validationStatus ?? null,
    });
  }

  return choices;
}

/** What the companion renders once a choice is resolved. */
export type ResolvedCompanionAvatar = {
  choice: CompanionAvatarChoice;
  /** Set for VRM choices; drives `VoiceAvatarCanvas` via presence. */
  vrmUrl: string | null;
  vrmAssetId: string | null;
  /** Catalog validation status, forwarded to `vrmValidationStatus` (see gate). */
  vrmValidationStatus: string | null;
  /** Set for image choices; drives the `CachedAvatarImage` fallback slot. */
  imageUrl: string | null;
};

/**
 * Resolve the active choice. Prefers the stored choice id when it still exists,
 * then the first VRM (a 3D model is the richer surface), then the first image,
 * then null when the agent has no avatar at all.
 */
export function resolveAvatarSelection(
  choices: CompanionAvatarChoice[],
  storedChoiceId?: string | null,
): ResolvedCompanionAvatar | null {
  if (!choices.length) return null;
  const stored = storedChoiceId ? choices.find((c) => c.id === storedChoiceId) : undefined;
  const chosen = stored ?? choices.find((c) => c.kind === 'vrm') ?? choices[0]!;
  return {
    choice: chosen,
    vrmUrl: chosen.kind === 'vrm' ? chosen.url : null,
    vrmAssetId: chosen.kind === 'vrm' ? (chosen.assetId ?? null) : null,
    vrmValidationStatus: chosen.kind === 'vrm' ? (chosen.validationStatus ?? null) : null,
    imageUrl: chosen.kind === 'image' ? chosen.url : null,
  };
}

/**
 * Presence patch for a selection. A VRM choice writes
 * `vrmUrl`/`vrmAssetId`/`vrmValidationStatus` — the validation status is required
 * or the character kit refuses to fetch a non-platform VRM. An image choice
 * clears all three so the profile image is authoritative.
 */
export function selectionToPresence(
  base: ParticipantPresenceV1 | null | undefined,
  resolved: ResolvedCompanionAvatar | null,
): ParticipantPresenceV1 {
  if (!resolved || resolved.choice.kind === 'image') {
    return mergeParticipantPresenceV1(base, {
      vrmUrl: null,
      vrmAssetId: null,
      vrmValidationStatus: null,
    });
  }
  return mergeParticipantPresenceV1(base, {
    vrmUrl: resolved.vrmUrl,
    vrmAssetId: resolved.vrmAssetId,
    vrmValidationStatus: resolved.vrmValidationStatus as ParticipantPresenceV1['vrmValidationStatus'],
  });
}

/** Local, per-contact persistence of the gallery choice (contact id → mode+id). */
export type CompanionAvatarPref = {
  mode: CompanionAvatarKind;
  choiceId: string;
};

export type CompanionAvatarStore = {
  get(contactId: string): CompanionAvatarPref | null;
  set(contactId: string, pref: CompanionAvatarPref): void;
};

function parsePref(raw: unknown): CompanionAvatarPref | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.mode !== 'vrm' && r.mode !== 'image') return null;
  if (typeof r.choiceId !== 'string' || !r.choiceId) return null;
  return { mode: r.mode, choiceId: r.choiceId };
}

/**
 * A tolerant localStorage-backed pref store, mirroring `createPresenceStore`
 * (never throws when storage is unavailable / full).
 */
export function createCompanionAvatarStore(storageKeyPrefix: string): CompanionAvatarStore {
  const keyFor = (id: string) => `${storageKeyPrefix}:companion-avatar:v1:${id}`;
  return {
    get(contactId) {
      if (typeof localStorage === 'undefined') return null;
      try {
        const raw = localStorage.getItem(keyFor(contactId));
        return raw ? parsePref(JSON.parse(raw)) : null;
      } catch {
        return null;
      }
    },
    set(contactId, pref) {
      if (typeof localStorage === 'undefined') return;
      try {
        localStorage.setItem(keyFor(contactId), JSON.stringify(pref));
      } catch {
        // quota / private mode
      }
    },
  };
}

/**
 * A compact one-line preview of the latest transcript turn, for the collapsed
 * chat strip in the companion (the full pane replaces it when expanded).
 */
export function latestTranscriptPreview(
  turns: Array<{ role: string; text?: string | null }>,
  maxLength = 140,
): string {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const text = (turns[i]?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }
  return '';
}
