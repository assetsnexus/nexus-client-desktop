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

/**
 * Route by command name. Sign-in now also registers the device, so call-order
 * mocks are brittle; a test names the commands it cares about and any other
 * command is a loud failure instead of a silently-wrong assertion.
 */
function routeByCommand(
  handlers: Record<string, (envelope: Record<string, any>) => Response>,
): typeof fetch {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const envelope = JSON.parse(String(init?.body));
    const handler = handlers[envelope.command];
    if (!handler) throw new Error(`unexpected command in test: ${envelope.command}`);
    return handler(envelope);
  }) as unknown as typeof fetch;
}

// The region echoes back the device id it was sent (`deviceId: payload.deviceId`),
// so the mock must do the same or the persisted id drifts from the login id.
const okDevice = (envelope: Record<string, any>) =>
  jsonResponse({ responseCode: 200, responseObject: { deviceId: envelope.payload.deviceId } });

/** The envelope of the last request whose command matches. */
function envelopeFor(fetchFn: typeof fetch, command: string): Record<string, any> {
  const calls = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
  const match = calls.find((call) => {
    try {
      return JSON.parse(String(call[1]?.body)).command === command;
    } catch {
      return false;
    }
  });
  if (!match) throw new Error(`no request found for command ${command}`);
  return JSON.parse(String(match[1].body));
}

describe('createAuthManager', () => {
  it('starts signed out with no stored token', async () => {
    const { auth } = manager(async () => jsonResponse({}) as unknown as Response);
    expect((await auth.getState()).status).toBe('signed_out');
  });

  it('completes an immediate login and persists the token', async () => {
    const fetchFn = routeByCommand({
      'anx.auth.login': () =>
        jsonResponse({ responseCode: 200, responseObject: { token: 'jwt', userId: 'u1' } }),
      'anx.device.register': okDevice,
    });
    const { auth, store } = manager(fetchFn, createMemorySecureStore());
    const state = await auth.login({ email: 'a@b.c', password: 'pw' });
    expect(state.status).toBe('signed_in');
    expect(await store.get(TOKEN_KEY)).toBe('jwt');
    expect(await auth.getToken()).toBe('jwt');
  });

  it('unwraps an object AuthToken on login (regression: TOTP read as failure)', async () => {
    const fetchFn = routeByCommand({
      'anx.auth.login': () =>
        jsonResponse({
          responseCode: 200,
          responseObject: {
            token: { token: 'jwt-obj', userId: 'u1', orgId: 'o1', role: 'owner', sid: 's1' },
          },
        }),
      'anx.device.register': okDevice,
    });
    const { auth, store } = manager(fetchFn, createMemorySecureStore());
    const state = await auth.login({ email: 'a@b.c', password: 'pw' });
    expect(state.status).toBe('signed_in');
    if (state.status !== 'signed_in') throw new Error('expected signed_in');
    expect(state.token).toBe('jwt-obj');
    expect(state.identity).toMatchObject({ userId: 'u1', orgId: 'o1', role: 'owner' });
    expect(await store.get(TOKEN_KEY)).toBe('jwt-obj');
  });

  it('passes the resolved region through on login', async () => {
    const fetchFn = routeByCommand({
      'anx.auth.login': () =>
        jsonResponse({ responseCode: 200, responseObject: { token: 'jwt', userId: 'u1' } }),
      'anx.device.register': okDevice,
    });
    const { auth } = manager(fetchFn);
    await auth.login({ email: 'a@b.c', password: 'pw', region: 'eu-west' });
    expect(envelopeFor(fetchFn, 'anx.auth.login').payload).toMatchObject({ region: 'eu-west' });
  });

  it('binds the login to this machine so the region can issue the device grant', async () => {
    // Regression: without a deviceId on the login the region logs `device=none`,
    // issues no device-enrolment grant, and the follow-up registration stalls on
    // 2FA — leaving the session with no deviceId and every command 401.
    const fetchFn = routeByCommand({
      'anx.auth.login': () =>
        jsonResponse({ responseCode: 200, responseObject: { token: 'jwt', userId: 'u1' } }),
      'anx.device.register': okDevice,
    });
    const { auth, store } = manager(fetchFn, createMemorySecureStore());
    await auth.login({ email: 'a@b.c', password: 'pw' });

    const loginPayload = envelopeFor(fetchFn, 'anx.auth.login').payload;
    expect(typeof loginPayload.deviceId).toBe('string');
    expect(loginPayload.deviceId).toBeTruthy();
    // The same id is the one sent to registration and persisted locally.
    expect(envelopeFor(fetchFn, 'anx.device.register').payload.deviceId).toBe(loginPayload.deviceId);
    expect(JSON.parse(String(await store.get(SECURE_KEYS.deviceKeys))).deviceId).toBe(loginPayload.deviceId);
  });

  it('lists countries and regions for the picker', async () => {
    const fetchFn = routeByCommand({
      'anx.country.list': () =>
        jsonResponse({
          responseCode: 200,
          responseObject: { countries: [{ code: 'DE', name: 'Germany', state: 'active' }] },
        }),
      'anx.region.list': () =>
        jsonResponse({
          responseCode: 200,
          responseObject: { regions: [{ slug: 'eu-west', name: 'EU West', state: 'active', countryCodes: ['DE'] }] },
        }),
    });
    const { auth } = manager(fetchFn);
    expect((await auth.listCountries()).map((c) => c.code)).toEqual(['DE']);
    expect((await auth.listRegions()).map((r) => r.slug)).toEqual(['eu-west']);
  });

  it('surfaces a 2FA challenge and completes it', async () => {
    const fetchFn = routeByCommand({
      'anx.auth.login': () =>
        jsonResponse({
          responseCode: 200,
          responseObject: {
            requiresTwoFactor: true,
            loginToken: 'lt-1',
            twoFactorMethods: ['email'],
            twoFactorChallengeHint: { channelType: 'email', sentTo: 'a***@b.c' },
          },
        }),
      'anx.auth.twoFactorLogin': () =>
        jsonResponse({ responseCode: 200, responseObject: { token: 'jwt-2' } }),
      'anx.device.register': okDevice,
    });
    const { auth } = manager(fetchFn, createMemorySecureStore());

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
    // The region receives the temporary loginToken, not an authRequestId, and
    // the presenting device id so it can bind the enrolment grant.
    const verify = envelopeFor(fetchFn, 'anx.auth.twoFactorLogin');
    expect(verify.payload.loginToken).toBe('lt-1');
    expect(verify.payload.method).toBe('email');
    expect(typeof verify.payload.deviceId).toBe('string');
    expect(verify.payload.deviceId).toBe(envelopeFor(fetchFn, 'anx.auth.login').payload.deviceId);
  });

  it('resolves the managed region and completes a passwordless sign-in', async () => {
    const fetchFn = routeByCommand({
      'anx.region.node.info': () =>
        jsonResponse({
          responseCode: 200,
          responseObject: { managedRegions: [{ slug: 'eu-west', state: 'active' }] },
        }),
      'anx.auth.passwordless.start': () =>
        jsonResponse({
          responseCode: 200,
          responseObject: { challengeToken: 'ct-1', channel: 'email', maskedTarget: 'a***@b.c' },
        }),
      'anx.auth.passwordless.verify': () =>
        jsonResponse({ responseCode: 200, responseObject: { token: 'jwt-3', userId: 'u3' } }),
      'anx.device.register': okDevice,
    });
    const { auth, store } = manager(fetchFn, createMemorySecureStore());

    const started = await auth.startPasswordless({ channel: 'email', identifier: 'a@b.c' });
    expect(started.status).toBe('two_factor_required');
    const start = envelopeFor(fetchFn, 'anx.auth.passwordless.start');
    expect(start.payload.region).toBe('eu-west');
    expect(start.payload.channel).toBe('email');
    expect(typeof start.payload.deviceId).toBe('string');

    const done = await auth.verifyPasswordless({ code: '123456' });
    expect(done.status).toBe('signed_in');
    expect(await store.get(TOKEN_KEY)).toBe('jwt-3');
  });

  it('clears the token on logout', async () => {
    const fetchFn = routeByCommand({
      'anx.auth.login': () =>
        jsonResponse({ responseCode: 200, responseObject: { token: 'jwt' } }),
      'anx.device.register': okDevice,
    });
    const { auth, store } = manager(fetchFn, createMemorySecureStore());
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
    const fetchFn = routeByCommand({
      'anx.auth.login': () => jsonResponse({ responseCode: 200, responseObject: { token: 'jwt' } }),
      'anx.device.register': () =>
        jsonResponse({ responseCode: 200, responseObject: { deviceId: 'dev-7' } }),
    });
    const { auth, store } = manager(fetchFn, createMemorySecureStore());
    await auth.login({ email: 'a', password: 'b' });

    const status = await auth.registerDevice();
    expect(status).toEqual({ registered: true, deviceId: 'dev-7', hasKeys: true });
    const stored = await store.get(SECURE_KEYS.deviceKeys);
    expect(stored).toContain('BEGIN PUBLIC KEY');
  });

  it('created sender tags commands with the token', async () => {
    const fetchFn = routeByCommand({
      'anx.auth.login': () =>
        jsonResponse({ responseCode: 200, responseObject: { token: 'jwt', userId: 'u1' } }),
      'anx.device.register': okDevice,
      'anx.ping': () => jsonResponse({ responseCode: 200, responseObject: { pong: true } }),
    });
    const { auth } = manager(fetchFn, createMemorySecureStore());
    await auth.login({ email: 'a', password: 'b' });

    const sender = await auth.createSender();
    const res = await sender.send('anx.ping');
    expect(res.ok).toBe(true);
    expect(envelopeFor(fetchFn, 'anx.ping').identity.token).toBe('jwt');
  });
});

describe('createAuthManager — device identity on the command path', () => {
  it('sends the registered deviceId with an authenticated command', async () => {
    // The 401 regression: `anx.communicate.conversations.list` was rejected with
    // "Device validation failed: Device ID is required" because the sender
    // carried a token but no deviceId.
    const fetchFn = routeByCommand({
      'anx.auth.login': () =>
        jsonResponse({ responseCode: 200, responseObject: { token: 'jwt', userId: 'u1' } }),
      'anx.device.register': () =>
        jsonResponse({ responseCode: 200, responseObject: { deviceId: 'dev-registered' } }),
      'anx.communicate.conversations.list': () =>
        jsonResponse({ responseCode: 200, responseObject: { conversations: [] } }),
    });
    const { auth } = manager(fetchFn, createMemorySecureStore());
    await auth.login({ email: 'a@b.c', password: 'pw' });

    const sender = await auth.createSender();
    const res = await sender.send('anx.communicate.conversations.list', {});

    expect(res.ok).toBe(true);
    const envelope = envelopeFor(fetchFn, 'anx.communicate.conversations.list');
    expect(envelope.identity.token).toBe('jwt');
    expect(envelope.identity.deviceId).toBe('dev-registered');
  });

  it('repairs a missing deviceId from the stored keypair (restart / pre-registration session)', async () => {
    // A restarted process has only the identity store + device keypair left. The
    // identity store session may predate registration, so the resolved identity
    // must fold in the acknowledged device id instead of sending none.
    const store = createMemorySecureStore();
    await store.set(TOKEN_KEY, 'jwt');
    await store.set(
      SECURE_KEYS.deviceKeys,
      JSON.stringify({ deviceId: 'dev-from-keys', registeredAt: '2026-01-01T00:00:00.000Z' }),
    );
    const fetchFn = routeByCommand({
      'anx.communicate.conversations.list': () =>
        jsonResponse({ responseCode: 200, responseObject: { conversations: [] } }),
    });
    const auth = createAuthManager({
      secureStore: store,
      clientOptions: { baseUrl: 'https://region.example', fetchFn },
      deviceName: 'test',
      platform: 'linux',
      appVersion: '0.1.0',
      getActiveToken: () => 'jwt',
      // The persisted session record has no deviceId (recorded pre-registration).
      getActiveIdentity: () => ({ userId: 'u1', orgId: null, role: null, deviceId: null }),
    });

    const state = await auth.getState();
    expect(state.status).toBe('signed_in');
    if (state.status !== 'signed_in') throw new Error('expected signed_in');
    expect(state.identity.deviceId).toBe('dev-from-keys');

    const sender = await auth.createSender();
    const res = await sender.send('anx.communicate.conversations.list', {});
    expect(res.ok).toBe(true);
    expect(envelopeFor(fetchFn, 'anx.communicate.conversations.list').identity.deviceId).toBe(
      'dev-from-keys',
    );
  });

  it('self-heals: registers on the first command when the region-acknowledged device is missing', async () => {
    // A session can outlive a refused registration (the region answered 202 at
    // login, so no device row was created). Without a repair, EVERY command is
    // answered with a device-validation 401; the sender must register once and
    // then carry the id.
    const store = createMemorySecureStore();
    await store.set(TOKEN_KEY, 'jwt');
    // A local keypair that was never acknowledged by the region.
    await store.set(SECURE_KEYS.deviceKeys, JSON.stringify({ deviceId: 'dev-local', registeredAt: null }));
    const fetchFn = routeByCommand({
      'anx.device.register': (env) =>
        jsonResponse({ responseCode: 200, responseObject: { deviceId: env.payload.deviceId } }),
      'anx.communicate.conversations.list': () =>
        jsonResponse({ responseCode: 200, responseObject: { conversations: [] } }),
    });
    const auth = createAuthManager({
      secureStore: store,
      clientOptions: { baseUrl: 'https://region.example', fetchFn },
      deviceName: 'test',
      platform: 'linux',
      appVersion: '0.1.0',
      getActiveToken: () => 'jwt',
      getActiveIdentity: () => ({ userId: 'u1', orgId: null, role: null, deviceId: null }),
    });

    const sender = await auth.createSender();
    const res = await sender.send('anx.communicate.conversations.list', {});

    expect(res.ok).toBe(true);
    // Registered exactly once, and the command carried the id the region echoed.
    expect(JSON.parse(String(await store.get(SECURE_KEYS.deviceKeys))).registeredAt).toBeTruthy();
    expect(envelopeFor(fetchFn, 'anx.communicate.conversations.list').identity.deviceId).toBe('dev-local');
  });

  it('never asserts a deviceId the region has not acknowledged', async () => {
    // A locally generated id is sent at login (to bind the enrolment grant) but
    // an unknown id is *rejected* by the region, so it must not be presented as
    // an identity claim until registration confirms it.
    const store = createMemorySecureStore();
    await store.set(TOKEN_KEY, 'jwt');
    await store.set(SECURE_KEYS.deviceKeys, JSON.stringify({ deviceId: 'dev-unregistered' }));
    const fetchFn = routeByCommand({
      'anx.device.register': () =>
        jsonResponse({ responseCode: 202, responseObject: { authorizationRequired: true } }, 202),
    });
    const auth = createAuthManager({
      secureStore: store,
      clientOptions: { baseUrl: 'https://region.example', fetchFn },
      deviceName: 'test',
      platform: 'linux',
      appVersion: '0.1.0',
      getActiveToken: () => 'jwt',
      getActiveIdentity: () => ({ userId: 'u1', orgId: null, role: null, deviceId: null }),
    });

    const state = await auth.getState();
    if (state.status !== 'signed_in') throw new Error('expected signed_in');
    expect(state.identity.deviceId).toBeNull();
  });

  it('treats an already-registered device as success rather than failing the session', async () => {
    const fetchFn = routeByCommand({
      'anx.auth.login': () =>
        jsonResponse({ responseCode: 200, responseObject: { token: 'jwt', userId: 'u1' } }),
      'anx.device.register': () =>
        jsonResponse(
          { responseCode: 409, errorObjects: [{ code: 'DEVICE_ALREADY_REGISTERED', message: 'already registered' }] },
          409,
        ),
    });
    const { auth } = manager(fetchFn, createMemorySecureStore());
    const state = await auth.login({ email: 'a@b.c', password: 'pw' });
    expect(state.status).toBe('signed_in');
    if (state.status !== 'signed_in') throw new Error('expected signed_in');
    // The keypair is ours, so the id holds; the session is not left deviceless.
    expect(state.identity.deviceId).toBe(envelopeFor(fetchFn, 'anx.auth.login').payload.deviceId);
  });

  it('as a last resort asks the region to register when signing in without a device id', async () => {
    // Hydration with a stored token and no keypair: registration must run before
    // the first command, otherwise it would be rejected for a missing deviceId.
    const store = createMemorySecureStore();
    await store.set(TOKEN_KEY, 'jwt');
    const fetchFn = routeByCommand({
      'anx.device.list': () => jsonResponse({ responseCode: 200, responseObject: {} }),
      'anx.device.register': () =>
        jsonResponse({ responseCode: 200, responseObject: { deviceId: 'dev-hydrated' } }),
    });
    const auth = createAuthManager({
      secureStore: store,
      clientOptions: { baseUrl: 'https://region.example', fetchFn },
      deviceName: 'test',
      platform: 'linux',
      appVersion: '0.1.0',
      getActiveToken: () => 'jwt',
      getActiveIdentity: () => ({ userId: 'u1', orgId: null, role: null, deviceId: null }),
    });

    const hydration = await auth.hydrateSession();
    expect(hydration.view).toBe('signed_in');
    const state = await auth.getState();
    if (state.status !== 'signed_in') throw new Error('expected signed_in');
    expect(state.identity.deviceId).toBe('dev-hydrated');
  });
});

describe('createAuthManager — device link', () => {
  it('starts a link, hides the secret, and signs in on approval', async () => {
    let pollCount = 0;
    const fetchFn = routeByCommand({
      'anx.auth.device-link.start': () =>
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
      'anx.auth.device-link.poll': () => {
        pollCount += 1;
        if (pollCount === 1) {
          return jsonResponse({ responseCode: 200, responseObject: { status: 'pending', interval: 5 } });
        }
        return jsonResponse({
          responseCode: 200,
          responseObject: {
            status: 'approved',
            token: 'jwt-link',
            session: {
              id: 'sess-1',
              userId: 'u9',
              token: { token: 'jwt-link', userId: 'u9', orgId: 'org-2', role: 'owner' },
            },
          },
        });
      },
      'anx.device.register': okDevice,
    });

    const { auth, store } = manager(fetchFn, createMemorySecureStore());

    const started = await auth.startDeviceLink();
    expect(started.userCode).toBe('H7K2-9QFP');
    expect(started.verificationUri).toContain('H7K2-9QFP');
    // The renderer never sees the secret device code.
    expect((started as Record<string, unknown>).deviceCode).toBeUndefined();

    expect((await auth.pollDeviceLink()).status).toBe('pending');
    // Secret deviceCode was sent to the region on poll, not leaked upward.
    expect(envelopeFor(fetchFn, 'anx.auth.device-link.poll').payload.deviceCode).toBe('secret-123');

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

    const fetchFn = routeByCommand({
      'anx.auth.login': () =>
        jsonResponse({ responseCode: 200, responseObject: { token: 'jwt', userId: 'u1', deviceId: 'dev-1' } }),
      'anx.device.register': okDevice,
      'anx.storage.workspace.list': () =>
        jsonResponse(
          { responseCode: 401, message: 'Device validation failed: Device has been removed and is no longer active' },
          401,
        ),
    });

    const auth = createAuthManager({
      secureStore: store,
      clientOptions: { baseUrl: 'https://region.example', fetchFn },
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
    const fetchFn = routeByCommand({
      'anx.auth.login': () =>
        jsonResponse({ responseCode: 200, responseObject: { token: 'jwt', userId: 'u1' } }),
      'anx.device.register': okDevice,
      'anx.storage.workspace.folder.create': () =>
        jsonResponse({ responseCode: 400, message: 'invalid folder name' }, 400),
    });

    const auth = createAuthManager({
      secureStore: store,
      clientOptions: { baseUrl: 'https://region.example', fetchFn },
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
    const fetchFn = routeByCommand({
      'anx.auth.login': () =>
        jsonResponse({ responseCode: 200, responseObject: { token: 'jwt', userId: 'u1' } }),
      'anx.device.register': okDevice,
      'anx.ai-agents.virtual-employees.list': () =>
        jsonResponse({ responseCode: 403, errorObjects: [{ code: 'FORBIDDEN', message: 'Access denied' }] }, 403),
    });

    const auth = createAuthManager({
      secureStore: store,
      clientOptions: { baseUrl: 'https://region.example', fetchFn },
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
    const fetchFn = routeByCommand({
      'anx.ai-agents.virtual-employees.list': () =>
        jsonResponse({ responseCode: 401, errorObjects: [{ code: 'UNAUTHORIZED', message: 'Authentication required' }] }, 401),
    });

    const auth = createAuthManager({
      secureStore: store,
      clientOptions: { baseUrl: 'https://region.example', fetchFn },
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
