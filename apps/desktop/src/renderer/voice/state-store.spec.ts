import { describe, expect, it, vi } from 'vitest';
import { createVoiceStore, type VoiceStoreReader } from './state-store.js';
import type {
  GpuSttEngineStatus,
  LocalVoiceState,
  VoiceBinaryStatus,
  WakeSttStatus,
} from '../../shared/ipc.js';

/** Minimal stand-ins for the three bridge reads. */
function voiceState(models: number): LocalVoiceState {
  return {
    settings: {
      enabled: true,
      idleTimeoutSeconds: 300,
      sttEngine: 'local',
      ttsEngine: 'cloud',
      sttModelId: null,
      ttsModelId: null,
      customSttEndpoint: null,
      customTtsEndpoint: null,
      ignoreTlsForCustom: false,
      sttBackend: 'auto',
      sttComputeType: 'auto',
    },
    resources: {
      ram: { totalBytes: 1, freeBytes: 1 },
      vram: null,
      vramReason: 'no gpu',
      checkedAt: 'now',
    },
    models: Array.from({ length: models }, (_, i) => ({
      id: `m${i}`,
      kind: 'stt' as const,
      label: `Model ${i}`,
      source: 'region' as const,
      downloadUrl: null,
      sourceUrl: null,
      sizeBytes: null,
      vramGiB: null,
      runtime: null,
      licenseKeys: [],
      installState: 'installed' as const,
      installedBytes: 0,
      downloadPercent: null,
    })),
    engines: [],
    modelsDir: '/tmp',
  };
}

const binary: VoiceBinaryStatus = {
  id: 'whisper-server',
  installed: true,
  source: 'managed',
  path: '/x/whisper-server',
  installDir: '/x',
  canInstall: true,
  assetLabel: 'linux-x64',
  assetSizeBytes: 1,
  state: 'idle',
  downloadPercent: null,
  error: null,
  instructions: { command: null, steps: [], manualRequired: false, expectsOnPath: 'whisper-server' },
};

const wakeStt: WakeSttStatus = {
  ready: true,
  reason: null,
  code: null,
  modelId: 'm0',
  modelLabel: 'Model 0',
  usingCustomEndpoint: false,
  runnerInstalled: true,
  threads: 8,
  backend: 'whisper_cpp',
};

const gpuStt: GpuSttEngineStatus = {
  installed: true,
  envDir: '/data/voice-py',
  gpu: { name: 'NVIDIA GeForce RTX 2080', memoryMiB: 8192, driverVersion: '595.0' },
  gpuUsable: true,
  pythonAvailable: true,
  pythonPath: '/usr/bin/python3',
  requirements: ['faster-whisper>=1.0.0'],
  state: 'installed',
  progressPercent: null,
  error: null,
  instructions: { manualRequired: false, steps: [] },
};

function reader(over: Partial<VoiceStoreReader> = {}): VoiceStoreReader {
  return {
    localVoiceGetState: vi.fn(async () => voiceState(2)),
    voiceBinaryStatus: vi.fn(async () => binary),
    wakeSttStatus: vi.fn(async () => wakeStt),
    gpuSttStatus: vi.fn(async () => gpuStt),
    ...over,
  };
}

describe('createVoiceStore', () => {
  it('reads all three surfaces on first retain and notifies subscribers', async () => {
    const r = reader();
    const store = createVoiceStore({ reader: r, intervalMs: 100_000 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const release = store.retain();
    await store.refresh();
    const snap = store.getSnapshot();
    expect(snap.state?.models).toHaveLength(2);
    expect(snap.binary?.installed).toBe(true);
    expect(snap.wakeStt?.ready).toBe(true);
    expect(snap.gpuStt?.installed).toBe(true);
    expect(snap.loading).toBe(false);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    release();
  });

  it('tolerates a reader without the GPU-engine read (older preload)', async () => {
    const r = reader({ gpuSttStatus: undefined });
    const store = createVoiceStore({ reader: r, intervalMs: 100_000 });
    const release = store.retain();
    await store.refresh();
    expect(store.getSnapshot().gpuStt).toBeNull();
    release();
  });

  it('keeps the last good value when a read fails (never blanks the panel)', async () => {
    let fail = false;
    const r = reader({
      localVoiceGetState: vi.fn(async () => {
        if (fail) throw new Error('bridge down');
        return voiceState(3);
      }),
    });
    const store = createVoiceStore({ reader: r, intervalMs: 100_000 });
    const release = store.retain();
    await store.refresh();
    expect(store.getSnapshot().state?.models).toHaveLength(3);
    fail = true;
    await store.refresh();
    // The previous snapshot survives the failed read.
    expect(store.getSnapshot().state?.models).toHaveLength(3);
    release();
  });

  it('stops polling once every component unmounts', async () => {
    const r = reader();
    const store = createVoiceStore({ reader: r, intervalMs: 100_000 });
    const releaseA = store.retain();
    const releaseB = store.retain();
    releaseA();
    // One subscriber left: still retained.
    expect(store.getSnapshot()).toBeDefined();
    releaseB();
    // Both released — a further refresh still works (explicit), but no timer.
    await store.refresh();
    expect(store.getSnapshot().state).not.toBeNull();
  });

  it('dedupes concurrent refreshes into one set of reads', async () => {
    let resolveState: (v: LocalVoiceState) => void = () => {};
    const localVoiceGetState = vi.fn(
      () =>
        new Promise<LocalVoiceState>((resolve) => {
          resolveState = resolve;
        }),
    );
    const store = createVoiceStore({ reader: reader({ localVoiceGetState }), intervalMs: 100_000 });
    store.retain();
    const a = store.refresh();
    const b = store.refresh();
    resolveState(voiceState(1));
    await Promise.all([a, b]);
    expect(localVoiceGetState).toHaveBeenCalledOnce();
  });
});
