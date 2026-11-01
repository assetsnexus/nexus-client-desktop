/**
 * Storage identity fan-out (main process, pure).
 *
 * The Storage hub lists **every storage the signed-in user can reach**, not just
 * the active identity's: the personal context plus one context per organisation
 * membership. Region storage is scoped by `orgId` (`anx.storage.workspace.list`
 * returns the caller's personal workspaces plus every workspace of the identity's
 * `orgId`), so "all identities" is expressed as one command per context.
 *
 * ## Why the *user* session token, not each business token
 *
 * A membership login (`business:<orgId>:<userId>`) stores its own token, but the
 * user-level (private) session token is the stable, org-agnostic credential: the
 * region resolves the caller's memberships from it and authorises a matching
 * `orgId` in the envelope. Verified live — the private token lists/reads/writes
 * an org's storage given that org's `orgId`, while the per-org business tokens go
 * stale (a signed-out membership leaves a token the region answers 401 for).
 * Using one user-session token for every context therefore lists the full union
 * without a context silently dropping out.
 *
 * Framework-free and injectable so it is unit-testable without a region.
 */

/** Either the user's own (personal) context or one org-membership context. */
export type StorageIdentityKind = 'personal' | 'org';

export type StorageIdentityContext = {
  /** Stable routing key: {@link PERSONAL_IDENTITY_KEY} or `org:<orgId>`. */
  key: string;
  kind: StorageIdentityKind;
  /** The user the session token belongs to. */
  userId: string | null;
  orgId: string | null;
  /** Human org name (business identities); `null` for the personal context. */
  orgName: string | null;
  /**
   * Raw org logo value as the region returns it (`orgLogo` on
   * `anx.organization.membership.list`). The renderer resolves it to a loadable
   * URL via `resolveOrgLogoUrl` — it is never assumed to be absolute here.
   */
  orgLogo: string | null;
  /** Token to send for this context (the account's user-session token). */
  token: string;
  /** Device the session was validated against (forwarded on every command). */
  deviceId: string | null;
};

/** The account's own session, used as the token authority for every context. */
export type StorageUserSession = {
  userId: string | null;
  token: string;
  deviceId: string | null;
};

/** A membership row reduced to the fields the fan-out needs. */
export type StorageMembership = {
  orgId: string | null;
  orgName: string | null;
  orgLogo: string | null;
};

export const PERSONAL_IDENTITY_KEY = 'personal';

/** Routing key for an organisation's storage context. */
export function orgIdentityKey(orgId: string): string {
  return `org:${orgId}`;
}

/**
 * The context key a workspace belongs to: org workspaces are owned by their org
 * context, everything else by the personal one. Region workspace rows carry
 * `orgId` (`null` = personal).
 */
export function identityKeyForWorkspace(orgId: string | null | undefined): string {
  return orgId ? orgIdentityKey(orgId) : PERSONAL_IDENTITY_KEY;
}

/**
 * Every storage context for the signed-in user: the personal context first, then
 * one per organisation membership (deduped by `orgId`).
 *
 * Returns an empty list when there is no usable session token — the caller then
 * shows an empty state rather than issuing an unauthenticated command.
 */
export function buildStorageIdentities(input: {
  /** The account's private/user session (token authority for every context). */
  userSession: StorageUserSession | null;
  /** Org memberships (`anx.organization.membership.list`). */
  memberships: StorageMembership[];
}): StorageIdentityContext[] {
  const session = input.userSession;
  if (!session || !session.token) return [];

  const base = {
    userId: session.userId,
    token: session.token,
    deviceId: session.deviceId,
  } as const;

  const out: StorageIdentityContext[] = [
    {
      key: PERSONAL_IDENTITY_KEY,
      kind: 'personal',
      orgId: null,
      orgName: null,
      orgLogo: null,
      ...base,
    },
  ];

  const seen = new Set<string>();
  for (const m of input.memberships) {
    const orgId = typeof m.orgId === 'string' ? m.orgId.trim() : '';
    if (!orgId || seen.has(orgId)) continue;
    seen.add(orgId);
    out.push({
      key: orgIdentityKey(orgId),
      kind: 'org',
      orgId,
      orgName: m.orgName ?? null,
      orgLogo: m.orgLogo ?? null,
      ...base,
    });
  }

  return out;
}

/**
 * Pick the identity to send for a call. Prefers an explicit `identityKey`; falls
 * back to the personal context (the everyday default) when it is absent or no
 * longer resolves, so an operation issued against a stale key degrades to the
 * user's own storage instead of failing outright.
 */
export function resolveStorageIdentity(
  contexts: StorageIdentityContext[],
  identityKey: string | null | undefined,
): StorageIdentityContext | null {
  if (contexts.length === 0) return null;
  if (identityKey) {
    const match = contexts.find((c) => c.key === identityKey);
    if (match) return match;
  }
  return contexts.find((c) => c.key === PERSONAL_IDENTITY_KEY) ?? contexts[0];
}
