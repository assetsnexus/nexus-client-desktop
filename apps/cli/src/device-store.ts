/**
 * Adapts the async {@link SecureStore} to the synchronous `DeviceKeyStore`
 * interface `@nexus/node-core` expects. The keypair is read once at session
 * start and written back after registration.
 */

import { SECURE_KEYS, type DeviceKeyStore, type DeviceKeys, type SecureStore } from '@nexus/node-core';

export function createSecureDeviceKeyStore(
  secureStore: SecureStore,
  seed: DeviceKeys | null = null,
): DeviceKeyStore {
  let cache: DeviceKeys | null = seed;
  return {
    load: () => cache,
    save: (keys) => {
      cache = keys;
      // Fire-and-forget: persistence is best-effort and must not block the
      // synchronous registration flow.
      void secureStore.set(SECURE_KEYS.deviceKeys, JSON.stringify(keys));
    },
    clear: () => {
      cache = null;
      void secureStore.delete(SECURE_KEYS.deviceKeys);
    },
  };
}

/** Load a persisted device keypair from the secure store, if any. */
export async function loadPersistedDeviceKeys(secureStore: SecureStore): Promise<DeviceKeys | null> {
  const raw = await secureStore.get(SECURE_KEYS.deviceKeys);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DeviceKeys;
  } catch {
    return null;
  }
}
