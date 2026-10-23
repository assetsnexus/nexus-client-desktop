/**
 * React bindings for the shared audio store.
 *
 * One module-scope store instance backed by the real bridge, plus a hook that
 * ref-counts mounts so device hotplug polling only runs while a consumer is
 * mounted. Used by the settings panel (device configuration) and the bottom bar
 * (mute toggle + soundwave).
 */

import { useEffect, useSyncExternalStore } from 'react';
import { bridge } from '../bridge.js';
import { setAudioOutputSinkProvider } from '@nexus/chat-core';
import { normalizeAudioSettings, type AudioSettings } from '../../shared/audio.js';
import { createAudioStore, type AudioSnapshot, type AudioStore } from './store.js';

/** Where the mute flags live between restarts (localStorage; not a secret). */
const MUTE_KEY = 'nexus.audio.mute';

function readMute(): { input: boolean; output: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(MUTE_KEY) ?? '{}') as {
      input?: unknown;
      output?: unknown;
    };
    return { input: raw.input === true, output: raw.output === true };
  } catch {
    return { input: false, output: false };
  }
}

function writeMute(mute: { input: boolean; output: boolean }): void {
  try {
    localStorage.setItem(MUTE_KEY, JSON.stringify(mute));
  } catch {
    /* ignore quota/disabled storage */
  }
}

let singleton: AudioStore | null = null;

/** The app-wide audio store (created lazily against the real bridge). */
export function audioStore(): AudioStore {
  if (!singleton) {
    singleton = createAudioStore({
      readSettings: async () => {
        const ui = await bridge.getUiSettings();
        return normalizeAudioSettings(ui.audio);
      },
      writeSettings: async (patch: Partial<AudioSettings>) => {
        const current = normalizeAudioSettings((await bridge.getUiSettings()).audio);
        const merged = normalizeAudioSettings({
          output: { ...current.output, ...patch.output },
          input: { ...current.input, ...patch.input },
        });
        const saved = await bridge.setUiSettings({ audio: merged });
        return normalizeAudioSettings(saved.audio);
      },
      mediaDevices: () =>
        typeof navigator !== 'undefined' && navigator.mediaDevices
          ? (navigator.mediaDevices as unknown as { enumerateDevices: () => Promise<Array<{ deviceId: string; kind: string; label: string }>> })
          : null,
      readMute,
      writeMute,
    });
    // Make every agent utterance follow the configured speaker routing (primary,
    // or the speaker an agent redirected to via its audio tools). The provider is
    // read at playback time, so a change applies to the next utterance without a
    // restart.
    setAudioOutputSinkProvider(() => {
      if (!singleton) return null;
      if (singleton.getSnapshot().outputMuted) return null;
      return singleton.currentOutputDeviceIds();
    });
  }
  return singleton;
}

/** Subscribe to the audio snapshot; keeps hotplug polling alive while mounted. */
export function useAudioSnapshot(): AudioSnapshot {
  const store = audioStore();
  const snapshot = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
  );
  useEffect(() => store.retain(), [store]);
  return snapshot;
}

/**
 * The 0..n extra wake-listening microphone ids, read without React so the wake
 * director can consult them during reconcile. Returns `[]` before settings load.
 */
export function audioWakeInputIds(): string[] {
  try {
    return audioStore().getSnapshot().settings.input.wakeInputIds;
  } catch {
    return [];
  }
}

/** Whether input is currently muted (the bottom-bar toggle), read without React. */
export function isInputMuted(): boolean {
  try {
    return audioStore().getSnapshot().inputMuted;
  } catch {
    return false;
  }
}
