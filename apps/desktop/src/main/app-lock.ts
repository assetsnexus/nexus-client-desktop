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

import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  normalizeAppLockSettings,
  shouldLock,
  validatePin,
  isLockArmed,
  type AppLockSettings,
  type AppLockState,
} from '../shared/app-lock.js';
import type { SecureStore } from '@nexus/node-core';

export const PIN_SECURE_KEY = 'app.lock.pin';

/**
 * A stored PIN: salted PBKDF2-SHA256. Serialized as JSON in the secure store.
 * The plaintext PIN never persists anywhere.
 */
export type PinRecord = {
  v: 1;
  algorithm: 'pbkdf2-sha256';
  salt: string;
  hash: string;
  iterations: number;
  keylen: number;
};

const PIN_ITERATIONS = 210_000;
const PIN_KEYLEN = 32;

/**
 * Hash a PIN into a storable record. `salt`/`iterations` are injectable so the
 * test suite stays fast and deterministic; production uses a fresh random salt.
 */
export function createPinRecord(
  pin: string,
  opts: { salt?: string; iterations?: number } = {},
): PinRecord {
  const salt = opts.salt ?? randomBytes(16).toString('hex');
  const iterations = opts.iterations ?? PIN_ITERATIONS;
  const hash = pbkdf2Sync(pin, salt, iterations, PIN_KEYLEN, 'sha256').toString('hex');
  return { v: 1, algorithm: 'pbkdf2-sha256', salt, hash, iterations, keylen: PIN_KEYLEN };
}

/** Parse a persisted PIN record; returns null for anything malformed. */
export function parsePinRecord(raw: string | null | undefined): PinRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PinRecord>;
    if (
      value?.v !== 1 ||
      value.algorithm !== 'pbkdf2-sha256' ||
      typeof value.salt !== 'string' ||
      typeof value.hash !== 'string' ||
      typeof value.iterations !== 'number' ||
      typeof value.keylen !== 'number'
    ) {
      return null;
    }
    return value as PinRecord;
  } catch {
    return null;
  }
}

/**
 * Verify a PIN against a record with a constant-time comparison. A missing or
 * malformed record never verifies (fails closed).
 */
export function verifyPin(pin: string, record: PinRecord | null): boolean {
  if (!record || typeof pin !== 'string') return false;
  let candidate: Buffer;
  try {
    candidate = pbkdf2Sync(pin, record.salt, record.iterations, record.keylen, 'sha256');
  } catch {
    return false;
  }
  let expected: Buffer;
  try {
    expected = Buffer.from(record.hash, 'hex');
  } catch {
    return false;
  }
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

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
  /** Synchronous locked flag, for the notification gate (no await in the hot path). */
  isLockedNow(): boolean;
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

    isLockedNow(): boolean {
      return locked;
    },
  };
}
