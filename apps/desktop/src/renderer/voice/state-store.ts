/**
 * Renderer-side shared store for the local-voice surface (renderer).
 *
 * Both the "Local speech models" and the "Wake words" settings panels read the
 * same facts: which models are installed, whether the `whisper-server` runner is
 * present, and whether a speech-model wake can transcribe right now. Keeping one
 * polled store (rather than each panel polling the bridge on its own) means:
 *
 *  - installing a model or the runner in one panel is reflected in the other
 *    immediately, without a manual refresh — the user's core complaint was having
 *    to guess when state had changed;
 *  - the polling stops entirely when no panel is mounted, so a closed settings
 *    view costs nothing;
 *  - a completed install can force an immediate re-read instead of waiting for
 *    the next tick.
 *
 * Framework-light and dependency-injected so the polling/ref-counting policy is
 * testable without React or Electron.
 */

import type { LocalVoiceState, VoiceBinaryStatus, WakeSttStatus } from '../../shared/ipc.js';

/** The three bridge reads the store keeps warm. */
export type VoiceStoreReader = {
  localVoiceGetState(): Promise<LocalVoiceState>;
  voiceBinaryStatus(): Promise<VoiceBinaryStatus>;
  wakeSttStatus(): Promise<WakeSttStatus>;
};

export type VoiceSnapshot = {
  /** Every catalog model + settings; null until the first read resolves. */
  state: LocalVoiceState | null;
  /** The speech-engine runner (`whisper-server`) status; null until read. */
  binary: VoiceBinaryStatus | null;
  /** Whether an `stt_phrase` wake can transcribe on-device right now. */
  wakeStt: WakeSttStatus | null;
  /** True while a read is in flight (so the UI can show a subtle spinner). */
  loading: boolean;
};

const EMPTY: VoiceSnapshot = { state: null, binary: null, wakeStt: null, loading: false };

export type VoiceStore = {
  /** Subscribe to snapshot changes; returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** The current snapshot (stable identity until it actually changes). */
  getSnapshot(): VoiceSnapshot;
  /** Ensure polling is running (ref-counted); call from a mount effect. */
  retain(): () => void;
  /** Force an immediate re-read (e.g. right after an install/remove). */
  refresh(): Promise<void>;
};

export type VoiceStoreOptions = {
  reader: VoiceStoreReader;
  /** Poll interval in ms while at least one component is mounted. */
  intervalMs?: number;
  /** Injected for tests. */
  now?: () => number;
};

export function createVoiceStore(options: VoiceStoreOptions): VoiceStore {
  const intervalMs = options.intervalMs ?? 1500;
  const listeners = new Set<() => void>();
  let snapshot: VoiceSnapshot = EMPTY;
  let refs = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;

  function emit(next: VoiceSnapshot): void {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  /** Read all three surfaces in parallel; never throws (a failure keeps the last
   *  good value rather than blanking the panel). */
  async function read(): Promise<void> {
    if (inFlight) return inFlight;
    emit({ ...snapshot, loading: true });
    inFlight = (async () => {
      const [state, binary, wakeStt] = await Promise.all([
        options.reader.localVoiceGetState().catch(() => null),
        options.reader.voiceBinaryStatus().catch(() => null),
        options.reader.wakeSttStatus().catch(() => null),
      ]);
      emit({
        state: state ?? snapshot.state,
        binary: binary ?? snapshot.binary,
        wakeStt: wakeStt ?? snapshot.wakeStt,
        loading: false,
      });
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function startPolling(): void {
    if (timer) return;
    timer = setInterval(() => void read(), intervalMs);
    // A hidden/backgrounded renderer does not need the poll.
    (timer as { unref?: () => void }).unref?.();
  }

  function stopPolling(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    retain() {
      refs += 1;
      if (refs === 1) {
        startPolling();
        void read();
      }
      return () => {
        refs = Math.max(0, refs - 1);
        if (refs === 0) stopPolling();
      };
    },
    async refresh() {
      await read();
    },
  };
}
