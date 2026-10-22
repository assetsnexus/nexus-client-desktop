/**
 * Wake-word listening director (renderer).
 *
 * Owns the runtime side of wake listening for the desktop app: it loads the
 * persisted settings, arms one on-device detector per enabled binding over a
 * *single* microphone stream, tracks a smoothed input level for the bottom-bar
 * visualizer, and reports activations.
 *
 * Deliberately framework-free and dependency-injected so the whole policy
 * (arm/disarm, level smoothing, phrase routing, error states) is unit-testable
 * without React, Electron, or a real microphone.
 *
 * TRUST: a wake only ever reports which phrase fired and which agent it maps to.
 * It never authenticates, never dispatches a command, and never leaves the
 * machine with audio. See `@nexus/wake-word` `WAKE_WORD_TRUST`.
 */

import type {
  WakeAgentRow,
  WakeSettings,
  WakeWordBinding,
} from '../../shared/wake.js';
import { DEFAULT_WAKE_SETTINGS } from '../../shared/wake.js';
import { isAutoBinding, withAutoMappedBindings } from '../../shared/wake-automap.js';
import type { WakeBindingResolution, WakeListenState } from '../../shared/ipc.js';
import type { WakeDetector } from './engine.js';
import type { WakeMicSource } from './mic.js';
import { frameRms } from './mic.js';

/** The bridge surface the director needs (a slice of `NexusBridge`). */
export type WakeDirectorBridge = {
  wakeGetSettings(): Promise<WakeSettings>;
  wakeSetSettings(next: WakeSettings): Promise<WakeSettings>;
  /** The mappable agents, so names can be auto-mapped to wake words. */
  wakeListAgents(): Promise<WakeAgentRow[]>;
  wakeResolveBinding(binding: WakeWordBinding | string): Promise<WakeBindingResolution | null>;
  wakeReportState(state: WakeListenState): Promise<void>;
  wakeActivated(payload: { phrase: string; agentId: string | null }): Promise<void>;
};
export type WakeActivationHandler = (input: {
  binding: WakeWordBinding;
  confidence: number | null;
}) => void;

export type WakeDirectorOptions = {
  bridge: WakeDirectorBridge;
  /** Build a detector for one resolved binding (null when unavailable). */
  buildDetector: (resolution: WakeBindingResolution) => Promise<WakeDetector | null>;
  /**
   * Optional sample-rate sink for the STT-phrase hub: called once the microphone
   * is live so segment timing matches the real capture rate.
   */
  onSampleRate?: (sampleRate: number) => void;
  /** The microphone source; injectable for tests. */
  createMic: () => WakeMicSource;
  /** Called when a phrase fires, after main has been told to raise the window. */
  onActivate?: WakeActivationHandler;
  /** Notified on every state change (drives the bottom bar). */
  onStateChange?: (state: WakeListenState) => void;
  /** Level smoothing factor 0..1 (higher = snappier). */
  levelSmoothing?: number;
};

/** An armed binding and the detector watching for its phrase. */
type ArmedBinding = {
  binding: WakeWordBinding;
  detector: WakeDetector;
};

const DEFAULT_STATE: WakeListenState = {
  enabled: false,
  listening: false,
  activePhrases: [],
  level: 0,
  lastDetection: null,
  message: null,
};

/**
 * Pure level smoothing used by the visualizer and by tests. Keeps the meter from
 * jittering frame to frame: `next = prev*(1-k) + sample*k`.
 */
export function smoothLevel(prev: number, sample: number, k: number): number {
  const clamped = Math.min(1, Math.max(0, sample));
  const factor = Math.min(1, Math.max(0, k));
  return prev * (1 - factor) + clamped * factor;
}

export type WakeDirector = {
  /** Load settings and (if enabled) begin listening. */
  start(): Promise<void>;
  /** Stop listening and release the microphone. */
  stop(): void;
  /** Re-read settings and reconcile the armed detectors. */
  reload(): Promise<void>;
  /** Persist new settings (used by the settings UI) and reload. */
  saveSettings(next: WakeSettings): Promise<WakeSettings>;
  getState(): WakeListenState;
};

export function createWakeDirector(options: WakeDirectorOptions) {
  const smoothing = options.levelSmoothing ?? 0.25;
  const mic = options.createMic();

  let settings: WakeSettings = { ...DEFAULT_WAKE_SETTINGS };
  /** The effective bindings to arm: manual ones plus any auto-mapped agents. */
  let effectiveBindings: WakeWordBinding[] = [];
  let armed: ArmedBinding[] = [];
  let state: WakeListenState = { ...DEFAULT_STATE };
  let level = 0;
  let running = false;
  /** Bindings whose detector fired this activation, so one phrase fires once. */
  const firedThisActivation = new Set<string>();

  function emit(patch: Partial<WakeListenState>): void {
    state = { ...state, ...patch };
    options.onStateChange?.(state);
    void options.bridge.wakeReportState(state).catch(() => undefined);
  }

  /**
   * Update local listeners (the meter) without the ~25/s IPC chatter: main only
   * needs *meaningful* changes for the tray tooltip, not every level frame.
   */
  function emitLocal(patch: Partial<WakeListenState>): void {
    state = { ...state, ...patch };
    options.onStateChange?.(state);
  }

  /**
   * Compute the bindings to arm: manual ones plus, when auto-map is on, one per
   * agent named after that agent. Kept in the director (which owns the live
   * settings) so the bottom bar, the arm loop, and the settings UI all agree.
   */
  async function computeEffectiveBindings(next: WakeSettings): Promise<WakeWordBinding[]> {
    if (!next.autoMapAgents) return [...next.bindings];
    const agents = await options.bridge.wakeListAgents().catch(() => [] as WakeAgentRow[]);
    return withAutoMappedBindings({
      manual: next.bindings,
      agents,
      autoMap: true,
      mode: next.autoMapMode,
      ids: next.autoMapIds,
      defaultModelId: next.autoMapModelId,
      // Derived bindings must not collide with the user's own phrases.
      reservedPhrases: next.bindings.map((b) => b.phrase),
      existing: effectiveBindings.filter(isAutoBinding),
    });
  }

  /** Recompute the derived fields (phrases, listening) and push them. */
  function refreshDerived(message?: string | null): void {
    const activePhrases = armed.map((a) => a.binding.phrase);
    emit({
      enabled: settings.enabled,
      listening: running && mic.active && armed.length > 0,
      activePhrases,
      level,
      ...(message !== undefined ? { message } : {}),
    });
  }

  function handleFrame(frame: Float32Array): void {
    // Update the meter regardless of detections so the bottom bar stays alive.
    level = smoothLevel(level, frameRms(frame) * 3, smoothing);
    const at = Date.now();
    for (const entry of armed) {
      if (firedThisActivation.has(entry.binding.id)) continue;
      let result: { fired: boolean; confidence: number | null };
      try {
        result = entry.detector.push({ frame, at });
      } catch {
        // A detector must never crash the listening loop.
        continue;
      }
      if (!result.fired) continue;
      firedThisActivation.add(entry.binding.id);
      void fire(entry.binding, result.confidence);
    }
    emitLocal({ level });
  }

  async function fire(binding: WakeWordBinding, confidence: number | null): Promise<void> {
    const next = {
      lastDetection: { phrase: binding.phrase, agentId: binding.agentId, at: Date.now() },
    };
    emit(next);
    // Tell main first (raises the window), then let the UI route to the agent.
    await options.bridge
      .wakeActivated({ phrase: binding.phrase, agentId: binding.agentId })
      .catch(() => undefined);
    options.onActivate?.({ binding, confidence });
  }

  /** Build detectors for every enabled binding; skip the ones that cannot arm. */
  async function armAll(): Promise<{ armed: ArmedBinding[]; reason: string | null }> {
    const next: ArmedBinding[] = [];
    let firstReason: string | null = null;
    for (const binding of effectiveBindings) {
      if (!binding.enabled) continue;
      const resolution = await options.bridge.wakeResolveBinding(binding).catch(() => null);
      if (!resolution) {
        firstReason ??= 'A wake word could not be resolved.';
        continue;
      }
      if (!resolution.armed) {
        firstReason ??= resolution.unavailableReason ?? 'A wake word is not ready.';
        continue;
      }
      const detector = await options.buildDetector(resolution).catch(() => null);
      if (!detector || !detector.detecting) {
        firstReason ??= 'Wake detection is unavailable for a configured word.';
        continue;
      }
      next.push({ binding, detector });
    }
    return { armed: next, reason: next.length === 0 ? firstReason : null };
  }

  async function reconcile(): Promise<void> {
    firedThisActivation.clear();
    for (const entry of armed) entry.detector.dispose?.();
    armed = [];
    mic.stop();
    running = false;

    effectiveBindings = await computeEffectiveBindings(settings);

    if (!settings.enabled || effectiveBindings.every((b) => !b.enabled)) {
      level = 0;
      refreshDerived(null);
      return;
    }

    const { armed: nextArmed, reason } = await armAll();
    armed = nextArmed;
    if (armed.length === 0) {
      level = 0;
      refreshDerived(reason);
      return;
    }

    const started = await mic.start(handleFrame);
    running = started;
    if (started) options.onSampleRate?.(mic.sampleRate);
    refreshDerived(started ? null : (mic.message ?? 'Microphone capture failed.'));
  }

  return {
    async start() {
      settings = await options.bridge.wakeGetSettings().catch(() => settings);
      await reconcile();
    },
    stop() {
      mic.stop();
      for (const entry of armed) entry.detector.dispose?.();
      armed = [];
      running = false;
      firedThisActivation.clear();
      level = 0;
      refreshDerived(null);
    },
    async reload() {
      settings = await options.bridge.wakeGetSettings().catch(() => settings);
      await reconcile();
    },
    async saveSettings(next) {
      settings = await options.bridge.wakeSetSettings(next);
      await reconcile();
      return settings;
    },
    getState() {
      return state;
    },
  } satisfies WakeDirector;
}
