/**
 * Local STT transcriber for STT-phrase wake words (main process).
 *
 * The `stt_phrase` wake engine lets a wake word be *any* phrase — e.g. an
 * agent's name — which no fixed keyword model can do. It works by transcribing
 * short, VAD-gated speech segments on-device and matching the phrase as text.
 *
 * TRUST / HARD INVARIANT: a wake word must never send audio anywhere before it
 * fires (see `WAKE_WORD_TRUST.audioLeavesDeviceBeforeWake`). Wake transcription
 * is therefore **local-only**: the target must be loopback or a private-network
 * host. A cloud/region STT endpoint is refused, not silently used — otherwise a
 * background microphone would stream to the cloud continuously.
 *
 * The audio never touches disk and is never logged; PCM is wrapped in a WAV
 * container in memory purely because whisper-style servers expect a media file.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import {
  FASTER_WHISPER_DEFAULT_PORT,
  modelDirName,
  resolveEndpoint,
  type LocalVoiceModel,
} from '@nexus/local-voice';
import type { LocalVoiceEndpoint } from '../shared/ipc.js';
import { primaryModelFile } from './wake-host.js';

/**
 * Threads for the managed `whisper-server`.
 *
 * whisper.cpp defaults to **4** threads, which leaves most of a modern CPU idle
 * and made a 3-second utterance take ~30s on a CPU-only build. Scaling to the
 * machine's cores is the single biggest, zero-cost win (measured ~10x on an
 * 8-core i9). Capped so a huge host does not oversubscribe, and floored at 4.
 */
export function defaultWhisperThreads(coreCount: number = cpus().length): number {
  const cores = Number.isFinite(coreCount) && coreCount > 0 ? Math.floor(coreCount) : 4;
  return Math.max(4, Math.min(16, cores));
}

/**
 * Build the phrase-bias string from the armed wake phrases (agent names).
 *
 * A **bare, comma-separated list** — no "Vocabulary:" framing. The same value
 * feeds whisper.cpp's `--prompt` / `prompt` field and the faster-whisper
 * server's `hotwords`; framing was measured to *leak into* short transcripts
 * ("Vocabulary and conservation chambers…"), and hotwords in particular should
 * contain only the terms to favour, not sentence filler.
 */
export function buildPhraseBiasPrompt(phrases: readonly string[]): string | null {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of phrases) {
    const phrase = (raw ?? '').replace(/\s+/g, ' ').trim();
    if (!phrase) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(phrase);
  }
  if (cleaned.length === 0) return null;
  return cleaned.join(', ');
}

/** WAV container for one utterance. Kept pure and testable. */
export function encodeWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const rate = Math.max(8000, Math.min(192_000, Math.round(sampleRate) || 16_000));
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) {
    const clamped = Math.max(-1, Math.min(1, pcm[i]!));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return new Uint8Array(buffer);
}

/**
 * True when a host is acceptable for *wake* transcription: loopback or a private
 * network. Public/cloud hosts are refused so a wake can never stream to the
 * cloud. Deliberately conservative.
 */
export function isLocalWakeHost(hostname: string): boolean {
  const host = (hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  // 172.16.0.0 – 172.31.255.255
  const m = host.match(/^172\.(\d{1,2})\./);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  // *.local mDNS names and bare single-label hostnames are LAN-local by nature.
  if (host.endsWith('.local')) return true;
  if (!host.includes('.')) return true;
  return false;
}

/**
 * True when the port is serving *our* STT server (whisper.cpp or the
 * faster-whisper Python server), verified over HTTP rather than by a bare TCP
 * connect.
 *
 * This matters: any unrelated service can own the port (InfluxDB defaults to
 * 8086, which collides with the dev-service range), and a bare connect would
 * then report "already serving" — the engine would reuse a foreign server and
 * every transcription would silently fail. Both engines answer `GET /health`
 * with `{"status":"ok"}`, so requiring that shape proves it is ours.
 */
export async function isSttServerServing(
  port: number,
  doFetch: typeof fetch,
): Promise<boolean> {
  const health = await probeSttHealth(port, doFetch);
  return health.serving;
}

/** What `/health` said about a local STT server. */
export type SttHealth = {
  /** True when the port is answering *our* server's health contract. */
  serving: boolean;
  /**
   * False when the server is up but its speech engine failed to load (e.g. the
   * faster-whisper server could not dlopen a CUDA library, or the model download
   * is broken). A bound port is NOT proof of a working engine — this is what made
   * "wake word broken, no STT results" look like a healthy engine while every
   * transcription returned an error.
   */
  ready: boolean;
  /** The engine's own load error, when it reported one. */
  error: string | null;
  /** The device the engine loaded on (`cuda` / `cpu`), when reported. */
  device: string | null;
};

/**
 * Read a local STT server's `/health` and interpret it. Both engines answer
 * `{"status":"ok"}`; the faster-whisper server additionally reports `ready` and
 * `error` so a broken engine can be told apart from a working one. Absent
 * `ready` (whisper.cpp, or an older server) means "serving implies ready", since
 * that engine has no deferred load to fail.
 */
export async function probeSttHealth(
  port: number,
  doFetch: typeof fetch,
): Promise<SttHealth> {
  const failed: SttHealth = { serving: false, ready: false, error: null, device: null };
  try {
    const res = await doFetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return failed;
    const text = await res.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return failed;
    }
    const serving = parsed.status === 'ok' || typeof parsed.text === 'string';
    if (!serving) return failed;
    // An engine that explicitly reports not-ready is NOT usable, even though the
    // port answered: its model/CUDA load failed and every request would 500.
    const ready = parsed.ready === false ? false : true;
    return {
      serving,
      ready,
      error: typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error : null,
      device: typeof parsed.device === 'string' ? parsed.device : null,
    };
  } catch {
    return failed;
  }
}

/** A resolved, local-only transcription target. */
export type WakeSttTarget = {
  url: string;
  model: string | null;
};

/**
 * Machine-readable cause of a not-ready status, so the settings UI can point at
 * the *right* field to fix (install a model vs. install the runner) instead of
 * showing a single generic warning that is wrong half the time.
 */
export type WakeSttStatusCode =
  /** No local STT model is installed and no custom endpoint is configured. */
  | 'no_model'
  /** A model is installed, but the `whisper-server` runner is missing. */
  | 'no_runner'
  /** The runner exists but the local server could not be started/served. */
  | 'server_failed'
  /** The configured custom endpoint is not loopback/LAN (refused for a wake). */
  | 'cloud_refused';

export type WakeSttStatus = {
  /** True when a wake can transcribe right now. */
  ready: boolean;
  /** Human-safe reason when it cannot. */
  reason: string | null;
  /** Machine-readable cause when not ready (null when ready). */
  code: WakeSttStatusCode | null;
  /** The local STT model that would be served, if one is installed. */
  modelId: string | null;
  /** Display label of that model, for the UI. */
  modelLabel: string | null;
  /** True when the user pointed at a custom local endpoint instead. */
  usingCustomEndpoint: boolean;
  /** True when a runnable `whisper-server` was found (managed copy or PATH). */
  runnerInstalled: boolean;
  /**
   * Threads the managed server would use. Exposed so the UI can explain speed:
   * whisper.cpp defaults to 4, which is why an un-tuned CPU build felt unusable.
   */
  threads: number;
  /**
   * Which on-device engine would serve the wake. `faster_whisper` is the GPU
   * (CTranslate2) engine and is effectively realtime; `whisper_cpp` is the CPU
   * fallback. Surfaced so the settings UI can say which one is in play.
   */
  backend: 'whisper_cpp' | 'faster_whisper' | 'custom';
};

/**
 * The faster-whisper GPU engine, as the wake resolver needs it. Injected so the
 * wake module never imports the Python-process machinery directly (and can be
 * unit-tested without a GPU). Every method is best-effort and must not throw.
 */
export type WakeGpuRunner = {
  /** True when the venv interpreter + server script are present. */
  isInstalled: () => Promise<boolean>;
  /** True when the engine should be preferred over whisper.cpp right now. */
  preferred: () => Promise<boolean>;
  /** Spawn the Python server for the given GGML model file; null when it cannot. */
  spawn: (input: {
    ggmlFileName: string | null;
    port: number;
    /** Phrase bias (armed agent names); sent as `--hotwords`, never as a prompt. */
    hotwords: string | null;
  }) => ChildProcess | null;
  /** Port the Python server listens on (kept distinct from the CPU engine's). */
  port: number;
};

export type WakeSttDeps = {
  /** Directory installed models live in. */
  modelsDir: () => string;
  /** The current custom STT endpoint from settings, if any. */
  customEndpoint: () => LocalVoiceEndpoint | null;
  /** Look up a catalog model by id (for the installed STT file path). */
  findModel: (modelId: string) => LocalVoiceModel | null;
  /** True when a model's files are all present on disk. */
  isInstalled: (modelId: string) => boolean;
  /** The user's chosen STT model id, if any. */
  selectedModelId: () => string | null;
  /**
   * Every catalog model, so a wake can auto-select an installed STT model when
   * the user never explicitly chose one (the wake UI has no STT-model picker of
   * its own — it reuses whatever is installed).
   */
  listModels?: () => LocalVoiceModel[];
  /**
   * The live wake phrases to bias the decoder toward (agent names). Read at
   * spawn time so the initial prompt matches the currently armed phrases.
   */
  wakePhrases?: () => string[];
  /** Port for the managed whisper.cpp server (default 8085). */
  port?: number;
  /** whisper.cpp binary name (default `whisper-server`). */
  command?: string;
  /**
   * Threads for the managed server. Defaults to {@link defaultWhisperThreads}
   * (all cores, capped); whisper.cpp's own default of 4 is left most of a CPU idle.
   */
  threads?: number;
  /** Spawn override for tests. */
  spawnFn?: typeof spawn;
  /** Resolve a binary on PATH; overridable for tests. */
  resolveBinary?: (command: string) => string | null;
  /**
   * Map a command name to a concrete executable path (the app-managed
   * `whisper-server` when installed, else the bare name). Lets the wake engine use
   * a binary the app downloaded instead of requiring a manual PATH install.
   */
  binaryResolver?: (command: string) => string;
  /**
   * True when a runnable runner exists (managed copy or PATH). Lets `status()`
   * tell "install a model" apart from "install the runner". Absent = unknown, so
   * readiness still depends on the actual spawn attempt.
   */
  runnerInstalled?: () => boolean;
  /** File-existence check; overridable for tests. */
  fileExists?: (path: string) => boolean;
  /** Delay after spawning before the first request; overridable for tests. */
  startDelayMs?: number;
  /**
   * Probe whether our loopback port already has a server (the local-voice
   * lifecycle may have started one). Overridable for tests.
   */
  portInUse?: (port: number) => Promise<boolean>;
  /** Injected for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /**
   * The faster-whisper GPU engine, when configured. When present and ready it is
   * preferred over the CPU whisper.cpp server: on a GPU the same model is
   * effectively realtime, and the wake caption stops lagging speech.
   */
  gpuRunner?: WakeGpuRunner;
  /**
   * The GPU engine's port. Defaults to {@link FASTER_WHISPER_DEFAULT_PORT} (a
   * high port clear of the dev-service range the CPU engine's 8085 can collide
   * with). Kept distinct from the CPU engine's port so they never contend.
   */
  gpuPort?: number;
};

/** Parse a JSON body, returning null on any malformed input (never throws). */
function safeParse(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type WakeStt = {
  /** Resolve the local target + honest readiness (never throws). */
  status: () => Promise<WakeSttStatus>;
  /**
   * The last transcription failure, or null after a success. Lets the wake UI say
   * *why* nothing was heard (engine failed to load, server unreachable) instead of
   * silently showing an empty caption.
   */
  lastError: () => string | null;
  /**
   * Transcribe one utterance on-device; null when nothing was recognised.
   * `phrases` overrides the configured wake phrases for this call (the renderer
   * knows the armed phrases, including auto-mapped ones main never persists).
   */
  transcribe: (pcm: Float32Array, sampleRate: number, phrases?: string[]) => Promise<string | null>;
  /** Stop the managed server process, if one is running. */
  dispose: () => void;
};

/**
 * Resolve a wake STT target that is *both* runnable and local. Returns the target
 * or a human-safe reason. Prefers the user's explicitly-configured local
 * endpoint, then a managed whisper.cpp server over an installed STT model.
 */
export function createWakeStt(deps: WakeSttDeps): WakeStt {
  const port = deps.port ?? 8085;
  const gpuPort = deps.gpuPort ?? FASTER_WHISPER_DEFAULT_PORT;
  const command = deps.command ?? 'whisper-server';
  const threads = deps.threads ?? defaultWhisperThreads();
  const spawnFn = deps.spawnFn ?? spawn;
  const doFetch = deps.fetchFn ?? fetch;
  const fileExists = deps.fileExists ?? existsSync;
  let proc: ChildProcess | null = null;
  let starting: Promise<void> | null = null;
  /** The faster-whisper (GPU) server process, when that engine served the wake. */
  let gpuProc: ChildProcess | null = null;
  let gpuStarting: Promise<void> | null = null;
  /** True when a server we did NOT spawn is already serving on our port. */
  let externalServer = false;
  /**
   * The engine's own load error when a server was up but unusable (e.g. a missing
   * CUDA library). Surfaced in status/transcribe so "no results" has a real cause
   * instead of looking like silence.
   */
  let engineLoadError: string | null = null;
  /**
   * The most recent transcription failure (engine load error, HTTP error, or an
   * unreachable server). Exposed via {@link WakeStt.lastError} so the renderer can
   * explain "no results" instead of showing an empty caption as if the room was
   * silent. Cleared on a successful transcription.
   */
  let lastError: string | null = null;

  /**
   * True when *our* STT server is answering on the port. Uses the injected
   * `portInUse` probe when a test supplied one (so tests keep their TCP-only
   * semantics), and otherwise proves it over HTTP via the `/health` contract.
   */
  function servingOurServer(p: number): Promise<boolean> {
    if (deps.portInUse) return deps.portInUse(p).catch(() => false);
    return isSttServerServing(p, doFetch);
  }

  /**
   * True when the port serves our server *and* its engine loaded. Reusing a
   * server whose engine failed would make every transcription return an error
   * while readiness said "ready" — the exact silent failure this guards against.
   * A serving-but-not-ready server is recorded so the reason can be surfaced.
   */
  async function servingReadyServer(p: number): Promise<boolean> {
    if (deps.portInUse) return deps.portInUse(p).catch(() => false);
    const health = await probeSttHealth(p, doFetch);
    if (health.serving && !health.ready) {
      engineLoadError = health.error ?? 'The local speech engine failed to load.';
      return false;
    }
    if (health.serving && health.ready) engineLoadError = null;
    return health.serving;
  }
  /**
   * Whether the faster-whisper GPU engine should serve the wake. Best-effort:
   * any failure (engine not installed, no GPU, probe error) means "no", and the
   * whisper.cpp path is used exactly as before.
   */
  async function gpuPreferred(): Promise<boolean> {
    const runner = deps.gpuRunner;
    if (!runner) return false;
    try {
      if (!(await runner.isInstalled())) return false;
      return await runner.preferred();
    } catch {
      return false;
    }
  }

  /** True when a runnable runner is present (managed copy or PATH). */
  function runnerIsInstalled(): boolean {
    // Prefer the explicit probe (the voice-binary manager knows the truth).
    if (deps.runnerInstalled) return deps.runnerInstalled();
    // An injected PATH resolver is authoritative when it can say "missing".
    if (deps.resolveBinary) return deps.resolveBinary(command) !== null;
    // Unknown (production resolves to the bare name so `spawn` reads PATH): do
    // not claim the runner is missing, or we would mislabel a PATH install.
    return true;
  }

  /**
   * The installed STT model to serve the *wake* path.
   *
   * Wake gating only needs to spot a short phrase, so a small model is strictly
   * better: recognizing "Nox" with a 574 MB `large-v3-turbo` on a CPU build took
   * ~30s per utterance, while a `tiny`/`base` model does the same clip in well
   * under a second — the difference between "feels broken" and near-realtime.
   *
   * Policy (deliberately independent of the dictation selection, which may legitimately
   * want a large model): prefer the **smallest installed** STT model. That way
   * installing one fast model is enough for wake, and a big dictation model does
   * not silently make the wake unusable. Falls back to the user's choice, then to
   * any installed speech model, so a single installed model is always used.
   */
  function installedSttModel(): LocalVoiceModel | null {
    const all = (deps.listModels?.() ?? []).filter(
      (m) => m.kind === 'stt' && m.files.length > 0 && deps.isInstalled(m.id),
    );
    if (all.length > 0) {
      // Smallest by declared size (unknown sizes sort last, never win).
      return [...all].sort(
        (a, b) => (a.sizeBytes ?? Number.POSITIVE_INFINITY) - (b.sizeBytes ?? Number.POSITIVE_INFINITY),
      )[0]!;
    }
    const selected = deps.selectedModelId();
    if (selected) {
      const model = deps.findModel(selected);
      if (model && model.kind === 'stt' && deps.isInstalled(model.id)) return model;
    }
    return null;
  }

  /** The absolute path of the primary model file, or null when missing. */
  function modelFilePath(model: LocalVoiceModel): string | null {
    const file = primaryModelFile(model);
    if (!file) return null;
    const path = join(deps.modelsDir(), modelDirName(model), file);
    return fileExists(path) ? path : null;
  }

  function resolveBinary(name: string): string | null {
    if (deps.resolveBinary) return deps.resolveBinary(name);
    // The voice-binary manager returns a concrete path for the app-managed copy
    // (or an existing PATH install), and the bare name otherwise so `spawn`
    // resolves PATH itself.
    return deps.binaryResolver?.(name) ?? name;
  }

  function customTarget(): WakeSttTarget | null {
    const endpoint = deps.customEndpoint();
    if (!endpoint?.baseUrl) return null;
    const resolved = resolveEndpoint({
      kind: 'stt',
      protocol: endpoint.protocol,
      baseUrl: endpoint.baseUrl,
      ignoreTls: endpoint.ignoreTls,
    });
    if (!resolved.url) return null;
    return { url: resolved.url, model: null };
  }

  /**
   * Ensure a local whisper.cpp server is serving our port. Reuses one the
   * local-voice lifecycle already started (the same binary/port/path) instead of
   * spawning a second process that would fail to bind.
   */
  async function ensureServer(model: LocalVoiceModel): Promise<WakeSttTarget | null> {
    const url = `http://127.0.0.1:${port}/inference`;
    // Someone already serves this port → reuse it (do not kill what we did not
    // start). Verified over HTTP, not a bare TCP connect: an unrelated service on
    // the port must not be mistaken for our STT server, and a server whose engine
    // failed to load must not be reused either (its port answers, its
    // transcriptions all error).
    if (!proc && (await servingReadyServer(port))) {
      externalServer = true;
      return { url, model: model.modelRef ?? model.label };
    }
    const filePath = modelFilePath(model);
    if (!filePath) return null;
    const binary = resolveBinary(command);
    if (!binary) return null;
    if (!proc) {
      if (!starting) {
        starting = new Promise<void>((resolve) => {
          try {
            // `-t`: whisper.cpp defaults to 4 threads, which idles most of a CPU
            // and was the dominant cause of ~30s transcripts. `--prompt`: bias the
            // decoder toward the armed wake phrases (agent names) so unusual proper
            // nouns are recognized, not guessed into similar-sounding words.
            const args = [
              '-m',
              filePath,
              '--host',
              '127.0.0.1',
              '--port',
              String(port),
              '--inference-path',
              '/inference',
              '-t',
              String(threads),
            ];
            const phrasePrompt = buildPhraseBiasPrompt(deps.wakePhrases?.() ?? []);
            if (phrasePrompt) args.push('--prompt', phrasePrompt);
            proc = spawnFn(binary, args, { stdio: 'ignore', detached: false });
            proc.on('exit', () => {
              proc = null;
            });
            // A missing/unrunnable binary surfaces as an `error` event, not an
            // `exit`; without this the process handle would linger and we would
            // wrongly report ready. Swallow it here (readiness is decided by the
            // port probe below) so it never becomes an uncaught exception.
            proc.on('error', () => {
              proc = null;
            });
          } catch {
            proc = null;
          }
          // Give the process a moment to bind its port before the first request.
          setTimeout(resolve, deps.startDelayMs ?? 400);
        });
      }
      await starting;
      starting = null;
    }
    if (!proc) return null;
    // Confirm the server is actually serving: a spawned-but-crashed binary would
    // otherwise be reported as ready and every transcription would silently fail.
    if (!(await servingOurServer(port))) return null;
    return { url, model: model.modelRef ?? model.label };
  }

  /**
   * Ensure the faster-whisper (GPU) Python server is serving its own port. Kept
   * separate from {@link ensureServer} because it is a different process (a venv
   * Python, not a binary) and a different port, so the two engines never contend
   * for a socket. Returns null when it cannot start, so the caller falls back to
   * whisper.cpp rather than failing the wake.
   */
  async function ensureGpuServer(model: LocalVoiceModel): Promise<WakeSttTarget | null> {
    const runner = deps.gpuRunner;
    if (!runner) return null;
    const url = `http://127.0.0.1:${gpuPort}/inference`;
    // Reuse a server already bound to the GPU port (e.g. a prior session), but
    // only when its engine actually *loaded*. A server whose CUDA libraries were
    // unreachable still binds and answers `/health`, so a bare "is it serving"
    // check would adopt a permanently broken engine and every transcription would
    // 500 — the exact "wake word broken, no STT results" symptom. This mirrors
    // `ensureServer`'s readiness-aware reuse for whisper.cpp.
    if (!gpuProc && (await servingReadyServer(gpuPort))) {
      return { url, model: model.modelRef ?? model.label };
    }
    if (!gpuProc) {
      if (!gpuStarting) {
        gpuStarting = new Promise<void>((resolve) => {
          try {
            // Phrase bias is passed as `hotwords`, not an initial prompt: a prompt
            // leaks into short transcripts. See `buildPhraseBiasPrompt`.
            const hotwords = buildPhraseBiasPrompt(deps.wakePhrases?.() ?? []);
            gpuProc = runner.spawn({
              ggmlFileName: primaryModelFile(model),
              port: gpuPort,
              hotwords,
            });
            gpuProc?.on('exit', () => {
              gpuProc = null;
            });
            gpuProc?.on('error', () => {
              gpuProc = null;
            });
          } catch {
            gpuProc = null;
          }
          // The Python server imports CTranslate2 and loads the model before it
          // binds, which takes noticeably longer than whisper.cpp's startup.
          setTimeout(resolve, deps.startDelayMs ?? 1200);
        });
      }
      await gpuStarting;
      gpuStarting = null;
    }
    if (!gpuProc) return null;
    // Wait for the engine to actually *load*, not just bind. The Python server
    // binds its port only after importing faster-whisper/CTranslate2 and loading
    // the model into VRAM; on a cold start (first import, model download) that can
    // take several seconds. The previous fixed sleep gave up early, so the wake
    // silently fell back to CPU whisper.cpp — or, worse, reused a server whose
    // engine had failed to load. Poll `/health` until it reports ready.
    const health = await waitForEngineReady(gpuPort);
    if (!health.serving) return null;
    if (!health.ready) {
      // Bound but broken (e.g. the CUDA libraries could not be loaded): do not
      // pretend it works — record the reason and let the caller fall back.
      engineLoadError = health.error ?? 'The local speech engine failed to load.';
      return null;
    }
    engineLoadError = null;
    return { url, model: model.modelRef ?? model.label };
  }

  /**
   * Poll `/health` until the engine reports ready, or give up. A server that is
   * up but whose engine failed returns immediately (retrying cannot fix a missing
   * library), while a still-loading server keeps its port closed or reports
   * `ready: false` without an error — both are waited on within the budget.
   */
  async function waitForEngineReady(p: number): Promise<SttHealth> {
    const budget = deps.startDelayMs ?? 1200;
    const deadline = Date.now() + Math.max(budget, 15_000);
    let last: SttHealth = { serving: false, ready: false, error: null, device: null };
    while (Date.now() < deadline) {
      const health = await probeSttHealth(p, doFetch);
      if (health.serving) {
        if (health.ready) return health;
        // Serving but broken with a real error: retrying will not help.
        if (health.error) return health;
      }
      last = health;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return last;
  }

  type Resolution = {
    target: WakeSttTarget | null;
    reason: string | null;
    code: WakeSttStatusCode | null;
    model: LocalVoiceModel | null;
    usingCustomEndpoint: boolean;
    /** True when the configuration *could* run, even if nothing is running yet. */
    capable?: boolean;
  };

  /**
   * Resolve the wake STT target.
   *
   * `status()` must be side-effect free — it is polled by the settings UI every
   * couple of seconds, and starting a whisper server (loading a model into VRAM)
   * just because a panel is open would be wrong. So `spawn: false` reports
   * *capability* (model installed + runner available, or a server already
   * serving) without launching anything; `transcribe()` passes `spawn: true` to
   * actually start the server on demand.
   */
  async function resolveTarget(spawn: boolean): Promise<Resolution> {
    const custom = customTarget();
    if (custom) {
      let host = '';
      try {
        host = new URL(custom.url).hostname;
      } catch {
        host = '';
      }
      if (!isLocalWakeHost(host)) {
        return {
          target: null,
          code: 'cloud_refused',
          model: null,
          usingCustomEndpoint: true,
          reason:
            'A wake word can only use a local speech model — audio must never leave this device.',
        };
      }
      return { target: custom, reason: null, code: null, model: null, usingCustomEndpoint: true };
    }
    const model = installedSttModel();
    if (!model) {
      return {
        target: null,
        code: 'no_model',
        model: null,
        usingCustomEndpoint: false,
        reason:
          'Install a speech-to-text model under “Local speech models” (or configure a local endpoint) to wake on a spoken phrase.',
      };
    }
    if (!spawn) {
      // Capability check: the weights must be on disk, and either a server is
      // already serving or a runner exists (GPU engine or whisper.cpp) to start.
      if (!modelFilePath(model)) {
        return {
          target: null,
          code: 'no_model',
          model,
          usingCustomEndpoint: false,
          reason: 'The installed speech model file is missing — reinstall it under “Local speech models”.',
        };
      }
      // A GPU engine that is installed + has a usable GPU is always "capable":
      // it starts on demand, so readiness must not depend on it running now.
      if (await gpuPreferred()) {
        return { target: null, reason: null, code: null, model, usingCustomEndpoint: false, capable: true };
      }
      // A server already up on the port counts only when its engine loaded: a
      // serving-but-broken engine would make readiness claim "ready" while every
      // transcription failed. Otherwise a runnable runner means "capable" (it
      // starts on demand), which is what readiness is about.
      const serving = await servingReadyServer(port);
      if (serving || runnerIsInstalled()) {
        return {
          target: null,
          reason: null,
          code: null,
          model,
          usingCustomEndpoint: false,
          capable: true,
        };
      }
      return {
        target: null,
        code: 'no_runner',
        model,
        usingCustomEndpoint: false,
        reason:
          'Install the whisper.cpp runner (“Local speech models” → Speech engine runner → Install) to run the installed speech model.',
      };
    }
    // Prefer the faster-whisper GPU engine when it is ready: it is effectively
    // realtime, where whisper.cpp on CPU lags speech. Fall back to whisper.cpp
    // whenever the GPU engine is unavailable or fails to start.
    if (await gpuPreferred()) {
      const gpuTarget = await ensureGpuServer(model);
      if (gpuTarget) return { target: gpuTarget, reason: null, code: null, model, usingCustomEndpoint: false };
    }
    const target = await ensureServer(model);
    if (!target) {
      // A model is present but nothing can run it: distinguish a missing runner
      // from a server that failed to bind, so the UI highlights the right fix.
      const runner = runnerIsInstalled();
      return {
        target: null,
        code: runner ? 'server_failed' : 'no_runner',
        model,
        usingCustomEndpoint: false,
        reason: runner
          ? `The local speech server could not start. Try again, or check that port ${port} is free.`
          : 'Install the whisper.cpp runner (“Local speech models” → Speech engine runner → Install) to run the installed speech model.',
      };
    }
    return { target, reason: null, code: null, model, usingCustomEndpoint: false };
  }

  return {
    async status(): Promise<WakeSttStatus> {
      // No `spawn`: reporting readiness must never start a server (loading a
      // model into VRAM). "Ready" means a wake *would* transcribe — either an
      // already-serving server, a runnable model+runner, or a local endpoint.
      const r = await resolveTarget(false);
      const ready = r.target !== null || r.capable === true;
      // Which engine would serve: the GPU engine when it is ready, else the CPU
      // fallback (or the user's custom local endpoint).
      const backend: WakeSttStatus['backend'] = r.usingCustomEndpoint
        ? 'custom'
        : (await gpuPreferred())
          ? 'faster_whisper'
          : 'whisper_cpp';
      return {
        ready,
        // A load error already discovered on the port is more specific than the
        // generic resolution reason, so prefer it.
        reason: ready ? null : (engineLoadError ?? r.reason),
        code: ready ? null : r.code,
        modelId: r.model?.id ?? null,
        modelLabel: r.model?.label ?? null,
        usingCustomEndpoint: r.usingCustomEndpoint,
        runnerInstalled: r.usingCustomEndpoint ? true : runnerIsInstalled(),
        threads,
        backend,
      };
    },
    async transcribe(pcm, sampleRate, phrases) {
      if (!pcm.length) return null;
      const resolution = await resolveTarget(true);
      const target = resolution.target;
      if (!target) {
        // A real cause (missing model, missing runner, engine failed to load) must
        // not look like "the user said nothing": the wake path would show an empty
        // caption forever with no explanation. Report it so the renderer surfaces
        // a message; the reason string is already human-safe.
        const reason = engineLoadError ?? resolution.reason;
        if (reason) lastError = reason;
        return null;
      }
      try {
        const wav = encodeWav(pcm, sampleRate);
        const form = new FormData();
        // Blob is a global in Node 20 / Electron; the server only sees bytes.
        form.append('file', new Blob([wav], { type: 'audio/wav' }), 'wake.wav');
        form.append('response_format', 'json');
        if (target.model) form.append('model', target.model);
        // Per-request phrase bias: covers a server we did not spawn (a reused
        // local-voice lifecycle server, or a custom loopback endpoint) whose
        // initial prompt predates the currently armed phrases. Caller-supplied
        // phrases win; they include auto-mapped names main never persists.
        const phrasePrompt = buildPhraseBiasPrompt(phrases ?? deps.wakePhrases?.() ?? []);
        if (phrasePrompt) form.append('prompt', phrasePrompt);
        const res = await doFetch(target.url, { method: 'POST', body: form });
        const text = await res.text();
        if (!res.ok) {
          // An engine that cannot load answers 500 with `{"error": "…"}`. Returning
          // a bare null here is what made a broken GPU engine indistinguishable
          // from silence, so record and surface the engine's own message.
          const parsed = safeParse(text);
          const detail =
            typeof parsed?.error === 'string' && parsed.error.trim()
              ? parsed.error.trim()
              : `The local speech server returned HTTP ${res.status}.`;
          lastError = detail;
          return null;
        }
        if (!text) return null;
        // whisper.cpp returns `{"text": "…"}`; OpenAI-compatible returns the same.
        const parsed = safeParse(text);
        if (parsed) {
          const value = parsed.text ?? (parsed.data as Record<string, unknown> | undefined)?.text;
          lastError = null;
          return typeof value === 'string' && value.trim() ? value.trim() : null;
        }
        const plain = text.trim();
        return plain ? plain : null;
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'The local speech server could not be reached.';
        return null;
      }
    },
    lastError() {
      return lastError;
    },
    dispose() {
      // Kill the GPU (Python) server we spawned, if any. A GPU server never goes
      // through the whisper.cpp lifecycle, so it is always ours to stop.
      if (gpuProc) {
        const p = gpuProc;
        gpuProc = null;
        try {
          p.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
      // Never kill a whisper.cpp server we did not start (the local-voice
      // lifecycle owns that one).
      if (!proc || externalServer) return;
      const p = proc;
      proc = null;
      try {
        p.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    },
  };
}
