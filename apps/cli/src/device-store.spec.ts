import { describe, expect, it } from 'vitest';
import { createMemorySecureStore } from '@nexus/node-core';
import { generateDeviceKeys } from '@nexus/node-core';
import { createSecureDeviceKeyStore, loadPersistedDeviceKeys } from './device-store.js';

describe('createSecureDeviceKeyStore', () => {
  it('caches a saved keypair and persists it to the secure store', async () => {
    const secure = createMemorySecureStore();
    const store = createSecureDeviceKeyStore(secure);
    expect(store.load()).toBeNull();
    const keys = generateDeviceKeys();
    store.save(keys);
    expect(store.load()?.deviceId).toBe(keys.deviceId);
    // Persisted asynchronously.
    await Promise.resolve();
    expect(await loadPersistedDeviceKeys(secure)).toMatchObject({ deviceId: keys.deviceId });
  });

  it('seeds from an existing keypair', () => {
    const secure = createMemorySecureStore();
    const keys = generateDeviceKeys();
    const store = createSecureDeviceKeyStore(secure, keys);
    expect(store.load()?.deviceId).toBe(keys.deviceId);
  });

  it('clears the cache and the persisted key', async () => {
    const secure = createMemorySecureStore();
    const store = createSecureDeviceKeyStore(secure);
    store.save(generateDeviceKeys());
    await Promise.resolve();
    store.clear();
    expect(store.load()).toBeNull();
    await Promise.resolve();
    expect(await loadPersistedDeviceKeys(secure)).toBeNull();
  });
});

describe('loadPersistedDeviceKeys', () => {
  it('returns null for an absent or corrupt entry', async () => {
    const secure = createMemorySecureStore();
    expect(await loadPersistedDeviceKeys(secure)).toBeNull();
    await secure.set('device.keys', 'not json');
    expect(await loadPersistedDeviceKeys(secure)).toBeNull();
  });
});
