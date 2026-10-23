/**
 * Audio device store (renderer).
 *
 * Owns the app-wide audio preferences — primary/allowed speakers, primary
 * dictation microphone, and 0..n extra wake-listening microphones — plus the live
 * mute state and the resolved output routing an agent may target.
 *
 * Device *ids* are all that is persisted; labels are re-read from
 * `navigator.mediaDevices.enumerateDevices()` each session (they need a mic
 * permission grant before Chromium will fill them in). A configured device that
 * is no longer present is reported as unavailable rather than dropped.
 *
 * Deliberately dependency-injected and framework-free so the policy
 * (normalize, resolve targets, de-dupe, mute) is unit-testable without a browser.
 */

import {
  DEFAULT_AUDIO_SETTINGS,
  hasAgentOutputTargets,
  normalizeAudioSettings,
  resolveOutputTargets,
  type AudioOutputTarget,
  type AudioSettings,
} from '../../shared/audio.js';

/** A selectable input or output device. */
export type AudioDevice = {
  deviceId: string;
  label: string;
  /** True when this is the OS default for its kind. */
  isDefault: boolean;
  /** True when the configured id refers to a device that is not connected now. */
  available: boolean;
};

export type AudioSnapshot = {
  settings: AudioSettings;
  inputs: AudioDevice[];
  outputs: AudioDevice[];
  /** Where agent speech currently goes (`primary` unless an agent redirected it). */
  outputTarget: AudioOutputTarget;
  /** Muted input: no microphone capture (wake + dictation pause). */
  inputMuted: boolean;
  /** Muted output: agent speech is suppressed locally. */
  outputMuted: boolean;
  /** True when the OS granted microphone permission (labels populated). */
  hasMicPermission: boolean;
};

export type MediaDevicesLike = {
  enumerateDevices: () => Promise<Array<{ deviceId: string; kind: string; label: string }>>;
};

export type AudioStoreDeps = {
  /** Read the persisted UI settings (which carry the `audio` block). */
  readSettings: () => Promise<AudioSettings>;
  /** Persist a partial `audio` update. */
  writeSettings: (patch: Partial<AudioSettings>) => Promise<AudioSettings>;
  /** Media device enumeration; injectable for tests. */
  mediaDevices: () => MediaDevicesLike | null;
  /** Persistable mute state (kept alongside settings; injectable). */
  readMute?: () => { input: boolean; output: boolean };
  writeMute?: (mute: { input: boolean; output: boolean }) => void;
};

export type AudioStore = {
  getSnapshot(): AudioSnapshot;
  subscribe(listener: () => void): () => void;
  retain(): () => void;
  /** Re-read settings + devices. */
  refresh(): Promise<void>;
  setPatch(patch: Partial<AudioSettings>): Promise<void>;
  setInputMuted(muted: boolean): void;
  setOutputMuted(muted: boolean): void;
  toggleInputMuted(): boolean;
  setOutputTarget(target: AudioOutputTarget): void;
  /** Concrete device ids agent speech should currently play on. */
  currentOutputDeviceIds(): string[];
  /** True when the user lets an agent redirect/broadcast speech at all. */
  agentCanRoute(): boolean;
};

/** Human label for a device, falling back to its kind + position. */
function deviceLabel(raw: { label: string }, kind: 'input' | 'output', index: number): string {
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (label) return label;
  return kind === 'input' ? `Microphone ${index + 1}` : `Speaker ${index + 1}`;
}

/**
 * Build the device lists from raw enumeration, marking the OS default and any
 * configured-but-absent device so the UI can show it as unavailable.
 */
export function buildAudioDevices(
  raw: Array<{ deviceId: string; kind: string; label: string }>,
  settings: AudioSettings,
): { inputs: AudioDevice[]; outputs: AudioDevice[] } {
  const configuredInputs = new Set(
    [settings.input.primaryInputId, ...settings.input.wakeInputIds].filter(
      (id): id is string => Boolean(id),
    ),
  );
  const configuredOutputs = new Set(
    [settings.output.primaryOutputId, ...settings.output.allowedOutputIds].filter(
      (id): id is string => Boolean(id),
    ),
  );

  const inputs: AudioDevice[] = [];
  const outputs: AudioDevice[] = [];
  let inputIndex = 0;
  let outputIndex = 0;
  for (const device of raw) {
    if (device.kind === 'audioinput') {
      inputs.push({
        deviceId: device.deviceId,
        label: deviceLabel(device, 'input', inputIndex++),
        isDefault: device.deviceId === 'default' || device.deviceId === '',
        available: true,
      });
    } else if (device.kind === 'audiooutput') {
      outputs.push({
        deviceId: device.deviceId,
        label: deviceLabel(device, 'output', outputIndex++),
        isDefault: device.deviceId === 'default' || device.deviceId === '',
        available: true,
      });
    }
  }

  // Surface configured-but-absent devices so a user notices a moved speaker.
  const seenInputs = new Set(inputs.map((d) => d.deviceId));
  for (const id of configuredInputs) {
    if (!seenInputs.has(id)) {
      inputs.push({ deviceId: id, label: 'Unavailable microphone', isDefault: false, available: false });
    }
  }
  const seenOutputs = new Set(outputs.map((d) => d.deviceId));
  for (const id of configuredOutputs) {
    if (!seenOutputs.has(id)) {
      outputs.push({ deviceId: id, label: 'Unavailable speaker', isDefault: false, available: false });
    }
  }

  return { inputs, outputs };
}

export function createAudioStore(deps: AudioStoreDeps): AudioStore {
  const listeners = new Set<() => void>();
  let retainCount = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  let snapshot: AudioSnapshot = {
    settings: DEFAULT_AUDIO_SETTINGS,
    inputs: [],
    outputs: [],
    outputTarget: 'primary',
    inputMuted: deps.readMute?.().input ?? false,
    outputMuted: deps.readMute?.().output ?? false,
    hasMicPermission: false,
  };

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function set(next: Partial<AudioSnapshot>): void {
    snapshot = { ...snapshot, ...next };
    emit();
  }

  async function readDevices(): Promise<{
    inputs: AudioDevice[];
    outputs: AudioDevice[];
    hasMicPermission: boolean;
  }> {
    const devices = deps.mediaDevices();
    if (!devices) return { inputs: [], outputs: [], hasMicPermission: false };
    try {
      const raw = await devices.enumerateDevices();
      const built = buildAudioDevices(raw, snapshot.settings);
      // Chromium fills labels only once a mic permission grant exists.
      const hasMicPermission = raw.some((d) => d.kind === 'audioinput' && d.label?.trim());
      return { ...built, hasMicPermission };
    } catch {
      return { inputs: [], outputs: [], hasMicPermission: false };
    }
  }

  async function refresh(): Promise<void> {
    const settings = normalizeAudioSettings(await deps.readSettings().catch(() => snapshot.settings));
    snapshot = { ...snapshot, settings };
    const devices = await readDevices();
    set(devices);
  }

  /** Keep device hotplug reflected while the store is mounted. */
  function ensurePolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => void refresh(), 4000);
  }
  function maybeStopPolling(): void {
    if (retainCount > 0 || !pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retain() {
      retainCount += 1;
      ensurePolling();
      void refresh();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retainCount = Math.max(0, retainCount - 1);
        maybeStopPolling();
      };
    },
    refresh,
    async setPatch(patch) {
      const merged = normalizeAudioSettings({
        output: { ...snapshot.settings.output, ...patch.output },
        input: { ...snapshot.settings.input, ...patch.input },
      });
      const saved = await deps.writeSettings(merged).catch(() => merged);
      set({ settings: normalizeAudioSettings(saved) });
      await refresh();
    },
    setInputMuted(muted) {
      const next = { input: muted, output: snapshot.outputMuted };
      deps.writeMute?.(next);
      set({ inputMuted: muted });
    },
    setOutputMuted(muted) {
      const next = { input: snapshot.inputMuted, output: muted };
      deps.writeMute?.(next);
      set({ outputMuted: muted });
    },
    toggleInputMuted() {
      const next = !snapshot.inputMuted;
      this.setInputMuted(next);
      return next;
    },
    setOutputTarget(target) {
      set({ outputTarget: target });
    },
    currentOutputDeviceIds() {
      return resolveOutputTargets(snapshot.settings, snapshot.outputTarget);
    },
    agentCanRoute() {
      return hasAgentOutputTargets(snapshot.settings);
    },
  };
}
