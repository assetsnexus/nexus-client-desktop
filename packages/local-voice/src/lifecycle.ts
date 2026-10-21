/**
 * Voice engine lifecycle (@nexus/local-voice).
 *
 * A local STT/TTS engine must not sit in VRAM when nobody is talking. This
 * module is the pure state machine the desktop manager drives: it decides when
 * to start an engine (a session needs it), when to unload it (idle past a
 * timeout), and reports the live state + last-used time for the UI.
 *
 * The actual process/model loading is injected (`engine`), so this is testable
 * without a GPU and is reused by the main process unchanged.
 */

export type EngineLocation = 'cloud' | 'local';

export type EngineState = 'unloaded' | 'loading' | 'ready' | 'error';

export type EngineLifecycleSnapshot = {
  id: string;
  kind: 'stt' | 'tts';
  location: EngineLocation;
  state: EngineState;
  /** Epoch ms of the last request that used this engine. */
  lastUsedAtMs: number | null;
  /** Epoch ms when an idle unload is due; null when not scheduled. */
  unloadAtMs: number | null;
  error: string | null;
};

/** The host-provided engine: load/unload + a tick check-unload decision. */
export type LocalEngine = {
  id: string;
  kind: 'stt' | 'tts';
  load: () => Promise<void>;
  unload: () => Promise<void>;
};

export type IdlePolicy = {
  /** Unload the engine when idle for this long. */
  idleTimeoutMs: number;
  /** Never unload a local engine before this (guards flapping). */
  minLoadedMs?: number;
};

export const DEFAULT_IDLE_POLICY: IdlePolicy = { idleTimeoutMs: 5 * 60_000, minLoadedMs: 15_000 };

export type LifecycleOptions = {
  engines: LocalEngine[];
  policy?: Partial<IdlePolicy>;
  now?: () => number;
};

export type VoiceLifecycle = {
  /** Ensure the engine is loaded (start/stop when needed). */
  acquire(id: string): Promise<EngineLifecycleSnapshot>;
  /** Record that a request just used the engine, resetting the idle timer. */
  touch(id: string): EngineLifecycleSnapshot;
  /** Unload immediately (e.g. the user turned the engine off). */
  release(id: string): Promise<EngineLifecycleSnapshot>;
  /** Unload every engine (app quit). */
  releaseAll(): Promise<EngineLifecycleSnapshot[]>;
  /** Called on an interval: unload engines idle past the timeout. */
  tick(): Promise<EngineLifecycleSnapshot[]>;
  snapshot(): EngineLifecycleSnapshot[];
  get(id: string): EngineLifecycleSnapshot | null;
};

function initialState(engine: LocalEngine): EngineLifecycleSnapshot {
  return {
    id: engine.id,
    kind: engine.kind,
    location: 'local',
    state: 'unloaded',
    lastUsedAtMs: null,
    unloadAtMs: null,
    error: null,
  };
}

/**
 * Create the lifecycle manager. Engines are addressed by id; an unknown id
 * returns a null snapshot from `get` and throws nothing from `acquire` —
 * a clock-only snapshot with state `error`.
 */
export function createVoiceLifecycle(options: LifecycleOptions): VoiceLifecycle {
  const now = options.now ?? (() => Date.now());
  const policy: IdlePolicy = { ...DEFAULT_IDLE_POLICY, ...options.policy };
  const byId = new Map<string, LocalEngine>(options.engines.map((e) => [e.id, e]));
  const state = new Map<string, EngineLifecycleSnapshot>(
    options.engines.map((e) => [e.id, initialState(e)]),
  );
  // Guard against concurrent loads of the same engine.
  const inFlight = new Map<string, Promise<EngineLifecycleSnapshot>>();

  const patch = (id: string, p: Partial<EngineLifecycleSnapshot>): EngineLifecycleSnapshot => {
    const cur = state.get(id)!;
    const next = { ...cur, ...p };
    state.set(id, next);
    return next;
  };

  async function load(id: string): Promise<EngineLifecycleSnapshot> {
    const engine = byId.get(id);
    if (!engine) {
      // Unknown engine — surface a synthetic error snapshot rather than throw.
      return {
        id,
        kind: 'stt',
        location: 'local',
        state: 'error',
        lastUsedAtMs: null,
        unloadAtMs: null,
        error: 'Unknown local engine',
      };
    }
    const cur = state.get(id)!;
    if (cur.state === 'ready') {
      return touch(id);
    }
    patch(id, { state: 'loading', error: null });
    try {
      await engine.load();
      const t = now();
      return patch(id, {
        state: 'ready',
        lastUsedAtMs: t,
        unloadAtMs: t + policy.idleTimeoutMs,
        error: null,
      });
    } catch (err) {
      return patch(id, {
        state: 'error',
        unloadAtMs: null,
        error: err instanceof Error ? err.message : 'Failed to load local engine',
      });
    }
  }

  function touch(id: string): EngineLifecycleSnapshot {
    const cur = state.get(id);
    if (!cur) {
      return {
        id,
        kind: 'stt',
        location: 'local',
        state: 'error',
        lastUsedAtMs: null,
        unloadAtMs: null,
        error: 'Unknown local engine',
      };
    }
    if (cur.state !== 'ready') return cur;
    const t = now();
    return patch(id, { lastUsedAtMs: t, unloadAtMs: t + policy.idleTimeoutMs });
  }

  async function unloadIfIdle(id: string): Promise<EngineLifecycleSnapshot> {
    const cur = state.get(id);
    const engine = byId.get(id);
    if (!cur || !engine) return cur!;
    if (cur.state !== 'ready' || cur.unloadAtMs == null) return cur;
    if (now() < cur.unloadAtMs) return cur;
    // Respect the minimum loaded duration so a rapid acquire/idle cycle cannot
    // thrash the loader.
    if (policy.minLoadedMs && cur.lastUsedAtMs != null) {
      const loadedFor = now() - (cur.unloadAtMs - policy.idleTimeoutMs);
      if (loadedFor < policy.minLoadedMs) return cur;
    }
    try {
      await engine.unload();
    } catch {
      // Even on unload failure, mark unloaded so we do not keep holding VRAM
      // "virtually"; the next acquire will reload.
    }
    return patch(id, { state: 'unloaded', unloadAtMs: null, error: null });
  }

  return {
    async acquire(id) {
      const pending = inFlight.get(id);
      if (pending) return pending;
      const p = load(id).finally(() => inFlight.delete(id));
      inFlight.set(id, p);
      return p;
    },
    touch,
    async release(id) {
      const engine = byId.get(id);
      const cur = state.get(id);
      if (!cur) {
        return {
          id,
          kind: 'stt',
          location: 'local',
          state: 'unloaded',
          lastUsedAtMs: null,
          unloadAtMs: null,
          error: null,
        };
      }
      if (!engine || cur.state === 'unloaded') return cur;
      try {
        await engine.unload();
      } catch {
        /* ignore */
      }
      return patch(id, { state: 'unloaded', unloadAtMs: null, error: null });
    },
    async releaseAll() {
      const out: EngineLifecycleSnapshot[] = [];
      for (const id of byId.keys()) out.push(await this.release(id));
      return out;
    },
    async tick() {
      const out: EngineLifecycleSnapshot[] = [];
      for (const id of byId.keys()) out.push(await unloadIfIdle(id));
      return out;
    },
    snapshot() {
      return [...state.values()];
    },
    get(id) {
      return state.get(id) ?? null;
    },
  };
}
