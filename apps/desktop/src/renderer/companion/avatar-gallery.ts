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
import {
  localAvatarUrl,
  mappedLocalAvatar,
  type LocalAvatarRecord,
  type LocalAvatarsConfig,
} from '../../shared/local-avatars.js';

// Re-exported so a consumer (e.g. `CompanionView`) that already imports the
// gallery helpers can resolve an agent's mapped model without a second import.
export { mappedLocalAvatar };

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

/**
 * One entry of the region's per-agent `profilePictures[]` (virtual employee
 * multi-picture field). Backward compatible: an agent with a single picture
 * returns `undefined`, and exactly one entry mirrors the canonical
 * `profilePictureUrl` via `primary: true`.
 */
export type CompanionProfilePicture = {
  url: string;
  primary?: boolean;
  /** Expression / face key this picture is linked to (`face` on the region). */
  face?: string;
  label?: string;
  addedAt?: string;
};

/**
 * Tolerant parse of a VE row's `profilePictures` field. Drops non-object
 * entries and any non-fetchable URL (a `blob:`/`data:` payload must never be
 * persisted), keeping the region's order. Pure — shared by the gallery and its
 * tests without a region round-trip.
 */
export function parseProfilePictures(raw: unknown): CompanionProfilePicture[] {
  if (!Array.isArray(raw)) return [];
  const out: CompanionProfilePicture[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const url = typeof rec.url === 'string' ? rec.url.trim() : '';
    if (!url) continue;
    if (url.startsWith('blob:') || url.startsWith('data:')) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const picture: CompanionProfilePicture = { url };
    if (rec.primary === true) picture.primary = true;
    if (typeof rec.face === 'string' && rec.face.trim()) picture.face = rec.face.trim();
    if (typeof rec.label === 'string' && rec.label.trim()) picture.label = rec.label.trim();
    if (typeof rec.addedAt === 'string' && rec.addedAt.trim()) picture.addedAt = rec.addedAt.trim();
    out.push(picture);
  }
  return out;
}

export type CompanionAvatarChoice = {
  /** Stable id: `image:<contactId>` | `presence:vrm` | `vrm:<assetId>` | `local:<avatarId>`. */
  id: string;
  kind: CompanionAvatarKind;
  label: string;
  /** VRM/manifest URL (kind `vrm`) or picture URL (kind `image`); null when unusable. */
  url: string | null;
  /** Catalog asset id when the choice came from `anx.inference.avatar-assets.list`. */
  assetId?: string | null;
  /**
   * Local library entry id when the choice came from this device's own avatar
   * library (`nexus-avatar://…`). The gallery uses it to remove the entry, and
   * the companion uses it to persist the per-agent mapping.
   */
  localAvatarId?: string | null;
  /** True for entries in the on-disk library (so the tile can offer "Remove"). */
  local?: boolean;
  /**
   * Zero-based index into the agent's own `profilePictures` set. Present only
   * for the agent's own pictures (not catalog portraits), so the companion's
   * carousel knows which picture a `kind: 'image'` choice represents.
   */
  pictureIndex?: number;
  /** The picture's linked expression/face key, when the region supplied one. */
  pictureFace?: string | null;
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
  /**
   * The agent's own multi-picture set (region `profilePictures[]`). When present
   * each entry becomes a switchable picture tile, and `avatarUrl` (the canonical
   * primary) is skipped so the primary does not appear twice.
   */
  profilePictures?: CompanionProfilePicture[] | null;
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
 * True when a VRM URL points at this device's own avatar library (the
 * `nexus-avatar:` scheme the main process serves). Such a URL is per-device, so
 * it is presented as a library tile instead of the agent's configured VRM.
 */
export function isLocalLibraryUrl(url: string | null | undefined): boolean {
  const trimmed = typeof url === 'string' ? url.trim().toLowerCase() : '';
  return trimmed.startsWith('nexus-avatar:');
}

/**
 * Build the ordered gallery for an agent:
 *  1. the profile image (always available as a fallback when the contact has one),
 *  2. this device's own avatar library (`nexus-avatar://…`, Deliverable 2) — the
 *     entries the user imported, with the one mapped to **this** agent leading,
 *  3. the agent's configured VRM (`presence.vrmUrl`), then
 *  4. every usable catalog avatar row — 3D VRM models and 2D portraits.
 *
 * Gesture packs (`vrma`/`manifest`) are deliberately excluded: the region maps
 * those to animation clips, not avatars. Duplicate URLs are collapsed, and
 * blob:/data: model URLs are rejected (a `blob:` URL is per-session and must
 * never be persisted — same rule the config sheet enforces).
 *
 * A configured VRM that is itself a library URL is skipped: it is only a mirror
 * of a local pick (`selectionToPresence` writes the picked URL into presence),
 * and the library tile is the authoritative, removable record of it.
 */
export function buildAvatarChoices(input: {
  contact: CompanionAvatarContact | null;
  presence?: CompanionPresenceLike | null;
  assets?: CompanionAvatarAsset[] | null;
  /** This device's local avatar library + per-agent mapping (Deliverable 2). */
  localAvatars?: LocalAvatarsConfig | null;
}): CompanionAvatarChoice[] {
  const choices: CompanionAvatarChoice[] = [];
  const seenVrmUrls = new Set<string>();

  const pushVrm = (choice: CompanionAvatarChoice) => {
    if (!choice.url || choice.url.startsWith('blob:') || choice.url.startsWith('data:')) return;
    if (seenVrmUrls.has(choice.url)) return;
    seenVrmUrls.add(choice.url);
    choices.push(choice);
  };

  const pushPicture = (picture: CompanionProfilePicture, index: number) => {
    choices.push({
      id: `image:${input.contact!.id}:${index}`,
      kind: 'image',
      // Prefer the picture's own label / face key, else a plain caption.
      label: picture.label || (picture.face ? `Picture · ${picture.face}` : 'Profile picture'),
      url: picture.url,
      pictureIndex: index,
      pictureFace: picture.face ?? null,
    });
  };

  // The agent's own multi-picture set leads the image tiles (primary first), so
  // the carousel starts on the canonical picture. A single-picture agent still
  // has `profilePictures === undefined` on the wire, and falls through to the
  // plain `avatarUrl` tile below — do not regress that path.
  const pictures = input.contact?.profilePictures ?? null;
  if (pictures && pictures.length) {
    const ordered = pictures
      .map((picture, index) => ({ picture, index }))
      .sort((a, b) => (a.picture.primary === b.picture.primary ? 0 : a.picture.primary ? -1 : 1));
    for (const { picture, index } of ordered) pushPicture(picture, index);
  } else if (input.contact?.avatarUrl) {
    choices.push({
      id: `image:${input.contact.id}`,
      kind: 'image',
      label: 'Profile image',
      url: input.contact.avatarUrl,
    });
  }

  // The agent's *mapped* library avatar leads the 3D tiles, so the model the
  // user deliberately pinned to this agent is the one that wins the fallback
  // order (and the one the gallery highlights when nothing is stored). The other
  // library entries follow, newest last.
  const local = input.localAvatars ?? null;
  const mapped = mappedLocalAvatar(local, input.contact?.id);
  const localRecords: LocalAvatarRecord[] = (local?.avatars ?? []).slice();
  if (mapped) {
    localRecords.sort((a, b) => (a.id === mapped.id ? -1 : b.id === mapped.id ? 1 : 0));
  }
  for (const record of localRecords) {
    pushVrm({
      id: `local:${record.id}`,
      kind: 'vrm',
      label: record.id === mapped?.id ? `${record.label} (this agent)` : record.label,
      url: localAvatarUrl(record),
      local: true,
      localAvatarId: record.id,
      // A library model needs no catalog status: the character-kit gate trusts
      // the host's own `nexus-avatar:` scheme (`isLocalLibraryAvatarUrl`).
      validationStatus: null,
    });
  }

  const configuredVrm = readPresenceString(input.presence, 'vrmUrl');
  if (configuredVrm && !isLocalLibraryUrl(configuredVrm)) {
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
  if (stored) {
    return {
      choice: stored,
      vrmUrl: stored.kind === 'vrm' ? stored.url : null,
      vrmAssetId: stored.kind === 'vrm' ? (stored.assetId ?? null) : null,
      vrmValidationStatus: stored.kind === 'vrm' ? (stored.validationStatus ?? null) : null,
      imageUrl: stored.kind === 'image' ? stored.url : null,
    };
  }
  const chosen = choices.find((c) => c.kind === 'vrm') ?? choices[0]!;
  return {
    choice: chosen,
    vrmUrl: chosen.kind === 'vrm' ? chosen.url : null,
    vrmAssetId: chosen.kind === 'vrm' ? (chosen.assetId ?? null) : null,
    vrmValidationStatus: chosen.kind === 'vrm' ? (chosen.validationStatus ?? null) : null,
    imageUrl: chosen.kind === 'image' ? chosen.url : null,
  };
}

/**
 * Resolve the stage from a stored per-contact pref, honoring the **mode** the
 * avatar button toggles:
 *
 *  - `mode: 'image'` → the agent's own carousel picture at `pref.pictureIndex`
 *    (or the stored image choice / first image). This is the 2D picture surface.
 *  - `mode: 'vrm'`  → the stored VRM choice (its model id). If that model has
 *    gone away, fall back to the first available VRM, then to any image.
 *
 * Unlike {@link resolveAvatarSelection} the mode is authoritative: a stored
 * *image* choice no longer forces the picture when the user has toggled back to
 * 3D. Returns null when the agent has no avatar at all.
 */
export function resolveCompanionStage(
  choices: CompanionAvatarChoice[],
  pref: CompanionAvatarPref | null,
): ResolvedCompanionAvatar | null {
  if (!choices.length) return null;

  const asResolved = (choice: CompanionAvatarChoice): ResolvedCompanionAvatar => ({
    choice,
    vrmUrl: choice.kind === 'vrm' ? choice.url : null,
    vrmAssetId: choice.kind === 'vrm' ? (choice.assetId ?? null) : null,
    vrmValidationStatus: choice.kind === 'vrm' ? (choice.validationStatus ?? null) : null,
    imageUrl: choice.kind === 'image' ? choice.url : null,
  });

  const byId = (id: string | null | undefined) =>
    id ? choices.find((c) => c.id === id) : undefined;

  if (pref?.mode === 'image') {
    // Prefer the carousel picture the user rotated to, then the stored choice,
    // then the first image tile — never fall back to a 3D model in picture mode.
    const carousel = resolveCarouselChoice(choices, pref.pictureIndex);
    if (carousel) return asResolved(carousel);
    const imageChoice = byId(pref.choiceId) ?? choices.find((c) => c.kind === 'image');
    if (imageChoice) return asResolved(imageChoice);
  }

  if (pref?.mode === 'vrm') {
    const modelChoice = byId(pref.choiceId);
    if (modelChoice && modelChoice.kind === 'vrm') return asResolved(modelChoice);
    const anyVrm = choices.find((c) => c.kind === 'vrm');
    if (anyVrm) return asResolved(anyVrm);
  }

  // No pref (or the preferred surface is unavailable): keep the original policy
  // — the stored choice, then a 3D model, then the first tile.
  return resolveAvatarSelection(choices, pref?.choiceId ?? null);
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

/**
 * The agent's own picture choices, in carousel order (primary first). Catalog
 * portraits (no `pictureIndex`) are excluded: the carousel rotates the agent's
 * *own* pictures, not unrelated catalog art. Empty when the agent has ≤1 picture
 * or only a single canonical `avatarUrl` tile.
 */
export function pictureChoices(choices: readonly CompanionAvatarChoice[]): CompanionAvatarChoice[] {
  return choices.filter((c) => c.kind === 'image' && typeof c.pictureIndex === 'number');
}

/**
 * Pick the carousel entry to display for a stored index. Clamps out-of-range
 * indices (the picture set shrinks between sessions) onto a real entry, and
 * falls back to the first picture when none is stored. Returns null when the
 * agent has no carousel (0-or-1 picture / only the canonical tile).
 */
export function resolveCarouselChoice(
  choices: readonly CompanionAvatarChoice[],
  storedIndex: number | null | undefined,
): CompanionAvatarChoice | null {
  const pictures = pictureChoices(choices);
  if (pictures.length < 2) return null;
  const requested =
    typeof storedIndex === 'number' && Number.isInteger(storedIndex) ? storedIndex : 0;
  const found = pictures.find((c) => c.pictureIndex === requested);
  return found ?? pictures[0]!;
}

/** Next picture index in the carousel (wraps), given the current index. */
export function cyclePictureIndex(
  choices: readonly CompanionAvatarChoice[],
  currentIndex: number,
  step = 1,
): number {
  const pictures = pictureChoices(choices);
  if (!pictures.length) return 0;
  const idx = pictures.findIndex((c) => c.pictureIndex === currentIndex);
  const base = idx < 0 ? 0 : idx;
  const next = (((base + step) % pictures.length) + pictures.length) % pictures.length;
  return pictures[next]!.pictureIndex ?? 0;
}

/** Local, per-contact persistence of the gallery choice (contact id → mode+id). */
export type CompanionAvatarPref = {
  /**
   * Whether the companion shows the 3D/VRM stage or the agent's profile picture.
   * This is the avatar-button toggle; it is independent of which VRM *choice* is
   * stored, so flipping back to 3D restores the last model instead of the first.
   */
  mode: CompanionAvatarKind;
  choiceId: string;
  /**
   * Selected entry in the agent's multi-picture carousel (the region
   * `profilePictures[].index`), remembered per contact so reopening a companion
   * shows the same picture the user rotated to last.
   */
  pictureIndex?: number;
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
  const pref: CompanionAvatarPref = { mode: r.mode, choiceId: r.choiceId };
  if (typeof r.pictureIndex === 'number' && Number.isInteger(r.pictureIndex)) {
    pref.pictureIndex = r.pictureIndex;
  }
  return pref;
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
