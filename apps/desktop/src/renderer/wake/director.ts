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
  /**
   * Build a detector for one resolved binding (null when unavailable).
   *
   * `groupKey` identifies the microphone stream the detector will serve. Detectors
   * that carry per-stream state (the STT-phrase hub's segmentation buffer) must be
   * built *per stream* — a shared buffer would interleave frames from different
   * microphones into one corrupt segment, so nothing ever transcribes.
   */
  buildDetector: (resolution: WakeBindingResolution, groupKey: string) => Promise<WakeDetector | null>;
  /**
   * Optional sample-rate sink for a microphone's STT-phrase hub: called once the
   * stream is live so segment timing matches the real capture rate.
   */
  onSampleRate?: (sampleRate: number, groupKey: string) => void;
  /**
   * Called when a microphone group is torn down, so per-stream resources (the
   * group's STT hub) can be released. Optional; without it resources are dropped
   * when the detector set is rebuilt.
   */
  disposeGroup?: (groupKey: string) => void;
  /**
   * The microphone source for the primary input; injectable for tests. When
   * `wakeInputIds` is non-empty the source is looked up per device via
   * `createMicForDevice` instead, so 0..n extra mics can listen in parallel.
   */
  createMic: () => WakeMicSource;
  /**
   * Build an extra wake-listening microphone for a device id (the secondary
   * microphones configured in audio settings). Optional: without it, only the
   * primary mic is used, preserving single-mic behaviour.
   */
  createMicForDevice?: (deviceId: string) => WakeMicSource;
  /**
   * The 0..n extra microphones that should also listen for wake words. Read from
   * audio settings; the director arms a mic (and a detector set) per device.
   */
  getWakeInputIds?: () => string[];
  /**
   * Initial microphone mute state (the bottom-bar toggle persists it). While
   * muted the director keeps its settings but opens no microphone.
   */
  isInputMuted?: () => boolean;
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

/**
 * One microphone stream and the detectors watching *its* frames. Detectors carry
 * per-stream state (audio buffers), so each microphone gets its own detector set;
 * `firedThisActivation` still de-dupes so a phrase heard on two mics fires once.
 */
type MicGroup = {
  key: string;
  mic: WakeMicSource;
  entries: ArmedBinding[];
};

const DEFAULT_STATE: WakeListenState = {
  enabled: false,
  listening: false,
  activePhrases: [],
  level: 0,
  transcript: null,
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
  /** Reconcile using the already-loaded settings (e.g. after a device/mute change). */
  reconcileNow(): Promise<void>;
  /** Persist new settings (used by the settings UI) and reload. */
  saveSettings(next: WakeSettings): Promise<WakeSettings>;
  /**
   * Record the latest on-device speech-recognition result so the bottom bar can
   * stream the words it heard and highlight the wake word. Called by the STT
   * hub; local-only (drives the UI, never the IPC state report).
   */
  noteTranscript(text: string): void;
  getState(): WakeListenState;
};

export function createWakeDirector(options: WakeDirectorOptions) {
  const smoothing = options.levelSmoothing ?? 0.25;
  const primaryMic = options.createMic();
  /** devicId → mic, for the extra wake-listening microphones (Wave-2). */
  const extraMics = new Map<string, WakeMicSource>();

  let settings: WakeSettings = { ...DEFAULT_WAKE_SETTINGS };
  /** The effective bindings to arm: manual ones plus any auto-mapped agents. */
  let effectiveBindings: WakeWordBinding[] = [];
  /** Live microphone groups: the primary input first, then the extra wake mics. */
  let groups: MicGroup[] = [];
  let state: WakeListenState = { ...DEFAULT_STATE };
  let level = 0;
  /** Latest on-device transcript, for the live caption. UI-only. */
  let transcript: string | null = null;
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
    // Every microphone group arms the SAME bindings, so the union across groups
    // would list each phrase once per microphone. Report the distinct armed
    // phrases instead (first-seen order preserved), never a duplicate.
    const activePhrases: string[] = [];
    const seen = new Set<string>();
    for (const group of groups) {
      for (const entry of group.entries) {
        const phrase = entry.binding.phrase;
        if (seen.has(phrase)) continue;
        seen.add(phrase);
        activePhrases.push(phrase);
      }
    }
    const anyMicActive = groups.some((g) => g.mic.active);
    const anyArmed = groups.some((g) => g.entries.length > 0);
    emit({
      enabled: settings.enabled,
      listening: running && anyMicActive && anyArmed,
      activePhrases,
      level,
      transcript,
      ...(message !== undefined ? { message } : {}),
    });
  }

  /**
   * Handle one frame from *one* microphone: update the shared meter and push the
   * frame through that group's detectors. A binding that already fired this
   * activation is skipped so a phrase heard on two mics still fires once.
   */
  function handleGroupFrame(group: MicGroup, frame: Float32Array): void {
    // Update the meter regardless of detections so the bottom bar stays alive.
    level = smoothLevel(level, frameRms(frame) * 3, smoothing);
    const at = Date.now();
    for (const entry of group.entries) {
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

  /**
   * Resolve every enabled binding once, so each microphone can build its own
   * detector set from the same resolutions. Skips bindings that cannot arm.
   */
  async function resolveBindings(): Promise<{
    resolved: Array<{ binding: WakeWordBinding; resolution: WakeBindingResolution }>;
    reason: string | null;
  }> {
    const resolved: Array<{ binding: WakeWordBinding; resolution: WakeBindingResolution }> = [];
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
      resolved.push({ binding, resolution });
    }
    return { resolved, reason: resolved.length === 0 ? firstReason : null };
  }

  /**
   * Build one detector set (one detector per resolved binding) for a mic group.
   * `groupKey` scopes per-stream detector state (e.g. the STT hub) to this mic, so
   * frames from different microphones never share a segmentation buffer.
   */
  async function buildGroupEntries(
    resolved: Array<{ binding: WakeWordBinding; resolution: WakeBindingResolution }>,
    groupKey: string,
  ): Promise<ArmedBinding[]> {
    const entries: ArmedBinding[] = [];
    for (const { binding, resolution } of resolved) {
      const detector = await options.buildDetector(resolution, groupKey).catch(() => null);
      if (!detector || !detector.detecting) continue;
      entries.push({ binding, detector });
    }
    return entries;
  }

  async function reconcile(): Promise<void> {
    firedThisActivation.clear();
    for (const group of groups) {
      for (const entry of group.entries) entry.detector.dispose?.();
      group.mic.stop();
      options.disposeGroup?.(group.key);
    }
    groups = [];
    for (const mic of extraMics.values()) mic.stop();
    running = false;
    // A caption from the previous configuration would be stale: clear it now.
    transcript = null;

    effectiveBindings = await computeEffectiveBindings(settings);

    if (!settings.enabled || effectiveBindings.every((b) => !b.enabled)) {
      level = 0;
      refreshDerived(null);
      return;
    }

    // Muted: keep the configuration but open no microphone at all.
    if (options.isInputMuted?.()) {
      level = 0;
      refreshDerived('Microphone is muted.');
      return;
    }

    const { resolved, reason } = await resolveBindings();
    if (resolved.length === 0) {
      level = 0;
      refreshDerived(reason);
      return;
    }

    // The primary input is always used; the configured extra wake mics join it.
    const wakeInputIds = options.getWakeInputIds?.() ?? [];
    const candidates: Array<{ key: string; mic: WakeMicSource }> = [
      { key: 'primary', mic: primaryMic },
    ];
    if (options.createMicForDevice) {
      for (const deviceId of wakeInputIds) {
        if (!extraMics.has(deviceId)) extraMics.set(deviceId, options.createMicForDevice(deviceId));
        candidates.push({ key: `device:${deviceId}`, mic: extraMics.get(deviceId)! });
      }
    }

    // Start every mic; keep the ones that came up. Any live mic contributes frames.
    // Each mic gets its own detector set built for its `key`, so per-stream state
    // (the STT segmentation buffer) is never shared across microphones.
    let anyStarted = false;
    for (const candidate of candidates) {
      const entries = await buildGroupEntries(resolved, candidate.key);
      const group: MicGroup = { key: candidate.key, mic: candidate.mic, entries };
      const started = await candidate.mic.start((frame) => handleGroupFrame(group, frame));
      if (started) {
        groups.push(group);
        anyStarted = true;
        options.onSampleRate?.(candidate.mic.sampleRate, candidate.key);
      } else {
        for (const entry of entries) entry.detector.dispose?.();
        options.disposeGroup?.(candidate.key);
      }
    }
    running = anyStarted;
    refreshDerived(anyStarted ? null : (primaryMic.message ?? 'Microphone capture failed.'));
  }

  return {
    async start() {
      settings = await options.bridge.wakeGetSettings().catch(() => settings);
      await reconcile();
    },
    stop() {
      for (const group of groups) {
        group.mic.stop();
        for (const entry of group.entries) entry.detector.dispose?.();
        options.disposeGroup?.(group.key);
      }
      groups = [];
      for (const mic of extraMics.values()) mic.stop();
      running = false;
      firedThisActivation.clear();
      level = 0;
      transcript = null;
      refreshDerived(null);
    },
    async reload() {
      settings = await options.bridge.wakeGetSettings().catch(() => settings);
      await reconcile();
    },
    async reconcileNow() {
      await reconcile();
    },
    noteTranscript(text: string) {
      const trimmed = (text ?? '').trim();
      if (!trimmed) return;
      // Local-only UI update: no IPC chatter for every recognized segment.
      emitLocal({ transcript: trimmed });
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
