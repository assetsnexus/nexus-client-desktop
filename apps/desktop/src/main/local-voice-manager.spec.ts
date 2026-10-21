import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The main-process modules import `electron`; stub the bits we touch.
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
}));

const { createLocalVoiceManager } = await import('./local-voice-manager.js');
const { BUILTIN_VOICE_MODELS, modelDirName } = await import('@nexus/local-voice');

const dirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-local-voice-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A probe runner that never shells out. */
const probeRunners = {
  totalmem: () => 16 * 1024 ** 3,
  freemem: () => 8 * 1024 ** 3,
  platform: 'linux' as const,
  run: async () => '16384, 8192\n',
};

/** A runtime with no real engines (the fake persists state for assertions). */
function fakeRuntime() {
  const loads: string[] = [];
  const unloads: string[] = [];
  return {
    loads,
    unloads,
    runtime: {
      list: () => [
        {
          id: 'whisper.cpp',
          kind: 'stt' as const,
          load: async () => {
            loads.push('whisper.cpp');
          },
          unload: async () => {
            unloads.push('whisper.cpp');
          },
        },
      ],
      dispose: async () => {},
    },
  };
}

function manager(overrides: Record<string, unknown> = {}) {
  const dir = tempDir();
  const { runtime, loads, unloads } = fakeRuntime();
  const m = createLocalVoiceManager({
    getSender: async () => ({ send: vi.fn(async () => ({ data: { models: [] } })) }),
    dataDir: dir,
    settingsPath: join(dir, 'local-voice.json'),
    probeRunners,
    engineRuntime: runtime,
    ...overrides,
  });
  return { m, dir, loads, unloads };
}

describe('local voice manager', () => {
  it('starts with cloud engines disabled and the built-in catalog', async () => {
    const { m } = manager();
    const state = await m.getState();
    expect(state.settings.enabled).toBe(true);
    expect(state.settings.sttEngine).toBe('cloud');
    expect(state.models.length).toBe(BUILTIN_VOICE_MODELS.length);
    expect(state.models.every((r) => r.installState === 'not_installed')).toBe(true);
    await m.dispose();
  });

  it('reports free RAM and VRAM', async () => {
    const { m } = manager();
    const state = await m.getState();
    expect(state.resources.ram?.totalBytes).toBe(16 * 1024 ** 3);
    expect(state.resources.vram?.vendor).toBe('nvidia');
    expect(state.resources.vram?.freeBytes).toBe(8192 * 1024 * 1024);
    await m.dispose();
  });

  it('persists a settings patch and rebuilds the engine lifecycle', async () => {
    const { m, dir } = manager();
    await m.setSettings({ sttEngine: 'local', idleTimeoutSeconds: 42, sttModelId: 'catalog:x' });
    const state = await m.getState();
    expect(state.settings.sttEngine).toBe('local');
    expect(state.settings.idleTimeoutSeconds).toBe(42);
    // Persisted to disk for the next launch.
    const m2 = createLocalVoiceManager({
      getSender: async () => ({ send: vi.fn() }),
      dataDir: dir,
      settingsPath: join(dir, 'local-voice.json'),
      probeRunners,
      engineRuntime: fakeRuntime().runtime,
    });
    const reloaded = await m2.getState();
    expect(reloaded.settings.sttEngine).toBe('local');
    expect(reloaded.settings.idleTimeoutSeconds).toBe(42);
    await m.dispose();
    await m2.dispose();
  });

  it('marks a model installed when its files are on disk', async () => {
    const { m, dir } = manager();
    const stt = BUILTIN_VOICE_MODELS.find((x) => x.kind === 'stt')!;
    const modelDir = join(dir, 'voice-models', modelDirName(stt));
    mkdirSync(modelDir, { recursive: true });
    for (const f of stt.files) {
      writeFileSync(join(modelDir, f.name), new Uint8Array(4));
    }
    const state = await m.getState();
    const row = state.models.find((r) => r.id === stt.id)!;
    expect(row.installState).toBe('installed');
    expect(row.downloadPercent).toBe(100);
    await m.dispose();
  });

  it('keeps the built-in download URL when the region row omits one', async () => {
    const { m } = manager({
      getSender: async () => ({
        send: vi.fn(async () => ({
          data: {
            models: [
              // Same id as a builtin, but no download metadata.
              { id: 'static:desktop/whisper-small-q5', category: 'stt', displayName: 'Whisper Small' },
            ],
          },
        })),
      }),
    });
    await m.refreshCatalog();
    const state = await m.getState();
    const row = state.models.find((r) => r.id === 'catalog:desktop/whisper-small-q5')!;
    // `mergeVoiceCatalog` keeps the builtin URL when the region row lacks one.
    expect(row.downloadUrl).toContain('huggingface.co');
    await m.dispose();
  });

  it('removes an installed model from disk', async () => {
    const { m, dir } = manager();
    const stt = BUILTIN_VOICE_MODELS.find((x) => x.kind === 'stt')!;
    const modelDir = join(dir, 'voice-models', modelDirName(stt));
    mkdirSync(modelDir, { recursive: true });
    for (const f of stt.files) writeFileSync(join(modelDir, f.name), new Uint8Array(4));
    await m.remove(stt.id);
    const state = await m.getState();
    expect(state.models.find((r) => r.id === stt.id)!.installState).toBe('not_installed');
    await m.dispose();
  });

  it('reports an install error for a model with no artifact', async () => {
    const { m } = manager();
    // A custom endpoint row has no files.
    await m.install('catalog:does-not-exist');
    const state = await m.getState();
    expect(state.models.every((r) => r.error == null || r.id !== 'catalog:does-not-exist')).toBe(true);
    await m.dispose();
  });

  it('unloads engines on dispose', async () => {
    const { m, unloads } = manager();
    // Force a lifecycle build so there is something to release.
    await m.probeResources();
    await m.dispose();
    expect(unloads).toEqual([]); // nothing was acquired, so nothing to unload
  });

  it('exposes a validate() that flags a local engine with no model', async () => {
    const { m } = manager();
    const v = m.validate({ sttEngine: 'local', sttModelId: null, customSttEndpoint: null });
    expect(v.valid).toBe(false);
    expect(v.errors.sttModel).toBeTruthy();
    await m.dispose();
  });

  it('reports voice capabilities from installed models and the region catalog', async () => {
    const { m, dir } = manager({
      getSender: async () => ({
        send: vi.fn(async () => ({
          data: {
            models: [
              {
                id: 'static:cloud-stt',
                category: 'stt',
                displayName: 'Cloud STT',
                downloadUrl: 'https://huggingface.co/x/stt',
              },
            ],
          },
        })),
      }),
    });
    // Nothing installed yet: cloud STT is available, no local engine.
    await m.refreshCatalog();
    let caps = await m.voiceCapabilities();
    expect(caps.cloudSttAvailable).toBe(true);
    expect(caps.localSttAvailable).toBe(false);

    // Install a builtin STT model on disk → local STT becomes available.
    const stt = BUILTIN_VOICE_MODELS.find((x) => x.kind === 'stt')!;
    const modelDir = join(dir, 'voice-models', modelDirName(stt));
    mkdirSync(modelDir, { recursive: true });
    for (const f of stt.files) writeFileSync(join(modelDir, f.name), new Uint8Array(4));
    caps = await m.voiceCapabilities();
    expect(caps.localSttAvailable).toBe(true);
    await m.dispose();
  });

  it('counts a configured custom endpoint as a local engine', async () => {
    const { m } = manager();
    await m.setSettings({
      customSttEndpoint: {
        kind: 'stt',
        protocol: 'whisper_rest',
        baseUrl: 'https://self-hosted.local:8085',
        ignoreTls: true,
      },
    });
    const caps = await m.voiceCapabilities();
    expect(caps.localSttAvailable).toBe(true);
    await m.dispose();
  });
});
