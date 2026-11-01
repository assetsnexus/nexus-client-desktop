/**
 * Canonical Nexus storage reference — client-side twin of the agent helper.
 *
 * Nexus chat agents read/write storage through a reference URI they can parse
 * from a message. The canonical form is defined once, in
 * `anx-inference/backend/src/inference/storage/storage-reference.util.ts`:
 *
 *     bfstorage://<workspaceId>/<fileIdOrObjectKey>
 *
 * A user who copies a file's path in the desktop app and pastes it into a Nexus
 * chat must produce a reference the region-side agent resolves identically, so
 * this module reimplements **that exact format** rather than inventing a local
 * variant. Keep the prefix and the slash-splitting rules byte-compatible with
 * the agent helper; if the agent format ever changes, this file changes with it
 * (and `storage-reference.spec.ts` fails loudly).
 *
 * The portal deep-link helper below mirrors the region's
 * `formatStorageExplorerPath` so "Open in portal" lands on the same bucket/file
 * the portal's own explorer would open.
 */

/** Scheme prefix every storage reference starts with. */
export const BF_STORAGE_REF_PREFIX = 'bfstorage://';

/**
 * Build a canonical storage reference.
 *
 * Leading slashes in the key are dropped so a caller can pass either
 * `/docs/report.pdf` or `docs/report.pdf` and get the same reference. The
 * workspace id is the region storage bucket id.
 */
export function formatStorageReference(workspaceId: string, fileOrObjectKey: string): string {
  const key = fileOrObjectKey.replace(/^\/+/, '');
  return `${BF_STORAGE_REF_PREFIX}${workspaceId}/${key}`;
}

/**
 * Parse a canonical storage reference back into its parts, or `null` when the
 * string is not a storage reference. Mirrors the agent helper's tolerant rules:
 * surrounding whitespace is ignored and extra leading slashes in the key are
 * stripped, but an empty bucket id or empty key is rejected.
 */
export function parseStorageReference(
  ref: string,
): { workspaceId: string; fileOrObjectKey: string } | null {
  const trimmed = ref.trim();
  if (!trimmed.startsWith(BF_STORAGE_REF_PREFIX)) return null;
  const rest = trimmed.slice(BF_STORAGE_REF_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 1) return null;
  const workspaceId = rest.slice(0, slash);
  const fileOrObjectKey = rest.slice(slash + 1).replace(/^\/+/, '');
  if (!workspaceId || !fileOrObjectKey) return null;
  return { workspaceId, fileOrObjectKey };
}

/** True when the string looks like a Nexus storage reference. */
export function isStorageReference(value: string): boolean {
  return parseStorageReference(value) !== null;
}

/** Portal surfaces a storage link can target. */
export type PortalSurface = 'user' | 'org';

/** Options for the portal deep-link builder. */
export type StorageExplorerPathOptions = {
  /**
   * Region file id to select on arrival. The canonical reference carries an
   * object key; when the row's file id is known, pass it so the portal opens
   * the exact file rather than resolving a key.
   */
  fileId?: string;
  /** Portal console surface. `org` targets the `/b2b` routes. */
  surface?: PortalSurface;
};

/**
 * Portal bucket-browser deep link, matching the region's
 * `formatStorageExplorerPath`: `/user/storage/browser/<bucketId>?file=<fileId>`.
 * Org surfaces use the `/b2b` variant.
 */
export function formatStorageExplorerPath(
  workspaceId: string,
  fileOrObjectKey: string,
  opts?: StorageExplorerPathOptions,
): string {
  const fileParam = opts?.fileId || fileOrObjectKey;
  const q = new URLSearchParams({ file: fileParam });
  const prefix = opts?.surface === 'org' ? '/b2b' : '/user';
  return `${prefix}/storage/browser/${encodeURIComponent(workspaceId)}?${q.toString()}`;
}

/**
 * Absolute portal URL for "Open in portal", or `null` when no portal origin is
 * known. `baseUrl` is the region/gateway origin the desktop app already uses for
 * org logos; it is trimmed of trailing slashes before joining.
 */
export function absoluteStorageExplorerUrl(
  baseUrl: string | null | undefined,
  workspaceId: string,
  fileOrObjectKey: string,
  opts?: StorageExplorerPathOptions,
): string | null {
  const base = baseUrl?.trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}${formatStorageExplorerPath(workspaceId, fileOrObjectKey, opts)}`;
}
