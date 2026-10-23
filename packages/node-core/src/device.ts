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
  /**
   * Set once the region has acknowledged this device. Until then the id exists
   * locally (it is sent at login so the region can bind a device-enrolment
   * grant) but must NOT be presented as an identity claim: the region rejects an
   * unknown device id with a device-validation 401.
   */
  registeredAt?: string | null;
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
    registeredAt: null,
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
  // The region's `anx.device.register` handler requires `generalPublicKey` and
  // `privatePublicKey` (400 MISSING_REQUIRED_FIELDS otherwise). The desktop has
  // a single RSA keypair, so both slots carry the same SPKI PEM. `publicKey` is
  // kept for older region builds that only read the legacy field.
  const payload: Record<string, unknown> = {
    deviceId: keys.deviceId,
    generalPublicKey: keys.publicKeyPem,
    privatePublicKey: keys.publicKeyPem,
    publicKey: keys.publicKeyPem,
    deviceType: input.deviceType ?? 'desktop',
  };
  if (input.deviceName) payload.deviceName = input.deviceName;
  if (input.platform) payload.platform = input.platform;
  if (input.appVersion) payload.appVersion = input.appVersion;

  const res = await sendCommand(opts, 'anx.device.register', payload, { token });
  if (
    res.responseCode === 202 ||
    res.authorizationRequired ||
    res.responseCode < 200 ||
    res.responseCode >= 300
  ) {
    // 202 / `authorizationRequired` means the region wants a fresh SCA before it
    // will create the device row — it is *not* a success. Reporting one would
    // leave the caller believing the device exists while every later command is
    // still rejected for a missing device id.
    const error = new Error(
      res.authorizationRequired || res.responseCode === 202
        ? 'device registration requires two-factor authorization'
        : (res.message ?? `device registration failed (${res.responseCode})`),
    );
    const typed = error as Error & { responseCode?: number; code?: string };
    typed.responseCode = res.authorizationRequired ? 202 : res.responseCode;
    typed.code = res.authorizationRequired ? 'AUTHORIZATION_REQUIRED' : res.code;
    throw error;
  }
  const body = (res.responseObject ?? {}) as Record<string, unknown>;
  // The region answers `{ device: { id, deviceId, ... } }` where `id` is the
  // Mongo `_id` and `deviceId` is the client-generated id we actually sent.
  // Reading `id` would poison the identity with a Mongo ObjectId, and the region
  // then rejects every later command with a device-validation 401 — so prefer
  // the echoed client id and only fall back to our own id.
  const device = (body.device as Record<string, unknown> | undefined) ?? {};
  const registeredId =
    (typeof body.deviceId === 'string' && body.deviceId) ||
    (typeof device.deviceId === 'string' && device.deviceId) ||
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
  let result: DeviceRegistrationResult;
  try {
    result = await registerDevice(opts, keys, input, token);
  } catch (err) {
    // "Ensure" is idempotent: a 409 means this exact device id is already
    // registered and active. The keypair is ours (it lives in our secure store
    // under the same id), so the device identity already holds — treat it as
    // success rather than failing the session. The region only rotates keys on
    // an explicit `forceReregister`, which this path never sets.
    const typed = err as Error & { responseCode?: number; code?: string };
    const alreadyRegistered =
      typed.responseCode === 409 ||
      typed.code === 'DEVICE_ALREADY_REGISTERED' ||
      /already registered/i.test(typed.message ?? '');
    if (!alreadyRegistered) throw err;
    result = { deviceId: keys.deviceId, raw: {} };
  }
  const persisted: DeviceKeys = {
    ...keys,
    deviceId: result.deviceId,
    registeredAt: new Date().toISOString(),
  };
  store.save(persisted);
  return result;
}
