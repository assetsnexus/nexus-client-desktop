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

  it('surfaces a 2FA challenge and completes it', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            responseCode: 202,
            responseObject: { requiresTwoFactor: true, factors: ['email'] },
            authRequestId: 'auth-1',
          },
          202,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ responseCode: 200, responseObject: { token: 'jwt-2' } }));
    const { auth } = manager(fetchFn as unknown as typeof fetch, createMemorySecureStore());

    const first = await auth.login({ email: 'a@b.c', password: 'pw' });
    expect(first.status).toBe('two_factor_required');
    if (first.status === 'two_factor_required') {
      expect(first.authRequestId).toBeTruthy();
    }
    const state = await auth.getState();
    expect(state.status).toBe('two_factor_required');

    const done = await auth.submitTwoFactor({
      authRequestId: (first as { authRequestId: string }).authRequestId,
      code: '123456',
    });
    expect(done.status).toBe('signed_in');
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
