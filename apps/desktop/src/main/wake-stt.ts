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
import { connect } from 'node:net';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { modelDirName, resolveEndpoint, type LocalVoiceModel } from '@nexus/local-voice';
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
 * Build the initial-prompt phrase bias. whisper.cpp conditions the decoder on
 * `--prompt` / the `prompt` form field, which sharpens recognition of unusual
 * proper nouns — exactly our case, since wake phrases are agent names ("Nox",
 * "Razail"). Framing them as a vocabulary list keeps it a hint, not a transcript.
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
  return `Vocabulary: ${cleaned.join(', ')}.`;
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

/** True when something is already listening on the loopback port. */
function defaultPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(400, () => {
      socket.destroy();
      resolve(false);
    });
  });
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
};

export type WakeStt = {
  /** Resolve the local target + honest readiness (never throws). */
  status: () => Promise<WakeSttStatus>;
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
  const command = deps.command ?? 'whisper-server';
  const threads = deps.threads ?? defaultWhisperThreads();
  const spawnFn = deps.spawnFn ?? spawn;
  const doFetch = deps.fetchFn ?? fetch;
  const fileExists = deps.fileExists ?? existsSync;
  const probePort = deps.portInUse ?? defaultPortInUse;
  let proc: ChildProcess | null = null;
  let starting: Promise<void> | null = null;
  /** True when a server we did NOT spawn is already serving on our port. */
  let externalServer = false;

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
    // Someone already serves this port → reuse it (do not kill what we did not start).
    if (!proc && (await probePort(port).catch(() => false))) {
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
    if (!(await probePort(port).catch(() => false))) return null;
    return { url, model: model.modelRef ?? model.label };
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
      // already serving or a runner exists to start one.
      if (!modelFilePath(model)) {
        return {
          target: null,
          code: 'no_model',
          model,
          usingCustomEndpoint: false,
          reason: 'The installed speech model file is missing — reinstall it under “Local speech models”.',
        };
      }
      const serving = await probePort(port).catch(() => false);
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
          ? 'The local speech server could not start. Try again, or check that port 8085 is free.'
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
      return {
        ready,
        reason: ready ? null : r.reason,
        code: ready ? null : r.code,
        modelId: r.model?.id ?? null,
        modelLabel: r.model?.label ?? null,
        usingCustomEndpoint: r.usingCustomEndpoint,
        runnerInstalled: r.usingCustomEndpoint ? true : runnerIsInstalled(),
        threads,
      };
    },
    async transcribe(pcm, sampleRate, phrases) {
      if (!pcm.length) return null;
      const { target } = await resolveTarget(true);
      if (!target) return null;
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
        if (!res.ok) return null;
        const text = await res.text();
        if (!text) return null;
        // whisper.cpp returns `{"text": "…"}`; OpenAI-compatible returns the same.
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          const value = parsed.text ?? (parsed.data as Record<string, unknown> | undefined)?.text;
          return typeof value === 'string' && value.trim() ? value.trim() : null;
        } catch {
          const plain = text.trim();
          return plain ? plain : null;
        }
      } catch {
        return null;
      }
    },
    dispose() {
      // Never kill a server we did not start (the local-voice lifecycle owns it).
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
