/**
 * React bindings for the shared local-voice store.
 *
 * One module-scope store instance backed by the real bridge, plus a hook that
 * ref-counts mounts. Both panels (Local speech models + Wake words) use the same
 * instance, so an install in one is visible in the other instantly.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { bridge } from '../bridge.js';
import { createVoiceStore, type VoiceSnapshot, type VoiceStore } from './state-store.js';

let singleton: VoiceStore | null = null;

/** The app-wide voice store (created lazily against the real bridge). */
export function voiceStore(): VoiceStore {
  if (!singleton) {
    singleton = createVoiceStore({
      reader: {
        localVoiceGetState: () => bridge.localVoiceGetState(),
        voiceBinaryStatus: () => bridge.voiceBinaryStatus(),
        wakeSttStatus: () => bridge.wakeSttStatus(),
      },
    });
  }
  return singleton;
}

/** Subscribe to the shared snapshot; keeps polling alive while mounted. */
export function useVoiceSnapshot(): VoiceSnapshot {
  const store = voiceStore();
  const snapshot = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
  );
  useEffect(() => store.retain(), [store]);
  return snapshot;
}

/** Force an immediate re-read (call right after an install/remove/settings save). */
export function refreshVoiceState(): Promise<void> {
  return voiceStore().refresh();
}
