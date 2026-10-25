import { describe, expect, it } from 'vitest';
import {
  CPU_COMPUTE_TYPE,
  FASTER_WHISPER_DEFAULT_PORT,
  FASTER_WHISPER_MODELS,
  MIN_USEFUL_VRAM_MIB,
  composeLibraryPath,
  cudaDeviceArg,
  cudaLibraryPathsFor,
  resolveSitePackages,
  fasterWhisperEnvPlan,
  fasterWhisperModelFor,
  fasterWhisperServerArgs,
  ggmlModelFamily,
  parseGpuInfo,
  pickSttBackend,
  pipInstallArgs,
  requirementSpecs,
  resolveComputeType,
  shouldUseGpu,
  venvCreateArgs,
  type GpuInfo,
} from '../gpu-engine.js';

describe('parseNvidiaSmi', () => {
  it('parses the first GPU line of CSV output', () => {
    const csv = 'NVIDIA GeForce RTX 2080, 8192, 595.99.02\n';
    expect(parseGpuInfo(csv)).toEqual({
      name: 'NVIDIA GeForce RTX 2080',
      memoryMiB: 8192,
      driverVersion: '595.99.02',
    });
  });

  it('takes the first GPU when several are present', () => {
    const csv = 'NVIDIA GeForce RTX 2080, 8192, 595.0\nNVIDIA GeForce GTX 1050, 4096, 595.0\n';
    expect(parseGpuInfo(csv)?.name).toBe('NVIDIA GeForce RTX 2080');
  });

  it('returns null for empty / unparseable output (no GPU, command failed)', () => {
    expect(parseGpuInfo('')).toBeNull();
    expect(parseGpuInfo(null)).toBeNull();
    expect(parseGpuInfo(undefined)).toBeNull();
    expect(parseGpuInfo('\n  \n')).toBeNull();
  });

  it('tolerates a missing driver field and a non-numeric memory value', () => {
    expect(parseGpuInfo('Some GPU, [N/A]')).toEqual({
      name: 'Some GPU',
      memoryMiB: 0,
      driverVersion: null,
    });
  });
});

describe('shouldUseGpu', () => {
  const gpu = (memoryMiB: number): GpuInfo => ({ name: 'GPU', memoryMiB, driverVersion: null });

  it('rejects no GPU and tiny GPUs', () => {
    expect(shouldUseGpu(null)).toBe(false);
    expect(shouldUseGpu(gpu(MIN_USEFUL_VRAM_MIB - 1))).toBe(false);
  });

  it('accepts a GPU with enough VRAM (a 2 GB floor)', () => {
    expect(shouldUseGpu(gpu(MIN_USEFUL_VRAM_MIB))).toBe(true);
    expect(shouldUseGpu(gpu(8192))).toBe(true);
  });
});

describe('compute type + device resolution', () => {
  it('maps the automatic hint to float16 on GPU and int8 on CPU', () => {
    expect(resolveComputeType('auto', true)).toBe('float16');
    expect(resolveComputeType('auto', false)).toBe(CPU_COMPUTE_TYPE);
  });

  it('honours an explicit preference regardless of device', () => {
    expect(resolveComputeType('int8_float16', true)).toBe('int8_float16');
    expect(resolveComputeType('float32', false)).toBe('float32');
  });

  it('selects the cuda/cpu device arg', () => {
    expect(cudaDeviceArg(true)).toBe('cuda');
    expect(cudaDeviceArg(false)).toBe('cpu');
  });
});

describe('ggmlModelFamily / fasterWhisperModelFor', () => {
  it('strips the ggml prefix and quantization suffix', () => {
    expect(ggmlModelFamily('ggml-tiny-q5_1.bin')).toBe('tiny');
    expect(ggmlModelFamily('ggml-base-q5_1.bin')).toBe('base');
    expect(ggmlModelFamily('ggml-small-q5_1.bin')).toBe('small');
    expect(ggmlModelFamily('ggml-large-v3-turbo-q5_0.bin')).toBe('large-v3-turbo');
    expect(ggmlModelFamily('ggml-medium-f16.bin')).toBe('medium');
  });

  it('returns null for empty input', () => {
    expect(ggmlModelFamily(null)).toBeNull();
    expect(ggmlModelFamily('')).toBeNull();
  });

  it('maps known families onto CTranslate2 repos, unknown families to null', () => {
    expect(fasterWhisperModelFor('ggml-tiny-q5_1.bin')).toBe(FASTER_WHISPER_MODELS.tiny);
    expect(fasterWhisperModelFor('ggml-large-v3-turbo-q5_0.bin')).toBe(
      'deepdml/faster-whisper-large-v3-turbo-ct2',
    );
    expect(fasterWhisperModelFor('ggml-tiny.en-q5_1.bin')).toBeNull();
  });
});

describe('requirements', () => {
  it('always includes the runtime, and CUDA libs only for GPU', () => {
    const cpu = requirementSpecs(false);
    expect(cpu).toContain('faster-whisper>=1.0.0');
    expect(cpu).toContain('ctranslate2>=4.0.0');
    expect(cpu.some((r) => r.startsWith('nvidia-cublas'))).toBe(false);

    const gpu = requirementSpecs(true);
    expect(gpu).toContain('nvidia-cublas-cu12');
    expect(gpu).toContain('nvidia-cudnn-cu12>=9.0.0');
  });
});

describe('fasterWhisperEnvPlan', () => {
  it('builds a POSIX venv layout under the data dir', () => {
    const plan = fasterWhisperEnvPlan({
      dataDir: '/home/u/.config/Electron',
      includeGpu: true,
      platform: 'linux',
      pythonVersion: '3.12',
    });
    expect(plan.envDir).toBe('/home/u/.config/Electron/voice-py');
    expect(plan.venvPython).toBe('/home/u/.config/Electron/voice-py/bin/python');
    expect(plan.pythonCommand).toBe('python3');
    // POSIX venvs nest site-packages under the interpreter version; the old
    // `lib/site-packages` does not exist and silently broke CUDA discovery.
    expect(plan.libDir).toBe('/home/u/.config/Electron/voice-py/lib');
    expect(plan.sitePackages).toBe(
      '/home/u/.config/Electron/voice-py/lib/python3.12/site-packages',
    );
    expect(plan.libraryPaths).toContain(
      '/home/u/.config/Electron/voice-py/lib/python3.12/site-packages/nvidia/cublas/lib',
    );
    expect(plan.libraryPaths).toContain(
      '/home/u/.config/Electron/voice-py/lib/python3.12/site-packages/nvidia/cudnn/lib',
    );
  });

  it('prefers the site-packages directory that actually exists on disk', () => {
    // A venv created by a different Python minor version than the guess: the
    // on-disk directory must win, or the CUDA paths point at nothing.
    const plan = fasterWhisperEnvPlan({
      dataDir: '/data',
      includeGpu: true,
      platform: 'linux',
      pythonVersion: '3.11',
      exists: (p) => p === '/data/voice-py/lib/python3.13/site-packages',
      readdir: () => ['python3.13', 'python3.12', 'site-packages'],
    });
    expect(plan.sitePackages).toBe('/data/voice-py/lib/python3.13/site-packages');
    expect(plan.libraryPaths[0]).toBe(
      '/data/voice-py/lib/python3.13/site-packages/nvidia/cublas/lib',
    );
  });

  it('uses the Windows venv layout and no CUDA libs on CPU', () => {
    const plan = fasterWhisperEnvPlan({
      dataDir: 'C:/Users/u/AppData/Roaming/Electron',
      includeGpu: false,
      platform: 'win32',
    });
    expect(plan.venvPython).toBe('C:/Users/u/AppData/Roaming/Electron/voice-py/Scripts/python.exe');
    expect(plan.libraryPaths).toEqual([]);
    expect(plan.requirements.some((r) => r.startsWith('nvidia-'))).toBe(false);
  });

  it('strips a trailing slash on dataDir', () => {
    const plan = fasterWhisperEnvPlan({ dataDir: '/data/', includeGpu: false, platform: 'linux' });
    expect(plan.envDir).toBe('/data/voice-py');
  });

  it('honours an explicit python command', () => {
    const plan = fasterWhisperEnvPlan({
      dataDir: '/d',
      includeGpu: false,
      platform: 'linux',
      pythonCommand: '/usr/bin/python3.12',
    });
    expect(plan.pythonCommand).toBe('/usr/bin/python3.12');
  });
});

describe('venvCreateArgs / pipInstallArgs', () => {
  const plan = fasterWhisperEnvPlan({ dataDir: '/d', includeGpu: true, platform: 'linux' });

  it('creates the venv with `-m venv`', () => {
    expect(venvCreateArgs(plan)).toEqual(['-m', 'venv', '/d/voice-py']);
  });

  it('upgrades pip and installs every requirement', () => {
    const args = pipInstallArgs(plan);
    expect(args.slice(0, 4)).toEqual(['-m', 'pip', 'install', '--upgrade']);
    expect(args).toContain('faster-whisper>=1.0.0');
    expect(args).toContain('nvidia-cudnn-cu12>=9.0.0');
  });
});

describe('resolveSitePackages', () => {
  it('finds the versioned site-packages directory of a real venv', () => {
    expect(
      resolveSitePackages('/v/lib', {
        exists: (p) => p === '/v/lib/python3.12/site-packages',
        readdir: () => ['python3.12', 'python3.11'],
      }),
    ).toBe('/v/lib/python3.12/site-packages');
  });

  it('accepts a flat lib/site-packages layout when present', () => {
    expect(
      resolveSitePackages('/v/lib', { exists: (p) => p === '/v/lib/site-packages', readdir: () => [] }),
    ).toBe('/v/lib/site-packages');
  });

  it('picks the highest interpreter version when several exist', () => {
    expect(
      resolveSitePackages('/v/lib', {
        exists: (p) => p === '/v/lib/python3.13/site-packages',
        readdir: () => ['python3.9', 'python3.13', 'python3.11'],
      }),
    ).toBe('/v/lib/python3.13/site-packages');
  });

  it('returns null when nothing matches (caller falls back to the plan)', () => {
    expect(resolveSitePackages('/v/lib', { exists: () => false, readdir: () => ['python3.12'] })).toBeNull();
    expect(
      resolveSitePackages('/v/lib', {
        exists: () => false,
        readdir: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toBeNull();
  });
});

describe('cudaLibraryPathsFor', () => {
  it('lists cublas, cudnn and nvrtc under the given site-packages', () => {
    expect(cudaLibraryPathsFor('/sp')).toEqual([
      '/sp/nvidia/cublas/lib',
      '/sp/nvidia/cudnn/lib',
      '/sp/nvidia/cuda_nvrtc/lib',
    ]);
  });
});

describe('composeLibraryPath', () => {
  it('prepends the pip CUDA paths and preserves the existing value', () => {
    const out = composeLibraryPath(['/py/cublas', '/py/cudnn'], '/usr/lib:/usr/local/lib');
    expect(out).toBe('/py/cublas:/py/cudnn:/usr/lib:/usr/local/lib');
  });

  it('yields just the pip paths when nothing existed', () => {
    expect(composeLibraryPath(['/py/cublas'], undefined)).toBe('/py/cublas');
    expect(composeLibraryPath([], '')).toBe('');
  });
});

describe('FASTER_WHISPER_DEFAULT_PORT', () => {
  it('stays clear of the 8080-8090 band common dev services squat on (e.g. InfluxDB/8086)', () => {
    expect(FASTER_WHISPER_DEFAULT_PORT).toBeGreaterThan(8090);
  });
});

describe('fasterWhisperServerArgs', () => {
  it('builds the full command line including the phrase-bias hotwords', () => {
    const args = fasterWhisperServerArgs({
      scriptPath: '/app/local-stt-server.py',
      model: 'base',
      host: '127.0.0.1',
      port: 8085,
      inferencePath: '/inference',
      device: 'cuda',
      computeType: 'float16',
      beamSize: 1,
      hotwords: 'Nox, Razail',
      language: 'en',
    });
    expect(args).toEqual([
      '-u',
      '/app/local-stt-server.py',
      '--model',
      'base',
      '--host',
      '127.0.0.1',
      '--port',
      '8085',
      '--inference-path',
      '/inference',
      '--device',
      'cuda',
      '--compute-type',
      'float16',
      '--beam-size',
      '1',
      '--language',
      'en',
      '--hotwords',
      'Nox, Razail',
      '--no-speech-threshold',
      '0.4',
      '--temperature',
      '0',
    ]);
  });

  it('always passes the anti-hallucination decode policy', () => {
    const args = fasterWhisperServerArgs({
      scriptPath: 's.py',
      model: 'tiny',
      host: '127.0.0.1',
      port: 9000,
      inferencePath: '/inference',
      device: 'cpu',
      computeType: 'int8',
      beamSize: 1,
    });
    // Silence must not be decoded into filler/phantom wake names: gate no-speech
    // and keep the temperature deterministic. VAD filtering is on by default.
    expect(args[args.indexOf('--no-speech-threshold') + 1]).toBe('0.4');
    expect(args[args.indexOf('--temperature') + 1]).toBe('0');
    expect(args).not.toContain('--no-vad-filter');
  });

  it('honours an explicit no-speech threshold and can disable the VAD filter', () => {
    const args = fasterWhisperServerArgs({
      scriptPath: 's.py',
      model: 'tiny',
      host: '127.0.0.1',
      port: 9000,
      inferencePath: '/inference',
      device: 'cpu',
      computeType: 'int8',
      beamSize: 1,
      noSpeechThreshold: 0.35,
      vadFilter: false,
    });
    expect(args[args.indexOf('--no-speech-threshold') + 1]).toBe('0.35');
    expect(args).toContain('--no-vad-filter');
  });

  it('omits the optional hotwords/language when absent', () => {
    const args = fasterWhisperServerArgs({
      scriptPath: 's.py',
      model: 'tiny',
      host: '127.0.0.1',
      port: 9000,
      inferencePath: '/inference',
      device: 'cpu',
      computeType: 'int8',
      beamSize: 1,
    });
    expect(args).not.toContain('--hotwords');
    expect(args).not.toContain('--initial-prompt');
    expect(args).not.toContain('--language');
  });
});

describe('pickSttBackend', () => {
  it('auto prefers the GPU engine only when installed and usable', () => {
    expect(pickSttBackend({ preference: 'auto', gpuInstalled: true, gpuUsable: true })).toBe(
      'faster_whisper',
    );
    expect(pickSttBackend({ preference: 'auto', gpuInstalled: false, gpuUsable: true })).toBe(
      'whisper_cpp',
    );
    expect(pickSttBackend({ preference: 'auto', gpuInstalled: true, gpuUsable: false })).toBe(
      'whisper_cpp',
    );
  });

  it('an explicit CPU choice always wins', () => {
    expect(pickSttBackend({ preference: 'whisper_cpp', gpuInstalled: true, gpuUsable: true })).toBe(
      'whisper_cpp',
    );
  });

  it('an explicit GPU choice falls back to CPU when it cannot run', () => {
    expect(
      pickSttBackend({ preference: 'faster_whisper', gpuInstalled: false, gpuUsable: true }),
    ).toBe('whisper_cpp');
    expect(
      pickSttBackend({ preference: 'faster_whisper', gpuInstalled: true, gpuUsable: true }),
    ).toBe('faster_whisper');
  });
});
