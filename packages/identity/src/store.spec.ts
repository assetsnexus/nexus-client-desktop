import { describe, expect, it } from 'vitest';
import {
  activeAccount,
  activeIdentity,
  createIdentityStoreState,
  identityKey,
  isExpired,
  pruneExpired,
  removeAccount,
  removeIdentity,
  setActiveIdentity,
  switchAccount,
  upsertIdentity,
  type StoredIdentity,
} from './store.js';

const privateId = (userId: string, over: Partial<StoredIdentity> = {}): StoredIdentity => ({
  key: identityKey({ kind: 'private', userId, orgId: null }),
  kind: 'private',
  userId,
  orgId: null,
  role: 'owner',
  token: `t-${userId}`,
  deviceId: 'd1',
  label: 'Personal',
  expiresAt: null,
  ...over,
});

const businessId = (userId: string, orgId: string, over: Partial<StoredIdentity> = {}): StoredIdentity => ({
  key: identityKey({ kind: 'business', userId, orgId }),
  kind: 'business',
  userId,
  orgId,
  role: 'member',
  token: `t-${orgId}`,
  deviceId: 'd1',
  label: `Org ${orgId}`,
  expiresAt: null,
  ...over,
});

describe('identityKey', () => {
  it('namespaces private vs business sessions', () => {
    expect(identityKey({ kind: 'private', userId: 'u1', orgId: null })).toBe('private:u1');
    expect(identityKey({ kind: 'business', userId: 'u1', orgId: 'o1' })).toBe('business:o1:u1');
  });
});

describe('upsertIdentity', () => {
  it('login (private) makes the user the active account + identity', () => {
    const s = upsertIdentity(createIdentityStoreState(), privateId('u1'));
    expect(s.activeUserId).toBe('u1');
    expect(activeIdentity(s)?.key).toBe('private:u1');
  });

  it('adds business identities to the same account, private sorted first', () => {
    let s = upsertIdentity(createIdentityStoreState(), privateId('u1'));
    s = upsertIdentity(s, businessId('u1', 'o1'));
    const account = activeAccount(s);
    expect(account?.identities.map((i) => i.kind)).toEqual(['private', 'business']);
    // The active identity stays private on first add.
    expect(activeIdentity(s)?.kind).toBe('private');
  });

  it('replaces an existing identity with the same key (re-login refreshes the token)', () => {
    let s = upsertIdentity(createIdentityStoreState(), privateId('u1'));
    s = upsertIdentity(s, privateId('u1', { token: 'fresh' }));
    expect(activeAccount(s)?.identities).toHaveLength(1);
    expect(activeIdentity(s)?.token).toBe('fresh');
  });

  it('requires a userId', () => {
    expect(() => upsertIdentity(createIdentityStoreState(), privateId('', { userId: null }))).toThrow(/userId/);
  });

  it('does not mutate the input state', () => {
    const base = createIdentityStoreState();
    upsertIdentity(base, privateId('u1'));
    expect(base.accounts).toHaveLength(0);
  });
});

describe('setActiveIdentity (org switch)', () => {
  it('switches the active identity within the account', () => {
    let s = upsertIdentity(createIdentityStoreState(), privateId('u1'));
    s = upsertIdentity(s, businessId('u1', 'o1'));
    const { state, identity } = setActiveIdentity(s, 'business:o1:u1');
    expect(identity?.orgId).toBe('o1');
    expect(activeIdentity(state)?.orgId).toBe('o1');
  });

  it('refuses an unknown identity', () => {
    const s = upsertIdentity(createIdentityStoreState(), privateId('u1'));
    expect(setActiveIdentity(s, 'business:nope:u1').identity).toBeNull();
  });
});

describe('switchAccount (temporary multi-user)', () => {
  it('switches the active account when enabled', () => {
    let s = upsertIdentity(createIdentityStoreState(), privateId('u1'));
    s = upsertIdentity(s, privateId('u2'));
    expect(s.activeUserId).toBe('u2');
    const { state, identity } = switchAccount(s, 'u1');
    expect(identity?.userId).toBe('u1');
    expect(state.activeUserId).toBe('u1');
  });

  it('is a no-op when the switcher is disabled', () => {
    let s = upsertIdentity(createIdentityStoreState(), privateId('u1'));
    s = upsertIdentity(s, privateId('u2'));
    const disabled = { ...s, accountSwitcherEnabled: false };
    const { state, identity } = switchAccount(disabled, 'u1');
    expect(identity).toBeNull();
    expect(state.activeUserId).toBe('u2');
  });

  it('refuses an unknown account', () => {
    const s = upsertIdentity(createIdentityStoreState(), privateId('u1'));
    expect(switchAccount(s, 'ghost').identity).toBeNull();
  });
});

describe('removeAccount / removeIdentity', () => {
  it('removing the active account falls back to another', () => {
    let s = upsertIdentity(createIdentityStoreState(), privateId('u1'));
    s = upsertIdentity(s, privateId('u2'));
    const next = removeAccount(s, 'u2');
    expect(next.activeUserId).toBe('u1');
    expect(next.accounts).toHaveLength(1);
  });

  it('removing the last identity drops the account', () => {
    let s = upsertIdentity(createIdentityStoreState(), privateId('u1'));
    const next = removeIdentity(s, 'u1', 'private:u1');
    expect(next.accounts).toHaveLength(0);
    expect(next.activeUserId).toBeNull();
  });

  it('removing the active identity falls back to another in the same account', () => {
    let s = upsertIdentity(createIdentityStoreState(), privateId('u1'));
    s = upsertIdentity(s, businessId('u1', 'o1'));
    s = setActiveIdentity(s, 'business:o1:u1').state;
    const next = removeIdentity(s, 'u1', 'business:o1:u1');
    expect(activeIdentity(next)?.kind).toBe('private');
  });
});

describe('expiry', () => {
  it('detects an expired session', () => {
    expect(isExpired(privateId('u1', { expiresAt: '2020-01-01T00:00:00.000Z' }))).toBe(true);
    expect(isExpired(privateId('u1', { expiresAt: '2999-01-01T00:00:00.000Z' }))).toBe(false);
    expect(isExpired(privateId('u1', { expiresAt: null }))).toBe(false);
  });

  it('prunes expired sessions and repairs the active selection', () => {
    let s = upsertIdentity(createIdentityStoreState(), privateId('u1', { expiresAt: '2020-01-01T00:00:00.000Z' }));
    s = upsertIdentity(s, businessId('u1', 'o1'));
    const next = pruneExpired(s);
    expect(next.accounts[0].identities).toHaveLength(1);
    expect(activeIdentity(next)?.orgId).toBe('o1');
  });

  it('keeps an explicit sign-out (null activeUserId) across a reload', () => {
    // A switch-user logout sets `activeUserId: null` while keeping the accounts.
    // Reloading must not silently re-activate an account and sign the user back
    // in; only a *stale* active id (its account pruned) is repaired.
    let s = upsertIdentity(createIdentityStoreState(), privateId('u1'));
    s = { ...s, activeUserId: null };
    const next = pruneExpired(s);
    expect(next.accounts).toHaveLength(1);
    expect(next.activeUserId).toBeNull();
    expect(activeIdentity(next)).toBeNull();
  });

  it('still repairs an active id whose account disappeared', () => {
    let s = upsertIdentity(createIdentityStoreState(), privateId('u1'));
    s = upsertIdentity(s, privateId('u2'));
    // Simulate the active account being removed out from under the id.
    s = { ...s, accounts: s.accounts.filter((a) => a.userId !== s.activeUserId) };
    const next = pruneExpired(s);
    expect(next.activeUserId).toBe('u1');
  });
});
