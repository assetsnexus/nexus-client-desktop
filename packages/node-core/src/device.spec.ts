import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryDeviceKeyStore,
  ensureDeviceIdentity,
  generateDeviceKeys,
  generateRecoveryCode,
  registerDevice,
} from './device.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('generateDeviceKeys', () => {
  it('produces an RSA PEM keypair with a device id', () => {
    const keys = generateDeviceKeys(() => new Date('2026-01-02T03:04:05Z'));
    expect(keys.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(keys.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(keys.deviceId).toMatch(/[0-9a-f-]{36}/);
    expect(keys.createdAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('generates unique device ids', () => {
    expect(generateDeviceKeys().deviceId).not.toBe(generateDeviceKeys().deviceId);
  });
});

describe('generateRecoveryCode', () => {
  it('returns a hex string of the requested byte length', () => {
    expect(generateRecoveryCode(8)).toHaveLength(16);
    expect(generateRecoveryCode(8)).toMatch(/^[0-9a-f]+$/);
  });
});

describe('registerDevice', () => {
  it('submits the public key and desktop device type', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ responseCode: 200, responseObject: { deviceId: 'dev-1' } }),
    );
    const keys = generateDeviceKeys();
    const out = await registerDevice(
      { baseUrl: 'https://r.example', fetchFn: fetchFn as unknown as typeof fetch },
      keys,
      { deviceName: 'alex-laptop', platform: 'linux', appVersion: '0.1.0' },
      'tok',
    );
    expect(out.deviceId).toBe('dev-1');
    const envelope = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body));
    expect(envelope.command).toBe('anx.device.register');
    expect(envelope.payload.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(envelope.payload.deviceType).toBe('desktop');
    expect(envelope.payload.deviceName).toBe('alex-laptop');
    expect(envelope.identity.token).toBe('tok');
  });

  it('sends the field names the region handler requires (generalPublicKey + privatePublicKey)', async () => {
    // Regression: sending only the legacy `publicKey` made the region answer
    // 400 MISSING_REQUIRED_FIELDS, so the device row was never created and every
    // later authenticated command failed with 401 'Device ID is required'.
    const fetchFn = vi.fn(async () =>
      jsonResponse({ responseCode: 200, responseObject: { deviceId: 'dev-2' } }),
    );
    const keys = generateDeviceKeys();
    await registerDevice(
      { baseUrl: 'https://r.example', fetchFn: fetchFn as unknown as typeof fetch },
      keys,
      { deviceName: 'alex-laptop', platform: 'linux' },
      'tok',
    );
    const envelope = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body));
    expect(envelope.payload.generalPublicKey).toBe(keys.publicKeyPem);
    expect(envelope.payload.privatePublicKey).toBe(keys.publicKeyPem);
    expect(envelope.payload.platform).toBe('linux');
  });

  it('throws on a non-2xx response', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ responseCode: 400, responseObject: {}, message: 'bad key' }),
    );
    await expect(
      registerDevice(
        { baseUrl: 'https://r.example', fetchFn: fetchFn as unknown as typeof fetch },
        generateDeviceKeys(),
        {},
        'tok',
      ),
    ).rejects.toThrow(/bad key/);
  });

  it('reads the echoed client device id, not the Mongo `device.id`', async () => {
    // Regression: the region answers `{ device: { id, deviceId } }` where `id`
    // is the Mongo `_id`. Taking `device.id` made the identity claim a Mongo
    // ObjectId, and the region then rejected every command with 401 'Device
    // validation failed: Device not found or does not belong to user'.
    const keys = generateDeviceKeys();
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        responseCode: 200,
        responseObject: { device: { id: '6512f0a1b2c3d4e5f6071829', deviceId: keys.deviceId } },
      }),
    );
    const out = await registerDevice(
      { baseUrl: 'https://r.example', fetchFn: fetchFn as unknown as typeof fetch },
      keys,
      { deviceName: 'alex-laptop', platform: 'linux' },
      'tok',
    );
    expect(out.deviceId).toBe(keys.deviceId);
  });
});

describe('ensureDeviceIdentity', () => {
  it('generates, registers, and persists keys', async () => {
    const store = createMemoryDeviceKeyStore();
    const fetchFn = vi.fn(async () =>
      jsonResponse({ responseCode: 200, responseObject: { deviceId: 'dev-9' } }),
    );
    const out = await ensureDeviceIdentity(
      { baseUrl: 'https://r.example', fetchFn: fetchFn as unknown as typeof fetch },
      store,
      { deviceName: 'n' },
      'tok',
    );
    expect(out.deviceId).toBe('dev-9');
    const persisted = store.load();
    expect(persisted?.deviceId).toBe('dev-9');
    expect(persisted?.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });

  it('reuses an existing stored keypair', async () => {
    const existing = generateDeviceKeys();
    const store = createMemoryDeviceKeyStore(existing);
    const fetchFn = vi.fn(async () =>
      jsonResponse({ responseCode: 200, responseObject: { deviceId: existing.deviceId } }),
    );
    await ensureDeviceIdentity(
      { baseUrl: 'https://r.example', fetchFn: fetchFn as unknown as typeof fetch },
      store,
      {},
      'tok',
    );
    const envelope = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body));
    expect(envelope.payload.publicKey).toBe(existing.publicKeyPem);
  });

  it('treats an already-registered device as success and keeps our device id', async () => {
    // The region answers 409 DEVICE_ALREADY_REGISTERED when the device id is
    // active and untouched. The keypair is ours, so the identity already holds —
    // failing here would leave the session with no deviceId and 401 every command.
    const existing = generateDeviceKeys();
    const store = createMemoryDeviceKeyStore(existing);
    const fetchFn = vi.fn(async () =>
      jsonResponse(
        { responseCode: 409, errorObjects: [{ code: 'DEVICE_ALREADY_REGISTERED', message: 'already registered' }] },
        409,
      ),
    );
    const out = await ensureDeviceIdentity(
      { baseUrl: 'https://r.example', fetchFn: fetchFn as unknown as typeof fetch },
      store,
      {},
      'tok',
    );
    expect(out.deviceId).toBe(existing.deviceId);
    // Persisted so the identity can carry it on the next command.
    expect(store.load()?.deviceId).toBe(existing.deviceId);
  });

  it('treats a 202 with the flag nested in responseObject as auth-required (not success)', async () => {
    // Regression: the dispatcher's command-authorization gate returns
    // `responseCode: 202` with `authorizationRequired` nested *inside*
    // `responseObject`. Reading only the top-level flag made a 202 look like a
    // plain success, so the caller believed the device existed, recorded a
    // `registeredAt`, and every later command 401'd on the unregistered id.
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        responseCode: 202,
        responseObject: {
          authorizationRequired: true,
          authRequestId: 'req-202',
          authMethod: '2fa_user_mail',
        },
      }),
    );
    const store = createMemoryDeviceKeyStore();
    await expect(
      ensureDeviceIdentity(
        { baseUrl: 'https://r.example', fetchFn: fetchFn as unknown as typeof fetch },
        store,
        {},
        'tok',
      ),
    ).rejects.toThrow(/two-factor authorization/);
    // Nothing may be persisted as registered, or the identity is poisoned.
    expect(store.load()).toBeNull();
  });

  it('still throws on a genuine registration failure (e.g. 422 bad key)', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(
        { responseCode: 422, errorObjects: [{ code: 'INVALID_PUBLIC_KEY', message: 'Invalid generalPublicKey' }] },
        422,
      ),
    );
    await expect(
      ensureDeviceIdentity(
        { baseUrl: 'https://r.example', fetchFn: fetchFn as unknown as typeof fetch },
        createMemoryDeviceKeyStore(),
        {},
        'tok',
      ),
    ).rejects.toThrow(/Invalid generalPublicKey/);
  });
});
