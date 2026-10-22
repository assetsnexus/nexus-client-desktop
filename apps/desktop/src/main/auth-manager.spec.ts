import { describe, expect, it, vi } from 'vitest';
import { createMemorySecureStore, scopedKey, SECURE_KEYS } from '@nexus/node-core';
import { createAuthManager } from './auth-manager.js';

const TOKEN_KEY = scopedKey(SECURE_KEYS.token, null);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function manager(fetchFn: typeof fetch, store = createMemorySecureStore()) {
  return {
    store,
    auth: createAuthManager({
      secureStore: store,
      clientOptions: { baseUrl: 'https://region.example', fetchFn },
      deviceName: 'test',
      platform: 'linux',
      appVersion: '0.1.0',
    }),
  };
}

describe('createAuthManager', () => {
  it('starts signed out with no stored token', async () => {
    const { auth } = manager(async () => jsonResponse({}) as unknown as Response);
    expect((await auth.getState()).status).toBe('signed_out');
  });

  it('completes an immediate login and persists the token', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ responseCode: 200, responseObject: { token: 'jwt', userId: 'u1' } }),
    );
    const { auth, store } = manager(fetchFn as unknown as typeof fetch, createMemorySecureStore());
    const state = await auth.login({ email: 'a@b.c', password: 'pw' });
    expect(state.status).toBe('signed_in');
    expect(await store.get(TOKEN_KEY)).toBe('jwt');
    expect(await auth.getToken()).toBe('jwt');
  });

  it('unwraps an object AuthToken on login (regression: TOTP read as failure)', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        responseCode: 200,
        responseObject: {
          token: { token: 'jwt-obj', userId: 'u1', orgId: 'o1', role: 'owner', sid: 's1' },
        },
      }),
    );
    const { auth, store } = manager(fetchFn as unknown as typeof fetch, createMemorySecureStore());
    const state = await auth.login({ email: 'a@b.c', password: 'pw' });
    expect(state.status).toBe('signed_in');
    if (state.status !== 'signed_in') throw new Error('expected signed_in');
    expect(state.token).toBe('jwt-obj');
    expect(state.identity).toMatchObject({ userId: 'u1', orgId: 'o1', role: 'owner' });
    expect(await store.get(TOKEN_KEY)).toBe('jwt-obj');
  });

  it('passes the resolved region through on login', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ responseCode: 200, responseObject: { token: 'jwt', userId: 'u1' } }),
    );
    const { auth } = manager(fetchFn as unknown as typeof fetch);
    await auth.login({ email: 'a@b.c', password: 'pw', region: 'eu-west' });
    const call = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const envelope = JSON.parse(String(call[1].body));
    expect(envelope.payload).toMatchObject({ region: 'eu-west' });
  });

  it('lists countries and regions for the picker', async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const { command } = JSON.parse(String(init.body));
      if (command === 'anx.country.list') {
        return jsonResponse({
          responseCode: 200,
          responseObject: { countries: [{ code: 'DE', name: 'Germany', state: 'active' }] },
        });
      }
      return jsonResponse({
        responseCode: 200,
        responseObject: { regions: [{ slug: 'eu-west', name: 'EU West', state: 'active', countryCodes: ['DE'] }] },
      });
    });
    const { auth } = manager(fetchFn as unknown as typeof fetch);
    expect((await auth.listCountries()).map((c) => c.code)).toEqual(['DE']);
    expect((await auth.listRegions()).map((r) => r.slug)).toEqual(['eu-west']);
  });

  it('surfaces a 2FA challenge and completes it', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            responseCode: 200,
            responseObject: {
              requiresTwoFactor: true,
              loginToken: 'lt-1',
              twoFactorMethods: ['email'],
              twoFactorChallengeHint: { channelType: 'email', sentTo: 'a***@b.c' },
            },
          },
          200,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ responseCode: 200, responseObject: { token: 'jwt-2' } }));
    const { auth } = manager(fetchFn as unknown as typeof fetch, createMemorySecureStore());

    const first = await auth.login({ email: 'a@b.c', password: 'pw' });
    expect(first.status).toBe('two_factor_required');
    if (first.status === 'two_factor_required') {
      expect(first.loginToken).toBe('lt-1');
      expect(first.methods).toContain('email');
      expect(first.hint?.sentTo).toBe('a***@b.c');
    }
    const state = await auth.getState();
    expect(state.status).toBe('two_factor_required');

    const done = await auth.submitTwoFactor({ code: '123456', method: 'email' });
    expect(done.status).toBe('signed_in');
    // The region receives the temporary loginToken, not an authRequestId.
    const verifyEnvelope = JSON.parse(String((fetchFn.mock.calls[1] as [string, RequestInit])[1].body));
    expect(verifyEnvelope.command).toBe('anx.auth.twoFactorLogin');
    expect(verifyEnvelope.payload.loginToken).toBe('lt-1');
    expect(verifyEnvelope.payload.method).toBe('email');
  });

  it('resolves the managed region and completes a passwordless sign-in', async () => {
    const fetchFn = vi
      .fn()
      // 1. region discovery
      .mockResolvedValueOnce(
        jsonResponse({
          responseCode: 200,
          responseObject: { managedRegions: [{ slug: 'eu-west', state: 'active' }] },
        }),
      )
      // 2. passwordless start
      .mockResolvedValueOnce(
        jsonResponse({
          responseCode: 200,
          responseObject: { challengeToken: 'ct-1', channel: 'email', maskedTarget: 'a***@b.c' },
        }),
      )
      // 3. passwordless verify -> session
      .mockResolvedValueOnce(
        jsonResponse({ responseCode: 200, responseObject: { token: 'jwt-3', userId: 'u3' } }),
      );

    const { auth, store } = manager(fetchFn as unknown as typeof fetch, createMemorySecureStore());

    const started = await auth.startPasswordless({ channel: 'email', identifier: 'a@b.c' });
    expect(started.status).toBe('two_factor_required');
    const startEnvelope = JSON.parse(String((fetchFn.mock.calls[1] as [string, RequestInit])[1].body));
    expect(startEnvelope.command).toBe('anx.auth.passwordless.start');
    expect(startEnvelope.payload.region).toBe('eu-west');
    expect(startEnvelope.payload.channel).toBe('email');

    const done = await auth.verifyPasswordless({ code: '123456' });
    expect(done.status).toBe('signed_in');
    expect(await store.get(TOKEN_KEY)).toBe('jwt-3');
  });

  it('clears the token on logout', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ responseCode: 200, responseObject: { token: 'jwt' } }),
    );
    const { auth, store } = manager(fetchFn as unknown as typeof fetch, createMemorySecureStore());
    await auth.login({ email: 'a', password: 'b' });
    await auth.logout();
    expect((await auth.getState()).status).toBe('signed_out');
    expect(await store.get(TOKEN_KEY)).toBeNull();
  });

  it('reports device status as not registered before any device setup', async () => {
    const { auth } = manager(async () => jsonResponse({}) as unknown as Response);
    expect(await auth.getDeviceStatus()).toEqual({
      registered: false,
      deviceId: null,
      hasKeys: false,
    });
  });

  it('registers a device, generating and persisting a keypair', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body));
      if (envelope.command === 'anx.auth.login') {
        return jsonResponse({ responseCode: 200, responseObject: { token: 'jwt' } });
      }
      return jsonResponse({ responseCode: 200, responseObject: { deviceId: 'dev-7' } });
    });
    const { auth, store } = manager(fetchFn as unknown as typeof fetch, createMemorySecureStore());
    await auth.login({ email: 'a', password: 'b' });

    const status = await auth.registerDevice();
    expect(status).toEqual({ registered: true, deviceId: 'dev-7', hasKeys: true });
    const stored = await store.get(SECURE_KEYS.deviceKeys);
    expect(stored).toContain('BEGIN PUBLIC KEY');
  });

  it('created sender tags commands with the token', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body));
      if (envelope.command === 'anx.auth.login') {
        return jsonResponse({ responseCode: 200, responseObject: { token: 'jwt', userId: 'u1' } });
      }
      return jsonResponse({ responseCode: 200, responseObject: { pong: true } });
    });
    const { auth } = manager(fetchFn as unknown as typeof fetch, createMemorySecureStore());
    await auth.login({ email: 'a', password: 'b' });

    const sender = await auth.createSender();
    const res = await sender.send('anx.ping');
    expect(res.ok).toBe(true);
    const lastCall = fetchFn.mock.calls.at(-1) as [string, RequestInit];
    const envelope = JSON.parse(String(lastCall[1].body));
    expect(envelope.identity.token).toBe('jwt');
  });
});

describe('createAuthManager — device link', () => {
  it('starts a link, hides the secret, and signs in on approval', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          responseCode: 200,
          responseObject: {
            deviceCode: 'secret-123',
            userCode: 'H7K2-9QFP',
            verificationUri: 'https://portal.example/link?code=H7K2-9QFP',
            expiresAt: '2030-01-01T00:05:00.000Z',
            interval: 5,
          },
        }),
      )
      // First poll: still pending.
      .mockResolvedValueOnce(
        jsonResponse({ responseCode: 200, responseObject: { status: 'pending', interval: 5 } }),
      )
      // Second poll: approved, with the minted session.
      .mockResolvedValueOnce(
        jsonResponse({
          responseCode: 200,
          responseObject: {
            status: 'approved',
            token: 'jwt-link',
            session: { id: 'sess-1', userId: 'u9', token: { token: 'jwt-link', userId: 'u9', orgId: 'org-2', role: 'owner' } },
          },
        }),
      );

    const { auth, store } = manager(fetchFn as unknown as typeof fetch, createMemorySecureStore());

    const started = await auth.startDeviceLink();
    expect(started.userCode).toBe('H7K2-9QFP');
    expect(started.verificationUri).toContain('H7K2-9QFP');
    // The renderer never sees the secret device code.
    expect((started as Record<string, unknown>).deviceCode).toBeUndefined();

    expect((await auth.pollDeviceLink()).status).toBe('pending');
    // Secret deviceCode was sent to the region on poll, not leaked upward.
    const pollEnvelope = JSON.parse(String((fetchFn.mock.calls[1] as [string, RequestInit])[1].body));
    expect(pollEnvelope.command).toBe('anx.auth.device-link.poll');
    expect(pollEnvelope.payload.deviceCode).toBe('secret-123');

    const done = await auth.pollDeviceLink();
    expect(done.status).toBe('approved');
    if (done.status === 'approved') {
      expect(done.authState.status).toBe('signed_in');
      if (done.authState.status === 'signed_in') {
        expect(done.authState.identity.userId).toBe('u9');
      }
    }
    expect(await store.get(TOKEN_KEY)).toBe('jwt-link');
    expect(await auth.getToken()).toBe('jwt-link');
  });

  it('reports expired when polling without an active link', async () => {
    const { auth } = manager(async () => jsonResponse({}) as unknown as Response);
    expect((await auth.pollDeviceLink()).status).toBe('expired');
  });
});

describe('createAuthManager — device revocation', () => {
  it('tears down tokens + keys and fires onSessionLost when the device is removed', async () => {
    const onSessionLost = vi.fn();
    const store = createMemorySecureStore();
    await store.set(TOKEN_KEY, 'jwt');
    await store.set(SECURE_KEYS.deviceKeys, JSON.stringify({ deviceId: 'dev-1' }));

    // login first so the manager caches identity, then a command is rejected.
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ responseCode: 200, responseObject: { token: 'jwt', userId: 'u1', deviceId: 'dev-1' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { responseCode: 401, message: 'Device validation failed: Device has been removed and is no longer active' },
          401,
        ),
      );

    const auth = createAuthManager({
      secureStore: store,
      clientOptions: { baseUrl: 'https://region.example', fetchFn: fetchFn as unknown as typeof fetch },
      deviceName: 'test',
      platform: 'linux',
      appVersion: '0.1.0',
      onSessionLost,
    });

    await auth.login({ email: 'a@b.c', password: 'pw' });
    const sender = await auth.createSender();
    const res = await sender.send('anx.storage.workspace.list', {});

    expect(res.ok).toBe(false);
    expect(onSessionLost).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'device_revoked', deviceRevoked: true }),
    );
    // All access is gone: token + device keys wiped, state signed out.
    expect(await store.get(TOKEN_KEY)).toBeNull();
    expect(await store.get(SECURE_KEYS.deviceKeys)).toBeNull();
    expect((await auth.getState()).status).toBe('signed_out');
  });

  it('does not tear down on ordinary business errors', async () => {
    const onSessionLost = vi.fn();
    const store = createMemorySecureStore();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ responseCode: 200, responseObject: { token: 'jwt', userId: 'u1' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ responseCode: 400, message: 'invalid folder name' }, 400));

    const auth = createAuthManager({
      secureStore: store,
      clientOptions: { baseUrl: 'https://region.example', fetchFn: fetchFn as unknown as typeof fetch },
      deviceName: 'test',
      platform: 'linux',
      appVersion: '0.1.0',
      onSessionLost,
    });
    await auth.login({ email: 'a@b.c', password: 'pw' });
    const sender = await auth.createSender();
    await sender.send('anx.storage.workspace.folder.create', {});

    expect(onSessionLost).not.toHaveBeenCalled();
    expect(await store.get(TOKEN_KEY)).toBe('jwt');
  });

  it('does not tear down a signed-in session on a 403 authorization denial', async () => {
    // Regression: opening a panel whose catalog command is not permitted (e.g.
    // the wake-word agent list in Settings) returned 403, was misread as
    // session loss, and signed the user out — the panel opened then vanished.
    const onSessionLost = vi.fn();
    const store = createMemorySecureStore();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ responseCode: 200, responseObject: { token: 'jwt', userId: 'u1' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ responseCode: 403, errorObjects: [{ code: 'FORBIDDEN', message: 'Access denied' }] }, 403),
      );

    const auth = createAuthManager({
      secureStore: store,
      clientOptions: { baseUrl: 'https://region.example', fetchFn: fetchFn as unknown as typeof fetch },
      deviceName: 'test',
      platform: 'linux',
      appVersion: '0.1.0',
      onSessionLost,
    });
    await auth.login({ email: 'a@b.c', password: 'pw' });
    const sender = await auth.createSender();
    const res = await sender.send('anx.ai-agents.virtual-employees.list', {});

    expect(res.ok).toBe(false);
    expect(res.responseCode).toBe(403);
    expect(res.code).toBe('FORBIDDEN');
    expect(onSessionLost).not.toHaveBeenCalled();
    expect(await store.get(TOKEN_KEY)).toBe('jwt');
    expect((await auth.getState()).status).toBe('signed_in');
  });

  it('does not tear down when an anonymous (token-less) command is refused', async () => {
    // A pre-sign-in command that the region refuses proves nothing about the
    // device; tearing down here would wipe a session that does not exist yet.
    const onSessionLost = vi.fn();
    const store = createMemorySecureStore();
    const fetchFn = vi.fn(async () =>
      jsonResponse({ responseCode: 401, errorObjects: [{ code: 'UNAUTHORIZED', message: 'Authentication required' }] }, 401),
    );

    const auth = createAuthManager({
      secureStore: store,
      clientOptions: { baseUrl: 'https://region.example', fetchFn: fetchFn as unknown as typeof fetch },
      deviceName: 'test',
      platform: 'linux',
      appVersion: '0.1.0',
      onSessionLost,
    });
    const sender = await auth.createSender();
    const res = await sender.send('anx.ai-agents.virtual-employees.list', {});

    expect(res.responseCode).toBe(401);
    expect(onSessionLost).not.toHaveBeenCalled();
  });
});
