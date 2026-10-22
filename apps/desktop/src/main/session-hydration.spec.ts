import { describe, expect, it } from 'vitest';
import {
  CLOCK_SKEW_MS,
  base64UrlDecode,
  decideStartupSession,
  isTokenExpired,
  readTokenExpiryMs,
  type HydrationInput,
  type SessionProbe,
} from './session-hydration.js';

const NOW = Date.parse('2026-10-22T10:00:00.000Z');

function input(patch: Partial<HydrationInput> = {}): HydrationInput {
  return {
    hasToken: true,
    hasAccounts: true,
    corrupted: false,
    expiresAtMs: NOW + 3_600_000,
    probe: 'ok' as SessionProbe,
    now: NOW,
    ...patch,
  };
}

/** Build a JWT-ish token with the given `exp` (seconds), no signature needed. */
function tokenWithExp(exp: number | null): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(exp == null ? {} : { exp })).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('isTokenExpired', () => {
  it('treats a missing/invalid exp as not expired', () => {
    expect(isTokenExpired(null, NOW)).toBe(false);
    expect(isTokenExpired(Number.NaN, NOW)).toBe(false);
  });

  it('is true at/after expiry and false before', () => {
    expect(isTokenExpired(NOW - 1, NOW)).toBe(true);
    expect(isTokenExpired(NOW, NOW)).toBe(true);
    expect(isTokenExpired(NOW + 1, NOW)).toBe(false);
  });
});

describe('readTokenExpiryMs', () => {
  it('reads the exp claim in milliseconds', () => {
    expect(readTokenExpiryMs(tokenWithExp(1_800_000_000))).toBe(1_800_000_000_000);
  });

  it('returns null for a token without exp or malformed input', () => {
    expect(readTokenExpiryMs(tokenWithExp(null))).toBeNull();
    expect(readTokenExpiryMs('not-a-jwt')).toBeNull();
    expect(readTokenExpiryMs(null)).toBeNull();
    expect(readTokenExpiryMs('a.%%%.c')).toBeNull();
  });
});

describe('base64UrlDecode', () => {
  it('decodes base64url without padding', () => {
    const encoded = Buffer.from('{"a":1}').toString('base64url');
    expect(base64UrlDecode(encoded)).toBe('{"a":1}');
  });
});

describe('decideStartupSession', () => {
  it('signs in when the region accepted the session', () => {
    const out = decideStartupSession(input());
    expect(out).toMatchObject({ view: 'signed_in', reason: 'ok', hasSession: true });
    expect(out.clearSession).toBe(false);
  });

  it('signs out plainly when there is no stored session', () => {
    const out = decideStartupSession(input({ hasToken: false, hasAccounts: false, probe: 'skipped' }));
    expect(out).toMatchObject({ view: 'signed_out', reason: 'no_session', clearSession: false });
    expect(out.message).toBeNull();
  });

  it('clears a corrupted store and asks the user to sign in again', () => {
    const out = decideStartupSession(input({ corrupted: true, probe: 'skipped' }));
    expect(out).toMatchObject({ view: 'signed_out', reason: 'corrupted', clearSession: true });
    expect(out.message).toBeTruthy();
  });

  it('clears a locally expired token even with no probe (offline + expired)', () => {
    const out = decideStartupSession(
      input({ probe: 'skipped', expiresAtMs: NOW - 1 }),
    );
    expect(out).toMatchObject({ view: 'signed_out', reason: 'expired', clearSession: true });
  });

  it('treats a token expiring inside the skew margin as expired (safe re-auth)', () => {
    // Expiring in 30s is inside the margin: sign out now rather than start the
    // session with a token that is about to die mid-flight.
    const out = decideStartupSession(input({ expiresAtMs: NOW + 30_000 }));
    expect(out).toMatchObject({ view: 'signed_out', reason: 'expired', clearSession: true });
  });

  it('keeps a session whose expiry is beyond the skew margin', () => {
    const out = decideStartupSession(input({ expiresAtMs: NOW + CLOCK_SKEW_MS + 1000 }));
    expect(out.view).toBe('signed_in');
  });

  it('clears on a revoked device', () => {
    const out = decideStartupSession(input({ probe: 'revoked' }));
    expect(out).toMatchObject({ view: 'signed_out', reason: 'revoked', clearSession: true });
  });

  it('clears on a region-reported expiry', () => {
    const out = decideStartupSession(input({ probe: 'expired' }));
    expect(out).toMatchObject({ view: 'signed_out', reason: 'expired', clearSession: true });
  });

  it('clears a bare 401 (unauthorized)', () => {
    const out = decideStartupSession(input({ probe: 'unauthorized' }));
    expect(out).toMatchObject({ view: 'signed_out', reason: 'unauthorized', clearSession: true });
  });

  it('KEEPS the session and offers retry when the region is unreachable', () => {
    // The critical offline case: a network outage must never sign the user out.
    const out = decideStartupSession(input({ probe: 'unreachable' }));
    expect(out).toMatchObject({
      view: 'offline_retry',
      reason: 'region_unreachable',
      hasSession: true,
      clearSession: false,
      canRetry: true,
    });
    expect(out.message).toBeTruthy();
  });

  it('treats a skipped probe with a stored token as signed in (lazy validation)', () => {
    const out = decideStartupSession(input({ probe: 'skipped' }));
    expect(out).toMatchObject({ view: 'signed_in', reason: 'ok' });
  });

  it('honours the identity store alone (accounts but no explicit token)', () => {
    const out = decideStartupSession(input({ hasToken: false, hasAccounts: true, probe: 'skipped' }));
    expect(out.view).toBe('signed_in');
  });

  it('prefers corrupted over every other signal', () => {
    const out = decideStartupSession(input({ corrupted: true, probe: 'revoked' }));
    expect(out.reason).toBe('corrupted');
  });

  it('flags canRetry only for the offline case', () => {
    const cases: SessionProbe[] = ['ok', 'revoked', 'expired', 'unauthorized', 'skipped'];
    for (const probe of cases) {
      expect(decideStartupSession(input({ probe })).canRetry).toBe(false);
    }
    expect(decideStartupSession(input({ probe: 'unreachable' })).canRetry).toBe(true);
  });
});

describe('CLOCK_SKEW_MS', () => {
  it('is a small positive margin', () => {
    expect(CLOCK_SKEW_MS).toBeGreaterThan(0);
    expect(CLOCK_SKEW_MS).toBeLessThanOrEqual(5 * 60_000);
  });
});
