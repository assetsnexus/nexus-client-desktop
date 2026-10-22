/**
 * Auth + device session manager for the main process.
 *
 * Owns the region auth lifecycle (login -> optional 2FA -> token), persists the
 * token and device keypair in the secure store, and exposes the small surface
 * the IPC layer needs. Keeps a single in-flight 2FA challenge.
 */

import {
  ensureDeviceIdentity,
  generateDeviceKeys,
  listCountries as regionListCountries,
  listRegions as regionListRegions,
  login as regionLogin,
  pollDeviceLink,
  readIdentity,
  resendPasswordless as regionResendPasswordless,
  resolveManagedRegion,
  scopedKey,
  SECURE_KEYS,
  startDeviceLink,
  startPasswordless as regionStartPasswordless,
  switchLoginTwoFactor as regionSwitchLoginTwoFactor,
  twoFactorLogin as regionTwoFactorLogin,
  verifyPasswordless as regionVerifyPasswordless,
  type AuthClientOptions,
  type AuthIdentity,
  type CommandResult,
  type CommandSender,
  type CountryRow,
  type DeviceKeyStore,
  type DeviceLinkStarted,
  type LoginCredentials,
  type PasswordlessChannel,
  type RegionRow,
  type SecureStore,
} from '@nexus/node-core';
import type {
  AuthState,
  DeviceLinkPollOutcome,
  DeviceLinkSessionStart,
  DeviceStatus,
  PasswordlessChallengeState,
  SessionHydrationState,
  TwoFactorRequest,
} from '../shared/ipc.js';
import {
  decideStartupSession,
  readTokenExpiryMs,
  type HydrationResult,
  type SessionProbe,
} from './session-hydration.js';

const TOKEN_KEY = scopedKey(SECURE_KEYS.token, null);

export type AuthManagerOptions = {
  secureStore: SecureStore;
  /** Region client options minus the per-call token. */
  clientOptions: AuthClientOptions;
  deviceName: string;
  platform: string;
  appVersion: string;
  /**
   * Optional active-token resolver. When set (Phase 9 identity switching), it
   * takes precedence over the single persisted token so the sender always uses
   * the currently-selected identity.
   */
  getActiveToken?: () => string | null;
  /** Called after a successful login / 2FA completion (Phase 9 identity record). */
  onAuthenticated?: (input: { token: string; identity: AuthIdentity }) => void;
  /**
   * Called when the region rejects a command because the session/device is dead
   * (device removed in the portal, token revoked/expired). The owner must tear
   * down local access: tokens, storage, sync schedules, mounts, and the UI.
   */
  onSessionLost?: (loss: { reason: string; deviceRevoked: boolean; message: string }) => void;
};

export type AuthManager = {
  getState(): Promise<AuthState>;
  login(creds: LoginCredentials): Promise<AuthState>;
  submitTwoFactor(req: TwoFactorRequest): Promise<AuthState>;
  /** Re-target which enrolled method the pending password challenge uses. */
  switchTwoFactorMethod(method: string): Promise<AuthState>;
  /** Countries for the login country picker (public; no session needed). */
  listCountries(): Promise<CountryRow[]>;
  /** Regions for resolving a country to its serving region (public). */
  listRegions(): Promise<RegionRow[]>;
  /** Passwordless (email / SMS / voice) code sign-in, step 1. */
  startPasswordless(input: { channel: PasswordlessChannel; identifier: string }): Promise<AuthState>;
  /** Passwordless code sign-in, step 2. */
  verifyPasswordless(input: { code: string }): Promise<AuthState>;
  /** Re-send the passwordless code, optionally switching channel. */
  resendPasswordless(input?: { channel?: PasswordlessChannel }): Promise<AuthState>;
  /** Abandon an in-flight password / passwordless challenge. */
  cancelChallenge(): Promise<AuthState>;
  /** Mint a cross-device login link (QR "sign in with the Nexus app"). */
  startDeviceLink(): Promise<DeviceLinkSessionStart>;
  /** Poll an in-flight link; the approved branch signs this device in once. */
  pollDeviceLink(): Promise<DeviceLinkPollOutcome>;
  logout(): Promise<void>;
  /** Force a signed-out state after a detected session loss (device revoked). */
  forceSignOut(reason?: string): Promise<void>;
  /**
   * Startup hydration (Deliverable 2): decide whether the stored session is
   * still good. Probes the region when a session exists, applies the pure
   * decision in `session-hydration.ts`, clears a dead session, and reports what
   * the renderer should render (signed in / offline retry / signed out).
   */
  hydrateSession(): Promise<SessionHydrationState>;
  getToken(): Promise<string | null>;
  getDeviceStatus(): Promise<DeviceStatus>;
  registerDevice(): Promise<DeviceStatus>;
  /** Build a token-bearing sender for command calls from the main process. */
  createSender(): Promise<CommandSender>;
};

export function createAuthManager(options: AuthManagerOptions): AuthManager {
  const { secureStore } = options;
  let pendingChallenge: PasswordlessChallengeState | null = null;
  /** In-flight cross-device link; the secret deviceCode never leaves this scope. */
  let activeDeviceLink: DeviceLinkStarted | null = null;
  let cachedToken: string | null = null;
  let cachedIdentity: AuthIdentity | null = null;
  /** Cache the node's managed region slug (passwordless start needs it). */
  let cachedRegion: string | null = null;

  async function managedRegion(): Promise<string> {
    if (cachedRegion) return cachedRegion;
    const slug = await resolveManagedRegion(options.clientOptions);
    if (!slug) {
      throw new Error('this region node does not advertise a managed region');
    }
    cachedRegion = slug;
    return slug;
  }

  async function loadDeviceKeys() {
    const raw = await secureStore.get(SECURE_KEYS.deviceKeys);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ReturnType<typeof generateDeviceKeys>;
    } catch {
      return null;
    }
  }

  async function persistIdentity(token: string, identity: AuthIdentity): Promise<AuthState> {
    cachedToken = token;
    cachedIdentity = identity;
    pendingChallenge = null;
    await secureStore.set(TOKEN_KEY, token);
    options.onAuthenticated?.({ token, identity });
    return { status: 'signed_in', token, identity };
  }

  async function currentState(): Promise<AuthState> {
    if (pendingChallenge) {
      return { status: 'two_factor_required', ...pendingChallenge };
    }
    // Phase 9: the identity store (multi-account / org switch) is the token
    // authority when wired; it supersedes the single persisted token.
    const activeOverride = options.getActiveToken?.() ?? null;
    if (activeOverride) {
      cachedToken = activeOverride;
      return { status: 'signed_in', token: activeOverride, identity: cachedIdentity ?? emptyIdentity() };
    }
    if (cachedToken && cachedIdentity) {
      return { status: 'signed_in', token: cachedToken, identity: cachedIdentity };
    }
    const stored = await secureStore.get(TOKEN_KEY);
    if (stored) {
      cachedToken = stored;
      cachedIdentity = { userId: null, orgId: null, role: null, deviceId: null };
      return { status: 'signed_in', token: stored, identity: cachedIdentity };
    }
    return { status: 'signed_out' };
  }

  function emptyIdentity(): AuthIdentity {
    return { userId: null, orgId: null, role: null, deviceId: null };
  }

  /** Map the pure decision to the IPC wire shape (adds the refreshed token). */
  function toHydrationState(decision: HydrationResult): SessionHydrationState {
    return {
      view: decision.view,
      reason: decision.reason,
      message: decision.message,
      canRetry: decision.canRetry,
      hasSession: decision.hasSession,
      token: decision.view === 'signed_out' ? null : cachedToken,
      identity: decision.view === 'signed_out' ? null : cachedIdentity,
    };
  }

  /**
   * Probe the region to learn whether the stored session is still valid. Uses
   * `anx.device.list` — a cheap, read-only, session-bearing command. A transport
   * failure (the region cannot be reached at all) is `unreachable`; a response
   * is classified through the same session-loss rules the senders use.
   */
  async function probeRegion(token: string): Promise<SessionProbe> {
    let res: CommandResult;
    try {
      const { sendCommand } = await import('@nexus/node-core');
      res = await sendCommand(options.clientOptions, 'anx.device.list', {}, { token });
    } catch {
      // Network/TLS failure: offline, not a dead session.
      return 'unreachable';
    }
    if (res.responseCode >= 200 && res.responseCode < 300) return 'ok';
    const { classifySessionFailure } = await import('@nexus/node-core');
    const loss = classifySessionFailure({
      responseCode: res.responseCode,
      message: res.message,
      code: res.code,
    });
    if (!loss.lost) return 'ok'; // An authorization decision, not a dead session.
    if (loss.reason === 'device_revoked') return 'revoked';
    if (loss.reason === 'expired') return 'expired';
    return 'unauthorized';
  }

  /**
   * Force a signed-out state after the region proves the session/device is dead
   * (device removed in the portal, token revoked). Stricter than `logout`: it
   * also drops the device keypair so a later re-registration cannot inherit
   * stale keys, matching the region's soft-delete behaviour.
   */
  async function forceSignOut(_reason?: string): Promise<void> {
    cachedToken = null;
    cachedIdentity = null;
    pendingChallenge = null;
    await secureStore.delete(TOKEN_KEY);
    await secureStore.delete(SECURE_KEYS.deviceKeys);
  }

  /** Build the renderer-facing challenge state from a region challenge. */
  function challengeState(
    challenge: {
      loginToken: string;
      methods?: string[];
      factors: string[];
      hint?: { channelType?: string; sentTo?: string | null; methodSlug?: string };
      message?: string;
    },
    flow: 'password' | 'passwordless',
  ): PasswordlessChallengeState {
    const methods = challenge.methods?.length ? challenge.methods : challenge.factors;
    pendingChallenge = {
      loginToken: challenge.loginToken,
      flow,
      methods,
      factors: challenge.factors,
      hint: challenge.hint,
      message: challenge.message,
    };
    return pendingChallenge;
  }

  return {
    getState: currentState,

    async login(creds) {
      const result = await regionLogin(options.clientOptions, creds);
      if (result.kind === 'authenticated') {
        return persistIdentity(result.token, result.identity);
      }
      return { status: 'two_factor_required', ...challengeState(result.challenge, 'password') };
    },

    async listCountries() {
      return regionListCountries(options.clientOptions);
    },

    async listRegions() {
      return regionListRegions(options.clientOptions);
    },

    async submitTwoFactor(req) {
      if (!pendingChallenge) {
        throw new Error('no sign-in challenge is in progress');
      }
      const out = await regionTwoFactorLogin(options.clientOptions, {
        loginToken: pendingChallenge.loginToken,
        method: req.method || pendingChallenge.methods[0] || 'email',
        code: req.code,
        deviceId: null,
      });
      return persistIdentity(out.token, out.identity);
    },

    async switchTwoFactorMethod(method) {
      if (!pendingChallenge) {
        throw new Error('no sign-in challenge is in progress');
      }
      const out = await regionSwitchLoginTwoFactor(options.clientOptions, {
        loginToken: pendingChallenge.loginToken,
        method,
      });
      return {
        status: 'two_factor_required',
        ...challengeState(
          {
            loginToken: pendingChallenge.loginToken,
            methods: out.methods.length ? out.methods : [method],
            factors: pendingChallenge.factors,
            hint: out.hint,
            message: pendingChallenge.message,
          },
          pendingChallenge.flow,
        ),
      };
    },

    async startPasswordless(input) {
      const region = await managedRegion();
      const started = await regionStartPasswordless(options.clientOptions, {
        channel: input.channel,
        identifier: input.identifier,
        region,
      });
      pendingChallenge = {
        loginToken: started.challengeToken,
        flow: 'passwordless',
        methods: [input.channel],
        factors: [input.channel],
        hint: { channelType: input.channel, sentTo: started.maskedTarget ?? null },
      };
      return { status: 'two_factor_required', ...pendingChallenge };
    },

    async verifyPasswordless(input) {
      if (!pendingChallenge || pendingChallenge.flow !== 'passwordless') {
        throw new Error('no sign-in code is in progress');
      }
      const out = await regionVerifyPasswordless(options.clientOptions, {
        challengeToken: pendingChallenge.loginToken,
        code: input.code,
      });
      if (out.kind === 'authenticated') {
        return persistIdentity(out.token, out.identity);
      }
      if (out.kind === 'account_disabled') {
        throw new Error(out.message);
      }
      // Step-up: the code was proven but another factor is required.
      return { status: 'two_factor_required', ...challengeState(out.challenge, 'passwordless') };
    },

    async resendPasswordless(input) {
      if (!pendingChallenge || pendingChallenge.flow !== 'passwordless') {
        throw new Error('no sign-in code is in progress');
      }
      const out = await regionResendPasswordless(options.clientOptions, {
        challengeToken: pendingChallenge.loginToken,
        channel: input?.channel,
      });
      pendingChallenge = {
        ...pendingChallenge,
        methods: [out.channel],
        hint: { channelType: out.channel, sentTo: out.maskedTarget ?? null },
      };
      return { status: 'two_factor_required', ...pendingChallenge };
    },

    async cancelChallenge() {
      pendingChallenge = null;
      return currentState();
    },

    async startDeviceLink() {
      const started = await startDeviceLink(options.clientOptions, {
        deviceName: options.deviceName,
        platform: options.platform,
        appVersion: options.appVersion,
      });
      // Keep the secret in main-process memory only; the renderer gets just
      // what it must render plus an opaque handle to poll with.
      activeDeviceLink = started;
      return {
        userCode: started.userCode,
        appLink: started.appLink,
        verificationUri: started.verificationUri,
        expiresAt: started.expiresAt,
        interval: started.interval,
      };
    },

    async pollDeviceLink() {
      if (!activeDeviceLink) return { status: 'expired' };
      const result = await pollDeviceLink(options.clientOptions, activeDeviceLink.deviceCode);
      if (result.status === 'approved') {
        activeDeviceLink = null;
        // The region returns the minted JWT plus the session record it was
        // bound to. The session's embedded AuthToken carries the identity
        // claims (userId/orgId/role), which the desktop needs for its sender.
        const session = (result.session ?? {}) as Record<string, unknown>;
        const authToken = (session.token ?? {}) as Record<string, unknown>;
        const token =
          typeof result.token === 'string'
            ? result.token
            : typeof authToken.token === 'string'
              ? authToken.token
              : '';
        if (!token) throw new Error('approved link returned no session token');
        const state = await persistIdentity(token, readIdentity({ ...session, ...authToken }));
        return { status: 'approved' as const, authState: state };
      }
      if (result.status === 'expired' || result.status === 'denied') {
        activeDeviceLink = null;
      }
      return result;
    },

    async logout() {
      cachedToken = null;
      cachedIdentity = null;
      pendingChallenge = null;
      await secureStore.delete(TOKEN_KEY);
    },

    forceSignOut,

    async hydrateSession(): Promise<SessionHydrationState> {
      // Resolve the stored session. A partial/corrupt identity index or a
      // secure-store read that throws both degrade to a recoverable signed-out
      // state rather than a dead screen.
      let corrupted = false;
      let storedToken: string | null = null;
      try {
        storedToken = options.getActiveToken?.() ?? cachedToken ?? (await secureStore.get(TOKEN_KEY));
      } catch {
        corrupted = true;
      }
      const hasAccounts = Boolean(options.getActiveToken?.());

      // Nothing stored: no probe, plain signed out.
      if (!storedToken && !hasAccounts) {
        return toHydrationState(
          decideStartupSession({
            hasToken: false,
            hasAccounts: false,
            corrupted: false,
            expiresAtMs: null,
            probe: 'skipped',
          }),
        );
      }

      const expiresAtMs = readTokenExpiryMs(storedToken);
      // Skip a doomed network round-trip when the token is already expired; the
      // decision treats a locally-expired token as a dead session either way.
      let probe: SessionProbe = 'skipped';
      if (storedToken && !corrupted && expiresAtMs !== null && expiresAtMs <= Date.now()) {
        probe = 'expired';
      } else if (storedToken && !corrupted) {
        probe = await probeRegion(storedToken);
      }

      const decision = decideStartupSession({
        hasToken: Boolean(storedToken),
        hasAccounts,
        corrupted,
        expiresAtMs,
        probe,
      });

      if (decision.clearSession) {
        try {
          cachedToken = null;
          cachedIdentity = null;
          pendingChallenge = null;
          await secureStore.delete(TOKEN_KEY);
          await secureStore.delete(SECURE_KEYS.deviceKeys);
        } catch {
          /* best-effort; the renderer still returns to sign-in */
        }
      }
      return toHydrationState(decision);
    },

    getToken: async () =>
      options.getActiveToken?.() ?? cachedToken ?? (await secureStore.get(TOKEN_KEY)),

    async getDeviceStatus(): Promise<DeviceStatus> {
      const keys = await loadDeviceKeys();
      return {
        registered: Boolean(cachedIdentity?.deviceId) || Boolean(keys?.deviceId),
        deviceId: cachedIdentity?.deviceId ?? keys?.deviceId ?? null,
        hasKeys: Boolean(keys),
      };
    },

    async registerDevice(): Promise<DeviceStatus> {
      const token = await this.getToken();
      if (!token) throw new Error('cannot register a device while signed out');
      // Ensure a local keypair exists, then register with the region.
      let keys = await loadDeviceKeys();
      if (!keys) {
        keys = generateDeviceKeys();
        await secureStore.set(SECURE_KEYS.deviceKeys, JSON.stringify(keys));
      }
      const store: DeviceKeyStore = {
        load: () => keys,
        save: (next) => {
          keys = next;
        },
        clear: () => {
          keys = null as never;
        },
      };
      const result = await ensureDeviceIdentity(
        options.clientOptions,
        store,
        {
          deviceName: options.deviceName,
          platform: options.platform,
          appVersion: options.appVersion,
          deviceType: 'desktop',
        },
        token,
      );
      await secureStore.set(SECURE_KEYS.deviceKeys, JSON.stringify(keys));
      if (cachedIdentity) cachedIdentity = { ...cachedIdentity, deviceId: result.deviceId };
      return { registered: true, deviceId: result.deviceId, hasKeys: true };
    },

    async createSender(): Promise<CommandSender> {
      const token = await this.getToken();
      const identity = {
        userId: cachedIdentity?.userId ?? undefined,
        orgId: cachedIdentity?.orgId ?? undefined,
        role: cachedIdentity?.role ?? undefined,
        deviceId: cachedIdentity?.deviceId ?? undefined,
      };
      return {
        async send(command, payload): Promise<CommandResult> {
          const { sendCommand, classifySessionFailure } = await import('@nexus/node-core');
          const res = await sendCommand(
            options.clientOptions,
            command,
            payload ?? {},
            { token, identity },
          );
          const ok = res.responseCode >= 200 && res.responseCode < 300;
          // Global session revocation gate: a device removed in the portal makes
          // the region reject every command. Detect it once, tear everything down.
          // Only meaningful when this call actually carried a session — an
          // anonymous request that is refused proves nothing about the device,
          // and tearing down here would sign the user out for a command that was
          // simply not permitted (or issued before sign-in).
          if (!ok && token) {
            const loss = classifySessionFailure({
              responseCode: res.responseCode,
              message: res.message,
              code: res.code,
            });
            if (loss.lost) {
              await forceSignOut(loss.reason);
              options.onSessionLost?.({
                reason: loss.reason,
                deviceRevoked: loss.deviceRevoked,
                message: loss.message,
              });
            }
          }
          return {
            ok,
            data: res.responseObject,
            responseCode: res.responseCode,
            responseObject: res.responseObject,
            message: res.message,
            code: res.code,
            authorizationRequired: res.authorizationRequired,
            authRequestId: res.authRequestId,
          };
        },
      };
    },
  };
}
