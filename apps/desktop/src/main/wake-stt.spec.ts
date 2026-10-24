import { describe, expect, it, vi } from 'vitest';
import type { LocalVoiceModel } from '@nexus/local-voice';
import {
  encodeWav,
  isLocalWakeHost,
  createWakeStt,
  buildPhraseBiasPrompt,
  defaultWhisperThreads,
} from './wake-stt.js';

/** Minimal local-voice model row for the resolver. */
function sttModel(over: Partial<LocalVoiceModel> = {}): LocalVoiceModel {
  return {
    id: 'catalog:desktop/whisper-small-q5',
    kind: 'stt',
    source: 'region',
    label: 'Whisper Small',
    modelRef: 'edge/whisper-small',
    downloadUrl: 'https://example/whisper',
    sizeBytes: null,
    vramGiB: 0,
    runtime: 'whisper.cpp',
    files: [{ name: 'ggml-small.bin', url: 'https://example/ggml-small.bin', sizeBytes: null, sha256: null }],
    licenseKeys: [],
    sha256: null,
    ...over,
  } as LocalVoiceModel;
}

describe('encodeWav', () => {
  it('writes a RIFF/WAVE header with the PCM payload', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5]), 16_000);
    const view = new DataView(wav.buffer);
    const tag = (o: number) => String.fromCharCode(...new Uint8Array(wav.buffer, o, 4));
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(tag(36)).toBe('data');
    expect(view.getUint32(24, true)).toBe(16_000); // sample rate
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint16(34, true)).toBe(16); // bits
    // 44-byte header + 3 samples * 2 bytes.
    expect(wav.byteLength).toBe(44 + 6);
  });

  it('clamps samples into the 16-bit range', () => {
    const wav = encodeWav(new Float32Array([2, -2]), 16_000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32767);
  });
});

describe('defaultWhisperThreads', () => {
  it('scales to the core count (whisper.cpp would default to 4)', () => {
    expect(defaultWhisperThreads(8)).toBe(8);
    expect(defaultWhisperThreads(16)).toBe(16);
  });

  it('floors at 4 and caps at 16 so it never undersubscribes or floods', () => {
    expect(defaultWhisperThreads(2)).toBe(4);
    expect(defaultWhisperThreads(1)).toBe(4);
    expect(defaultWhisperThreads(64)).toBe(16);
    expect(defaultWhisperThreads(0)).toBe(4);
    expect(defaultWhisperThreads(Number.NaN)).toBe(4);
  });
});

describe('buildPhraseBiasPrompt', () => {
  it('builds a vocabulary hint from the armed phrases', () => {
    expect(buildPhraseBiasPrompt(['Nox', 'Razail'])).toBe('Vocabulary: Nox, Razail.');
  });

  it('de-duplicates case-insensitively and trims/collapses whitespace', () => {
    expect(buildPhraseBiasPrompt(['  Nox ', 'nox', 'B2B   Services'])).toBe(
      'Vocabulary: Nox, B2B Services.',
    );
  });

  it('returns null when there is nothing to bias toward', () => {
    expect(buildPhraseBiasPrompt([])).toBeNull();
    expect(buildPhraseBiasPrompt(['', '   '])).toBeNull();
  });
});

describe('isLocalWakeHost', () => {
  it('accepts loopback and private-network hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '10.0.0.5', '192.168.1.9', '172.16.4.2', 'my-box.local', 'whisperbox']) {
      expect(isLocalWakeHost(h)).toBe(true);
    }
  });

  it('refuses public / cloud hosts so a wake can never stream there', () => {
    for (const h of ['api.openai.com', '8.8.8.8', '172.32.0.1', 'example.com', '']) {
      expect(isLocalWakeHost(h)).toBe(false);
    }
  });
});

describe('createWakeStt', () => {
  it('is not ready with an honest reason when no model is installed', async () => {
    const stt = createWakeStt({
      modelsDir: () => '/tmp/none',
      customEndpoint: () => null,
      findModel: () => null,
      isInstalled: () => false,
      selectedModelId: () => null,
    });
    const status = await stt.status();
    expect(status.ready).toBe(false);
    expect(status.reason).toContain('Install a speech-to-text model');
  });

  it('refuses a non-local custom endpoint', async () => {
    const stt = createWakeStt({
      modelsDir: () => '/tmp/none',
      customEndpoint: () => ({
        kind: 'stt',
        protocol: 'openai_audio',
        baseUrl: 'https://api.example.com/v1',
        ignoreTls: false,
      }),
      findModel: () => null,
      isInstalled: () => false,
      selectedModelId: () => null,
    });
    const status = await stt.status();
    expect(status.ready).toBe(false);
    expect(status.reason).toContain('local');
  });

  it('transcribes through a local endpoint and unwraps {text}', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ text: 'hello bob' }),
    })) as unknown as typeof fetch;
    const stt = createWakeStt({
      modelsDir: () => '/tmp/none',
      customEndpoint: () => ({
        kind: 'stt',
        protocol: 'whisper_rest',
        baseUrl: 'http://127.0.0.1:9000',
        ignoreTls: false,
      }),
      findModel: () => null,
      isInstalled: () => false,
      selectedModelId: () => null,
      fetchFn,
    });
    const text = await stt.transcribe(new Float32Array([0.1, 0.2]), 16_000);
    expect(text).toBe('hello bob');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('returns null (never throws) when the server errors', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const stt = createWakeStt({
      modelsDir: () => '/tmp/none',
      customEndpoint: () => ({
        kind: 'stt',
        protocol: 'whisper_rest',
        baseUrl: 'http://127.0.0.1:9000',
        ignoreTls: false,
      }),
      findModel: () => null,
      isInstalled: () => false,
      selectedModelId: () => null,
      fetchFn,
    });
    expect(await stt.transcribe(new Float32Array([0.1]), 16_000)).toBeNull();
  });

  it('does not transcribe empty audio', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const stt = createWakeStt({
      modelsDir: () => '/tmp/none',
      customEndpoint: () => ({
        kind: 'stt',
        protocol: 'whisper_rest',
        baseUrl: 'http://127.0.0.1:9000',
        ignoreTls: false,
      }),
      findModel: () => null,
      isInstalled: () => false,
      selectedModelId: () => null,
      fetchFn,
    });
    expect(await stt.transcribe(new Float32Array(0), 16_000)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reports a runnable model as ready without spawning a server', async () => {
    const spawnFn = vi.fn();
    const model = sttModel();
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: (id) => id === model.id,
      selectedModelId: () => model.id,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      resolveBinary: () => 'whisper-server',
      fileExists: () => true,
      startDelayMs: 0,
      portInUse: async () => false,
    });
    const status = await stt.status();
    expect(status.ready).toBe(true);
    expect(status.code).toBeNull();
    expect(status.modelLabel).toBe('Whisper Small');
    // Crucial: merely checking readiness must not load the model into VRAM.
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('auto-selects any installed STT model when none is explicitly chosen', async () => {
    const model = sttModel({ id: 'catalog:desktop/whisper-large-v3-turbo-q5', label: 'Whisper Turbo' });
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: (id) => id === model.id,
      // The user never picked a model (the wake UI has no picker of its own).
      selectedModelId: () => null,
      listModels: () => [model],
      resolveBinary: () => 'whisper-server',
      fileExists: () => true,
      startDelayMs: 0,
      portInUse: async () => false,
    });
    const status = await stt.status();
    expect(status.ready).toBe(true);
    expect(status.modelId).toBe(model.id);
    expect(status.modelLabel).toBe('Whisper Turbo');
  });

  it('prefers the smallest installed STT model so the wake stays near-realtime', async () => {
    const turbo = sttModel({
      id: 'catalog:desktop/whisper-large-v3-turbo-q5',
      label: 'Whisper Turbo',
      sizeBytes: 574_041_195,
    });
    const tiny = sttModel({
      id: 'catalog:desktop/whisper-tiny-q5',
      label: 'Whisper Tiny',
      sizeBytes: 32_152_673,
    });
    const installed = new Set([turbo.id, tiny.id]);
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => [turbo, tiny].find((m) => m.id === id) ?? null,
      isInstalled: (id) => installed.has(id),
      // The user picked the big dictation model explicitly — wake must NOT honour
      // it, or a CPU-only box waits ~30s per phrase.
      selectedModelId: () => turbo.id,
      listModels: () => [turbo, tiny],
      resolveBinary: () => 'whisper-server',
      fileExists: () => true,
      portInUse: async () => false,
    });
    const status = await stt.status();
    expect(status.modelId).toBe(tiny.id);
    expect(status.modelLabel).toBe('Whisper Tiny');
  });

  it('spawns the app-managed runner resolved through binaryResolver (no PATH install)', async () => {
    const spawnFn = vi.fn((_command: string, _args: string[]) => ({
      on: vi.fn(),
      kill: vi.fn(),
    }));
    const fetchFn = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ text: 'managed' }),
    })) as unknown as typeof fetch;
    const model = sttModel();
    const managed = '/home/u/.config/nexus/voice-bin/whisper-server/whisper-bin-ubuntu-x64/whisper-server';
    let bound = false;
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: (id) => id === model.id,
      selectedModelId: () => model.id,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      // No PATH install: the app-managed copy is the only way to run.
      binaryResolver: () => managed,
      fileExists: () => true,
      startDelayMs: 0,
      portInUse: async () => bound,
      fetchFn,
    });
    expect((await stt.status()).ready).toBe(true);
    // Transcription spawns on demand; simulate the process binding its port.
    setTimeout(() => {
      bound = true;
    }, 0);
    expect(await stt.transcribe(new Float32Array([0.2]), 16_000)).toBe('managed');
    expect(spawnFn).toHaveBeenCalledOnce();
    // The concrete managed path is what got spawned — not the bare name.
    expect(spawnFn.mock.calls[0]![0]).toBe(managed);
    stt.dispose();
  });

  it('spawns with tuned threads and a wake-phrase bias prompt', async () => {
    const spawnFn = vi.fn((_command: string, _args: string[]) => ({
      on: vi.fn(),
      kill: vi.fn(),
    }));
    const fetchFn = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ text: 'biased' }),
    })) as unknown as typeof fetch;
    const model = sttModel();
    let bound = false;
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: (id) => id === model.id,
      selectedModelId: () => model.id,
      threads: 12,
      wakePhrases: () => ['Nox', 'Razail'],
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      resolveBinary: () => 'whisper-server',
      fileExists: () => true,
      startDelayMs: 0,
      portInUse: async () => bound,
      fetchFn,
    });
    setTimeout(() => {
      bound = true;
    }, 0);
    expect(await stt.transcribe(new Float32Array([0.2]), 16_000)).toBe('biased');
    const args = spawnFn.mock.calls[0]![1] as string[];
    // Whisper's 4-thread default idled most of the CPU; we scale it up.
    expect(args).toContain('-t');
    expect(args[args.indexOf('-t') + 1]).toBe('12');
    // The armed phrases become the decoder's vocabulary hint.
    expect(args).toContain('--prompt');
    expect(args[args.indexOf('--prompt') + 1]).toContain('Nox');
    stt.dispose();
  });

  it('reports the tuned thread count in status', async () => {
    const model = sttModel();
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: (id) => id === model.id,
      selectedModelId: () => model.id,
      threads: 6,
    });
    expect((await stt.status()).threads).toBe(6);
  });

  it('bias-tunes each request too, covering a server we did not spawn', async () => {
    const model = sttModel();
    let captured: FormData | null = null;
    const fetchFn = vi.fn(async (_url: string, init: { body: FormData }) => {
      captured = init.body;
      return { ok: true, text: async () => JSON.stringify({ text: 'biased' }) };
    }) as unknown as typeof fetch;
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: (id) => id === model.id,
      selectedModelId: () => model.id,
      wakePhrases: () => ['Selene'],
      // Already serving (e.g. the local-voice lifecycle started it): no spawn.
      spawnFn: vi.fn() as unknown as typeof import('node:child_process').spawn,
      fileExists: () => true,
      portInUse: async () => true,
      fetchFn,
    });
    await stt.transcribe(new Float32Array([0.2]), 16_000);
    expect(captured).not.toBeNull();
    expect((captured as unknown as FormData).get('prompt')).toContain('Selene');
  });

  it('reuses a server already listening on the port instead of spawning a second', async () => {
    const spawnFn = vi.fn();
    const fetchFn = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ text: 'reused' }),
    })) as unknown as typeof fetch;
    const model = sttModel();
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: (id) => id === model.id,
      selectedModelId: () => model.id,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      resolveBinary: () => 'whisper-server',
      fileExists: () => true,
      startDelayMs: 0,
      portInUse: async () => true,
      fetchFn,
    });
    expect((await stt.status()).ready).toBe(true);
    expect(await stt.transcribe(new Float32Array([0.2]), 16_000)).toBe('reused');
    expect(spawnFn).not.toHaveBeenCalled();
    // Dispose must not kill a server it did not own.
    stt.dispose();
  });

  it('reports not-ready when the installed model file is missing', async () => {
    const model = sttModel();
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: () => true,
      selectedModelId: () => model.id,
      listModels: () => [model],
      resolveBinary: () => 'whisper-server',
      // The model file is gone: readiness must not claim the wake will work.
      fileExists: () => false,
      startDelayMs: 0,
      portInUse: async () => false,
    });
    const status = await stt.status();
    expect(status.ready).toBe(false);
    expect(status.code).toBe('no_model');
    expect(status.reason).toContain('reinstall');
    // And the actual transcription fails honestly (no server, no text).
    expect(await stt.transcribe(new Float32Array([0.1]), 16_000)).toBeNull();
  });

  it('distinguishes a missing runner from a missing model', async () => {
    const model = sttModel();
    // Model present, but no runnable binary anywhere.
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: () => true,
      selectedModelId: () => model.id,
      listModels: () => [model],
      resolveBinary: () => null,
      runnerInstalled: () => false,
      fileExists: () => true,
      portInUse: async () => false,
    });
    const status = await stt.status();
    expect(status.ready).toBe(false);
    expect(status.code).toBe('no_runner');
    expect(status.reason).toContain('runner');
    expect(status.runnerInstalled).toBe(false);
    // The model is still reported, so the UI can name it.
    expect(status.modelId).toBe(model.id);
  });

  it('reports no_model with a null model when nothing is installed', async () => {
    const stt = createWakeStt({
      modelsDir: () => '/tmp/none',
      customEndpoint: () => null,
      findModel: () => null,
      isInstalled: () => false,
      selectedModelId: () => null,
      listModels: () => [],
    });
    const status = await stt.status();
    expect(status.code).toBe('no_model');
    expect(status.modelId).toBeNull();
    expect(status.modelLabel).toBeNull();
    expect(status.usingCustomEndpoint).toBe(false);
  });

  it('flags a non-local custom endpoint as cloud_refused', async () => {
    const stt = createWakeStt({
      modelsDir: () => '/tmp/none',
      customEndpoint: () => ({
        kind: 'stt',
        protocol: 'openai_audio',
        baseUrl: 'https://api.example.com/v1',
        ignoreTls: false,
      }),
      findModel: () => null,
      isInstalled: () => false,
      selectedModelId: () => null,
    });
    const status = await stt.status();
    expect(status.code).toBe('cloud_refused');
    expect(status.usingCustomEndpoint).toBe(true);
  });
});
