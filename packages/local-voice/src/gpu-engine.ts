/**
 * Local GPU STT engine plan (@nexus/local-voice).
 *
 * The on-device STT path has two possible engines:
 *
 *  1. **whisper.cpp** (`whisper-server`) — a self-contained binary, CPU-only in
 *     the builds upstream publishes for Linux. On a big model it takes tens of
 *     seconds per utterance, which is why local speech "feels broken".
 *  2. **faster-whisper** — the CTranslate2 runtime, which runs on an NVIDIA GPU
 *     via CUDA. The same model that takes ~30s on CPU finishes in a few hundred
 *     milliseconds on a mid-range GPU, i.e. effectively realtime. It needs a
 *     Python interpreter plus a small set of pip packages, which is why it cannot
 *     be a single downloadable executable.
 *
 * This module is the **pure, dependency-free plan** for engine (2): where the
 * Python environment lives, which pip packages it needs, how a whisper.cpp GGML
 * model maps onto an equivalent CTranslate2 model, and how to read the machine's
 * GPU from `nvidia-smi`. The main process performs the side effects (creating
 * the venv, pip-installing, spawning) by consuming this plan; keeping the
 * decisions here makes them unit-testable without a GPU, Python, or the network.
 *
 * Contract note: the faster-whisper server we ship speaks whisper.cpp's
 * `/inference` HTTP contract (`multipart/form-data` with a `file` field, response
 * `{"text": "…"}`), so the wake + dictation paths talk to either engine with the
 * exact same client code and get per-request phrase biasing for free.
 */

/** Which runtime serves on-device speech-to-text. */
export type SttBackend = 'auto' | 'whisper_cpp' | 'faster_whisper';

export const STT_BACKENDS: SttBackend[] = ['auto', 'whisper_cpp', 'faster_whisper'];

export const STT_BACKEND_LABELS: Record<SttBackend, string> = {
  auto: 'Automatic (prefer GPU when available)',
  whisper_cpp: 'whisper.cpp (CPU)',
  faster_whisper: 'faster-whisper (NVIDIA GPU)',
};

/** Compute precision hint for CTranslate2 (`--compute-type`). */
export type ComputeType = 'auto' | 'float16' | 'int8_float16' | 'int8' | 'float32';

export const COMPUTE_TYPES: ComputeType[] = ['auto', 'float16', 'int8_float16', 'int8', 'float32'];

/**
 * CPU fallback precision. CTranslate2's `int8` is the fastest, most portable CPU
 * mode; it is what makes the Python engine a reasonable choice even without a
 * GPU.
 */
export const CPU_COMPUTE_TYPE: ComputeType = 'int8';

/** GPU paddings, kept pragmatic: mid-range cards want float16, small ones int8. */
export const GPU_COMPUTE_TYPE: ComputeType = 'float16';

/** One Python package the engine needs, with a version floor. */
export type PythonRequirement = {
  /** pip distribution name. */
  name: string;
  /** Minimum version (pip specifier `>=`), or null for "latest". */
  minVersion: string | null;
  /** True when it is only needed for NVIDIA GPU inference. */
  gpuOnly: boolean;
};

/**
 * The core requirements: the runtime + the two NVIDIA CUDA libraries it loads at
 * import time. `nvidia-cublas-cu12` / `nvidia-cudnn-cu12` are what make CUDA work
 * on a machine that has a driver but not a system-wide CUDA toolkit — exactly the
 * common case (a gaming/desktop NVIDIA box), and the reason GPU inference fails
 * with `libcublas.so.12 not found` otherwise.
 */
export const FASTER_WHISPER_REQUIREMENTS: PythonRequirement[] = [
  { name: 'faster-whisper', minVersion: '1.0.0', gpuOnly: false },
  { name: 'ctranslate2', minVersion: '4.0.0', gpuOnly: false },
  { name: 'numpy', minVersion: '1.24.0', gpuOnly: false },
  { name: 'nvidia-cublas-cu12', minVersion: null, gpuOnly: true },
  { name: 'nvidia-cudnn-cu12', minVersion: '9.0.0', gpuOnly: true },
];

/** Build the `pip install` argument list for the given target. */
export function requirementSpecs(includeGpu: boolean): string[] {
  return FASTER_WHISPER_REQUIREMENTS.filter((r) => includeGpu || !r.gpuOnly).map((r) =>
    r.minVersion ? `${r.name}>=${r.minVersion}` : r.name,
  );
}

/** Parsed `nvidia-smi` facts. */
export type GpuInfo = {
  /** Marketing name, e.g. `NVIDIA GeForce RTX 2080`. */
  name: string;
  /** Total VRAM in MiB. */
  memoryMiB: number;
  /** Driver version reported by `nvidia-smi`. */
  driverVersion: string | null;
};

/**
 * Parse the CSV emitted by
 * `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits`.
 * The first GPU wins (multi-GPU selection is a later concern). Returns null when
 * the output is empty or unparseable, so callers treat "no GPU" honestly.
 */
export function parseGpuInfo(csv: string | null | undefined): GpuInfo | null {
  const line = (csv ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const parts = line.split(',').map((p) => p.trim());
  const name = parts[0] ?? '';
  if (!name) return null;
  const memoryMiB = Number(parts[1]);
  return {
    name,
    memoryMiB: Number.isFinite(memoryMiB) ? memoryMiB : 0,
    driverVersion: parts[2] && parts[2] !== '[N/A]' ? parts[2] : null,
  };
}

/**
 * VRAM below this is not worth the CUDA path for a large model — int8 on CPU, or
 * a smaller model, is steadier than thrashing a tiny GPU.
 */
export const MIN_USEFUL_VRAM_MIB = 2048;

/**
 * Decide whether a detected GPU is worth using. An NVIDIA card with a driver and
 * at least {@link MIN_USEFUL_VRAM_MIB} of VRAM qualifies. Anything else keeps the
 * whisper.cpp CPU path.
 */
export function shouldUseGpu(gpu: GpuInfo | null): boolean {
  if (!gpu) return false;
  return gpu.memoryMiB >= MIN_USEFUL_VRAM_MIB;
}

/** The device arg passed to the server (`cuda` / `cpu`). */
export function cudaDeviceArg(useGpu: boolean): 'cuda' | 'cpu' {
  return useGpu ? 'cuda' : 'cpu';
}

/** Resolve a concrete compute type from the hint + whether a GPU is in play. */
export function resolveComputeType(preference: ComputeType, useGpu: boolean): ComputeType {
  if (preference !== 'auto') return preference;
  return useGpu ? GPU_COMPUTE_TYPE : CPU_COMPUTE_TYPE;
}

/**
 * faster-whisper resolves a bare name (`base`, `large-v3-turbo`) to the official
 * `Systran/faster-whisper-*` repo. Some models the region catalog offers only
 * exist as a community CTranslate2 conversion, so the mapping is explicit.
 */
export const FASTER_WHISPER_MODELS: Record<string, string> = {
  tiny: 'Systran/faster-whisper-tiny',
  base: 'Systran/faster-whisper-base',
  small: 'Systran/faster-whisper-small',
  medium: 'Systran/faster-whisper-medium',
  'large-v1': 'Systran/faster-whisper-large-v1',
  'large-v2': 'Systran/faster-whisper-large-v2',
  'large-v3': 'Systran/faster-whisper-large-v3',
  'large-v3-turbo': 'deepdml/faster-whisper-large-v3-turbo-ct2',
};

/**
 * Map an installed whisper.cpp GGML model file (`ggml-<name>-<quant>.bin`) onto a
 * faster-whisper model name, so the same model the user already downloaded is
 * reused on the GPU instead of forcing a second, differently-sized download.
 * The quantization suffix is irrelevant (CTranslate2 re-quantizes on load).
 * Returns null when the family cannot be determined.
 */
export function ggmlModelFamily(fileName: string | null | undefined): string | null {
  const base = (fileName ?? '').trim().toLowerCase().replace(/\.bin$/, '');
  if (!base) return null;
  // Strip the leading `ggml-`, then the quantization suffix. The suffix is what
  // identifies it as a whisper.cpp build; its exact form (`-q5_0`, `-q5_1`,
  // `-f16`) must not change the family we map to.
  const family = base
    .replace(/^ggml-/, '')
    .replace(/(-|_)(q\d+(_\d+)?|f16|fp16)$/, '')
    .trim();
  return family || null;
}

/** Resolve the CTranslate2/`faster-whisper` model name for a GGML file, if any. */
export function fasterWhisperModelFor(fileName: string | null | undefined): string | null {
  const family = ggmlModelFamily(fileName);
  if (!family) return null;
  return FASTER_WHISPER_MODELS[family] ?? null;
}

/** Everything the main process needs to create + use the Python environment. */
export type PythonEnvPlan = {
  /** Python interpreter to seed the venv with (`python3` by default). */
  pythonCommand: string;
  /** Where the virtualenv + server script live (under the app data dir). */
  envDir: string;
  /** The venv interpreter the engine runs (`<envDir>/bin/python`). */
  venvPython: string;
  /**
   * Venv `lib/`, the parent of the versioned `site-packages` directory. Kept so
   * callers can enumerate it at runtime: the exact site-packages name embeds the
   * interpreter's minor version (`lib/python3.12/site-packages`), which cannot be
   * known at plan time because the venv may be created by a different Python.
   */
  libDir: string;
  /**
   * The site-packages directory for the *seeding* interpreter. A best-effort
   * default: the real directory is discovered at runtime under {@link libDir},
   * so a Python minor-version mismatch cannot silently point at a non-existent
   * path (which would drop the CUDA libraries from `LD_LIBRARY_PATH`).
   */
  sitePackages: string;
  /** pip requirement specifiers to install. */
  requirements: string[];
  /**
   * Directories that must be prepended to `LD_LIBRARY_PATH` for CUDA libs, under
   * the plan-time site-packages. The spawner prefers the runtime-discovered
   * site-packages when the venv already exists.
   */
  libraryPaths: string[];
};

export type PythonEnvPlanInput = {
  /** App data directory the env is created under. */
  dataDir: string;
  /** Interpreter to build the venv from. */
  pythonCommand?: string;
  /** True when NVIDIA CUDA libraries should be installed too. */
  includeGpu: boolean;
  /** `posix` (Linux/macOS) or `win32` layout for `bin` vs `Scripts`. */
  platform?: NodeJS.Platform;
  /**
   * The venv interpreter's `major.minor` (e.g. `3.12`) when already known. Used
   * to name the site-packages directory before the venv exists; afterwards the
   * real directory is discovered on disk, so this is only a starting guess.
   */
  pythonVersion?: string;
  /** File-existence probe for discovering the versioned site-packages dir. */
  exists?: (path: string) => boolean;
  /** Directory listing probe for the same discovery (injected for tests). */
  readdir?: (path: string) => string[];
};

/**
 * The CUDA library sub-paths the pip `nvidia-*` wheels install, relative to a
 * site-packages directory. CTranslate2 `dlopen`s these by soname, so each lib
 * directory must be on `LD_LIBRARY_PATH` (or preloaded — see the server script).
 */
export const CUDA_LIBRARY_SUBDIRS: readonly string[] = [
  'nvidia/cublas/lib',
  'nvidia/cudnn/lib',
  'nvidia/cuda_nvrtc/lib',
];

/**
 * Resolve the CUDA library directories to add to `LD_LIBRARY_PATH` from the
 * *actual* site-packages directory of an existing venv.
 *
 * A POSIX venv stores packages under `lib/python<major>.<minor>/site-packages`.
 * The previous plan hardcoded `lib/site-packages`, which does not exist in a real
 * venv, so the CUDA directories were never found and every GPU transcription
 * failed with `libcublas.so.12 is not found` — while `/health` still said "ok".
 * This enumerates the versioned directories so the right one is used regardless
 * of which Python created the venv; the first match wins (there is normally one).
 *
 * `exists` and `readdir` are injectable so this stays unit-testable without a
 * filesystem.
 */
export function resolveSitePackages(
  libDir: string,
  deps: {
    exists?: (path: string) => boolean;
    readdir?: (path: string) => string[];
  } = {},
): string | null {
  const exists = deps.exists ?? (() => false);
  const readdir = deps.readdir ?? (() => []);
  // Fast path: some layouts (and the tests) put site-packages directly under lib/.
  const flat = `${libDir}/site-packages`;
  if (exists(flat)) return flat;
  let entries: string[] = [];
  try {
    entries = readdir(libDir);
  } catch {
    return null;
  }
  // `python3.12`, `python3.13`, … highest version wins if several exist.
  const versioned = entries
    .filter((name) => /^python\d+\.\d+$/.test(name))
    .sort((a, b) => {
      const [am, an] = a.slice('python'.length).split('.').map(Number);
      const [bm, bn] = b.slice('python'.length).split('.').map(Number);
      return (bm ?? 0) - (am ?? 0) || (bn ?? 0) - (an ?? 0);
    });
  for (const name of versioned) {
    const candidate = `${libDir}/${name}/site-packages`;
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** The CUDA lib dirs under a concrete site-packages directory. */
export function cudaLibraryPathsFor(sitePackages: string): string[] {
  return CUDA_LIBRARY_SUBDIRS.map((sub) => `${sitePackages}/${sub}`);
}

/**
 * The running Node/Electron build's Python version, when it reports one. Node does
 * not embed Python, so this is normally absent; the helper exists so the plan has
 * a single place to consult and tests can substitute a known version.
 */
export function systemPythonVersion(): string {
  const fromEnv = process.env.NEXUS_PYTHON_VERSION?.trim();
  if (fromEnv) return fromEnv;
  return '3.12';
}

/** Build the virtualenv/pip plan for the faster-whisper engine. */
export function fasterWhisperEnvPlan(input: PythonEnvPlanInput): PythonEnvPlan {
  const platform = input.platform ?? process.platform;
  const envDir = `${input.dataDir.replace(/[/\\]+$/, '')}/voice-py`;
  // POSIX venvs put the interpreter in `bin/`, Windows in `Scripts/`. The engine
  // is primarily a Linux/NVIDIA story, but the layout is platform-correct anyway.
  const bin = platform === 'win32' ? 'Scripts' : 'bin';
  const pythonExe = platform === 'win32' ? 'python.exe' : 'python';
  // POSIX venvs nest packages under a *versioned* directory
  // (`lib/python3.12/site-packages`), never directly under `lib/`. Hardcoding
  // `lib/site-packages` put a non-existent path on `LD_LIBRARY_PATH`, so
  // CTranslate2 could not dlopen libcublas and every GPU transcription failed.
  // Prefer a directory that actually exists on disk; otherwise fall back to the
  // caller's known interpreter version, then to the system Python's version.
  const libDir = `${envDir}/lib`;
  const discovered = resolveSitePackages(libDir, input);
  const pyVersion = input.pythonVersion?.trim() || systemPythonVersion();
  const sitePackages = discovered ?? `${libDir}/python${pyVersion}/site-packages`;
  return {
    pythonCommand: input.pythonCommand ?? 'python3',
    envDir,
    venvPython: `${envDir}/${bin}/${pythonExe}`,
    libDir,
    sitePackages,
    requirements: requirementSpecs(input.includeGpu),
    libraryPaths: input.includeGpu ? cudaLibraryPathsFor(sitePackages) : [],
  };
}

/** Arguments to create the virtualenv (`<python> -m venv <envDir>`). */
export function venvCreateArgs(plan: PythonEnvPlan): string[] {
  return ['-m', 'venv', plan.envDir];
}

/** Arguments to install the requirements (`<venvPython> -m pip install …`). */
export function pipInstallArgs(plan: PythonEnvPlan): string[] {
  return ['-m', 'pip', 'install', '--upgrade', 'pip', ...plan.requirements];
}

/**
 * Compose `LD_LIBRARY_PATH` so CTranslate2 finds the pip-installed CUDA
 * libraries. `existing` is preserved verbatim after ours; an absent value yields
 * just the pip paths.
 */
export function composeLibraryPath(
  libraryPaths: readonly string[],
  existing: string | undefined,
): string {
  const parts = [...libraryPaths, ...(existing ?? '').split(':').filter(Boolean)];
  return parts.join(':');
}

/**
 * The default loopback port for the faster-whisper (GPU) server. Chosen high and
 * deliberately clear of `8080`–`8090`, which common dev services squat on (e.g.
 * InfluxDB defaults to `8086`); a stolen port would make the GPU engine look
 * "already serving" and silently fall back to CPU.
 */
export const FASTER_WHISPER_DEFAULT_PORT = 18085;

/**
 * Default no-speech gate for the wake path. faster-whisper's own default (0.6)
 * is too permissive once the decoder is biased toward the armed wake phrases:
 * on silence it still produced a phantom name (`Vylaar.`) that would fire a
 * wake. Real speech scores ~0.01 and silence >0.4, so 0.4 clears the
 * hallucination with a wide margin. Kept here (not only in the Python server) so
 * the exact spawn command line is unit-tested.
 */
export const DEFAULT_NO_SPEECH_THRESHOLD = 0.4;

/** How the server is launched (matches whisper.cpp's `/inference` contract). */
export type FasterWhisperServerArgsInput = {
  /** Path to the shipped server script (`.py`). */
  scriptPath: string;
  /** Model name or absolute model directory. */
  model: string;
  host: string;
  port: number;
  /** HTTP path the server answers transcription on (default `/inference`). */
  inferencePath: string;
  device: 'cuda' | 'cpu';
  computeType: ComputeType;
  beamSize: number;
  /**
   * Optional phrase bias — the armed agent names. Passed as faster-whisper's
   * `hotwords`, **not** as an `initial_prompt`: an initial prompt is prepended to
   * the decoder's context and leaks into short transcripts (a greeting uttered
   * right after would be transcribed as the vocabulary line), whereas hotwords
   * only re-weight tokens.
   */
  hotwords?: string | null;
  language?: string | null;
  /**
   * No-speech gate for the decoder (faster-whisper `no_speech_threshold`).
   * faster-whisper defaults to 0.6, which is too permissive for the wake path:
   * with hotwords bias, silence still decoded into a phantom agent name (a real
   * room/monitor source that goes silent produces exactly this). Real speech
   * scores ~0.01, silence >0.4, so 0.4 drops the hallucination without touching
   * real utterances. Omitted = the server default (see `local-stt-server.py`).
   */
  noSpeechThreshold?: number;
  /** Skip the decoder's temperature-fallback sampling (default: 0, deterministic). */
  temperature?: number;
  /** Enable the silero VAD filter (default: true) for the wake path. */
  vadFilter?: boolean;
};

/**
 * Server CLI args. Mirrors the flat flags `local-stt-server.py` accepts; kept
 * here so the exact command line is testable without spawning anything.
 */
export function fasterWhisperServerArgs(input: FasterWhisperServerArgsInput): string[] {
  const args = [
    '-u',
    input.scriptPath,
    '--model',
    input.model,
    '--host',
    input.host,
    '--port',
    String(input.port),
    '--inference-path',
    input.inferencePath,
    '--device',
    input.device,
    '--compute-type',
    input.computeType,
    '--beam-size',
    String(input.beamSize),
  ];
  if (input.language) args.push('--language', input.language);
  // `--hotwords` (not `--initial-prompt`): biases toward the agent names without
  // priming the decoder's transcript context. See `FasterWhisperServerArgsInput`.
  if (input.hotwords) args.push('--hotwords', input.hotwords);
  // No-speech gating for the wake path. Passed explicitly (not left to the
  // Python default) so the anti-hallucination policy is visible in the exact
  // command line and covered by `fasterWhisperServerArgs` unit tests.
  const noSpeech = input.noSpeechThreshold ?? DEFAULT_NO_SPEECH_THRESHOLD;
  args.push('--no-speech-threshold', String(noSpeech));
  args.push('--temperature', String(input.temperature ?? 0));
  // Never let a silent span reach the decoder: silero VAD drops it. On by default
  // for the wake path; a caller must opt out explicitly.
  if ((input.vadFilter ?? true) === false) args.push('--no-vad-filter');
  return args;
}

/** Live installation state of the Python environment, for the settings UI. */
export type GpuEngineInstallState = 'missing' | 'installing' | 'installed' | 'error';

export type GpuEngineStatus = {
  /** True when the venv interpreter + a server script exist and import cleanly. */
  installed: boolean;
  /** Directory the environment lives in (shown for transparency). */
  envDir: string;
  /** The NVIDIA GPU that would be used, or null when none was detected. */
  gpu: GpuInfo | null;
  /** True when the GPU is usable for inference (VRAM floor met). */
  gpuUsable: boolean;
  /** True when a `python3` interpreter was found to build the venv from. */
  pythonAvailable: boolean;
  /** Interpreter path/name used, when found. */
  pythonPath: string | null;
  /** pip requirement specifiers that will be installed. */
  requirements: string[];
  /** Live install progress. */
  state: GpuEngineInstallState;
  /** 0..100 while installing, else null. */
  progressPercent: number | null;
  /** Last install/verify error, human-safe. */
  error: string | null;
  /** Honest steps when a one-click install is impossible (e.g. no Python). */
  instructions: {
    manualRequired: boolean;
    steps: string[];
  };
};

/**
 * Whether the faster-whisper engine should be chosen. `auto` prefers the GPU
 * engine whenever the environment is installed and a usable GPU exists, and
 * otherwise keeps whisper.cpp. An explicit choice is honoured as long as the
 * engine can actually run, so a user who picked GPU on a box whose GPU probe
 * failed is never silently sent back to CPU without a reason.
 */
export function pickSttBackend(input: {
  preference: SttBackend;
  gpuInstalled: boolean;
  gpuUsable: boolean;
}): 'whisper_cpp' | 'faster_whisper' {
  const gpuReady = input.gpuInstalled && input.gpuUsable;
  switch (input.preference) {
    case 'faster_whisper':
      return gpuReady ? 'faster_whisper' : 'whisper_cpp';
    case 'whisper_cpp':
      return 'whisper_cpp';
    default:
      return gpuReady ? 'faster_whisper' : 'whisper_cpp';
  }
}
