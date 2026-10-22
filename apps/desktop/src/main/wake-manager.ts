/**
 * Wake-word manager (main process).
 *
 * Owns two things the renderer cannot:
 *  - the persisted wake settings (`wake.json` in userData), validated through the
 *    same normalizer the UI uses, and
 *  - the reaction to a wake *event*: bringing the window forward so the mapped
 *    agent's chat can open and start dictation.
 *
 * The on-device detection itself runs in the renderer (`@nexus/wake-word` needs
 * Web Audio), which reports live state here for the tray tooltip. This manager
 * never sees audio and never authenticates — a wake only routes to an agent.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  normalizeUtteranceQueue,
  normalizeWakeSettings,
  DEFAULT_WAKE_SETTINGS,
  type QueuedUtterance,
  type WakeSettings,
  type WakeWordBinding,
} from '../shared/wake.js';
import type { WakeBindingResolution } from '../shared/ipc.js';
import type { WakeEngineKind } from '../shared/wake.js';

export type WakeActivation = {
  phrase: string;
  agentId: string | null;
};

/** Internal resolution from the host (carries the raw artifact). */
type HostResolution = {
  binding: WakeBindingResolution['binding'];
  engineKind: WakeEngineKind;
  armed: boolean;
  artifact: { bytes: Uint8Array } | null;
  customSampleFingerprint: WakeBindingResolution['customSampleFingerprint'];
};

export type WakeManagerDeps = {
  settingsPath: string;
  /** Path for the unsent transcript queue (review-after-timeout). */
  queuePath?: string;
  /** Resolve a binding for arming (delegates to the wake host). */
  resolveBinding: (binding: WakeWordBinding | string) => HostResolution | null;
  /**
   * Whether the local STT model a binding points at is installed and runnable
   * (for `stt_phrase`). Absent = assume unavailable, so an uninstalled model is
   * reported honestly rather than arming a detector that can never transcribe.
   */
  localSttReady?: (binding: WakeWordBinding) => boolean;
  /** Persist normalized settings (delegates to the wake host). */
  persist?: (next: WakeSettings) => WakeSettings;
  /** Bring the app to the foreground for the mapped agent. */
  onActivate: (activation: WakeActivation) => void;
  /** Optional hook when live listener state changes (tray tooltip). */
  onStateChange?: (state: unknown) => void;
};

/**
 * Pure mapping from the host resolution to the wire shape the renderer consumes:
 * flattens `artifact.bytes` to `modelBytes` and derives a human-safe
 * `unavailableReason` when the binding cannot be armed.
 */
export function toBindingResolution(
  resolved: HostResolution | null,
  localSttReady = false,
): WakeBindingResolution | null {
  if (!resolved) return null;
  const modelBytes = resolved.artifact?.bytes ?? null;
  let unavailableReason: string | null = null;
  if (!resolved.binding.enabled) unavailableReason = 'This wake word is turned off.';
  else if (resolved.engineKind === 'custom_sample' && !resolved.customSampleFingerprint)
    unavailableReason = 'Record a voice sample for this wake word first.';
  else if (resolved.engineKind === 'stt_phrase' && !resolved.binding.modelId)
    unavailableReason = 'Choose a speech model for this wake word first.';
  else if (resolved.engineKind === 'stt_phrase' && !localSttReady)
    unavailableReason = 'The selected speech model is not installed, or no local speech model is running.';
  else if (resolved.engineKind === 'builtin' && !resolved.binding.modelId)
    unavailableReason = 'Choose a wake-word model first.';
  else if (resolved.engineKind === 'builtin' && !modelBytes)
    unavailableReason = 'The selected wake-word model is not installed yet.';
  return {
    binding: resolved.binding,
    engineKind: resolved.engineKind,
    armed: resolved.armed && unavailableReason === null,
    modelBytes,
    customSampleFingerprint: resolved.customSampleFingerprint ?? null,
    transcribeLocally: resolved.engineKind === 'stt_phrase',
    unavailableReason,
  };
}

export function createWakeManager(deps: WakeManagerDeps) {
  const queuePath = deps.queuePath;

  function readSettings(): WakeSettings {
    if (!existsSync(deps.settingsPath)) return { ...DEFAULT_WAKE_SETTINGS };
    try {
      return normalizeWakeSettings(JSON.parse(readFileSync(deps.settingsPath, 'utf8')) as unknown);
    } catch {
      return { ...DEFAULT_WAKE_SETTINGS };
    }
  }

  function readQueue(): QueuedUtterance[] {
    if (!queuePath || !existsSync(queuePath)) return [];
    try {
      return normalizeUtteranceQueue(JSON.parse(readFileSync(queuePath, 'utf8')) as unknown);
    } catch {
      return [];
    }
  }

  function writeQueue(queue: QueuedUtterance[]): QueuedUtterance[] {
    const normalized = normalizeUtteranceQueue(queue);
    if (queuePath) {
      mkdirSync(dirname(queuePath), { recursive: true });
      writeFileSync(queuePath, JSON.stringify(normalized, null, 2), 'utf8');
    }
    return normalized;
  }

  return {
    getSettings(): WakeSettings {
      return readSettings();
    },
    setSettings(next: unknown): WakeSettings {
      const normalized = normalizeWakeSettings(next);
      mkdirSync(dirname(deps.settingsPath), { recursive: true });
      writeFileSync(deps.settingsPath, JSON.stringify(normalized, null, 2), 'utf8');
      return deps.persist ? deps.persist(normalized) : normalized;
    },
    /** Unsubmitted transcripts kept for review (the `queue` unsent policy). */
    getQueue(): QueuedUtterance[] {
      return readQueue();
    },
    setQueue(next: unknown): QueuedUtterance[] {
      return writeQueue(Array.isArray(next) ? (next as QueuedUtterance[]) : []);
    },
    resolveBinding(bindingOrId: WakeWordBinding | string): WakeBindingResolution | null {
      const resolved = deps.resolveBinding(bindingOrId);
      if (!resolved) return null;
      const ready =
        resolved.engineKind === 'stt_phrase'
          ? (deps.localSttReady?.(resolved.binding) ?? false)
          : false;
      return toBindingResolution(resolved, ready);
    },
    /**
     * A wake fired. Route to the mapped agent; never authenticate. A binding with
     * no agent still raises the window, since the user spoke the word.
     */
    activate(activation: WakeActivation): void {
      deps.onActivate(activation);
    },
    reportState(state: unknown): void {
      deps.onStateChange?.(state);
    },
  };
}

export type WakeManager = ReturnType<typeof createWakeManager>;
