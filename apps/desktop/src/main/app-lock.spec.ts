import { describe, expect, it, vi } from 'vitest';
import { createMemorySecureStore } from '@nexus/node-core';
import {
  PIN_SECURE_KEY,
  createAppLockManager,
  parsePinRecord,
  type AppLockManager,
} from './app-lock.js';
import { DEFAULT_APP_LOCK_SETTINGS, type AppLockSettings } from '../shared/app-lock.js';

/** A tiny in-memory settings store mirroring the real one's coercion contract. */
function makeHarness(initial: Partial<AppLockSettings> = {}) {
  let settings: AppLockSettings = { ...DEFAULT_APP_LOCK_SETTINGS, ...initial };
  let nowMs = 1_000_000;
  const secureStore = createMemorySecureStore();
  const manager: AppLockManager = createAppLockManager({
    secureStore,
    getSettings: () => settings,
    setSettings: (patch) => {
      settings = { ...settings, ...patch };
      return settings;
    },
    now: () => nowMs,
  });
  return {
    manager,
    secureStore,
    advance: (ms: number) => {
      nowMs += ms;
    },
    get settings() {
      return settings;
    },
  };
}

describe('createAppLockManager', () => {
  it('starts disarmed without a PIN', async () => {
    const h = makeHarness();
    const state = await h.manager.getState();
    expect(state.hasPin).toBe(false);
    expect(state.locked).toBe(false);
    expect(state.armed).toBe(false);
  });

  it('stores only a salted hash — never the PIN itself', async () => {
    const h = makeHarness();
    await h.manager.setPin('1234');
    const raw = await h.secureStore.get(PIN_SECURE_KEY);
    expect(raw).toBeTruthy();
    expect(raw).not.toContain('1234');
    const record = parsePinRecord(raw);
    expect(record?.algorithm).toBe('pbkdf2-sha256');
    expect(record?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses an invalid PIN', async () => {
    const h = makeHarness();
    await expect(h.manager.setPin('12')).rejects.toThrow(/at least/);
    await expect(h.manager.setPin('abcd')).rejects.toThrow(/digits/);
  });

  it('verifies the correct PIN and rejects a wrong one', async () => {
    const h = makeHarness();
    await h.manager.setPin('4321');
    expect(await h.manager.unlock('0000')).toBe(false);
    expect(await h.manager.unlock('4321')).toBe(true);
  });

  it('locks after the configured idle timeout, and unlock clears it', async () => {
    const h = makeHarness({ enabled: true, timeoutMinutes: 1 });
    await h.manager.setPin('1234');
    h.manager.noteActivity();
    h.advance(30_000);
    expect(await h.manager.evaluateLocked()).toBe(false);
    h.advance(31_000);
    expect(await h.manager.evaluateLocked()).toBe(true);
    expect(await h.manager.unlock('1234')).toBe(true);
    expect(await h.manager.evaluateLocked()).toBe(false);
  });

  it('never arms without a PIN (avoids an instant lock-out)', async () => {
    const h = makeHarness();
    const state = await h.manager.updateSettings({ enabled: true });
    expect(state.armed).toBe(false);
    expect(state.settings.enabled).toBe(false);
  });

  it('is a UI gate only: locking does not require/perform any crypto', async () => {
    // Purely a state machine; no key material is touched by lock/unlock.
    const h = makeHarness({ enabled: true, timeoutMinutes: 5 });
    await h.manager.setPin('1234');
    await h.manager.lock();
    expect(h.manager.isLockedNow()).toBe(true);
    const snapshot = await h.manager.getState();
    expect(snapshot.locked).toBe(true);
    // Nothing secret was read from the store on the lock path.
    expect(snapshot).not.toHaveProperty('hash');
    expect(snapshot).not.toHaveProperty('salt');
    expect(JSON.stringify(snapshot)).not.toMatch(/"hash"|"salt"|"pin"/i);
  });

  it('clears the PIN AND disarms on clearPin (sign-out recovery path)', async () => {
    const h = makeHarness();
    await h.manager.setPin('1234');
    await h.manager.updateSettings({ enabled: true });
    expect((await h.manager.getState()).armed).toBe(true);
    const cleared = await h.manager.clearPin();
    expect(cleared.hasPin).toBe(false);
    expect(cleared.settings.enabled).toBe(false);
    expect(cleared.locked).toBe(false);
  });

  it('resetLocked clears the in-memory flag without touching the PIN', async () => {
    const h = makeHarness({ enabled: true });
    await h.manager.setPin('1234');
    await h.manager.lock();
    h.manager.resetLocked();
    expect(h.manager.isLockedNow()).toBe(false);
    expect((await h.manager.getState()).hasPin).toBe(true);
  });

  it('fails closed when the stored record is corrupt', async () => {
    const h = makeHarness();
    await h.secureStore.set(PIN_SECURE_KEY, '{not json');
    const state = await h.manager.getState();
    expect(state.hasPin).toBe(false);
    expect(await h.manager.unlock('1234')).toBe(false);
  });

  it('delivers isLockedNow() synchronously for the notification gate', async () => {
    const h = makeHarness({ enabled: true });
    const spy = vi.fn(() => h.manager.isLockedNow());
    await h.manager.setPin('1234');
    await h.manager.lock();
    expect(spy()).toBe(true);
  });
});
