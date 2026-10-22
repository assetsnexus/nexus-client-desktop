/**
 * App PIN lock manager (Deliverable 3, main process).
 *
 * Owns the salted PBKDF2-SHA256 PIN record in the secure store, the lock
 * settings in `settings.json` (via the settings store), and the "currently
 * locked" flag the renderer mirrors. The policy itself is pure and lives in
 * `shared/app-lock.ts`; this module only does IO and hashing.
 *
 * The lock is a UI gate only — nothing here blocks a command, a region call or a
 * biometric/2FA flow. Sign-out / switch-user / permanent logout clear the PIN so
 * a forgotten PIN can never permanently lock the user out.
 */

import {
  createPinRecord,
  normalizeAppLockSettings,
  parsePinRecord,
  shouldLock,
  verifyPin,
  validatePin,
  isLockArmed,
  type AppLockSettings,
  type AppLockState,
  type PinRecord,
} from '../shared/app-lock.js';
import type { SecureStore } from '@nexus/node-core';

export const PIN_SECURE_KEY = 'app.lock.pin';

export type AppLockManagerOptions = {
  secureStore: SecureStore;
  /** Read the persisted lock preferences (from the UI settings store). */
  getSettings: () => AppLockSettings;
  /** Persist lock preferences; returns the coerced value. */
  setSettings: (patch: Partial<AppLockSettings>) => AppLockSettings;
  /** Injectable clock for tests. */
  now?: () => number;
};

export type AppLockManager = {
  /** Current lock state for the renderer (never includes the PIN/hash). */
  getState(): Promise<AppLockState>;
  /** Set or replace the PIN (validated). Persists a fresh salted record. */
  setPin(pin: string): Promise<AppLockState>;
  /** Remove the PIN; also disarms the lock (the sign-out recovery path). */
  clearPin(): Promise<AppLockState>;
  /** Change the timeout / enabled flag. Arming without a PIN is refused. */
  updateSettings(patch: Partial<AppLockSettings>): Promise<AppLockState>;
  /** Record user activity (resets the idle timer). */
  noteActivity(atMs?: number): void;
  /** Evaluate the policy against the current clock; returns the locked flag. */
  evaluateLocked(): Promise<boolean>;
  /** Attempt to unlock with `pin`; returns true on success. */
  unlock(pin: string): Promise<boolean>;
  /** Force the UI into the locked state (e.g. explicit "lock now"). */
  lock(): Promise<void>;
  /** Forget the in-memory locked flag (e.g. after a sign-out teardown). */
  resetLocked(): void;
};

export function createAppLockManager(options: AppLockManagerOptions): AppLockManager {
  const now = options.now ?? (() => Date.now());
  let locked = false;
  let lastActivityAtMs: number | null = null;

  async function readPinRecord(): Promise<PinRecord | null> {
    try {
      return parsePinRecord(await options.secureStore.get(PIN_SECURE_KEY));
    } catch {
      return null;
    }
  }

  async function state(): Promise<AppLockState> {
    const settings = normalizeAppLockSettings(options.getSettings());
    const record = await readPinRecord();
    return {
      settings,
      hasPin: record != null,
      locked,
      armed: isLockArmed(settings, record != null),
    };
  }

  return {
    getState: state,

    async setPin(pin: string): Promise<AppLockState> {
      const check = validatePin(pin);
      if (!check.ok) throw new Error(check.reason);
      await options.secureStore.set(PIN_SECURE_KEY, JSON.stringify(createPinRecord(pin.trim())));
      // Setting a PIN is an explicit act of presence: do not lock immediately.
      lastActivityAtMs = now();
      locked = false;
      return state();
    },

    async clearPin(): Promise<AppLockState> {
      await options.secureStore.delete(PIN_SECURE_KEY);
      // Removing the PIN must also disarm the lock, so the state is never armed
      // without a way to unlock.
      options.setSettings({ enabled: false });
      locked = false;
      lastActivityAtMs = null;
      return state();
    },

    async updateSettings(patch: Partial<AppLockSettings>): Promise<AppLockState> {
      const requested = normalizeAppLockSettings({ ...options.getSettings(), ...patch });
      const record = await readPinRecord();
      // Arming without a PIN would be an instant lock-out: refuse it.
      if (requested.enabled && !record) {
        options.setSettings({ ...requested, enabled: false });
      } else {
        options.setSettings(requested);
      }
      if (!requested.enabled) locked = false;
      return state();
    },

    noteActivity(atMs?: number): void {
      lastActivityAtMs = atMs ?? now();
    },

    async evaluateLocked(): Promise<boolean> {
      const settings = normalizeAppLockSettings(options.getSettings());
      const record = await readPinRecord();
      const next = shouldLock({
        settings,
        hasPin: record != null,
        lastActivityAtMs,
        now: now(),
        currentlyLocked: locked,
      });
      locked = next;
      return locked;
    },

    async unlock(pin: string): Promise<boolean> {
      const record = await readPinRecord();
      const ok = verifyPin(pin, record);
      if (ok) {
        locked = false;
        lastActivityAtMs = now();
      }
      return ok;
    },

    async lock(): Promise<void> {
      const record = await readPinRecord();
      const settings = normalizeAppLockSettings(options.getSettings());
      // Only lock when the lock is actually armed; a disarmed state has no PIN
      // to unlock with.
      if (isLockArmed(settings, record != null)) locked = true;
    },

    resetLocked(): void {
      locked = false;
    },
  };
}
