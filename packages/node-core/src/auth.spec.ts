import { describe, expect, it, vi } from 'vitest';
import {
  RegionAuthError,
  listCountries,
  listRegions,
  login,
  readIdentity,
  sendCommand,
  twoFactorLogin,
} from './auth.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const base = { baseUrl: 'https://region.example/' };

describe('sendCommand', () => {
  it('posts the envelope and normalizes the response', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ responseCode: 200, responseObject: { ok: true } }),
    );
    const res = await sendCommand({ ...base, fetchFn: fetchFn as unknown as typeof fetch }, 'anx.ping', {
      a: 1,
    });
    expect(res.responseCode).toBe(200);
    expect(res.responseObject).toEqual({ ok: true });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://region.example/command');
    const envelope = JSON.parse(String(init.body));
    expect(envelope.command).toBe('anx.ping');
    expect(envelope.payload).toEqual({ a: 1 });
    expect(envelope.responseExpected).toBe(true);
    expect(typeof envelope.requestId).toBe('string');
  });

  it('attaches the bearer token and identity', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ responseCode: 200, responseObject: {} }));
    await sendCommand(
      { ...base, fetchFn: fetchFn as unknown as typeof fetch, headers: { 'X-Anx-App': 'nexus-desktop' } },
      'anx.x',
      {},
      { token: 'tok', identity: { userId: 'u1' } },
    );
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect((init.headers as Record<string, string>)['X-Anx-App']).toBe('nexus-desktop');
    const envelope = JSON.parse(String(init.body));
    expect(envelope.identity).toEqual({ userId: 'u1', token: 'tok' });
  });

  it('throws a RegionAuthError on transport failure', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      sendCommand({ ...base, fetchFn: fetchFn as unknown as typeof fetch }, 'anx.x'),
    ).rejects.toBeInstanceOf(RegionAuthError);
  });
});

describe('login', () => {
  it('returns a token when authentication completes immediately', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        responseCode: 200,
        responseObject: { token: 'jwt-1', userId: 'u1', orgId: 'o1', role: 'member' },
      }),
    );
    const result = await login({ ...base, fetchFn: fetchFn as unknown as typeof fetch }, {
      email: 'a@b.c',
      password: 'pw',
    });
    expect(result.kind).toBe('authenticated');
    if (result.kind === 'authenticated') {
      expect(result.token).toBe('jwt-1');
      expect(result.identity.userId).toBe('u1');
      expect(result.identity.orgId).toBe('o1');
    }
  });

  it('returns a 2FA challenge when the region requires it', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        responseCode: 200,
        responseObject: {
          requiresTwoFactor: true,
          loginToken: 'lt-1',
          twoFactorMethods: ['email', 'sms'],
          twoFactorChallengeHint: { channelType: 'email', sentTo: 'a***@b.c' },
        },
      }),
    );
    const result = await login({ ...base, fetchFn: fetchFn as unknown as typeof fetch }, {
      email: 'a@b.c',
      password: 'pw',
    });
    expect(result.kind).toBe('two_factor_required');
    if (result.kind === 'two_factor_required') {
      expect(result.challenge.loginToken).toBe('lt-1');
      expect(result.challenge.methods).toEqual(['email', 'sms']);
      expect(result.challenge.factors).toEqual(['email', 'sms']);
      expect(result.challenge.hint?.sentTo).toBe('a***@b.c');
    }
  });

  it('throws when neither token nor challenge is present', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ responseCode: 401, responseObject: {}, message: 'bad credentials' }),
    );
    await expect(
      login({ ...base, fetchFn: fetchFn as unknown as typeof fetch }, { email: 'a', password: 'b' }),
    ).rejects.toThrow(/bad credentials/);
  });
});

describe('twoFactorLogin', () => {
  it('completes and returns a token', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ responseCode: 200, responseObject: { token: 'jwt-2', userId: 'u1' } }),
    );
    const out = await twoFactorLogin({ ...base, fetchFn: fetchFn as unknown as typeof fetch }, {
      loginToken: 'lt-1',
      method: 'email',
      code: '123456',
    });
    expect(out.token).toBe('jwt-2');
    expect(out.identity.userId).toBe('u1');
    const envelope = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body));
    expect(envelope.command).toBe('anx.auth.twoFactorLogin');
    expect(envelope.payload).toEqual({ loginToken: 'lt-1', method: 'email', code: '123456' });
  });

  it('throws on failure', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ responseCode: 400, responseObject: {}, message: 'wrong code' }),
    );
    await expect(
      twoFactorLogin({ ...base, fetchFn: fetchFn as unknown as typeof fetch }, {
        loginToken: 'lt-1',
        method: 'email',
        code: 'x',
      }),
    ).rejects.toThrow(/wrong code/);
  });

  /**
   * Regression: the region's `LoginResponse.token` is an `AuthToken` object, not
   * a bare JWT string. Reading only the string form made a *successful* TOTP
   * verification look like `two-factor verification failed` (responseCode 200).
   */
  it('unwraps the AuthToken object and reads its identity claims', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        responseCode: 200,
        responseObject: {
          requiresTwoFactor: false,
          token: {
            token: 'jwt-object',
            expiresAt: '2026-10-23T00:00:00.000Z',
            userId: 'u9',
            orgId: 'o9',
            role: 'owner',
            sid: 'sid-9',
          },
        },
      }),
    );
    const out = await twoFactorLogin({ ...base, fetchFn: fetchFn as unknown as typeof fetch }, {
      loginToken: 'lt-1',
      method: 'authenticator',
      code: '59754095',
    });
    expect(out.token).toBe('jwt-object');
    expect(out.identity).toMatchObject({ userId: 'u9', orgId: 'o9', role: 'owner' });
  });
});

describe('readIdentity', () => {
  it('reads identity claims from a nested AuthToken object', () => {
    const identity = readIdentity({
      token: { token: 'jwt', userId: 'u1', orgId: 'o1', role: 'member' },
    });
    expect(identity).toMatchObject({ userId: 'u1', orgId: 'o1', role: 'member' });
  });

  it('prefers top-level claims over the nested token', () => {
    const identity = readIdentity({
      userId: 'top',
      token: { token: 'jwt', userId: 'nested' },
    });
    expect(identity.userId).toBe('top');
  });
});

describe('login', () => {
  it('forwards the resolved region and deviceId', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ responseCode: 200, responseObject: { token: 'jwt', userId: 'u1' } }),
    );
    await login({ ...base, fetchFn: fetchFn as unknown as typeof fetch }, {
      email: 'a@b.c',
      password: 'pw',
      region: 'europe-west',
      deviceId: 'dev-1',
    });
    const envelope = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body));
    expect(envelope.payload).toMatchObject({
      email: 'a@b.c',
      region: 'europe-west',
      deviceId: 'dev-1',
    });
  });

  it('reads the token from a successful AuthToken-object response', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        responseCode: 200,
        responseObject: { token: { token: 'jwt-obj', userId: 'u1', orgId: 'o1' } },
      }),
    );
    const result = await login({ ...base, fetchFn: fetchFn as unknown as typeof fetch }, {
      email: 'a@b.c',
      password: 'pw',
    });
    expect(result.kind).toBe('authenticated');
    if (result.kind !== 'authenticated') throw new Error('expected authenticated');
    expect(result.token).toBe('jwt-obj');
    expect(result.identity).toMatchObject({ userId: 'u1', orgId: 'o1' });
  });
});

describe('listCountries', () => {
  it('keeps active/preview rows, sorts by name, and drops empties', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        responseCode: 200,
        responseObject: {
          countries: [
            { code: 'US', name: 'United States', region: 'us-east', state: 'active' },
            { code: 'DE', name: 'Germany', region: 'eu-west', state: 'active' },
            { code: 'XX', name: 'Disabled Land', state: 'inactive' },
            { code: 'IT', name: 'Italy', region: 'eu-west', state: 'preview' },
            { code: '', name: 'Nameless', state: 'active' },
          ],
        },
      }),
    );
    const rows = await listCountries({ ...base, fetchFn: fetchFn as unknown as typeof fetch });
    expect(rows.map((c) => c.code)).toEqual(['DE', 'IT', 'US']);
    const envelope = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body));
    expect(envelope.command).toBe('anx.country.list');
  });
});

describe('listRegions', () => {
  it('drops the global region and normalizes countryCodes', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        responseCode: 200,
        responseObject: {
          regions: [
            { slug: 'global', name: 'Global', state: 'active', countryCodes: [] },
            { slug: 'eu-west', name: 'EU West', state: 'active', countryCodes: ['DE', 'FR', 7] },
            { slug: 'us-east', name: 'US East', state: 'inactive' },
          ],
        },
      }),
    );
    const rows = await listRegions({ ...base, fetchFn: fetchFn as unknown as typeof fetch });
    expect(rows.map((r) => r.slug)).toEqual(['eu-west', 'us-east']);
    expect(rows[0]?.countryCodes).toEqual(['DE', 'FR']);
    const envelope = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body));
    expect(envelope.command).toBe('anx.region.list');
  });
});
