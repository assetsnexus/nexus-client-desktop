/**
 * Multi-identity store (Phase 9).
 *
 * The desktop keeps a private (personal) session plus one session per org
 * membership, exactly like the ANX app / portal. On top of that it keeps a
 * **multi-account** list keyed by `userId`, so several local Nexus users can
 * coexist for testing (the temporary account switcher). The multi-account layer
 * is deliberately isolated behind `accountSwitcherEnabled` so it can be turned
 * off later without touching the single-user model.
 *
 * Persisted as JSON; the store is a pure state machine so it is testable with no
 * filesystem and no region calls.
 */

export type IdentityKind = 'private' | 'business';

export type StoredIdentity = {
  /** Session key: `private:<userId>` or `business:<orgId>:<userId>`. */
  key: string;
  kind: IdentityKind;
  userId: string | null;
  orgId: string | null;
  role: string | null;
  token: string;
  deviceId: string | null;
  label: string;
  /** ISO timestamp; a session is dropped when it is at/after this. */
  expiresAt: string | null;
};

export type AccountRecord = {
  userId: string;
  email: string | null;
  /** Identities for this user, private first. */
  identities: StoredIdentity[];
  /** Which identity is active within this account. */
  activeKey: string | null;
};

export type IdentityStoreState = {
  accounts: AccountRecord[];
  /** Active account (`userId`), across which `switchAccount` moves. */
  activeUserId: string | null;
  /** Feature flag: the temporary multi-account switcher. */
  accountSwitcherEnabled: boolean;
};

export function createIdentityStoreState(
  overrides: Partial<IdentityStoreState> = {},
): IdentityStoreState {
  return {
    accounts: [],
    activeUserId: null,
    accountSwitcherEnabled: true,
    ...overrides,
  };
}

export function identityKey(input: {
  kind: IdentityKind;
  userId: string | null;
  orgId: string | null;
}): string {
  if (input.kind === 'private') return `private:${input.userId ?? 'unknown'}`;
  return `business:${input.orgId ?? 'unknown'}:${input.userId ?? 'unknown'}`;
}

/** True when an identity's `expiresAt` is in the past relative to `now`. */
export function isExpired(identity: StoredIdentity, now: Date = new Date()): boolean {
  if (!identity.expiresAt) return false;
  const t = Date.parse(identity.expiresAt);
  if (Number.isNaN(t)) return false;
  return t <= now.getTime();
}

/** Find the account holding a user id. */
export function findAccount(state: IdentityStoreState, userId: string): AccountRecord | null {
  return state.accounts.find((a) => a.userId === userId) ?? null;
}

/** The active account, or null when signed out. */
export function activeAccount(state: IdentityStoreState): AccountRecord | null {
  if (!state.activeUserId) return null;
  return findAccount(state, state.activeUserId);
}

/** The active identity within the active account. */
export function activeIdentity(state: IdentityStoreState): StoredIdentity | null {
  const account = activeAccount(state);
  if (!account?.activeKey) return null;
  return account.identities.find((i) => i.key === account.activeKey) ?? null;
}

/**
 * Upsert an identity into the store. A private identity makes the user the
 * active account (login); a business identity is added to the same account.
 *
 * Pure: returns a new state, never mutates the input.
 */
export function upsertIdentity(state: IdentityStoreState, identity: StoredIdentity): IdentityStoreState {
  const userId = identity.userId ?? '';
  if (!userId) throw new Error('identity.userId is required to store a session');

  const accounts = state.accounts.map((a) => ({ ...a, identities: [...a.identities] }));
  let account = accounts.find((a) => a.userId === userId);
  if (!account) {
    account = { userId, email: null, identities: [], activeKey: null };
    accounts.push(account);
  }
  const idx = account.identities.findIndex((i) => i.key === identity.key);
  if (idx >= 0) account.identities[idx] = identity;
  else account.identities.push(identity);

  // Sort private first, then by label for a stable UI order.
  account.identities.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'private' ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  // A fresh private login becomes the active identity + account.
  const activeUserId = identity.kind === 'private' ? userId : state.activeUserId ?? userId;
  if (identity.kind === 'private' || !account.activeKey) account.activeKey = identity.key;

  return { ...state, accounts, activeUserId };
}

/**
 * Switch the active identity within the active account (org membership switch).
 * Returns the state unchanged when the identity is not in the active account.
 */
export function setActiveIdentity(
  state: IdentityStoreState,
  key: string,
): { state: IdentityStoreState; identity: StoredIdentity | null } {
  const account = activeAccount(state);
  if (!account) return { state, identity: null };
  const identity = account.identities.find((i) => i.key === key) ?? null;
  if (!identity) return { state, identity: null };
  const accounts = state.accounts.map((a) => (a.userId === account.userId ? { ...a, activeKey: key } : a));
  return { state: { ...state, accounts }, identity };
}

/**
 * Switch the active account (the temporary multi-account switcher). Gated by
 * `accountSwitcherEnabled` so it can be disabled without deleting the store.
 */
export function switchAccount(
  state: IdentityStoreState,
  userId: string,
): { state: IdentityStoreState; identity: StoredIdentity | null } {
  if (!state.accountSwitcherEnabled) {
    return { state, identity: null };
  }
  const account = findAccount(state, userId);
  if (!account) return { state, identity: null };
  const identity = account.identities.find((i) => i.key === account.activeKey) ?? null;
  return { state: { ...state, activeUserId: userId }, identity };
}

/** Remove an account entirely (logout of that user). */
export function removeAccount(state: IdentityStoreState, userId: string): IdentityStoreState {
  const accounts = state.accounts.filter((a) => a.userId !== userId);
  const activeUserId = state.activeUserId === userId ? accounts[0]?.userId ?? null : state.activeUserId;
  return { ...state, accounts, activeUserId };
}

/** Remove one identity (logout of a specific org/private session). */
export function removeIdentity(state: IdentityStoreState, userId: string, key: string): IdentityStoreState {
  const accounts = state.accounts.map((a) =>
    a.userId === userId ? { ...a, identities: a.identities.filter((i) => i.key !== key) } : a,
  );
  const account = accounts.find((a) => a.userId === userId);
  if (account && account.activeKey === key) {
    account.activeKey = account.identities[0]?.key ?? null;
  }
  const pruned = accounts.filter((a) => a.identities.length > 0);
  const activeUserId =
    state.activeUserId && pruned.some((a) => a.userId === state.activeUserId)
      ? state.activeUserId
      : pruned[0]?.userId ?? null;
  return { ...state, accounts: pruned, activeUserId };
}

/** Drop expired sessions (called on load / before each switch). */
export function pruneExpired(state: IdentityStoreState, now: Date = new Date()): IdentityStoreState {
  const accounts = state.accounts
    .map((a) => {
      const identities = a.identities.filter((i) => !isExpired(i, now));
      const activeKey =
        a.activeKey && identities.some((i) => i.key === a.activeKey)
          ? a.activeKey
          : identities[0]?.key ?? null;
      return { ...a, identities, activeKey };
    })
    .filter((a) => a.identities.length > 0);
  // Preserve an explicit sign-out (`activeUserId: null`) across a reload: the
  // user ended the active session while keeping the accounts (the switch-user
  // logout), so the loader must not silently pick an account and sign them back
  // in. The fallback only repairs a *previously active* account that is now
  // gone (e.g. it was pruned), matching `removeAccount`'s fallback.
  const activeUserId =
    state.activeUserId == null
      ? null
      : accounts.some((a) => a.userId === state.activeUserId)
        ? state.activeUserId
        : accounts[0]?.userId ?? null;
  return { ...state, accounts, activeUserId };
}
