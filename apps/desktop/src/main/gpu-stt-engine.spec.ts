import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createGpuSttEngine, type GpuSttEngineOptions } from './gpu-stt-engine.js';

/** A fake child process good enough for `run`/`spawn` bookkeeping. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 1234;
  return child;
}

type RunResult = { code: number | null; stdout: string; stderr: string };

/** Build an engine with all side effects faked; returns the captured calls. */
function makeEngine(overrides: Partial<GpuSttEngineOptions> = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawned: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const existing = new Set<string>();
  const responses: Array<(command: string, args: string[]) => RunResult> = [];

  const runCommand = vi.fn(async (command: string, args: string[]) => {
    calls.push({ command, args });
    for (const responder of responses) {
      const res = responder(command, args);
      if (res) return res;
    }
    // Default: succeed with empty output.
    return { code: 0, stdout: '', stderr: '' };
  });

  const spawnFn = vi.fn((command: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    spawned.push({ command, args, env: opts?.env });
    return fakeChild() as never;
  });

  const engine = createGpuSttEngine({
    dataDir: '/data',
    scriptPath: '/data/local-stt-server.py',
    fileExists: (p) => existing.has(p),
    whichFn: (cmd) => (cmd === 'python3' ? '/usr/bin/python3' : null),
    runCommand: runCommand as never,
    spawnFn: spawnFn as never,
    platform: 'linux',
    ...overrides,
  });

  return { engine, calls, spawned, existing, responses, runCommand, spawnFn };
}

describe('createGpuSttEngine — detection and status', () => {
  it('reports missing with a clear "no Python" instruction', async () => {
    const { engine } = makeEngine({
      whichFn: () => null,
      scriptCandidates: ['/data/local-stt-server.py'],
    });
    const status = await engine.status();
    expect(status.installed).toBe(false);
    expect(status.state).toBe('missing');
    expect(status.pythonAvailable).toBe(false);
  });

  it('detects the NVIDIA GPU and marks it usable', async () => {
    const { engine } = makeEngine({
      scriptCandidates: ['/data/local-stt-server.py'],
      whichFn: (cmd) => (cmd === 'python3' ? '/usr/bin/python3' : '/usr/bin/nvidia-smi'),
      runCommand: (async (_c: string, args: string[]) => {
        if (args[0]?.startsWith('--query-gpu')) {
          return { code: 0, stdout: 'NVIDIA GeForce RTX 2080, 8192, 595.99\n', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      }) as never,
    });
    const gpu = await engine.gpu();
    expect(gpu?.name).toBe('NVIDIA GeForce RTX 2080');
    const status = await engine.status();
    expect(status.gpuUsable).toBe(true);
    expect(status.requirements).toContain('nvidia-cudnn-cu12>=9.0.0');
  });

  it('treats a tiny GPU as unusable (keeps whisper.cpp)', async () => {
    const { engine } = makeEngine({
      scriptCandidates: ['/data/local-stt-server.py'],
      whichFn: (cmd) => (cmd === 'python3' ? '/usr/bin/python3' : '/usr/bin/nvidia-smi'),
      runCommand: (async (_c: string, args: string[]) => {
        if (args[0]?.startsWith('--query-gpu')) {
          return { code: 0, stdout: 'NVIDIA GeForce GT 710, 1024, 595.0\n', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      }) as never,
    });
    expect((await engine.status()).gpuUsable).toBe(false);
  });

  it('is installed only when both the venv interpreter and the script exist', async () => {
    const { engine } = makeEngine();
    expect(await engine.status()).toMatchObject({ installed: false, state: 'missing' });

    const withFiles = makeEngine();
    withFiles.existing.add('/data/voice-py/bin/python');
    withFiles.existing.add('/data/local-stt-server.py');
    const status = await withFiles.engine.status();
    expect(status.installed).toBe(true);
    expect(status.state).toBe('installed');
  });

  it('resolves the script from the candidate list (packaged layout)', async () => {
    const { engine, existing } = makeEngine({
      scriptPath: '/nope/local-stt-server.py',
      scriptCandidates: ['/nope/local-stt-server.py', '/resources/local-stt-server.py'],
    });
    existing.add('/resources/local-stt-server.py');
    existing.add('/data/voice-py/bin/python');
    expect((await engine.status()).installed).toBe(true);
  });
});

describe('createGpuSttEngine — install', () => {
  it('creates the venv, pip-installs, and verifies the import', async () => {
    const { engine, calls, existing, responses } = makeEngine();
    existing.add('/data/local-stt-server.py');
    // Creating the venv materialises its interpreter on disk, exactly as the real
    // `python -m venv` does.
    responses.push((_c, args) => {
      if (args.includes('venv')) existing.add('/data/voice-py/bin/python');
      return null as never;
    });
    const res = await engine.install();
    const commands = calls.map((c) => c.args.join(' '));
    // 1) venv creation from the system python.
    expect(commands.some((c) => c.startsWith('-m venv /data/voice-py'))).toBe(true);
    // 2) pip install against the venv interpreter.
    expect(commands.some((c) => c.includes('-m pip install --upgrade pip'))).toBe(true);
    expect(commands.some((c) => c.includes('faster-whisper>=1.0.0'))).toBe(true);
    // 3) import verification.
    expect(commands.some((c) => c.includes('import faster_whisper, ctranslate2'))).toBe(true);
    expect(res.state).toBe('installed');
    expect(res.error).toBeNull();
  });

  it('surfaces a pip failure with the stderr excerpt', async () => {
    const { engine, existing, responses } = makeEngine();
    existing.add('/data/local-stt-server.py');
    responses.push((_c, args) => {
      if (args.includes('venv')) existing.add('/data/voice-py/bin/python');
      return null as never;
    });
    responses.push((_c, args) =>
      args.includes('install') && args.some((a) => a.includes('faster-whisper'))
        ? { code: 1, stdout: '', stderr: 'ERROR: No matching distribution found' }
        : (null as never),
    );
    const res = await engine.install();
    expect(res.state).toBe('error');
    expect(res.error).toContain('pip install failed');
    expect(res.error).toContain('No matching distribution');
  });

  it('fails fast without Python', async () => {
    const { engine, existing } = makeEngine({ whichFn: () => null });
    existing.add('/data/local-stt-server.py');
    const res = await engine.install();
    expect(res.state).toBe('error');
    expect(res.error).toContain('Python 3 was not found');
  });

  it('fails when the script is missing rather than half-installing', async () => {
    const { engine, calls } = makeEngine();
    const res = await engine.install();
    expect(res.state).toBe('error');
    expect(res.error).toContain('server script is missing');
    expect(calls).toHaveLength(0);
  });

  it('cancelInstall aborts the in-flight pip step', async () => {
    const { engine, existing, runCommand, responses } = makeEngine();
    existing.add('/data/local-stt-server.py');
    responses.push((_c, args) => {
      if (args.includes('venv')) existing.add('/data/voice-py/bin/python');
      return null as never;
    });
    let capturedSignal: AbortSignal | undefined;
    (runCommand as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation(
      async (_c: string, args: string[], opts?: { signal?: AbortSignal }) => {
        if (args.includes('venv')) {
          existing.add('/data/voice-py/bin/python');
          return { code: 0, stdout: '', stderr: '' };
        }
        if (args.some((a) => a.includes('faster-whisper'))) {
          capturedSignal = opts?.signal;
          // Simulate the abort terminating the pip step.
          await new Promise((r) => setTimeout(r, 5));
          return { code: 143, stdout: '', stderr: 'terminated' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    );
    const installing = engine.install();
    engine.cancelInstall();
    const res = await installing;
    expect(capturedSignal).toBeDefined();
    // The aborted pip step returns a non-zero code, which surfaces as an error.
    expect(res.state).toBe('error');
  });
});

describe('createGpuSttEngine — spawnServer', () => {
  function installedEngine(overrides: Partial<GpuSttEngineOptions> = {}) {
    const ctx = makeEngine(overrides);
    ctx.existing.add('/data/local-stt-server.py');
    ctx.existing.add('/data/voice-py/bin/python');
    return ctx;
  }

  it('spawns the venv python with the mapped CTranslate2 model + CUDA env', async () => {
    const ctx = installedEngine({
      whichFn: (cmd) => (cmd === 'python3' ? '/usr/bin/python3' : '/usr/bin/nvidia-smi'),
      runCommand: (async (_c: string, args: string[]) =>
        args[0]?.startsWith('--query-gpu')
          ? { code: 0, stdout: 'NVIDIA GeForce RTX 2080, 8192, 595\n', stderr: '' }
          : { code: 0, stdout: '', stderr: '' }) as never,
    });
    await ctx.engine.gpu(); // warm the probe cache
    const proc = ctx.engine.spawnServer({ ggmlFileName: 'ggml-base-q5_1.bin', port: 8085 });
    expect(proc).not.toBeNull();
    const [call] = ctx.spawned;
    expect(call.command).toBe('/data/voice-py/bin/python');
    expect(call.args).toContain('--model');
    expect(call.args[call.args.indexOf('--model') + 1]).toBe('Systran/faster-whisper-base');
    expect(call.args[call.args.indexOf('--device') + 1]).toBe('cuda');
    expect(call.args[call.args.indexOf('--compute-type') + 1]).toBe('float16');
    // The venv nests site-packages under the interpreter version; the discovered
    // path must be used, not the old (non-existent) `lib/site-packages`.
    expect(call.env?.LD_LIBRARY_PATH).toContain(
      '/data/voice-py/lib/python3.12/site-packages/nvidia/cublas/lib',
    );
    expect(call.env?.LD_LIBRARY_PATH).not.toContain('/data/voice-py/lib/site-packages');
  });

  it('discovers the real versioned site-packages for LD_LIBRARY_PATH', async () => {
    const ctx = makeEngine({
      fileExists: (p) =>
        p === '/data/local-stt-server.py' ||
        p === '/data/voice-py/bin/python' ||
        p === '/data/voice-py/lib/python3.11/site-packages',
      readDir: () => ['python3.11'],
      whichFn: (cmd: string) => (cmd === 'python3' ? '/usr/bin/python3' : '/usr/bin/nvidia-smi'),
      runCommand: (async (_c: string, args: string[]) =>
        args[0]?.startsWith('--query-gpu')
          ? { code: 0, stdout: 'NVIDIA GeForce RTX 2080, 8192, 555.1', stderr: '' }
          : { code: 0, stdout: '', stderr: '' }) as never,
    });
    await ctx.engine.gpu();
    ctx.engine.spawnServer({ ggmlFileName: 'ggml-tiny-q5_1.bin', port: 8085 });
    const [call] = ctx.spawned;
    expect(call.env?.LD_LIBRARY_PATH).toContain(
      '/data/voice-py/lib/python3.11/site-packages/nvidia/cublas/lib',
    );
  });

  it('adds the phrase-bias hotwords (never an initial prompt)', async () => {
    const ctx = installedEngine();
    ctx.engine.spawnServer({
      ggmlFileName: 'ggml-tiny-q5_1.bin',
      port: 8085,
      hotwords: 'Nox, Razail',
    });
    const [call] = ctx.spawned;
    expect(call.args[call.args.indexOf('--hotwords') + 1]).toBe('Nox, Razail');
    // An initial prompt leaks into short transcripts, so it must never be used.
    expect(call.args).not.toContain('--initial-prompt');
  });

  it('omits hotwords when the phrase list is empty', async () => {
    const ctx = installedEngine();
    ctx.engine.spawnServer({ ggmlFileName: 'ggml-tiny-q5_1.bin', port: 8085, hotwords: '   ' });
    const [call] = ctx.spawned;
    expect(call.args).not.toContain('--hotwords');
  });

  it('falls back to CPU when no GPU is present', async () => {
    const ctx = installedEngine({ whichFn: (cmd) => (cmd === 'python3' ? '/usr/bin/python3' : null) });
    await ctx.engine.gpu(); // no nvidia-smi → null
    ctx.engine.spawnServer({ ggmlFileName: 'ggml-tiny-q5_1.bin', port: 8085 });
    const [call] = ctx.spawned;
    expect(call.args[call.args.indexOf('--device') + 1]).toBe('cpu');
    expect(call.args[call.args.indexOf('--compute-type') + 1]).toBe('int8');
  });

  it('refuses to spawn when the engine is not installed', async () => {
    const ctx = makeEngine();
    ctx.existing.add('/data/local-stt-server.py');
    expect(ctx.engine.spawnServer({ ggmlFileName: 'ggml-base-q5_1.bin', port: 8085 })).toBeNull();
  });

  it('refuses to spawn for an unmappable GGML family', async () => {
    const ctx = installedEngine();
    expect(ctx.engine.spawnServer({ ggmlFileName: 'ggml-weird-model.bin', port: 8085 })).toBeNull();
  });
});

describe('createGpuSttEngine — remove', () => {
  it('reports missing after removal', async () => {
    const { engine, existing } = makeEngine();
    existing.add('/data/local-stt-server.py');
    existing.add('/data/voice-py/bin/python');
    const res = engine.remove();
    expect(res.installed).toBe(false);
    expect(res.state).toBe('missing');
  });
});
