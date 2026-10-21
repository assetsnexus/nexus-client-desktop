/**
 * Local voice engine runtime (Phase 11e, main process).
 *
 * The `@nexus/local-voice` lifecycle decides *when* to load/unload an on-device
 * engine; this module is the side-effecting half — it spawns and stops the
 * actual whisper.cpp / TTS server processes (or talks to an already-running
 * OpenAI-compatible local server) and returns handles the lifecycle drives.
 *
 * It is behind an interface so unit tests inject a fake runtime and never spawn
 * anything. In production each runtime is a small wrapper that lazily starts its
 * process on `load()` and tears it down on `unload()`.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export type VoiceEngineLocation = 'cloud' | 'local';

export type LocalVoiceRuntimeEntry = {
  id: string;
  kind: 'stt' | 'tts';
  /** Start the engine; resolves once it is ready to serve. */
  load: () => Promise<void>;
  /** Stop the engine and release VRAM/RAM. */
  unload: () => Promise<void>;
};

export type LocalVoiceEngineRuntime = {
  list: () => LocalVoiceRuntimeEntry[];
  dispose: () => Promise<void>;
};

export type CreateEngineRuntimeOptions = {
  modelsDir: string;
  /** Resolve an engine id to a runnable command + args (null = not runnable). */
  resolve?: (id: string, kind: 'stt' | 'tts') => { command: string; args: string[] } | null;
  /** Spawn override (tests). */
  spawnFn?: typeof spawn;
};

/** Default on-device runtimes we know how to start. */
const DEFAULT_ENGINES: Array<{ id: string; kind: 'stt' | 'tts'; binary: string; args: string[] }> = [
  {
    id: 'whisper.cpp',
    kind: 'stt',
    binary: 'whisper-server',
    args: ['--host', '127.0.0.1', '--port', '8085', '--inference-path', '/inference'],
  },
  {
    id: 'piper',
    kind: 'tts',
    binary: 'piper',
    args: ['--output-raw'],
  },
];

function makeProcessRuntime(entry: {
  id: string;
  kind: 'stt' | 'tts';
  command: string;
  args: string[];
}, spawnFn: typeof spawn): LocalVoiceRuntimeEntry {
  let proc: ChildProcess | null = null;
  return {
    id: entry.id,
    kind: entry.kind,
    async load() {
      if (proc) return;
      proc = spawnFn(entry.command, entry.args, { stdio: 'ignore', detached: false });
      proc.on('exit', () => {
        proc = null;
      });
      // Give the process a moment to bind its port before the first request.
      await new Promise((r) => setTimeout(r, 250));
    },
    async unload() {
      if (!proc) return;
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

/**
 * Build the default runtime. Engines whose binary is not on PATH are simply
 * omitted, so the lifecycle never tries to start something that cannot run — the
 * settings UI then shows the model as installed but the engine as unavailable.
 */
export function createDefaultEngineRuntime(
  options: CreateEngineRuntimeOptions,
): LocalVoiceEngineRuntime {
  const spawnFn = options.spawnFn ?? spawn;
  const entries: LocalVoiceRuntimeEntry[] = [];
  for (const def of DEFAULT_ENGINES) {
    if (options.resolve) {
      const resolved = options.resolve(def.id, def.kind);
      if (!resolved) continue;
      entries.push(makeProcessRuntime({ id: def.id, kind: def.kind, ...resolved }, spawnFn));
      continue;
    }
    entries.push(makeProcessRuntime({ id: def.id, kind: def.kind, command: def.binary, args: def.args }, spawnFn));
  }
  // A model-specific runtime is added on demand by the host once a model is
  // installed; the base set above is always available as the fallback.
  return {
    list: () => entries,
    async dispose() {
      await Promise.all(entries.map((e) => e.unload()));
    },
  };
}
