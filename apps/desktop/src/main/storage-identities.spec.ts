import { describe, expect, it } from 'vitest';
import {
  PERSONAL_IDENTITY_KEY,
  buildStorageIdentities,
  identityKeyForWorkspace,
  orgIdentityKey,
  resolveStorageIdentity,
  type StorageIdentityContext,
} from './storage-identities.js';

const session = {
  userId: 'user-1',
  token: 'user-session-token',
  deviceId: 'device-1',
};

describe('identityKeyForWorkspace', () => {
  it('routes an org workspace to its own org context', () => {
    expect(identityKeyForWorkspace('org-a')).toBe('org:org-a');
  });

  it('routes a workspace without an orgId to the personal context', () => {
    expect(identityKeyForWorkspace(null)).toBe(PERSONAL_IDENTITY_KEY);
    expect(identityKeyForWorkspace(undefined)).toBe(PERSONAL_IDENTITY_KEY);
    expect(identityKeyForWorkspace('')).toBe(PERSONAL_IDENTITY_KEY);
  });
});

describe('buildStorageIdentities', () => {
  it('returns nothing without a usable user session', () => {
    expect(buildStorageIdentities({ userSession: null, memberships: [] })).toEqual([]);
    expect(
      buildStorageIdentities({ userSession: { ...session, token: '' }, memberships: [] }),
    ).toEqual([]);
  });

  it('puts the personal context first and then one context per membership', () => {
    const contexts = buildStorageIdentities({
      userSession: session,
      memberships: [
        { orgId: 'org-a', orgName: 'Alpha', orgLogo: 'https://cdn/a.png' },
        { orgId: 'org-b', orgName: 'Beta', orgLogo: null },
      ],
    });

    expect(contexts.map((c) => c.key)).toEqual(['personal', 'org:org-a', 'org:org-b']);
    expect(contexts[0]).toMatchObject({ kind: 'personal', orgId: null, orgName: null, orgLogo: null });
    expect(contexts[1]).toMatchObject({
      kind: 'org',
      orgId: 'org-a',
      orgName: 'Alpha',
      orgLogo: 'https://cdn/a.png',
    });
  });

  it('uses the account user-session token + device for every context', () => {
    const contexts = buildStorageIdentities({
      userSession: session,
      memberships: [{ orgId: 'org-a', orgName: 'Alpha', orgLogo: null }],
    });
    for (const c of contexts) {
      expect(c.token).toBe('user-session-token');
      expect(c.deviceId).toBe('device-1');
      expect(c.userId).toBe('user-1');
    }
  });

  it('skips memberships without an orgId and de-dupes repeated orgs', () => {
    const contexts = buildStorageIdentities({
      userSession: session,
      memberships: [
        { orgId: null, orgName: 'No org', orgLogo: null },
        { orgId: '   ', orgName: 'Blank', orgLogo: null },
        { orgId: 'org-a', orgName: 'Alpha', orgLogo: null },
        { orgId: 'org-a', orgName: 'Alpha dup', orgLogo: null },
      ],
    });

    expect(contexts.map((c) => c.key)).toEqual(['personal', 'org:org-a']);
    expect(contexts.find((c) => c.key === 'org:org-a')?.orgName).toBe('Alpha');
  });
});

describe('resolveStorageIdentity', () => {
  const contexts: StorageIdentityContext[] = [
    {
      key: PERSONAL_IDENTITY_KEY,
      kind: 'personal',
      userId: 'user-1',
      orgId: null,
      orgName: null,
      orgLogo: null,
      token: 't',
      deviceId: 'd',
    },
    {
      key: orgIdentityKey('org-a'),
      kind: 'org',
      userId: 'user-1',
      orgId: 'org-a',
      orgName: 'Alpha',
      orgLogo: null,
      token: 't',
      deviceId: 'd',
    },
  ];

  it('returns null when there are no contexts at all', () => {
    expect(resolveStorageIdentity([], 'org:org-a')).toBeNull();
  });

  it('picks the context matching an explicit identity key', () => {
    expect(resolveStorageIdentity(contexts, 'org:org-a')?.orgId).toBe('org-a');
  });

  it('falls back to the personal context for a missing or unknown key', () => {
    expect(resolveStorageIdentity(contexts, undefined)?.key).toBe(PERSONAL_IDENTITY_KEY);
    expect(resolveStorageIdentity(contexts, 'org:gone')?.key).toBe(PERSONAL_IDENTITY_KEY);
  });
});
