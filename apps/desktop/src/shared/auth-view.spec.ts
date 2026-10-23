import { describe, expect, it } from 'vitest';
import { resolveShellView } from './auth-view.js';
import type { AuthState, SessionHydrationState } from './ipc.js';

const signedOut: AuthState = { status: 'signed_out' };
const signedIn: AuthState = {
  status: 'signed_in',
  token: 'jwt',
  identity: { userId: 'u1', orgId: null, role: null, deviceId: null },
};

function hydration(patch: Partial<SessionHydrationState> = {}): SessionHydrationState {
  return {
    view: 'signed_out',
    reason: 'no_session',
    message: null,
    canRetry: false,
    hasSession: false,
    token: null,
    identity: null,
    ...patch,
  };
}

describe('resolveShellView', () => {
  it('shows the starting placeholder until hydration resolves', () => {
    expect(resolveShellView({ auth: signedOut, hydration: null })).toBe('starting');
  });

  it('signs in when startup hydration found a live stored session', () => {
    expect(
      resolveShellView({ auth: signedIn, hydration: hydration({ view: 'signed_in', reason: 'ok' }) }),
    ).toBe('signed_in');
  });

  it('shows the sign-in screen when startup hydration found no session', () => {
    expect(resolveShellView({ auth: signedOut, hydration: hydration() })).toBe('signed_out');
  });

  it('offers a retry when the region was unreachable at boot', () => {
    expect(
      resolveShellView({
        auth: signedOut,
        hydration: hydration({ view: 'offline_retry', reason: 'region_unreachable', canRetry: true }),
      }),
    ).toBe('offline_retry');
  });

  it('signs in even with no hydration yet once a login has completed', () => {
    expect(resolveShellView({ auth: signedIn, hydration: null })).toBe('signed_in');
  });

  it('lets a completed login win over the stale startup snapshot (OTP bounce)', () => {
    // Regression: the app boots signed out, so hydration is a `signed_out`
    // snapshot. The user then signs in with password + OTP; `auth` flips to
    // `signed_in` but hydration is never recomputed. Gating `signedIn` on the
    // snapshot alone bounced the user straight back to the login form after a
    // successful OTP.
    expect(resolveShellView({ auth: signedIn, hydration: hydration() })).toBe('signed_in');
  });

  it('lets a completed login win over the offline screen too', () => {
    expect(
      resolveShellView({
        auth: signedIn,
        hydration: hydration({ view: 'offline_retry', reason: 'region_unreachable', canRetry: true }),
      }),
    ).toBe('signed_in');
  });
});
