/**
 * Wake director host (renderer).
 *
 * Owns the single wake director instance for the app and exposes it to React.
 * The director must outlive any one component (the bottom bar, the chat host),
 * so it is created once at module scope and shared. Construction is lazy and
 * side-effect-light; `start()` (which opens the microphone) is only called once
 * a component mounts the host.
 *
 * The built-in engine wiring lives here: the wake director is given the real
 * detector builder and microphone source, keeping `director.ts` free of
 * `@nexus/wake-word` / `onnxruntime-web` imports so those heavy chunks stay out
 * of the default bundle until wake is actually enabled.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { bridge, type WakeListenState, type WakeSettings, type WakeWordBinding } from '../bridge.js';
import { buildDetectorWithStt } from './engine.js';
import { createSttPhraseHub, type SttPhraseHub } from './stt-detector.js';
import { createWakeMic } from './mic.js';
import { audioWakeInputIds, isInputMuted } from '../audio/use-audio-store.js';
import { createWakeDirector, type WakeDirector } from './director.js';

/** React subscribers fed by the director's `onStateChange`. */
const listeners = new Set<() => void>();

/**
 * The app-wide bridge slice the director consumes. `onWakeActivated` is not part
 * of it — routing lives in the chat host, which subscribes on its own.
 */
const directorBridge = {
  wakeGetSettings: () => bridge.wakeGetSettings(),
  wakeSetSettings: (next: WakeSettings) => bridge.wakeSetSettings(next),
  wakeListAgents: () => bridge.wakeListAgents(),
  wakeResolveBinding: (binding: WakeWordBinding | string) => bridge.wakeResolveBinding(binding),
  wakeReportState: (state: WakeListenState) => bridge.wakeReportState(state),
  wakeActivated: (payload: { phrase: string; agentId: string | null }) =>
    bridge.wakeActivated(payload),
};

/**
 * One STT-phrase hub **per microphone stream**, shared by every `stt_phrase`
 * binding armed on that stream. A single segmentation + transcription pass
 * serves all phrases (auto-mapping N agents must not mean N transcriptions per
 * utterance), while keeping each microphone's audio in its own buffer so frames
 * from different devices never interleave into a corrupt segment.
 *
 * Transcription is local-only (see `wake-stt.ts`).
 */
const sttHubs = new Map<string, SttPhraseHub>();

function getSttHub(sampleRate: number, groupKey: string): SttPhraseHub {
  let hub = sttHubs.get(groupKey);
  if (!hub || hub.size === 0) {
    hub = createSttPhraseHub({
      sampleRate,
      transcribe: (pcm, rate) =>
        bridge.wakeTranscribeLocal({
          pcm,
          sampleRate: rate,
          // Passage of the currently armed phrases (incl. auto-mapped agent names
          // that main never persists) so the decoder is biased toward them.
          phrases: singleton?.getState().activePhrases ?? [],
        }),
      // Stream what was actually heard into the bottom bar (UI-only).
      onTranscript: (text) => singleton?.noteTranscript(text),
    });
    sttHubs.set(groupKey, hub);
  }
  return hub;
}

/** Release a microphone stream's hub when its group is torn down. */
function disposeSttHub(groupKey: string): void {
  const hub = sttHubs.get(groupKey);
  if (!hub) return;
  hub.reset();
  sttHubs.delete(groupKey);
}

let singleton: WakeDirector | null = null;
/** True once the wake host has been mounted (avoids double-starting). */
let started = false;

const buildDetector = (
  resolution: Parameters<typeof buildDetectorWithStt>[0],
  groupKey: string,
) => buildDetectorWithStt(resolution, { getHub: getSttHub }, undefined, groupKey);

export function wakeDirector(): WakeDirector {
  if (!singleton) {
    singleton = createWakeDirector({
      bridge: directorBridge,
      buildDetector,
      onSampleRate: (rate, groupKey) => sttHubs.get(groupKey)?.setSampleRate(rate),
      disposeGroup: disposeSttHub,
      createMic: () => createWakeMic(),
      // Extra wake-listening microphones (audio settings): each gets its own stream.
      createMicForDevice: (deviceId) => createWakeMic({ deviceId }),
      getWakeInputIds: () => audioWakeInputIds(),
      isInputMuted: () => isInputMuted(),
      onStateChange: () => listeners.forEach((l) => l()),
    });
  }
  return singleton;
}

/** Reopen (or close) capture after the mute toggle or device choice changes. */
export async function reconcileWakeDirector(): Promise<void> {
  await wakeDirector().reconcileNow();
}

/**
 * Subscribe to the live wake listen state (drives the bottom bar). Does not
 * start the director — mount `useWakeHost` for that.
 */
export function useWakeState(): WakeListenState {
  const director = wakeDirector();
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => director.getState(),
  );
}

/** Mount the wake host: start the director exactly once. */
export function useWakeHost(): void {
  useEffect(() => {
    if (started) return;
    started = true;
    void wakeDirector().start();
  }, []);
}

/** Re-read settings and reconcile (called by the settings UI after a save). */
export async function reloadWakeDirector(): Promise<void> {
  await wakeDirector().reload();
}
