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
});
