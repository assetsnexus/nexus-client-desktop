import { describe, expect, it, vi } from 'vitest';
import { createNexusAppsProvider, projectGrant, type NexusAppIdentity } from './nexus-apps.js';

const clientOptions = { baseUrl: 'https://region.example.com' };

function identity(over: Partial<NexusAppIdentity> = {}): NexusAppIdentity {
  return {
    key: 'private:u1',
    userId: 'u1',
    orgId: null,
    orgName: null,
    token: 't1',
    deviceId: 'd1',
    ...over,
  };
}

/** A `sendCommand`-shaped stub with an untyped call tuple for easy assertions. */
type SendCall = [unknown, string, Record<string, unknown>, { token?: string; identity: Record<string, unknown> }];
type SendMock = ReturnType<typeof vi.fn>;

function okResponse(items: Record<string, unknown>[]) {
  return { responseCode: 200, responseObject: { items, total: items.length } };
}

/** Extract the (token, identity) envelope of one recorded call. */
function envelopeOf(call: SendCall) {
  return call[3];
}

describe('projectGrant', () => {
  it('prefers the launcher url and label', () => {
    const out = projectGrant(
      {
        clientId: 'xcamp',
        clientName: 'Xcamp Client',
        clientHomepageUrl: 'https://home.example.com',
        clientPortalLauncher: { enabled: true, label: 'Xcamp', launchUrl: 'https://xcamp.example.com/app' },
      },
      { orgId: 'o1', orgName: 'Acme', userId: 'u1' },
    );
    expect(out).toMatchObject({
      clientId: 'xcamp',
      label: 'Xcamp',
      url: 'https://xcamp.example.com/app',
      orgId: 'o1',
      orgName: 'Acme',
    });
  });

  it('falls back to the client homepage and name', () => {
    const out = projectGrant(
      { clientId: 'bookforge', clientName: 'Bookforge', clientHomepageUrl: 'https://bookforge.example.com' },
      { orgId: null, orgName: null, userId: 'u1' },
    );
    expect(out).toMatchObject({ label: 'Bookforge', url: 'https://bookforge.example.com' });
  });

  it('drops a grant with an explicitly disabled launcher', () => {
    const out = projectGrant(
      {
        clientId: 'x',
        clientHomepageUrl: 'https://x.example.com',
        clientPortalLauncher: { enabled: false, launchUrl: 'https://x.example.com/app' },
      },
      { orgId: null, orgName: null, userId: 'u1' },
    );
    expect(out).toBeNull();
  });

  it('drops a grant with no linkable url', () => {
    expect(projectGrant({ clientId: 'x' }, { orgId: null, orgName: null, userId: 'u1' })).toBeNull();
    expect(projectGrant({}, { orgId: null, orgName: null, userId: 'u1' })).toBeNull();
  });
});

describe('createNexusAppsProvider', () => {
  it('unions grants across identities (personal + org-scoped) and dedupes by clientId', async () => {
    const send: SendMock = vi.fn(async (_opts: unknown, command: string) => {
      if (command === 'anx.oauth2.org.grants.list') {
        return okResponse([
          { clientId: 'xcamp', clientName: 'Xcamp', clientHomepageUrl: 'https://xcamp.example.com' },
          { clientId: 'bookforge', clientName: 'Bookforge', clientHomepageUrl: 'https://bookforge.example.com' },
        ]);
      }
      return okResponse([
        { clientId: 'xcamp', clientName: 'Xcamp', clientHomepageUrl: 'https://xcamp.example.com' },
      ]);
    });

    const provider = createNexusAppsProvider({
      listIdentities: () => [
        identity({ key: 'private:u1', orgId: null, token: 'personal' }),
        identity({ key: 'business:o1:u1', orgId: 'o1', orgName: 'Acme', token: 'org', deviceId: 'd-org' }),
      ],
      getClientOptions: () => clientOptions,
      send: send as never,
    });

    const result = await provider.list();
    expect(result.ok).toBe(true);
    expect(result.apps.map((a) => a.clientId).sort()).toEqual(['bookforge', 'xcamp']);
    // Personal session uses the self-scoped command; the org session uses the
    // org-scoped one (the self-scoped command returns nothing for an org grant).
    const calls = send.mock.calls as unknown as SendCall[];
    const tokensToCommands = calls.map((c) => [envelopeOf(c).token, c[1]]);
    expect(tokensToCommands).toContainEqual(['personal', 'anx.oauth2.grants.list']);
    expect(tokensToCommands).toContainEqual(['org', 'anx.oauth2.org.grants.list']);
  });

  it('forwards each identity deviceId (device validation is mandatory)', async () => {
    const send: SendMock = vi.fn(async () => okResponse([]));
    const provider = createNexusAppsProvider({
      listIdentities: () => [
        identity({ token: 'personal', orgId: null, deviceId: 'd-personal' }),
        identity({ token: 'org', orgId: 'o1', deviceId: 'd-org' }),
      ],
      getClientOptions: () => clientOptions,
      send: send as never,
    });
    await provider.list();
    const calls = send.mock.calls as unknown as SendCall[];
    const personal = calls.find((c) => envelopeOf(c).token === 'personal')!;
    const org = calls.find((c) => envelopeOf(c).token === 'org')!;
    expect(envelopeOf(personal).identity).toMatchObject({ userId: 'u1', deviceId: 'd-personal' });
    expect(envelopeOf(org).identity).toMatchObject({ userId: 'u1', orgId: 'o1', deviceId: 'd-org' });
  });

  it('falls back to the self-scoped command when the org-scoped read is refused', async () => {
    const send: SendMock = vi.fn(async (_opts: unknown, command: string) => {
      if (command === 'anx.oauth2.org.grants.list') {
        return { responseCode: 403, responseObject: { error: 'forbidden' } };
      }
      return okResponse([
        { clientId: 'mine', clientName: 'Mine', clientHomepageUrl: 'https://mine.example.com' },
      ]);
    });
    const provider = createNexusAppsProvider({
      listIdentities: () => [identity({ orgId: 'o1', token: 'org' })],
      getClientOptions: () => clientOptions,
      send: send as never,
    });
    const result = await provider.list();
    expect(result.ok).toBe(true);
    expect(result.apps.map((a) => a.clientId)).toEqual(['mine']);
    const calls = send.mock.calls as unknown as SendCall[];
    expect(calls.map((c) => c[1])).toEqual([
      'anx.oauth2.org.grants.list',
      'anx.oauth2.grants.list',
    ]);
  });

  it('requests only active grants', async () => {
    const send: SendMock = vi.fn(async () => okResponse([]));
    const provider = createNexusAppsProvider({
      listIdentities: () => [identity()],
      getClientOptions: () => clientOptions,
      send: send as never,
    });
    await provider.list();
    const calls = send.mock.calls as unknown as SendCall[];
    expect(calls[0]![2]).toMatchObject({ status: 'active' });
  });

  it('tolerates a failing identity and still returns the others', async () => {
    const send: SendMock = vi.fn(async (...args: unknown[]) => {
      if ((args[3] as { token?: string })?.token === 'bad') throw new Error('region unreachable');
      return okResponse([
        { clientId: 'ok', clientHomepageUrl: 'https://ok.example.com' },
      ]);
    });
    const provider = createNexusAppsProvider({
      listIdentities: () => [identity({ token: 'bad' }), identity({ token: 'good' })],
      getClientOptions: () => clientOptions,
      send: send as never,
    });
    const result = await provider.list();
    expect(result.ok).toBe(true);
    expect(result.apps.map((a) => a.clientId)).toEqual(['ok']);
  });

  it('reports not-ok and no apps when every identity fails', async () => {
    const send: SendMock = vi.fn(async () => {
      throw new Error('region unreachable');
    });
    const provider = createNexusAppsProvider({
      listIdentities: () => [identity({ token: 'a' }), identity({ token: 'b' })],
      getClientOptions: () => clientOptions,
      send: send as never,
    });
    expect(await provider.list()).toEqual({ apps: [], ok: false });
  });

  it('reports not-ok and no apps when signed out (no identities)', async () => {
    const provider = createNexusAppsProvider({
      listIdentities: () => [],
      getClientOptions: () => clientOptions,
      send: vi.fn() as never,
    });
    expect(await provider.list()).toEqual({ apps: [], ok: false });
  });

  it('ignores identities with no token', async () => {
    const send: SendMock = vi.fn(async () => okResponse([]));
    const provider = createNexusAppsProvider({
      listIdentities: () => [identity({ token: '' })],
      getClientOptions: () => clientOptions,
      send: send as never,
    });
    expect(await provider.list()).toEqual({ apps: [], ok: false });
    expect(send).not.toHaveBeenCalled();
  });
});
