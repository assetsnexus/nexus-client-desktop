import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_LOCK_SETTINGS,
  isLockArmed,
  lockGateVisible,
  msUntilLock,
  normalizeAppLockSettings,
  shouldLock,
  signOutClearsPin,
  validatePin,
  type AppLockSettings,
} from './app-lock.js';

const settings = (patch: Partial<AppLockSettings> = {}): AppLockSettings => ({
  ...DEFAULT_APP_LOCK_SETTINGS,
  ...patch,
});

const MIN = 60_000;

describe('normalizeAppLockSettings', () => {
  it('falls back to defaults for a malformed block', () => {
    expect(normalizeAppLockSettings(null)).toEqual(DEFAULT_APP_LOCK_SETTINGS);
    expect(normalizeAppLockSettings({ enabled: 'yes', timeoutMinutes: 'nope' })).toEqual(
      DEFAULT_APP_LOCK_SETTINGS,
    );
  });

  it('keeps valid values and rounds the timeout', () => {
    expect(normalizeAppLockSettings({ enabled: true, timeoutMinutes: 12.6 })).toEqual({
      enabled: true,
      timeoutMinutes: 13,
    });
  });

  it('rejects an out-of-range timeout', () => {
    expect(normalizeAppLockSettings({ timeoutMinutes: 0 }).timeoutMinutes).toBe(
      DEFAULT_APP_LOCK_SETTINGS.timeoutMinutes,
    );
    expect(normalizeAppLockSettings({ timeoutMinutes: 99999 }).timeoutMinutes).toBe(
      DEFAULT_APP_LOCK_SETTINGS.timeoutMinutes,
    );
  });

  it('defaults the lock to disarmed', () => {
    expect(DEFAULT_APP_LOCK_SETTINGS.enabled).toBe(false);
  });
});

describe('validatePin', () => {
  it('accepts 4..12 digits', () => {
    expect(validatePin('1234').ok).toBe(true);
    expect(validatePin('123456789012').ok).toBe(true);
  });

  it('rejects too short, too long, and non-numeric PINs', () => {
    expect(validatePin('123').ok).toBe(false);
    expect(validatePin('1'.repeat(13)).ok).toBe(false);
    expect(validatePin('12ab').ok).toBe(false);
  });
});

describe('isLockArmed', () => {
  it('is armed only when enabled AND a PIN exists', () => {
    expect(isLockArmed(settings({ enabled: true }), true)).toBe(true);
    expect(isLockArmed(settings({ enabled: true }), false)).toBe(false);
    expect(isLockArmed(settings({ enabled: false }), true)).toBe(false);
  });
});

describe('shouldLock', () => {
  const base = {
    settings: settings({ enabled: true, timeoutMinutes: 5 }),
    hasPin: true,
    lastActivityAtMs: 0,
    now: 0,
    currentlyLocked: false,
  };

  it('never locks while disarmed or without a PIN (no lock-out)', () => {
    expect(shouldLock({ ...base, settings: settings({ enabled: false }) })).toBe(false);
    expect(shouldLock({ ...base, hasPin: false })).toBe(false);
  });

  it('does not lock before the timeout elapses', () => {
    expect(shouldLock({ ...base, now: 4 * MIN })).toBe(false);
  });

  it('locks exactly at the timeout boundary', () => {
    expect(shouldLock({ ...base, now: 5 * MIN })).toBe(true);
  });

  it('locks immediately when no activity was ever recorded', () => {
    expect(shouldLock({ ...base, lastActivityAtMs: null, now: 0 })).toBe(true);
  });

  it('stays locked once locked, even after activity', () => {
    expect(shouldLock({ ...base, currentlyLocked: true, now: 0 })).toBe(true);
  });
});

describe('msUntilLock', () => {
  it('is null when disarmed or without a PIN', () => {
    expect(
      msUntilLock({
        settings: settings({ enabled: false }),
        hasPin: true,
        lastActivityAtMs: 0,
        now: 0,
        currentlyLocked: false,
      }),
    ).toBeNull();
    expect(
      msUntilLock({
        settings: settings({ enabled: true }),
        hasPin: false,
        lastActivityAtMs: 0,
        now: 0,
        currentlyLocked: false,
      }),
    ).toBeNull();
  });

  it('counts down and floors at zero', () => {
    const input = {
      settings: settings({ enabled: true, timeoutMinutes: 5 }),
      hasPin: true,
      lastActivityAtMs: 0,
      now: 1 * MIN,
      currentlyLocked: false,
    };
    expect(msUntilLock(input)).toBe(4 * MIN);
    expect(msUntilLock({ ...input, now: 99 * MIN })).toBe(0);
  });
});

describe('signOutClearsPin', () => {
  it('documents the lock-out recovery path', () => {
    expect(signOutClearsPin()).toBe(true);
  });
});

describe('lockGateVisible', () => {
  const base = { locked: true, signedIn: true, recoveryOpen: false };

  it('shows the gate while locked and signed in', () => {
    expect(lockGateVisible(base)).toBe(true);
  });

  it('hides the gate while not locked, or when signed out', () => {
    expect(lockGateVisible({ ...base, locked: false })).toBe(false);
    expect(lockGateVisible({ ...base, signedIn: false })).toBe(false);
  });

  it('hides the gate while the recovery (logout) dialog is open', () => {
    // Otherwise the overlay re-covers the dialog on the next lock poll and
    // the user can never reach the "forgot the PIN" path.
    expect(lockGateVisible({ ...base, recoveryOpen: true })).toBe(false);
  });

  it('returns the gate when recovery is cancelled', () => {
    expect(lockGateVisible({ ...base, recoveryOpen: true })).toBe(false);
    expect(lockGateVisible({ ...base, recoveryOpen: false })).toBe(true);
  });
});
