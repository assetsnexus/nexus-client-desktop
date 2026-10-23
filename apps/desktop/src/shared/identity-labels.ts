/**
 * Human-friendly labels for the identity switcher (Phase 9).
 *
 * The region identifies users, organisations and memberships by opaque ids
 * (UUIDs / 24-hex ObjectIds). Those ids are needed as React keys and for the
 * switch calls, but they are meaningless to a person, so they must never be
 * *displayed*. The switch panel therefore degrades to a readable placeholder
 * instead of a raw id fallback (e.g. `account.email ?? account.userId` used to
 * render a UUID whenever the email was missing).
 *
 * Pure and framework-free so it is trivially unit-testable.
 */

/** Canonical 8-4-4-4-12 UUID (any version / hex case). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mongo ObjectId (24 hex chars) or a bare 32-hex id without separators. */
const HEX_ID_RE = /^(?:[0-9a-f]{24}|[0-9a-f]{32})$/i;

/**
 * True when a value is an opaque identifier rather than a name a person would
 * recognise. Deliberately shape-based (not "contains a dash") so a real name
 * like `my-org` or an email is never mistaken for an id.
 */
export function isOpaqueId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return UUID_RE.test(trimmed) || HEX_ID_RE.test(trimmed);
}

/**
 * Return the first *displayable* candidate, or `fallback` when the only thing
 * available is missing/blank or an opaque id. Use for any label that previously
 * fell back to a `userId` / `orgId` / `membershipId`.
 */
export function humanLabel(value: string | null | undefined, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed || isOpaqueId(trimmed)) return fallback;
  return trimmed;
}
