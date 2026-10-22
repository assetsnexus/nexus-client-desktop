/**
 * App PIN lock policy (Deliverable 3) — pure, host-agnostic.
 *
 * After N minutes without user input the app locks its UI behind a PIN
 * (KeePass-style). This module holds the policy: timeout evaluation, the
 * lock/unlock decision, and the wire types. The salted PBKDF2 hashing lives in
 * the main process (`main/app-lock.ts`) so this file stays importable from the
 * sandboxed renderer (no Node built-ins).
 *
 * TRUST INVARIANTS:
 * - The lock is a **UI gate only**. It never gates a cryptographic operation:
 *   main-process commands, region calls, and biometric/2FA flows keep working
 *   exactly as before. The renderer hides its content until the PIN is entered.
 * - A user is **never permanently locked out**: forgetting the PIN is recovered
 *   by signing out / switching user / permanent logout, all of which clear it.
 */

/** Persisted (non-secret) lock preferences. */
export type AppLockSettings = {
  /** Whether the inactivity lock is armed. Off until the user opts in. */
  enabled: boolean;
  /** Minutes of inactivity before the app locks. */
  timeoutMinutes: number;
};

export const DEFAULT_APP_LOCK_SETTINGS: AppLockSettings = {
  // Off by default: a lock the user did not ask for is a lock-out.
  enabled: false,
  timeoutMinutes: 5,
};

/** Timeout presets offered in settings (minutes). */
export const LOCK_TIMEOUT_CHOICES: readonly number[] = [1, 5, 10, 15, 30, 60];

const MIN_TIMEOUT_MINUTES = 1;
const MAX_TIMEOUT_MINUTES = 24 * 60;

/** Coerce a persisted/patched lock block to valid values, per-field. */
export function normalizeAppLockSettings(raw: unknown): AppLockSettings {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const timeout = Number(value.timeoutMinutes);
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_APP_LOCK_SETTINGS.enabled,
    timeoutMinutes:
      Number.isFinite(timeout) && timeout >= MIN_TIMEOUT_MINUTES && timeout <= MAX_TIMEOUT_MINUTES
        ? Math.round(timeout)
        : DEFAULT_APP_LOCK_SETTINGS.timeoutMinutes,
  };
}

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 12;

/** Validate a candidate PIN; returns a machine-readable reason when invalid. */
export function validatePin(pin: string): { ok: true } | { ok: false; reason: string } {
  if (typeof pin !== 'string') return { ok: false, reason: 'pin must be a string' };
  const trimmed = pin.trim();
  if (trimmed.length < PIN_MIN_LENGTH) {
    return { ok: false, reason: `PIN must be at least ${PIN_MIN_LENGTH} digits` };
  }
  if (trimmed.length > PIN_MAX_LENGTH) {
    return { ok: false, reason: `PIN must be at most ${PIN_MAX_LENGTH} digits` };
  }
  if (!/^\d+$/.test(trimmed)) return { ok: false, reason: 'PIN must contain digits only' };
  return { ok: true };
}

/**
 * Whether the lock is armed *and* actually usable. A missing PIN disables the
 * lock: arming without a PIN would be an instant lock-out.
 */
export function isLockArmed(settings: AppLockSettings, hasPin: boolean): boolean {
  return settings.enabled && hasPin;
}

export type LockEvaluationInput = {
  /** Lock preferences. */
  settings: AppLockSettings;
  /** True when a PIN record exists in the secure store. */
  hasPin: boolean;
  /** Epoch ms of the last observed user input; null when none was recorded. */
  lastActivityAtMs: number | null;
  /** Injectable clock. */
  now: number;
  /** True when the UI is already locked. */
  currentlyLocked: boolean;
};

/**
 * Decide whether the UI should be locked now.
 *
 * - Never locks while disarmed or without a PIN (avoids a lock-out).
 * - Never *un*-locks on its own: an already-locked UI only clears via `unlock`.
 * - With no recorded activity the app locks immediately once armed, which is the
 *   safe reading of "we do not know when you last touched it".
 */
export function shouldLock(input: LockEvaluationInput): boolean {
  if (input.currentlyLocked) return true;
  if (!isLockArmed(input.settings, input.hasPin)) return false;
  const timeoutMs = input.settings.timeoutMinutes * 60_000;
  if (input.lastActivityAtMs == null) return true;
  return input.now - input.lastActivityAtMs >= timeoutMs;
}

/** Milliseconds until the armed lock would fire; null when disarmed/no PIN. */
export function msUntilLock(input: LockEvaluationInput): number | null {
  if (!isLockArmed(input.settings, input.hasPin)) return null;
  if (input.currentlyLocked) return 0;
  if (input.lastActivityAtMs == null) return 0;
  const timeoutMs = input.settings.timeoutMinutes * 60_000;
  return Math.max(0, timeoutMs - (input.now - input.lastActivityAtMs));
}

/**
 * Whether a sign-out / switch-user / permanent-logout action also removes the
 * PIN. Always true: that is the documented lock-out recovery path.
 */
export function signOutClearsPin(): true {
  return true;
}

/** Renderer-visible lock state (safe to expose; never carries the PIN/hash). */
export type AppLockState = {
  settings: AppLockSettings;
  /** True when a PIN record exists (i.e. the lock *can* be armed). */
  hasPin: boolean;
  /** True while the UI is currently locked. */
  locked: boolean;
  /** True when the lock is armed and will fire (enabled + hasPin). */
  armed: boolean;
};
