/**
 * Local GPU runner manager (Phase 4, main process).
 *
 * Owns the lifecycle of the loopback OpenAI-compatible proxy and its BYOK
 * registration: mint TLS once (kept in the secure store), start/stop the https
 * server, and register/unregister the endpoint with the region as an
 * `edge_gpu_sidecar` provider.
 *
 * All the interesting logic lives in `@nexus/local-runner`; this module only
 * wires it to Electron's secure store and the persisted settings JSON.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { app } from 'electron';
import {
  listLocalRunners,
  mintLocalTls,
  registerLocalRunner,
  startLocalRunnerServer,
  type LocalRunnerConfig,
  type LocalRunnerServer,
} from '@nexus/local-runner';
import { scopedKey, type SecureStore } from '@nexus/node-core';
import type { LocalRunnerSettings, LocalRunnerState } from '../shared/ipc.js';

/** Secure-store key for the runner's locally-minted material (never leaves the machine). */
const RUNNER_KEY = scopedKey('local_runner', null);

export const DEFAULT_RUNNER_SETTINGS: LocalRunnerSettings = {
  enabled: false,
  upstreamBaseUrl: 'http://127.0.0.1:11434',
  name: 'Local models (this machine)',
  scope: 'user',
};

type StoredRunnerSecrets = {
  apiKey: string;
  keyPem: string;
  certPem: string;
  certFingerprint: string;
  certNotAfter: string;
  altNames: string[];
};

export type RunnerManagerOptions = {
  secureStore: SecureStore;
  /** Token-bearing region sender (from the auth manager). */
  getSender: () => Promise<{ send: (command: string, payload?: Record<string, unknown>) => Promise<unknown> }>;
  /** Overridable for tests. */
  settingsPath?: string;
};

export type RunnerManager = ReturnType<typeof createRunnerManager>;

export function createRunnerManager(options: RunnerManagerOptions) {
  const settingsPath = options.settingsPath ?? join(app.getPath('userData'), 'runner.json');
  let server: LocalRunnerServer | null = null;
  let availability: LocalRunnerState['availability'] = 'stopped';
  let detail: string | undefined;
  let registration: { providerId?: string; wrapperId?: string } = {};

  function readSettings(): LocalRunnerSettings {
    if (!existsSync(settingsPath)) return { ...DEFAULT_RUNNER_SETTINGS };
    try {
      const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as Partial<LocalRunnerSettings>;
      return { ...DEFAULT_RUNNER_SETTINGS, ...raw };
    } catch {
      return { ...DEFAULT_RUNNER_SETTINGS };
    }
  }

  function writeSettings(value: LocalRunnerSettings): void {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(value, null, 2), 'utf8');
  }

  async function loadSecrets(): Promise<StoredRunnerSecrets> {
    const raw = await options.secureStore.get(RUNNER_KEY);
    if (raw) {
      try {
        return JSON.parse(raw) as StoredRunnerSecrets;
      } catch {
        // fall through to a fresh mint
      }
    }
    const tls = await mintLocalTls();
    const secrets: StoredRunnerSecrets = {
      apiKey: randomBytes(24).toString('base64url'),
      keyPem: tls.keyPem,
      certPem: tls.certPem,
      certFingerprint: tls.fingerprint,
      certNotAfter: tls.notAfter,
      altNames: tls.altNames,
    };
    await options.secureStore.set(RUNNER_KEY, JSON.stringify(secrets));
    return secrets;
  }

  function runnerConfig(settings: LocalRunnerSettings, secrets: StoredRunnerSecrets): LocalRunnerConfig | null {
    if (!server) return null;
    return {
      id: 'local-models',
      name: settings.name,
      endpointUrl: server.endpointUrl,
      apiKey: secrets.apiKey,
      defaultModel: settings.defaultModel,
    };
  }

  async function state(): Promise<LocalRunnerState> {
    const settings = readSettings();
    const secrets = await loadSecrets();
    return {
      settings,
      availability: settings.enabled ? availability : 'disabled',
      detail,
      endpointUrl: server?.endpointUrl ?? undefined,
      altNames: secrets.altNames,
      certFingerprint: secrets.certFingerprint,
      certNotAfter: secrets.certNotAfter,
      registered: Boolean(registration.providerId),
      providerId: registration.providerId,
      wrapperId: registration.wrapperId,
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async function start(): Promise<LocalRunnerState> {
    const settings = readSettings();
    if (!settings.enabled) {
      return state();
    }
    if (server) return state();
    availability = 'starting';
    try {
      const secrets = await loadSecrets();
      server = await startLocalRunnerServer({
        upstreamBaseUrl: settings.upstreamBaseUrl,
        apiKey: secrets.apiKey,
        keyPem: secrets.keyPem,
        certPem: secrets.certPem,
      });
      availability = 'available';
      detail = undefined;
    } catch (err) {
      availability = 'error';
      detail = err instanceof Error ? err.message : 'failed to start local runner';
    }
    return state();
  }

  async function stop(): Promise<LocalRunnerState> {
    if (server) {
      await server.close();
      server = null;
    }
    availability = 'stopped';
    return state();
  }

  /** Register the loopback endpoint as a BYOK `edge_gpu_sidecar` provider. */
  async function register(): Promise<LocalRunnerState> {
    if (!server) await start();
    const settings = readSettings();
    const secrets = await loadSecrets();
    const config = runnerConfig(settings, secrets);
    if (!config) {
      detail = 'runner is not running';
      return state();
    }
    const sender = await options.getSender();
    await registerLocalRunner(sender.send as never, config, { scope: settings.scope });
    // Re-read what the region actually holds, so we show the true state.
    const rows = await listLocalRunners(sender.send as never, { scope: settings.scope });
    const mine = rows.find((r) => r.endpointUrl === config.endpointUrl) ?? rows[0];
    registration = { providerId: mine?.providerId ?? undefined };
    return state();
  }

  return {
    getState: () => state(),
    async setSettings(patch: Partial<LocalRunnerSettings>): Promise<LocalRunnerState> {
      const next = { ...readSettings(), ...patch };
      writeSettings(next);
      if (!next.enabled && server) await stop();
      if (next.enabled && !server) await start();
      return state();
    },
    start,
    stop,
    register,
    /** Called on app quit so the loopback server does not outlive the app. */
    async dispose() {
      await stop();
    },
  };
}
