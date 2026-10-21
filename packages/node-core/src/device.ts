/**
 * Device identity for the desktop client.
 *
 * The desktop registers as `nexus-desktop` / `deviceType: 'desktop'`. Key
 * material is generated locally and stored via the injected {@link DeviceKeyStore}
 * (Electron `safeStorage` in the desktop app, the OS keychain in the CLI).
 *
 * Crypto is intentionally dependency-free: Node's `crypto` (RSA keypair + PEM)
 * covers the desktop registration path. Biometric SCA still resolves in the ANX
 * mobile app, matching the portal policy.
 */

import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { sendCommand, type AuthClientOptions } from './auth.js';

export type DeviceKeys = {
  deviceId: string;
  /** PKCS#8 PEM private key. Never leave the secure store. */
  privateKeyPem: string;
  /** SPKI PEM public key, submitted at registration. */
  publicKeyPem: string;
  createdAt: string;
};

export type DeviceKeyStore = {
  load(): DeviceKeys | null;
  save(keys: DeviceKeys): void;
  clear(): void;
};

/** In-memory store; the desktop app passes a `safeStorage`-backed store. */
export function createMemoryDeviceKeyStore(seed: DeviceKeys | null = null): DeviceKeyStore {
  let current = seed;
  return {
    load: () => current,
    save: (keys) => {
      current = keys;
    },
    clear: () => {
      current = null;
    },
  };
}

/** Generate a fresh device keypair with a new device id. */
export function generateDeviceKeys(now: () => Date = () => new Date()): DeviceKeys {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    deviceId: randomUUID(),
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
    createdAt: now().toISOString(),
  };
}

/** Generate a short human-readable pairing/backup code (unused secret material). */
export function generateRecoveryCode(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

export type DeviceRegistrationInput = {
  deviceName?: string;
  deviceType?: string;
  platform?: string;
  appVersion?: string;
};

export type DeviceRegistrationResult = {
  deviceId: string;
  raw: Record<string, unknown>;
};

/**
 * `anx.device.register`. Deliberately NOT decorated with `@Authorization`
 * upstream (chicken-and-egg during onboarding), so it works with the token
 * obtained from login.
 */
export async function registerDevice(
  opts: AuthClientOptions,
  keys: DeviceKeys,
  input: DeviceRegistrationInput,
  token: string,
): Promise<DeviceRegistrationResult> {
  const payload: Record<string, unknown> = {
    deviceId: keys.deviceId,
    publicKey: keys.publicKeyPem,
    deviceType: input.deviceType ?? 'desktop',
  };
  if (input.deviceName) payload.deviceName = input.deviceName;
  if (input.platform) payload.platform = input.platform;
  if (input.appVersion) payload.appVersion = input.appVersion;

  const res = await sendCommand(opts, 'anx.device.register', payload, { token });
  if (res.responseCode < 200 || res.responseCode >= 300) {
    throw new Error(res.message ?? `device registration failed (${res.responseCode})`);
  }
  const body = (res.responseObject ?? {}) as Record<string, unknown>;
  const registeredId =
    (typeof body.deviceId === 'string' && body.deviceId) ||
    ((body.device as Record<string, unknown> | undefined)?.id as string | undefined) ||
    keys.deviceId;
  return { deviceId: registeredId, raw: body };
}

/**
 * Ensure a device identity exists: load from the store or generate, register,
 * and persist. Returns the keys and the region-assigned device id.
 */
export async function ensureDeviceIdentity(
  opts: AuthClientOptions,
  store: DeviceKeyStore,
  input: DeviceRegistrationInput,
  token: string,
): Promise<DeviceRegistrationResult> {
  const keys = store.load() ?? generateDeviceKeys();
  const result = await registerDevice(opts, keys, input, token);
  const persisted: DeviceKeys = { ...keys, deviceId: result.deviceId };
  store.save(persisted);
  return result;
}
