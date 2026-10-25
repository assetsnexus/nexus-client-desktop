/**
 * Local avatar library contract (shared main ↔ renderer).
 *
 * The companion's avatar gallery used to be a dead end: it could only offer the
 * agent's configured VRM or a profile picture. This contract backs a *local*
 * library the user curates from their own disk, plus the per-agent mapping that
 * decides which library entry an agent renders with.
 *
 * Everything here is pure (no Electron, no fs) so the persistence shape — the
 * file-name rules, the mapping prunes — is unit tested directly. The store
 * (`main/local-avatar-store.ts`) adds the file copying on top.
 */

/** Which loader the file needs. Both are glTF-binary containers. */
export type LocalAvatarKind = 'vrm' | 'glb';

export type LocalAvatarRecord = {
  /** Stable id, also the library file's basename. */
  id: string;
  /** Display label (the original file name unless the user renamed it). */
  label: string;
  kind: LocalAvatarKind;
  /** Absolute path inside the app's avatar library directory. */
  filePath: string;
  /** Original file name, kept for display + duplicate hints. */
  fileName: string;
  sizeBytes: number;
  /** Epoch ms the entry was added, for ordering. */
  addedAt: number;
};

export type LocalAvatarsConfig = {
  avatars: LocalAvatarRecord[];
  /**
   * Client-remembered **agent (contact) → library avatar id** mapping. Kept
   * per contact on purpose: several companions can be open at once and each one
   * remembers its own agent's model, instead of one global avatar for everyone.
   */
  contactMappings: Record<string, string>;
};

export const DEFAULT_LOCAL_AVATARS: LocalAvatarsConfig = { avatars: [], contactMappings: {} };

/** File extensions the library accepts, in picker order. */
export const LOCAL_AVATAR_EXTENSIONS = ['.vrm', '.glb'] as const;

/** The native picker filter / `accept` attribute value. */
export const LOCAL_AVATAR_ACCEPT = LOCAL_AVATAR_EXTENSIONS.join(',');

/** Blob MIME type a library file is served with (glTF binary for both kinds). */
export const LOCAL_AVATAR_MIME = 'model/gltf-binary';

/**
 * Custom scheme that serves a library file to the renderer.
 *
 * A `file://` URL would work in a packaged app (the renderer is `file://` too)
 * but not in dev, where the renderer is served from the Vite http origin and
 * Chromium refuses a file fetch from a remote origin. This scheme is registered
 * as `standard` + `secure` + `supportFetchAPI` + `corsEnabled`, so the same URL
 * resolves — and the same `fetch()` path the avatar cache already uses works —
 * in both dev and packaged builds, without widening the renderer's origin.
 */
export const LOCAL_AVATAR_SCHEME = 'nexus-avatar';

/** Host segment of a library URL; the path is the copied file's basename. */
export const LOCAL_AVATAR_HOST = 'avatar';

/** Serve URL for one library entry: `nexus-avatar://avatar/<id><ext>`. */
export function localAvatarUrl(record: Pick<LocalAvatarRecord, 'id' | 'kind'>): string {
  return `${LOCAL_AVATAR_SCHEME}://${LOCAL_AVATAR_HOST}/${record.id}.${record.kind}`;
}

/**
 * The file name inside the library directory for a URL path, or null when the
 * path is not a plain single-segment `<id>.vrm|.glb`. The `..`/separator case is
 * rejected here so the protocol handler never resolves outside the library.
 */
export function localAvatarFileNameFromPath(pathname: string): string | null {
  const raw = typeof pathname === 'string' ? decodeURIComponentSafe(pathname) : '';
  const name = raw.replace(/^\/+/, '');
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  return isSupportedAvatarFileName(name) ? name : null;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** `.vrm` / `.glb` → kind, anything else → null. Case-insensitive. */
export function avatarKindFromFileName(name: string): LocalAvatarKind | null {
  const lower = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (lower.endsWith('.vrm')) return 'vrm';
  if (lower.endsWith('.glb')) return 'glb';
  return null;
}

export function isSupportedAvatarFileName(name: string): boolean {
  return avatarKindFromFileName(name) !== null;
}

/** `My Avatar (final).VRM` → `My Avatar (final)`; falls back to the raw name. */
export function avatarLabelFromFileName(name: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return 'Avatar';
  const kind = avatarKindFromFileName(trimmed);
  if (!kind) return trimmed;
  const base = trimmed.slice(0, trimmed.length - (kind.length + 1)).trim();
  return base || 'Avatar';
}

/**
 * Slug an id from a file name so a library file is recognisable on disk.
 * Only ASCII alphanumerics survive; anything else collapses to `-`.
 */
export function avatarIdSlug(name: string): string {
  const base = avatarLabelFromFileName(name).toLowerCase();
  const slug = base
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'avatar';
}

/**
 * Coerce one persisted record, dropping anything unusable. A record needs an id,
 * a supported extension, and a non-empty path — otherwise a hand-edited file
 * could point the loader at nothing (or at a non-model file).
 */
export function normalizeLocalAvatarRecord(raw: unknown): LocalAvatarRecord | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const filePath = typeof raw.filePath === 'string' ? raw.filePath.trim() : '';
  if (!id || !filePath) return null;
  const kind = avatarKindFromFileName(filePath) ?? avatarKindFromFileName(id);
  if (!kind) return null;
  const fileName =
    typeof raw.fileName === 'string' && raw.fileName.trim()
      ? raw.fileName.trim()
      : filePath.replace(/\\/g, '/').split('/').pop() || `${id}${kind}`;
  const label =
    typeof raw.label === 'string' && raw.label.trim()
      ? raw.label.trim()
      : avatarLabelFromFileName(fileName);
  const sizeBytes = Number.isFinite(raw.sizeBytes) ? Math.max(0, Number(raw.sizeBytes)) : 0;
  const addedAt = Number.isFinite(raw.addedAt) ? Number(raw.addedAt) : 0;
  return { id, label, kind, filePath, fileName, sizeBytes, addedAt };
}

/** Contact id → avatar id, dropping entries that are not strings. */
export function normalizeContactMappings(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [contactId, avatarId] of Object.entries(raw)) {
    const key = contactId.trim();
    if (!key || typeof avatarId !== 'string') continue;
    const value = avatarId.trim();
    if (value) out[key] = value;
  }
  return out;
}

/**
 * Coerce a persisted/patched config. Duplicate ids keep the first occurrence so
 * a hand-edited file cannot register the same library file twice.
 */
export function normalizeLocalAvatarsConfig(raw: unknown): LocalAvatarsConfig {
  if (!isRecord(raw)) return { ...DEFAULT_LOCAL_AVATARS };
  const seen = new Set<string>();
  const avatars: LocalAvatarRecord[] = [];
  if (Array.isArray(raw.avatars)) {
    for (const entry of raw.avatars) {
      const record = normalizeLocalAvatarRecord(entry);
      if (!record || seen.has(record.id)) continue;
      seen.add(record.id);
      avatars.push(record);
    }
  }
  return { avatars, contactMappings: normalizeContactMappings(raw.contactMappings) };
}

/** The library avatar a contact is mapped to, or null when unmapped/missing. */
export function mappedAvatarId(
  config: LocalAvatarsConfig | null | undefined,
  contactId: string | null | undefined,
): string | null {
  if (!config || !contactId) return null;
  const id = config.contactMappings[contactId];
  if (!id) return null;
  return config.avatars.some((a) => a.id === id) ? id : null;
}

/**
 * Drop mappings whose avatar left the library (removed, or the file is gone).
 * Returns the pruned config plus whether anything changed, so the store only
 * writes when there is something to write.
 */
export function pruneContactMappings(config: LocalAvatarsConfig): {
  config: LocalAvatarsConfig;
  changed: boolean;
} {
  const known = new Set(config.avatars.map((a) => a.id));
  const contactMappings: Record<string, string> = {};
  let changed = false;
  for (const [contactId, avatarId] of Object.entries(config.contactMappings)) {
    if (known.has(avatarId)) contactMappings[contactId] = avatarId;
    else changed = true;
  }
  return { config: { avatars: config.avatars, contactMappings }, changed };
}

/** Config with one library avatar removed and its mappings pruned. */
export function removeLocalAvatar(config: LocalAvatarsConfig, id: string): LocalAvatarsConfig {
  const avatars = config.avatars.filter((a) => a.id !== id);
  if (avatars.length === config.avatars.length) return config;
  return pruneContactMappings({ avatars, contactMappings: config.contactMappings }).config;
}

/** The library record a contact is mapped to (and that still exists), or null. */
export function mappedLocalAvatar(
  config: LocalAvatarsConfig | null | undefined,
  contactId: string | null | undefined,
): LocalAvatarRecord | null {
  const id = mappedAvatarId(config, contactId);
  if (!id || !config) return null;
  return config.avatars.find((a) => a.id === id) ?? null;
}

/**
 * True for a URL only this device can resolve — a `file:`/custom-scheme pick, a
 * per-session `blob:`, or an inline `data:` URL. Those are exactly the avatar
 * URLs the region cannot send to another device, so the local library is the
 * portable way to remember "this agent renders with my picked model".
 */
export function isDeviceLocalAvatarUrl(url: string | null | undefined): boolean {
  const trimmed = typeof url === 'string' ? url.trim().toLowerCase() : '';
  if (!trimmed) return false;
  return /^(file:|blob:|data:|nexus-avatar:)/.test(trimmed);
}
