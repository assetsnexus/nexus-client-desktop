import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The main-process modules import `electron`; stub the bits we touch.
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
}));

const { createRunnerManager, DEFAULT_RUNNER_SETTINGS } = await import('./runner-manager.js');
const { createMemorySecureStore } = await import('@nexus/node-core');

const dirs: string[] = [];
function tempSettings() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-runner-'));
  dirs.push(dir);
  return join(dir, 'runner.json');
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function manager(sender = vi.fn(async () => ({ responseCode: 200, responseObject: { wrappers: [] } }))) {
  const settingsPath = tempSettings();
  const secureStore = createMemorySecureStore();
  const m = createRunnerManager({ secureStore, getSender: async () => ({ send: sender }), settingsPath });
  return { m, sender, secureStore, settingsPath };
}

describe('runner manager', () => {
  it('defaults to disabled with the Ollama upstream and a user scope', async () => {
    const { m } = manager();
    const state = await m.getState();
    expect(state.settings).toEqual(DEFAULT_RUNNER_SETTINGS);
    expect(state.availability).toBe('disabled');
    expect(state.registered).toBe(false);
  });

  it('starts a loopback server when enabled and mints stable cert material', async () => {
    const { m, secureStore } = manager();
    const state = await m.setSettings({ enabled: true });
    expect(state.availability).toBe('available');
    expect(state.endpointUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(state.certFingerprint).toBeTruthy();
    expect(await secureStore.get('local_runner:default')).toBeTruthy();
    await m.stop();
  });

  it('stops the server when disabled', async () => {
    const { m } = manager();
    await m.setSettings({ enabled: true });
    const off = await m.setSettings({ enabled: false });
    expect(off.availability).toBe('disabled');
  });

  it('registers the endpoint with the region as edge_gpu_sidecar and reports the provider id', async () => {
    const sender = vi.fn(async (command: string) => {
      if (command === 'anx.ai.byok.register') {
        return { responseCode: 200, responseObject: { wrapper: { providerId: 'p1', wrapperId: 'w1' } } };
      }
      if (command === 'anx.ai.byok.list') {
        return {
          responseCode: 200,
          responseObject: {
            wrappers: [
              { providerId: 'p1', name: 'Local', kind: 'edge_gpu_sidecar', endpointUrl: 'https://127.0.0.1:1/v1' },
            ],
          },
        };
      }
      throw new Error(`unexpected ${command}`);
    });
    const { m } = manager(sender);
    await m.setSettings({ enabled: true });
    const state = await m.register();
    expect(sender).toHaveBeenCalledWith(
      'anx.ai.byok.register',
      expect.objectContaining({
        kind: 'edge_gpu_sidecar',
        hostingType: 'edge_processing',
        scope: 'user',
      }),
    );
    expect(state.registered).toBe(true);
    expect(state.providerId).toBe('p1');
    await m.stop();
  });

  it('persists settings across manager instances', async () => {
    const { m, settingsPath, secureStore } = manager();
    await m.setSettings({ enabled: false, name: 'My GPU', scope: 'org', upstreamBaseUrl: 'http://127.0.0.1:9999' });
    const m2 = createRunnerManager({
      secureStore,
      getSender: async () => ({ send: vi.fn() }),
      settingsPath,
    });
    const state = await m2.getState();
    expect(state.settings).toMatchObject({ name: 'My GPU', scope: 'org', upstreamBaseUrl: 'http://127.0.0.1:9999' });
  });
});
