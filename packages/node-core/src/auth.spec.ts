import { describe, expect, it, vi } from 'vitest';
import { RegionAuthError, login, sendCommand, twoFactorLogin } from './auth.js';

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
        responseCode: 202,
        responseObject: { requiresTwoFactor: true, factors: ['email', 'sms'] },
        authRequestId: 'auth-1',
      }),
    );
    const result = await login({ ...base, fetchFn: fetchFn as unknown as typeof fetch }, {
      email: 'a@b.c',
      password: 'pw',
    });
    expect(result.kind).toBe('two_factor_required');
    if (result.kind === 'two_factor_required') {
      expect(result.challenge.authRequestId).toBe('auth-1');
      expect(result.challenge.factors).toEqual(['email', 'sms']);
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
      authRequestId: 'auth-1',
      code: '123456',
    });
    expect(out.token).toBe('jwt-2');
    expect(out.identity.userId).toBe('u1');
  });

  it('falls back to the alternate command on 404', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ responseCode: 404, responseObject: {} }))
      .mockResolvedValueOnce(jsonResponse({ responseCode: 200, responseObject: { token: 'jwt-3' } }));
    const out = await twoFactorLogin(
      { ...base, fetchFn: fetchFn as unknown as typeof fetch },
      { authRequestId: 'auth-1', code: '000000' },
    );
    expect(out.token).toBe('jwt-3');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const second = JSON.parse(String((fetchFn.mock.calls[1] as [string, RequestInit])[1].body));
    expect(second.command).toBe('anx.auth.verify2fa');
  });

  it('throws on failure', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ responseCode: 401, responseObject: {}, message: 'wrong code' }),
    );
    await expect(
      twoFactorLogin({ ...base, fetchFn: fetchFn as unknown as typeof fetch }, {
        authRequestId: 'auth-1',
        code: 'x',
      }),
    ).rejects.toThrow(/wrong code/);
  });
});
