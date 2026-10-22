/**
 * Startup session hydration (Deliverable 2).
 *
 * "Signed in" must survive a restart and always reflect the truth. The decision
 * is easy to get subtly wrong (expired token, revoked device, an unreachable
 * region at boot, a corrupted store, several stored accounts), so the whole
 * policy is a single pure function here and the main process only gathers the
 * inputs and applies the outcome.
 *
 * The guiding rule: **never leave the user stuck.** An unreachable region is a
 * retryable *offline* state, not a sign-out; a genuinely dead session is cleared
 * with a clear reason; a corrupted store degrades to signed-out (recoverable by
 * signing in again) rather than a dead screen.
 */

/** What a lightweight startup probe of the region proved. */
export type SessionProbe =
  /** The region answered and accepted the session. */
  | 'ok'
  /** Network/TLS failure: the region could not be reached at all. */
  | 'unreachable'
  /** Device removed / token revoked: the session is genuinely dead. */
  | 'revoked'
  /** The token itself expired. */
  | 'expired'
  /** The region answered `401` without device-revocation evidence. */
  | 'unauthorized'
  /** No probe was attempted (no stored session). */
  | 'skipped';

/** Everything the decision needs, all already resolved by the caller. */
export type HydrationInput = {
  /** A token was found for the active identity (secure store or identity store). */
  hasToken: boolean;
  /** The identity store holds at least one account. */
  hasAccounts: boolean;
  /** The persisted session could not be read/parsed (partial or corrupt). */
  corrupted: boolean;
  /** Parsed JWT `exp` in epoch milliseconds, or null when unknown. */
  expiresAtMs: number | null;
  /** Result of the startup probe. */
  probe: SessionProbe;
  /** Injectable clock for tests. */
  now?: number;
};

export type HydrationView = 'signed_in' | 'offline_retry' | 'signed_out';

export type HydrationResult = {
  /** What the renderer should render. */
  view: HydrationView;
  /** True when a stored session exists (drives the offline retry screen). */
  hasSession: boolean;
  /** True when the caller must clear the stored token/identity. */
  clearSession: boolean;
  /** True when the renderer should offer an explicit retry (region unreachable). */
  canRetry: boolean;
  /** Machine-readable cause. */
  reason:
    | 'no_session'
    | 'corrupted'
    | 'expired'
    | 'revoked'
    | 'unauthorized'
    | 'region_unreachable'
    | 'ok';
  /** Human-safe message for the offline / signed-out screen, when useful. */
  message: string | null;
};

/** True when `expiresAtMs` is at or before `now`. A missing exp is not expired. */
export function isTokenExpired(expiresAtMs: number | null, now: number): boolean {
  if (expiresAtMs == null || !Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs <= now;
}

/** True when the local clock is far enough ahead that a session must be revalidated. */
export const CLOCK_SKEW_MS = 60_000;

/**
 * Decide what the app should do at startup given the stored session + probe.
 *
 * Order of precedence matters:
 * 1. A corrupted store cannot be trusted at all → signed out, clear it.
 * 2. No stored session at all → plain signed out.
 * 3. A proven-dead session (revoked / expired / rejected `401`) → signed out and
 *    clear, so the user is returned to sign-in instead of a broken shell.
 * 4. Region unreachable → **stay signed in** but surface a retryable offline
 *    state (never wipe a session just because the network is down).
 * 5. Otherwise → signed in.
 */
export function decideStartupSession(input: HydrationInput): HydrationResult {
  const now = input.now ?? Date.now();

  if (input.corrupted) {
    return {
      view: 'signed_out',
      hasSession: false,
      clearSession: true,
      canRetry: false,
      reason: 'corrupted',
      message: 'Your saved sign-in could not be read. Please sign in again.',
    };
  }

  if (!input.hasToken && !input.hasAccounts) {
    return {
      view: 'signed_out',
      hasSession: false,
      clearSession: false,
      canRetry: false,
      reason: 'no_session',
      message: null,
    };
  }

  // A token that has locally expired cannot be used; treat as a dead session
  // even if the probe never ran (offline + expired token is still expired).
  if (input.hasToken && isTokenExpired(input.expiresAtMs, now + CLOCK_SKEW_MS)) {
    return {
      view: 'signed_out',
      hasSession: true,
      clearSession: true,
      canRetry: false,
      reason: 'expired',
      message: 'Your session expired. Please sign in again.',
    };
  }

  switch (input.probe) {
    case 'revoked':
      return {
        view: 'signed_out',
        hasSession: true,
        clearSession: true,
        canRetry: false,
        reason: 'revoked',
        message: 'This device was removed. Please sign in again.',
      };
    case 'expired':
      return {
        view: 'signed_out',
        hasSession: true,
        clearSession: true,
        canRetry: false,
        reason: 'expired',
        message: 'Your session expired. Please sign in again.',
      };
    case 'unauthorized':
      return {
        view: 'signed_out',
        hasSession: true,
        clearSession: true,
        canRetry: false,
        reason: 'unauthorized',
        message: 'Your session is no longer valid. Please sign in again.',
      };
    case 'unreachable':
      // Offline: keep the session; show a retry rather than a dead screen.
      return {
        view: 'offline_retry',
        hasSession: true,
        clearSession: false,
        canRetry: true,
        reason: 'region_unreachable',
        message: 'The region is unreachable right now. Check your connection and try again.',
      };
    case 'ok':
    case 'skipped':
    default:
      return {
        view: 'signed_in',
        hasSession: true,
        clearSession: false,
        canRetry: false,
        reason: 'ok',
        message: null,
      };
  }
}

/**
 * Read the `exp` claim from a JWT without verifying it (the region is the only
 * authority on validity; this only tells us whether the token is *obviously*
 * past expiry at boot, so we can skip a doomed probe).
 */
export function readTokenExpiryMs(token: string | null | undefined): number | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as Record<string, unknown>;
    const exp = payload.exp;
    if (typeof exp === 'number' && Number.isFinite(exp)) return exp * 1000;
    if (typeof exp === 'string' && exp.trim() && Number.isFinite(Number(exp))) {
      return Number(exp) * 1000;
    }
    return null;
  } catch {
    return null;
  }
}

/** Decode a base64url segment (JWT payload) to a UTF-8 string. */
export function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  if (typeof Buffer !== 'undefined') return Buffer.from(padded, 'base64').toString('utf8');
  return decodeURIComponent(escape(atob(padded)));
}
