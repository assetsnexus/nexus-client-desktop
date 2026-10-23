/**
 * Renderer auth gate (pure, host-agnostic).
 *
 * Startup hydration answers one question: *is the session that was already on
 * disk still good?* It is a one-shot snapshot taken before the user interacts.
 * A sign-in that completes **after** that snapshot (password + 2FA, QR device
 * link, passwordless code) must therefore win over it: otherwise `signedIn`
 * stays false after a successful OTP and the shell bounces straight back to the
 * login form even though main just minted a valid session.
 *
 * Precedence (first match wins):
 * 1. A completed in-app sign-in (`auth.status === 'signed_in'`) — authoritative,
 *    it supersedes the stale startup snapshot.
 * 2. Hydration still deciding (`null`) — show the "starting" placeholder.
 * 3. Region unreachable at boot — the retryable offline screen (never a
 *    sign-out, and never a signed-in shell that cannot reach the region).
 * 4. Anything else — signed out, i.e. the sign-in screen.
 */

import type { AuthState, SessionHydrationState } from './ipc.js';

/** Which top-level surface the shell should render. */
export type ShellView = 'starting' | 'offline_retry' | 'signed_in' | 'signed_out';

export function resolveShellView(input: {
  auth: AuthState;
  hydration: SessionHydrationState | null;
}): ShellView {
  const { auth, hydration } = input;
  // A finished login is the strongest signal: hydration was computed before it.
  if (auth.status === 'signed_in') return 'signed_in';
  if (hydration === null) return 'starting';
  if (hydration.view === 'offline_retry') return 'offline_retry';
  return 'signed_out';
}
