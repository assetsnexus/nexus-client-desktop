import { describe, expect, it, vi } from 'vitest';
import { FASTER_WHISPER_DEFAULT_PORT, type LocalVoiceModel } from '@nexus/local-voice';
import {
  encodeWav,
  isLocalWakeHost,
  isSttServerServing,
  probeSttHealth,
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
  it('builds a bare comma list from the armed phrases (no leak-prone framing)', () => {
    expect(buildPhraseBiasPrompt(['Nox', 'Razail'])).toBe('Nox, Razail');
  });

  it('de-duplicates case-insensitively and trims/collapses whitespace', () => {
    expect(buildPhraseBiasPrompt(['  Nox ', 'nox', 'B2B   Services'])).toBe('Nox, B2B Services');
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

describe('isSttServerServing', () => {
  const json = (body: unknown, ok = true) => ({
    ok,
    text: async () => JSON.stringify(body),
  });

  it('accepts our whisper.cpp / faster-whisper health shape', async () => {
    const fetchFn = vi.fn(async () => json({ status: 'ok' })) as unknown as typeof fetch;
    expect(await isSttServerServing(18085, fetchFn)).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:18085/health', expect.anything());
  });

  it('rejects a foreign service that only happens to hold the port (InfluxDB /health)', async () => {
    // InfluxDB answers /health with a different shape; a bare TCP connect would
    // have wrongly adopted it as our STT server.
    const fetchFn = vi.fn(async () =>
      json({ name: 'influxdb', message: 'ready for queries and writes', status: 'pass' }),
    ) as unknown as typeof fetch;
    expect(await isSttServerServing(8086, fetchFn)).toBe(false);
  });

  it('rejects a non-JSON / non-ok response and a failed fetch', async () => {
    const html = vi.fn(async () => ({ ok: true, text: async () => '<html>hi</html>' })) as unknown as typeof fetch;
    expect(await isSttServerServing(8086, html)).toBe(false);
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await isSttServerServing(8086, down)).toBe(false);
  });

  it('still recognises a server whose engine failed to load (so the reason can be read)', async () => {
    // A bound port with a broken engine is *ours* — it must be recognised so the
    // app can surface the error, while `probeSttHealth` reports it is not ready.
    const fetchFn = vi.fn(async () =>
      json({ status: 'ok', ready: false, error: 'RuntimeError: Library libcublas.so.12 is not found' }),
    ) as unknown as typeof fetch;
    expect(await isSttServerServing(18085, fetchFn)).toBe(true);
    const health = await probeSttHealth(18085, fetchFn);
    expect(health).toMatchObject({
      serving: true,
      ready: false,
      error: expect.stringContaining('libcublas.so.12'),
    });
  });

  it('treats a server without a `ready` field as ready (whisper.cpp contract)', async () => {
    const fetchFn = vi.fn(async () => json({ status: 'ok' })) as unknown as typeof fetch;
    expect(await probeSttHealth(8085, fetchFn)).toMatchObject({ serving: true, ready: true, error: null });
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

describe('createWakeStt — faster-whisper GPU engine', () => {
  const GPU_PORT = FASTER_WHISPER_DEFAULT_PORT;

  function gpuRunner(over: Partial<Parameters<typeof createWakeStt>[0]['gpuRunner']> = {}) {
    return {
      port: GPU_PORT,
      isInstalled: vi.fn(async () => true),
      preferred: vi.fn(async () => true),
      spawn: vi.fn(() => ({ on: vi.fn(), kill: vi.fn() })),
      ...over,
    } as unknown as NonNullable<Parameters<typeof createWakeStt>[0]['gpuRunner']>;
  }

  it('reports the GPU backend in status without spawning anything', async () => {
    const model = sttModel();
    const runner = gpuRunner();
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: (id) => id === model.id,
      selectedModelId: () => model.id,
      listModels: () => [model],
      fileExists: () => true,
      portInUse: async () => false,
      gpuRunner: runner,
      gpuPort: GPU_PORT,
    });
    const status = await stt.status();
    expect(status.ready).toBe(true);
    expect(status.backend).toBe('faster_whisper');
    expect(runner.spawn).not.toHaveBeenCalled();
  });

  it('serves the wake from the GPU server (its own port) when preferred', async () => {
    const model = sttModel();
    let gpuBound = false;
    const runner = gpuRunner();
    const fetchFn = vi.fn(async (url: string) => ({
      ok: true,
      text: async () => JSON.stringify({ text: url.includes(String(GPU_PORT)) ? 'gpu' : 'cpu' }),
    })) as unknown as typeof fetch;
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: (id) => id === model.id,
      selectedModelId: () => model.id,
      listModels: () => [model],
      fileExists: () => true,
      startDelayMs: 0,
      // Only the GPU port is bound; the CPU port is free.
      portInUse: async (p) => (p === GPU_PORT ? gpuBound : false),
      fetchFn,
      gpuRunner: runner,
      gpuPort: GPU_PORT,
    });
    setTimeout(() => {
      gpuBound = true;
    }, 0);
    expect(await stt.transcribe(new Float32Array([0.3]), 16_000)).toBe('gpu');
    // The GPU runner was asked to spawn (phrase hotwords included), never the
    // whisper.cpp binary.
    expect(runner.spawn).toHaveBeenCalledOnce();
    const spawnArg = (runner.spawn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      ggmlFileName: string | null;
      port: number;
      hotwords: string | null;
    };
    expect(spawnArg.port).toBe(GPU_PORT);
    expect(spawnArg.ggmlFileName).toBe('ggml-small.bin');
    stt.dispose();
  });

  it('does not adopt a GPU server whose engine failed to load, and reports why', async () => {
    // The regression: the port answered `/health` "ok" while the engine could not
    // dlopen libcublas, so every transcription 500'd and the wake silently showed
    // nothing. A serving-but-not-ready engine must be rejected with its reason.
    const model = sttModel();
    const runner = gpuRunner();
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/health')) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              status: 'ok',
              ready: false,
              error: 'RuntimeError: Library libcublas.so.12 is not found or cannot be loaded',
            }),
        };
      }
      return { ok: false, status: 500, text: async () => JSON.stringify({ error: 'should not be called' }) };
    }) as unknown as typeof fetch;
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: (id) => id === model.id,
      selectedModelId: () => model.id,
      listModels: () => [model],
      resolveBinary: () => 'whisper-server',
      fileExists: () => true,
      startDelayMs: 0,
      // Both ports report as bound so the HTTP probe decides.
      portInUse: async () => false,
      fetchFn,
      gpuRunner: runner,
      gpuPort: GPU_PORT,
      spawnFn: vi.fn(() => ({ on: vi.fn(), kill: vi.fn() })) as unknown as typeof import('node:child_process').spawn,
    });
    expect(await stt.transcribe(new Float32Array([0.3]), 16_000)).toBeNull();
    // The engine's own error is surfaced, not swallowed into "nothing was said".
    expect(stt.lastError()).toContain('libcublas.so.12');
  });

  it('surfaces an HTTP error body from the speech server instead of a bare null', async () => {
    const model = sttModel();
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/health')) {
        return { ok: true, text: async () => JSON.stringify({ status: 'ok' }) };
      }
      return {
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: 'RuntimeError: Library libcublas.so.12 is not found' }),
      };
    }) as unknown as typeof fetch;
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: (id) => id === model.id,
      selectedModelId: () => model.id,
      listModels: () => [model],
      fileExists: () => true,
      portInUse: async () => true,
      fetchFn,
    });
    expect(await stt.transcribe(new Float32Array([0.3]), 16_000)).toBeNull();
    expect(stt.lastError()).toContain('libcublas.so.12');
  });

  it('waits for a still-loading GPU engine instead of giving up after a fixed sleep', async () => {
    const model = sttModel();
    const runner = gpuRunner();
    let ready = false;
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/health')) {
        // Bound, still importing the model: `ready` false with no error yet.
        return { ok: true, text: async () => JSON.stringify({ status: 'ok', ready }) };
      }
      return { ok: true, text: async () => JSON.stringify({ text: 'gpu-loaded' }) };
    }) as unknown as typeof fetch;
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: (id) => id === model.id,
      selectedModelId: () => model.id,
      listModels: () => [model],
      fileExists: () => true,
      startDelayMs: 0,
      portInUse: async (p) => p === GPU_PORT,
      fetchFn,
      gpuRunner: runner,
      gpuPort: GPU_PORT,
    });
    // The engine finishes loading shortly after the spawn.
    setTimeout(() => {
      ready = true;
    }, 120);
    expect(await stt.transcribe(new Float32Array([0.3]), 16_000)).toBe('gpu-loaded');
    expect(stt.lastError()).toBeNull();
    stt.dispose();
  });

  it('falls back to whisper.cpp when the GPU engine is not preferred', async () => {
    const model = sttModel();
    const spawnFn = vi.fn(() => ({ on: vi.fn(), kill: vi.fn() }));
    let cpuBound = false;
    const runner = gpuRunner({ preferred: vi.fn(async () => false) });
    const fetchFn = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ text: 'cpu' }) })) as unknown as typeof fetch;
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: (id) => id === model.id,
      selectedModelId: () => model.id,
      listModels: () => [model],
      resolveBinary: () => 'whisper-server',
      fileExists: () => true,
      startDelayMs: 0,
      portInUse: async (p) => (p === 8085 ? cpuBound : false),
      fetchFn,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      gpuRunner: runner,
      gpuPort: GPU_PORT,
    });
    setTimeout(() => {
      cpuBound = true;
    }, 0);
    expect(await stt.transcribe(new Float32Array([0.3]), 16_000)).toBe('cpu');
    expect(runner.spawn).not.toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledOnce();
    expect((await stt.status()).backend).toBe('whisper_cpp');
    stt.dispose();
  });

  it('falls back to whisper.cpp when the GPU server fails to start', async () => {
    const model = sttModel();
    const spawnFn = vi.fn(() => ({ on: vi.fn(), kill: vi.fn() }));
    const urls: string[] = [];
    // Preferred, but spawn returns null (engine vanished between checks).
    const runner = gpuRunner({ spawn: vi.fn(() => null) });
    const fetchFn = vi.fn(async (url: string) => {
      urls.push(url);
      return { ok: true, text: async () => JSON.stringify({ text: 'cpu' }) };
    }) as unknown as typeof fetch;
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: (id) => id === model.id,
      selectedModelId: () => model.id,
      listModels: () => [model],
      resolveBinary: () => 'whisper-server',
      fileExists: () => true,
      startDelayMs: 0,
      // The CPU port is already serving (e.g. the lifecycle started it); the GPU
      // port never comes up.
      portInUse: async (p) => p === 8085,
      fetchFn,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      gpuRunner: runner,
      gpuPort: GPU_PORT,
    });
    expect(await stt.transcribe(new Float32Array([0.3]), 16_000)).toBe('cpu');
    // The GPU engine was tried first, then the CPU server answered instead.
    expect(runner.spawn).toHaveBeenCalledOnce();
    expect(urls[0]).toContain('8085');
    expect(urls[0]).not.toContain(String(GPU_PORT));
    stt.dispose();
  });

  it('ignores the GPU engine for a custom local endpoint (backend=custom)', async () => {
    const runner = gpuRunner();
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
      gpuRunner: runner,
      gpuPort: GPU_PORT,
    });
    expect((await stt.status()).backend).toBe('custom');
    expect(runner.spawn).not.toHaveBeenCalled();
  });

  it('reuses an already-ready GPU server instead of spawning a second', async () => {
    const model = sttModel();
    const runner = gpuRunner();
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes('/health')) {
        return { ok: true, text: async () => JSON.stringify({ status: 'ok', ready: true, device: 'cuda' }) };
      }
      return { ok: true, text: async () => JSON.stringify({ text: 'reused-gpu' }) };
    }) as unknown as typeof fetch;
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: (id) => id === model.id,
      selectedModelId: () => model.id,
      listModels: () => [model],
      fileExists: () => true,
      startDelayMs: 0,
      // No TCP shortcut: the HTTP health probe decides whether to reuse.
      fetchFn,
      gpuRunner: runner,
      gpuPort: GPU_PORT,
    });
    expect(await stt.transcribe(new Float32Array([0.3]), 16_000)).toBe('reused-gpu');
    // A healthy engine already on the port is adopted: no second spawn, and the
    // transcription went to the GPU port.
    expect(runner.spawn).not.toHaveBeenCalled();
    expect(urls.some((u) => u.includes(String(GPU_PORT)) && u.includes('/inference'))).toBe(true);
    stt.dispose();
  });

  it('does not adopt an already-bound GPU server whose engine failed to load', async () => {
    // The reuse path used to accept any server whose port answered, so a broken
    // engine (CUDA libraries unreachable) was adopted and every transcription
    // 500'd with no explanation. It must be refused, its error surfaced, and the
    // CPU engine used instead.
    const model = sttModel();
    const runner = gpuRunner();
    const fetchFn = vi.fn(async (url: string) => {
      const onGpu = url.includes(String(GPU_PORT));
      if (url.includes('/health')) {
        // Only the GPU engine is broken; the CPU fallback port is healthy.
        return {
          ok: true,
          text: async () =>
            JSON.stringify(
              onGpu
                ? {
                    status: 'ok',
                    ready: false,
                    error: 'RuntimeError: Library libcublas.so.12 is not found or cannot be loaded',
                  }
                : { status: 'ok' },
            ),
        };
      }
      if (onGpu) {
        return { ok: false, status: 500, text: async () => JSON.stringify({ error: 'broken gpu' }) };
      }
      return { ok: true, text: async () => JSON.stringify({ text: 'cpu-fallback' }) };
    }) as unknown as typeof fetch;
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: (id) => id === model.id,
      selectedModelId: () => model.id,
      listModels: () => [model],
      resolveBinary: () => 'whisper-server',
      fileExists: () => true,
      startDelayMs: 0,
      // No TCP shortcut: the HTTP health probe must reject the broken GPU engine.
      fetchFn,
      gpuRunner: runner,
      gpuPort: GPU_PORT,
    });
    expect(await stt.transcribe(new Float32Array([0.3]), 16_000)).toBe('cpu-fallback');
    expect(stt.lastError()).toBeNull();
    stt.dispose();
  });

  it('does not let a throwing GPU runner break readiness', async () => {
    const model = sttModel();
    const runner = gpuRunner({
      isInstalled: vi.fn(async () => {
        throw new Error('probe failed');
      }),
    });
    const stt = createWakeStt({
      modelsDir: () => '/tmp/wake-stt',
      customEndpoint: () => null,
      findModel: (id) => (id === model.id ? model : null),
      isInstalled: (id) => id === model.id,
      selectedModelId: () => model.id,
      listModels: () => [model],
      resolveBinary: () => 'whisper-server',
      fileExists: () => true,
      portInUse: async () => false,
      gpuRunner: runner,
      gpuPort: GPU_PORT,
    });
    const status = await stt.status();
    expect(status.ready).toBe(true);
    expect(status.backend).toBe('whisper_cpp');
  });
});
