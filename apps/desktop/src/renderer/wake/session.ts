/**
 * Wake dictation session (renderer, pure state machine).
 *
 * Owns the *behaviour* half of a wake: after a phrase fires, the user may speak in
 * several bursts, each transcribed and appended to one buffer. The session ends
 * when the user speaks a submit phrase, clicks submit, or the inactivity timeout
 * fires — and only then does it decide whether to send, queue, or discard.
 *
 * Everything is dependency-injected (`speak`, `finish`, `now`) so the whole policy
 * is unit-testable without a microphone, a clock, or the region. The live preview
 * is exposed as observable state so the UI can render partial STT as it arrives.
 *
 * TRUST: a session only ever produces a *user* message for a conversation the user
 * can already write to. It never authenticates, approves, or dispatches.
 */

import {
  appendTranscript,
  matchSubmitPhrase,
  resolveAgentByName,
  resolveUnsent,
  type QueuedUtterance,
  type TranscriptAgent,
} from './transcript.js';
import type { WakeActivationMode, WakeUnsentPolicy } from '../../shared/wake.js';

export type SessionTarget = {
  agentId: string | null;
  agentName: string | null;
  phrase: string | null;
};

export type SessionStatus =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'review'
  | 'submitted'
  | 'discarded'
  | 'queued'
  | 'error';

export type SessionState = {
  status: SessionStatus;
  /** Committed text from completed bursts. */
  buffer: string;
  /** Partial STT of the turn currently being spoken (live preview). */
  partial: string;
  /** `buffer` + `partial`, for the live transcript display. */
  preview: string;
  target: SessionTarget;
  /** Non-fatal reason copy (e.g. mic unavailable). */
  message: string | null;
  /**
   * True when this session's dictation transcribes in the cloud (audio leaves
   * the device). The UI must then keep a visible surface up so the user always
   * knows their speech is being streamed. On-device transcription is `false`.
   */
  cloudTranscription: boolean;
  /**
   * Accumulated length of the parallel audio batch recorded during this turn,
   * ms. The widget offers "send as voice" when this is non-zero, so a user can
   * fall back to a normal cloud/custom STT message when the on-device transcript
   * is poor (or when no local engine is installed at all).
   */
  batchDurationMs: number;
  /** Number of VAD bursts folded into the batch so far. */
  batchChunks: number;
  /** True once the batch holds audio that can be sent as a voice message. */
  batchAvailable: boolean;
  /** True while a "send the audio" submit is in flight. */
  sendingAudio: boolean;
};

export type SessionOptions = {
  mode: WakeActivationMode;
  reviewBeforeSend: boolean;
  submitPhrases: readonly string[];
  unsentPolicy: WakeUnsentPolicy;
  timeoutMs: number;
  /** Known agents, for speak-led routing ("Bob, …"). */
  agents: readonly TranscriptAgent[];
  /** The agent the wake was bound to, if any (the session's initial target). */
  initialTarget?: SessionTarget;
  /**
   * True when dictation transcribes in the cloud (audio is streamed). Surfaced
   * in state so the UI keeps a visible "streaming" surface up.
   */
  cloudTranscription?: boolean;
  /**
   * Run one dictation turn. `onPartial` streams the live STT preview. Resolves
   * with the recognised text, or null when nothing was heard. Rejections are
   * surfaced as an error state.
   */
  dictate: (onPartial: (text: string) => void) => Promise<string | null>;
  /** Deliver the text as the user's message to the target conversation. */
  send: (input: { agentId: string | null; text: string }) => Promise<void>;
  /**
   * Deliver the recorded audio batch as a normal voice message (cloud / custom
   * STT applies). Optional: without it the widget shows no "send as voice"
   * action. Resolves false when there is nothing to send.
   */
  sendAudio?: () => Promise<boolean>;
  /** Keep an unsubmitted utterance for later review (queue policy). */
  enqueue: (entry: QueuedUtterance) => void;
  onStateChange?: (state: SessionState) => void;
  /** Clock, injectable for deterministic tests. */
  now?: () => number;
  /** Id factory, injectable for deterministic tests. */
  newId?: () => string;
};

export type WakeSession = {
  readonly state: SessionState;
  /** Begin: open dictation and keep accumulating until submit / timeout / cancel. */
  start(): void;
  /** Finish the current burst early (the user pressed stop). */
  stopTurn(): void;
  /** Submit the buffer now (manual submit via click). */
  submit(): Promise<void>;
  /**
   * Send the recorded audio as a normal voice message (cloud/custom STT). A
   * no-op when the session has no `sendAudio` or no audio was recorded.
   */
  submitAudio(): Promise<void>;
  /** Update the recorded audio-batch progress shown by the widget. */
  setBatch(info: { durationMs: number; chunks: number }): void;
  /**
   * Replace the committed buffer with user-edited text (the widget's input
   * field). Also folds the live partial into the buffer and clears it, so a
   * manual edit — or submitting the visible live transcript — never races the
   * in-flight preview. Counts as activity, so it delays the inactivity timeout.
   */
  setBuffer(text: string): void;
  /** Abandon the session; nothing is sent or queued. */
  cancel(): void;
  /** The inactivity timer fired — apply the unsent policy. */
  timeout(): Promise<void>;
  /** Force a state emit (tests drive the clock manually). */
  sync(): void;
};

export function createWakeSession(options: SessionOptions): WakeSession {
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => `utt-${now()}-${Math.random().toString(36).slice(2, 7)}`);

  let state: SessionState = {
    status: 'idle',
    buffer: '',
    partial: '',
    preview: '',
    target: options.initialTarget ?? { agentId: null, agentName: null, phrase: null },
    message: null,
    cloudTranscription: options.cloudTranscription === true,
    batchDurationMs: 0,
    batchChunks: 0,
    batchAvailable: false,
    sendingAudio: false,
  };
  let lastActivityAt = now();
  /** True once the session should stop capturing further bursts. */
  let captureStopped = false;
  /** True once the session has reached a terminal outcome (sent/queued/discarded/error). */
  let terminal = false;
  let turnInFlight = false;
  /** True while a manual submit is in flight, to avoid a double send. */
  let sending = false;

  function emit(patch: Partial<SessionState>): void {
    const nextBuffer = patch.buffer ?? state.buffer;
    const nextPartial = patch.partial ?? state.partial;
    state = {
      ...state,
      ...patch,
      preview: appendTranscript(nextBuffer, nextPartial),
    };
    options.onStateChange?.(state);
  }

  /** True when the inactivity timeout has elapsed since the last speech. */
  function timedOut(): boolean {
    return now() - lastActivityAt >= options.timeoutMs;
  }

  /** Capture bursts in a loop until the session submits, cancels, or goes quiet. */
  async function runTurn(): Promise<void> {
    if (captureStopped || terminal || turnInFlight) return;
    turnInFlight = true;
    try {
      // A single dictation turn may yield nothing (no speech); that ends the loop
      // and leaves the inactivity timeout to resolve the session.
      while (!captureStopped && !terminal) {
        emit({ status: 'listening', message: null });
        const text = await options.dictate((partial) => {
          lastActivityAt = now();
          emit({ partial });
        });
        if (captureStopped || terminal) return;
        lastActivityAt = now();
        const trimmed = (text ?? '').trim();
        if (!trimmed) {
          emit({ partial: '', status: 'listening' });
          return;
        }
        ingestBurst(trimmed);
      }
    } catch (err) {
      captureStopped = true;
      terminal = true;
      emit({
        status: 'error',
        partial: '',
        message: err instanceof Error ? err.message : 'Dictation failed.',
      });
    } finally {
      turnInFlight = false;
    }
  }

  /** Fold one recognized burst into the buffer and act on it. */
  function ingestBurst(text: string): void {
    const routing = resolveAgentByName(text, options.agents);
    if (routing) {
      // Speak-led routing: retarget the session and keep the instruction.
      emit({ target: { ...state.target, agentId: routing.agentId, agentName: routing.agentName } });
      text = routing.text;
    }

    const withBuffer = appendTranscript(state.buffer, text);
    const match = matchSubmitPhrase(withBuffer, options.submitPhrases);
    emit({ buffer: match.text, partial: '' });

    if (match.submitted) {
      // A spoken submit phrase ends the turn: stop capturing, then either hold for
      // review or send immediately when the user turned review off.
      captureStopped = true;
      if (options.reviewBeforeSend) {
        emit({ status: 'review' });
      } else {
        void submit();
      }
      return;
    }
    // No submit phrase yet: keep listening for the next burst.
    emit({ status: 'listening' });
  }

  /**
   * Fold the live partial into the committed buffer and clear it. Called before
   * a manual submit/edit so whatever the user can *see* in the field is what
   * gets sent — a partial was previously invisible to Send, which is why the
   * widget felt like it "never streamed" and could not be submitted.
   */
  function foldPartial(): void {
    const combined = appendTranscript(state.buffer, state.partial);
    if (combined !== state.buffer) emit({ buffer: combined, partial: '' });
  }

  async function submit(): Promise<void> {
    if (sending) return;
    foldPartial();
    const buffer = state.buffer.trim();
    if (!buffer) {
      captureStopped = true;
      terminal = true;
      emit({ status: 'discarded', partial: '' });
      return;
    }
    sending = true;
    captureStopped = true;
    terminal = true;
    emit({ status: 'submitted', partial: '' });
    try {
      await options.send({ agentId: state.target.agentId, text: buffer });
    } catch (err) {
      emit({ message: err instanceof Error ? err.message : 'Could not send the transcript.' });
    } finally {
      sending = false;
    }
  }

  /**
   * Send the recorded audio as a voice message. The transcript buffer is left
   * untouched (the user chose the audio path instead); a failure surfaces a
   * non-fatal message so the widget can offer the text path again.
   */
  async function submitAudio(): Promise<void> {
    if (sending || state.sendingAudio) return;
    if (!options.sendAudio) return;
    emit({ sendingAudio: true, message: null });
    try {
      const sent = await options.sendAudio();
      if (!sent) {
        emit({ sendingAudio: false, message: 'There was no audio to send.' });
        return;
      }
      captureStopped = true;
      terminal = true;
      emit({ status: 'submitted', sendingAudio: false, partial: '' });
    } catch (err) {
      emit({
        sendingAudio: false,
        message: err instanceof Error ? err.message : 'Could not send the audio.',
      });
    }
  }

  return {
    get state() {
      return state;
    },
    start() {
      captureStopped = false;
      terminal = false;
      lastActivityAt = now();
      emit({ status: 'listening', buffer: '', partial: '', message: null });
      void runTurn();
    },
    stopTurn() {
      // The dictation turn ends on its own trailing-silence detection; this is a
      // no-op hook for a UI "stop" that wants to cut the turn short.
    },
    async submit() {
      if (terminal) return;
      await submit();
    },
    async submitAudio() {
      if (terminal) return;
      await submitAudio();
    },
    setBatch(info) {
      if (terminal) return;
      emit({
        batchDurationMs: Math.max(0, Math.round(info.durationMs)),
        batchChunks: Math.max(0, Math.round(info.chunks)),
        batchAvailable: info.durationMs > 0 || info.chunks > 0,
      });
    },
    setBuffer(text) {
      if (terminal) return;
      // An explicit edit is user activity: reset the inactivity clock so the
      // unsent policy does not fire mid-typing.
      lastActivityAt = now();
      emit({ buffer: (text ?? '').replace(/\s+$/g, ''), partial: '' });
    },
    cancel() {
      captureStopped = true;
      terminal = true;
      emit({ status: 'discarded', partial: '' });
    },
    async timeout() {
      if (terminal) return;
      if (!timedOut()) return;
      const resolution = resolveUnsent({
        buffer: state.buffer,
        policy: options.unsentPolicy,
        submitted: false,
      });
      captureStopped = true;
      terminal = true;
      if (resolution.action === 'queue' && resolution.text) {
        options.enqueue({
          id: newId(),
          agentId: state.target.agentId,
          agentName: state.target.agentName,
          text: resolution.text,
          at: now(),
          phrase: state.target.phrase,
        });
        emit({ status: 'queued', partial: '' });
      } else {
        emit({ status: 'discarded', partial: '' });
      }
    },
    sync() {
      options.onStateChange?.(state);
    },
  };
}
