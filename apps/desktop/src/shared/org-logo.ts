/**
 * Organisation logo resolution for the identity switcher (Phase 9).
 *
 * The region returns an organisation's logo on `orgLogo`
 * (`anx.organization.membership.list` → `attachOrgDisplayFields` copies
 * `Org.logo` onto the membership). Depending on how the org was created that
 * value is one of:
 *
 *  - an absolute `https://…` / `http://…` URL,
 *  - an inline `data:image/…` URL (the create/update command accepts base64),
 *  - a root-relative region path such as `/public-files/<module>/<file>`.
 *
 * Relative paths only load when prefixed with the region/gateway origin — the
 * renderer origin is the Vite dev server (or `file://`), not the region. This
 * mirrors the portal's `resolvePublicFileUrl` (`utils/resolvePublicFileUrl.js`),
 * which absolutises `/public-files/...` against `ANX_GATEWAY_URL`.
 *
 * Pure and framework-free so it is unit-testable.
 */

/** Max inline data URL we will hand to an `<img>` (region caps this too). */
const MAX_INLINE_CHARS = 8192;

/**
 * Resolve a region-returned logo value to something an `<img src>` can load.
 * Returns `null` when there is nothing loadable (missing value, unsupported
 * shape, or a relative path without a base to absolutise against).
 */
export function resolveOrgLogoUrl(raw: unknown, baseUrl?: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;

  if (/^data:/i.test(value)) {
    // Only inline images, and only if not absurdly large (matches the region's
    // publishable-picture policy). A non-image data URL would never render.
    if (!/^data:image\//i.test(value)) return null;
    if (value.length > MAX_INLINE_CHARS) return null;
    return value;
  }
  if (/^https?:\/\//i.test(value)) return value;
  if (/^blob:/i.test(value)) return value;
  // Protocol-relative (`//host/path`) — resolve against https, the desktop's
  // only real region transport.
  if (value.startsWith('//')) return `https:${value}`;

  if (value.startsWith('/')) {
    const base = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : '';
    if (!base) return null;
    return `${base}${value}`;
  }
  // A bare value (e.g. a raw file id) is not an image URL; fall back to initials.
  return null;
}

/**
 * Up-to-two-letter monogram for an org without a logo. Mirrors the portal's
 * placeholder (the portal uses a briefcase icon; the desktop is dark-theme so a
 * monogram reads better and still conveys the org).
 */
export function orgInitials(name: string | null | undefined): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return '?';
  const words = trimmed.split(/[\s._\-/]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}
