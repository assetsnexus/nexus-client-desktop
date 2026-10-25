/**
 * faster-whisper GPU STT engine (main process).
 *
 * The on-device wake / dictation path can be served two ways: whisper.cpp
 * (`whisper-server`, CPU-only in the Linux builds upstream ships) or
 * **faster-whisper**, the CTranslate2 runtime that runs Whisper on an NVIDIA GPU.
 * On a mid-range GPU the same model that takes ~30s on CPU finishes in a few
 * hundred milliseconds — effectively realtime — which is the whole point of this
 * module.
 *
 * faster-whisper is a Python library, not a single executable, so this module
 * owns the extra machinery a Python engine needs: probing for `nvidia-smi` and a
 * `python3`, creating a virtualenv under the app data dir, pip-installing the
 * runtime (plus the two NVIDIA CUDA pip packages, because a driver alone is not
 * enough), and spawning the shipped `local-stt-server.py` with the right
 * `LD_LIBRARY_PATH` so CTranslate2 can find `libcublas`/`libcudnn`.
 *
 * The server speaks whisper.cpp's `/inference` contract, so the wake + dictation
 * clients do not care which engine answered.
 *
 * All the decisions (paths, requirement list, GGML→CTranslate2 mapping, GPU
 * parsing) live in `@nexus/local-voice`'s pure `gpu-engine` module; this file is
 * only the side-effecting half, behind an injectable `run`/`spawn` so tests never
 * create a venv, run pip, or touch a GPU.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  composeLibraryPath,
  fasterWhisperEnvPlan,
  fasterWhisperModelFor,
  fasterWhisperServerArgs,
  parseGpuInfo,
  pipInstallArgs,
  requirementSpecs,
  resolveComputeType,
  shouldUseGpu,
  venvCreateArgs,
  type ComputeType,
  type GpuEngineStatus,
  type GpuInfo,
  type PythonEnvPlan,
} from '@nexus/local-voice';
import { whichOnPath } from './voice-binaries.js';

export type GpuSttEngineOptions = {
  /** App data directory the venv + models live under. */
  dataDir: string;
  /**
   * Absolute path to the shipped `local-stt-server.py`. Callers resolve it from
   * the several places it can live (dev checkout vs. packaged resources).
   */
  scriptPath: string;
  /**
   * Candidate paths for the script, tried in order, so a single option covers
   * both the dev layout and a packaged app without the caller guessing.
   */
  scriptCandidates?: string[];
  /** Python interpreter to build the venv from (default `python3`). */
  pythonCommand?: string;
  /** Compute-type preference; `auto` picks float16 on GPU, int8 on CPU. */
  computeType?: ComputeType;
  /** Force the GPU path on/off (tests / an explicit user override). */
  includeGpu?: boolean;
  /** Absolute path to `nvidia-smi`, when already resolved. */
  nvidiaSmiPath?: string | null;
  /** File existence check; overridable for tests. */
  fileExists?: (path: string) => boolean;
  /** `nvidia-smi` runner; overridable for tests. Never throws. */
  runNvidiaSmi?: () => Promise<string | null>;
  /** PATH lookup override (tests). */
  whichFn?: (command: string) => string | null;
  /** Run a command to completion (venv/pip); injected in tests. */
  runCommand?: (command: string, args: string[], opts?: { signal?: AbortSignal }) => Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>;
  /** Spawn override (tests). */
  spawnFn?: typeof spawn;
  platform?: NodeJS.Platform;
};

export type GpuSttEngine = {
  /** Live status for the settings UI (never throws, never installs anything). */
  status: () => Promise<GpuEngineStatus>;
  /** True once the venv interpreter exists and the server imports cleanly. */
  isInstalled: () => Promise<boolean>;
  /** Create the venv + pip-install; resolves with the new status. */
  install: () => Promise<GpuEngineStatus>;
  /** Abort an in-flight install. */
  cancelInstall: () => void;
  /** Delete the venv to reclaim disk. */
  remove: () => GpuEngineStatus;
  /**
   * Spawn the Python server for a whisper.cpp GGML model on `port`, returning the
   * child process. Null when the engine is not installed or the model cannot be
   * mapped. Caller owns the process and must kill it.
   */
  spawnServer: (input: {
    ggmlFileName: string | null;
    port: number;
    /** Phrase bias (armed agent names); sent to the server as `--hotwords`. */
    hotwords?: string | null;
    language?: string | null;
  }) => ChildProcess | null;
  /** The environment plan (venv paths, requirements) — exposed for the UI/tests. */
  envPlan: () => PythonEnvPlan;
  /** The detected GPU, or null (cached after the first probe). */
  gpu: () => Promise<GpuInfo | null>;
  dispose: () => void;
};

/** Default `nvidia-smi` probe: name, VRAM, driver. Never throws. */
async function defaultGpuProbe(
  command: string,
  run: NonNullable<GpuSttEngineOptions['runCommand']>,
): Promise<GpuInfo | null> {
  try {
    const res = await run(command, [
      '--query-gpu=name,memory.total,driver_version',
      '--format=csv,noheader,nounits',
    ]);
    if (res.code !== 0) return null;
    return parseGpuInfo(res.stdout);
  } catch {
    return null;
  }
}

export function createGpuSttEngine(options: GpuSttEngineOptions): GpuSttEngine {
  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? existsSync;
  const spawnFn = options.spawnFn ?? spawn;
  const computePreference = options.computeType ?? 'auto';
  const venvAbort = { current: null as AbortController | null };

  let installState: GpuEngineStatus['state'] = 'missing';
  let progressPercent: number | null = null;
  let lastError: string | null = null;
  let cachedGpu: GpuInfo | null | undefined;
  let cachedScript: string | null | undefined;

  const plan = fasterWhisperEnvPlan({
    dataDir: options.dataDir,
    includeGpu: options.includeGpu ?? true,
    platform,
    ...(options.pythonCommand ? { pythonCommand: options.pythonCommand } : {}),
  });

  /** Resolve the shipped server script from the candidate list. */
  function scriptPath(): string | null {
    if (cachedScript !== undefined) return cachedScript;
    const candidates = [
      options.scriptPath,
      ...(options.scriptCandidates ?? []),
    ].filter((p): p is string => typeof p === 'string' && p.length > 0);
    cachedScript = candidates.find((p) => fileExists(p)) ?? null;
    return cachedScript;
  }

  /** Locate a Python 3 interpreter to build the venv from. */
  function pythonInterpreter(): string | null {
    const which = options.whichFn ?? ((cmd: string) => whichOnPath(cmd, process.env, platform, fileExists));
    const cmd = plan.pythonCommand;
    // An explicit absolute path is trusted (the user configured it); a bare name
    // is resolved on PATH.
    if (isAbsolute(cmd)) return fileExists(cmd) ? cmd : null;
    return which(cmd) ?? which('python');
  }

  /** Resolve `nvidia-smi` on PATH (or the configured absolute path). */
  function nvidiaSmiPath(): string | null {
    if (options.nvidiaSmiPath !== undefined) return options.nvidiaSmiPath;
    const which = options.whichFn ?? ((cmd: string) => whichOnPath(cmd, process.env, platform, fileExists));
    return which('nvidia-smi');
  }

  const defaultRun: NonNullable<GpuSttEngineOptions['runCommand']> = (command, args, opts) =>
    new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawnFn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
        return;
      }
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => (stdout += String(d)));
      child.stderr?.on('data', (d) => (stderr += String(d)));
      const onAbort = () => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      };
      opts?.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (err) => resolve({ code: null, stdout, stderr: stderr + String(err) }));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

  const run = options.runCommand ?? defaultRun;

  async function gpu(): Promise<GpuInfo | null> {
    if (cachedGpu !== undefined) return cachedGpu;
    const smi = nvidiaSmiPath();
    if (!smi) {
      cachedGpu = null;
      return null;
    }
    cachedGpu = await defaultGpuProbe(smi, run);
    return cachedGpu;
  }

  /** The venv interpreter exists and imports faster-whisper. */
  async function verifyInstall(): Promise<boolean> {
    if (!fileExists(plan.venvPython)) return false;
    const res = await run(plan.venvPython, ['-c', 'import faster_whisper, ctranslate2']);
    return res.code === 0;
  }

  async function status(): Promise<GpuEngineStatus> {
    const gpuInfo = await gpu();
    const usable = shouldUseGpu(gpuInfo);
    const python = pythonInterpreter();
    const script = scriptPath();
    const installed = script !== null && fileExists(plan.venvPython);
    // A completed install that has lost its interpreter (user deleted the dir)
    // must read as missing, not as a stale "installed".
    const state: GpuEngineStatus['state'] =
      installState === 'installing' || installState === 'error'
        ? installState
        : installed
          ? 'installed'
          : 'missing';
    const manualRequired = !python || script === null;
    const steps: string[] = [];
    if (!usable) {
      steps.push(
        'No usable NVIDIA GPU was detected — the whisper.cpp (CPU) engine will be used instead.',
      );
    }
    if (!python) {
      steps.push(
        `Install Python 3 (the \`${plan.pythonCommand}\` command was not found), then press Install.`,
      );
    }
    if (script === null) {
      steps.push('The bundled speech server script could not be found (reinstall the app).');
    }
    if (usable && python) {
      steps.push(
        'Press Install: the app creates a private Python environment under its data folder and installs faster-whisper + the NVIDIA CUDA libraries.',
      );
      steps.push('Nothing is installed system-wide and no administrator rights are required.');
    }
    return {
      installed: state === 'installed',
      envDir: plan.envDir,
      gpu: gpuInfo,
      gpuUsable: usable,
      pythonAvailable: python !== null,
      pythonPath: python,
      requirements: requirementSpecs(options.includeGpu ?? true),
      state,
      progressPercent: state === 'installing' ? progressPercent : null,
      error: lastError,
      instructions: { manualRequired, steps },
    };
  }

  async function isInstalled(): Promise<boolean> {
    if (scriptPath() === null) return false;
    if (!fileExists(plan.venvPython)) return false;
    // Cheap path check first; the import check is expensive, so it only runs when
    // the interpreter exists but the caller needs a definitive answer.
    return verifyInstall();
  }

  async function install(): Promise<GpuEngineStatus> {
    if (installState === 'installing') return status();
    const python = pythonInterpreter();
    if (!python) {
      installState = 'error';
      lastError = `Python 3 was not found (\`${plan.pythonCommand}\`). Install it, then retry.`;
      return status();
    }
    if (scriptPath() === null) {
      installState = 'error';
      lastError = 'The bundled speech server script is missing.';
      return status();
    }
    const controller = new AbortController();
    venvAbort.current = controller;
    lastError = null;
    progressPercent = 0;
    installState = 'installing';
    try {
      // 1) Create the virtualenv (skip when one already exists — pip re-run is
      //    cheap and idempotent, but `venv` over an existing dir is not needed).
      if (!fileExists(plan.venvPython)) {
        const created = await run(python, venvCreateArgs(plan), { signal: controller.signal });
        if (created.code !== 0) {
          throw new Error(
            `Could not create the Python environment: ${(created.stderr || created.stdout).trim().slice(0, 300)}`,
          );
        }
      }
      progressPercent = 20;
      // 2) Install the requirements with pip.
      const installed = await run(plan.venvPython, pipInstallArgs(plan), { signal: controller.signal });
      if (installed.code !== 0) {
        throw new Error(
          `pip install failed: ${(installed.stderr || installed.stdout).trim().slice(0, 300)}`,
        );
      }
      progressPercent = 90;
      // 3) Verify the runtime imports (catches a wheel that installed but cannot
      //    load, e.g. a missing CUDA library).
      const verified = await run(plan.venvPython, ['-c', 'import faster_whisper, ctranslate2']);
      if (verified.code !== 0) {
        throw new Error(
          `The runtime installed but could not be imported: ${(verified.stderr || verified.stdout).trim().slice(0, 300)}`,
        );
      }
      progressPercent = 100;
      installState = 'installed';
    } catch (err) {
      installState = 'error';
      lastError = err instanceof Error ? err.message : 'Install failed.';
    } finally {
      venvAbort.current = null;
    }
    const result = await status();
    // Keep the error surfaced even though `status()` reports the derived state.
    if (installState === 'error') return { ...result, state: 'error', error: lastError };
    return result;
  }

  function spawnServer(input: {
    ggmlFileName: string | null;
    port: number;
    hotwords?: string | null;
    language?: string | null;
  }): ChildProcess | null {
    const script = scriptPath();
    if (!script) return null;
    if (!fileExists(plan.venvPython)) return null;
    // `hotwords` is a biasing hint; drop it when empty. `input.hotwords` may be a
    // string for symmetry, but the caller passes null when there are no phrases.
    const hotwords = input.hotwords?.trim() ? input.hotwords : null;
    const model = fasterWhisperModelFor(input.ggmlFileName);
    if (!model) return null;
    // The GPU verdict is read from the probe cache: callers await `gpu()` during
    // status/readiness before spawning, so the cache is warm by spawn time.
    const useGpu = shouldUseGpu(cachedGpu ?? null);
    const computeType = resolveComputeType(computePreference, useGpu);
    // Build the command line from the pure, unit-tested builder so the exact
    // decode policy — model mapping, hotwords bias, and the no-speech /
    // VAD gating that stops a silent source from being decoded into phantom
    // wake names — lives in one place and cannot drift.
    const args = fasterWhisperServerArgs({
      scriptPath: script,
      model,
      host: '127.0.0.1',
      port: input.port,
      inferencePath: '/inference',
      device: useGpu ? 'cuda' : 'cpu',
      computeType,
      beamSize: 1,
      language: input.language ?? null,
      hotwords,
    });
    // CTranslate2 loads CUDA via `dlopen`, and the pip `nvidia-*` wheels live
    // outside the default search path, so prepend them for the child only.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (useGpu && plan.libraryPaths.length) {
      env.LD_LIBRARY_PATH = composeLibraryPath(plan.libraryPaths, process.env.LD_LIBRARY_PATH);
    }
    try {
      return spawnFn(plan.venvPython, args, { stdio: 'ignore', detached: false, env });
    } catch {
      return null;
    }
  }

  return {
    status,
    isInstalled,
    install,
    cancelInstall() {
      venvAbort.current?.abort();
      venvAbort.current = null;
      if (installState === 'installing') {
        installState = 'missing';
        progressPercent = null;
      }
    },
    remove() {
      try {
        rmSync(plan.envDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      installState = 'missing';
      progressPercent = null;
      lastError = null;
      // Synchronous status is fine here: nothing else changed, and the caller
      // re-reads via `status()` for the full picture.
      return {
        installed: false,
        envDir: plan.envDir,
        gpu: cachedGpu ?? null,
        gpuUsable: shouldUseGpu(cachedGpu ?? null),
        pythonAvailable: pythonInterpreter() !== null,
        pythonPath: pythonInterpreter(),
        requirements: requirementSpecs(options.includeGpu ?? true),
        state: 'missing',
        progressPercent: null,
        error: null,
        instructions: { manualRequired: false, steps: [] },
      };
    },
    spawnServer,
    envPlan: () => plan,
    gpu,
    dispose() {
      venvAbort.current?.abort();
      venvAbort.current = null;
    },
  };
}
