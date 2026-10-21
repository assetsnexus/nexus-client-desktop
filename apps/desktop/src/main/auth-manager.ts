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
  login as regionLogin,
  scopedKey,
  SECURE_KEYS,
  twoFactorLogin as regionTwoFactorLogin,
  type AuthClientOptions,
  type AuthIdentity,
  type CommandResult,
  type CommandSender,
  type DeviceKeyStore,
  type LoginCredentials,
  type SecureStore,
} from '@nexus/node-core';
import type { AuthState, DeviceStatus, TwoFactorRequest } from '../shared/ipc.js';

const TOKEN_KEY = scopedKey(SECURE_KEYS.token, null);

export type AuthManagerOptions = {
  secureStore: SecureStore;
  /** Region client options minus the per-call token. */
  clientOptions: AuthClientOptions;
  deviceName: string;
  platform: string;
  appVersion: string;
};

export type AuthManager = {
  getState(): Promise<AuthState>;
  login(creds: LoginCredentials): Promise<AuthState>;
  submitTwoFactor(req: TwoFactorRequest): Promise<AuthState>;
  logout(): Promise<void>;
  getToken(): Promise<string | null>;
  getDeviceStatus(): Promise<DeviceStatus>;
  registerDevice(): Promise<DeviceStatus>;
  /** Build a token-bearing sender for command calls from the main process. */
  createSender(): Promise<CommandSender>;
};

export function createAuthManager(options: AuthManagerOptions): AuthManager {
  const { secureStore } = options;
  let pendingChallenge: { authRequestId: string; factors: string[]; message?: string } | null = null;
  let cachedToken: string | null = null;
  let cachedIdentity: AuthIdentity | null = null;

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
    return { status: 'signed_in', token, identity };
  }

  async function currentState(): Promise<AuthState> {
    if (pendingChallenge) {
      return { status: 'two_factor_required', ...pendingChallenge };
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

  return {
    getState: currentState,

    async login(creds) {
      const result = await regionLogin(options.clientOptions, creds);
      if (result.kind === 'authenticated') {
        return persistIdentity(result.token, result.identity);
      }
      pendingChallenge = {
        authRequestId: result.challenge.authRequestId,
        factors: result.challenge.factors,
        message: result.challenge.message,
      };
      return { status: 'two_factor_required', ...pendingChallenge };
    },

    async submitTwoFactor(req) {
      const out = await regionTwoFactorLogin(options.clientOptions, {
        authRequestId: req.authRequestId,
        code: req.code,
        factor: req.factor,
      });
      return persistIdentity(out.token, out.identity);
    },

    async logout() {
      cachedToken = null;
      cachedIdentity = null;
      pendingChallenge = null;
      await secureStore.delete(TOKEN_KEY);
    },

    getToken: async () => cachedToken ?? (await secureStore.get(TOKEN_KEY)),

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
          const { sendCommand } = await import('@nexus/node-core');
          const res = await sendCommand(
            options.clientOptions,
            command,
            payload ?? {},
            { token, identity },
          );
          return {
            ok: res.responseCode >= 200 && res.responseCode < 300,
            data: res.responseObject,
            responseCode: res.responseCode,
            responseObject: res.responseObject,
            message: res.message,
            authorizationRequired: res.authorizationRequired,
            authRequestId: res.authRequestId,
          };
        },
      };
    },
  };
}
