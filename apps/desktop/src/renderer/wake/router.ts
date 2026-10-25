/**
 * Wake → presentation router (renderer).
 *
 * When a wake word fires, main raises the window and forwards the activation.
 * This module decides *how* the agent is surfaced (settings → activation mode) and
 * drives one dictation session through the pure {@link createWakeSession} policy:
 *
 *  - `chat` — open the agent's conversation and dictate into its composer;
 *  - `widget` — show a small overlay (waveform + live transcript + agent avatar)
 *    without opening the chat; the transcript is placed in the composer on submit;
 *  - `companion` — open the agent's immersive companion window in voice mode.
 *
 * It is deliberately separated from any component so the policy ("what should a
 * wake do?") is testable with fakes, and so the mechanics of driving the mounted
 * chat SPA live in one place.
 *
 * TRUST: a wake only opens a conversation and pre-fills a *user* message. It
 * never authenticates, never approves, and never dispatches a privileged command.
 */

import {
  resolveWakeActivationMode,
  type WakeActivationMode,
  type WakeSettings,
} from '../../shared/wake.js';
import type { QueuedUtterance, TranscriptAgent } from './transcript.js';
import { createWakeSession, type SessionState } from './session.js';

export type WakeChatTarget = {
  agentId: string | null;
  /** Chat contact id of the agent (the wake binding's `agentId`). */
  contactId: string;
  agentName: string | null;
  phrase: string;
};

export type WakeRouteState = 'idle' | 'opening' | 'listening' | 'review' | 'sending';

export type WakeChatRouter = {
  /** Route an activation: present the agent and drive one dictation session. */
  route(target: WakeChatTarget): Promise<void>;
  /** Cancel any in-flight session (e.g. the user typed instead). */
  cancel(): void;
  /** Submit the buffered transcript from a review surface. */
  submit(): Promise<void>;
  /**
   * Replace the committed transcript with user-edited text (the widget's input
   * field), folding any live partial in first. A no-op when idle.
   */
  setBuffer(text: string): void;
  /** Send the recorded audio as a normal voice message (the widget fallback). */
  submitAudio(): Promise<void>;
  /** The inactivity timer fired; apply the unsent policy. */
  timeout(): Promise<void>;
  /** Current session state, or null when idle. */
  getSession(): SessionState | null;
};

export type WakeChatRouterOptions = {
  /** Read the current wake behavior settings (mode, phrases, timeout, …). */
  getSettings: () => WakeSettings | Promise<WakeSettings>;
  /**
   * Present the agent for the given mode. Resolves once the surface is ready to
   * receive dictation. `chat` opens the thread, `widget` shows the overlay,
   * `companion` opens the companion window.
   *
   * Return `{ dictate: false }` when the surface runs its *own* realtime voice
   * (the companion window) so this router does not open a second capture.
   */
  present: (
    mode: WakeActivationMode,
    target: WakeChatTarget,
  ) => Promise<void | { dictate?: boolean }>;
  /** Capture one utterance and transcribe it; null when nothing was heard. */
  dictate: (onPartial: (text: string) => void) => Promise<string | null>;
  /** Deliver the transcript as the user's message to the open conversation. */
  send: (input: {
    contactId: string;
    text: string;
    /** Optional turn metadata (e.g. the companion's avatar pose). */
    browserContext?: Record<string, unknown>;
  }) => Promise<void>;
  /**
   * Deliver the recorded audio batch as a normal voice message (cloud / custom
   * STT applies). Optional; the widget hides "send as voice" without it.
   */
  sendAudio?: (input: {
    contactId: string;
    browserContext?: Record<string, unknown>;
  }) => Promise<boolean>;
  /**
   * Current audio-batch progress for the active turn (ms + chunk count). Called
   * by the capture as VAD segments accumulate, so the widget can show "Audio
   * batch · Ns recorded" without polling.
   */
  batchProgress?: () => { durationMs: number; chunks: number };
  /** Keep an unsubmitted transcript for review (the `queue` unsent policy). */
  enqueue: (entry: QueuedUtterance) => void;
  /**
   * Turn metadata to attach to a companion-originated turn. Called at send time
   * so it reflects the avatar's pose *now* (Deliverable 4); a non-companion
   * surface (widget / chat) omits it and sends a plain turn.
   */
  companionTurnContext?: () => Record<string, unknown> | undefined;
  /** Known agents for speak-led routing ("Bob, …"). */
  listAgents?: () => TranscriptAgent[];
  /**
   * True when dictation will transcribe in the cloud (audio leaves the device).
   * When it is, the router always shows a **visible** dictation surface (the
   * widget) even if the user configured "open chat", so they cannot miss that
   * their speech is being streamed. On-device transcription is unchanged.
   */
  transcriptionIsCloud?: () => boolean | Promise<boolean>;
  /** Called when a step fails, so the host can surface a non-fatal notice. */
  onError?: (message: string) => void;
  onStateChange?: (state: WakeRouteState) => void;
  /** Notified on every session state change (drives the widget/review UI). */
  onSessionChange?: (session: SessionState | null) => void;
  /** How often the inactivity deadline is checked (default 5s). */
  timeoutPollMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Id factory, injectable for tests. */
  newId?: () => string;
};

export function createWakeChatRouter(options: WakeChatRouterOptions) {
  const pollMs = options.timeoutPollMs ?? 5_000;
  /**
   * True between the start of `route()` and the moment its session is created.
   * The same utterance can arrive from several microphones, so two routes can be
   * issued back to back; only the first should present. A *lingering* session
   * (one still on screen in review) is deliberately not gated by this: a new wake
   * supersedes it, so the agent window opens every time the user speaks.
   */
  let routing = false;
  let current: ReturnType<typeof createWakeSession> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Fast poll for the audio-batch progress the widget shows (250ms). */
  let batchTimer: ReturnType<typeof setInterval> | null = null;

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (batchTimer) {
      clearInterval(batchTimer);
      batchTimer = null;
    }
  }

  /** Release the session lock and clear the presentation surface. */
  function conclude(): void {
    stopTimer();
    routing = false;
    current = null;
    options.onSessionChange?.(null);
    options.onStateChange?.('idle');
  }

  /** Poll the session's inactivity deadline and apply the unsent policy. */
  function startTimer(): void {
    if (pollMs <= 0) return;
    stopTimer();
    timer = setInterval(() => {
      void timeout();
    }, pollMs);
  }

  /**
   * Poll the capture's audio-batch progress at a UI-friendly cadence so the
   * widget can show "Audio batch · Ns recorded" while the user speaks. Kept
   * separate from the (much slower) inactivity poll.
   */
  function startBatchTimer(): void {
    if (!options.batchProgress || batchTimer) return;
    batchTimer = setInterval(() => {
      if (!current || current.state.status === 'submitted') return;
      current.setBatch(options.batchProgress!());
    }, 250);
  }

  async function timeout(): Promise<void> {
    if (!current) return;
    await current.timeout();
    // A timeout always concludes the session (send-now only comes from an explicit
    // submit), so release the lock and clear the surface.
    const status = current.state.status;
    if (status === 'queued' || status === 'discarded' || status === 'submitted') conclude();
  }

  return {
    async route(target: WakeChatTarget) {
      // The *same* utterance can reach us from several microphones at once; only
      // the first in-flight route should present (the detector's 2.5s cooldown is
      // the other half of that de-dup).
      if (routing) return;
      // A *different* wake supersedes any session still on screen (e.g. a review
      // bar the user left open). Returning early here instead was why the agent
      // window only opened once: the first session held the lock until its
      // inactivity timeout, so every wake in between was silently dropped.
      routing = true;
      if (current) current.cancel();
      stopTimer();
      current = null;
      try {
        const settings = await options.getSettings();
        // Cloud transcription means audio leaves the device while the user
        // speaks. Force the compact *widget* (always visible) even if the user
        // chose "open chat", so the streaming is never invisible.
        const cloudTranscription =
          (await Promise.resolve()
            .then(() => options.transcriptionIsCloud?.())
            .catch(() => false)) === true;
        // Shared resolution (see `resolveWakeActivationMode`): `companionOnWake`
        // wins, cloud transcription forces the visible widget, else the configured
        // mode. Main resolves the *same* mode for its focus policy.
        const mode: WakeActivationMode = resolveWakeActivationMode({
          activationMode: settings.activationMode,
          companionOnWake: settings.companionOnWake,
          cloudTranscription,
        });
        options.onStateChange?.('opening');
        const presented = await options.present(mode, target);

        // A surface that runs its own realtime voice (the companion window) owns
        // the session; opening a second microphone capture here would double it.
        if (presented && presented.dictate === false) {
          routing = false;
          options.onStateChange?.('idle');
          options.onSessionChange?.(null);
          return;
        }
        options.onStateChange?.('listening');

        const session = createWakeSession({
          mode: settings.activationMode,
          reviewBeforeSend: settings.reviewBeforeSend,
          submitPhrases: settings.submitPhrases,
          unsentPolicy: settings.unsentPolicy,
          timeoutMs: settings.activationTimeoutSeconds * 1000,
          agents: options.listAgents?.() ?? [],
          cloudTranscription,
          initialTarget: {
            agentId: target.agentId,
            agentName: target.agentName,
            phrase: target.phrase,
          },
          dictate: options.dictate,
          send: async (input) => {
            options.onStateChange?.('sending');
            await options.send({
              contactId: input.agentId ?? target.contactId,
              text: input.text,
              // Deliverable 4: the companion attaches its live avatar pose at
              // send time; a non-companion surface leaves it undefined.
              browserContext: options.companionTurnContext?.(),
            });
          },
          ...(options.sendAudio
            ? {
                sendAudio: () =>
                  options.sendAudio!({
                    contactId: target.contactId,
                    browserContext: options.companionTurnContext?.(),
                  }),
              }
            : {}),
          enqueue: options.enqueue,
          now: options.now,
          newId: options.newId,
          onStateChange: (state) => {
            options.onSessionChange?.(state);
            if (state.status === 'review') options.onStateChange?.('review');
          },
        });
        current = session;
        // Released *after* the session exists: anything that arrives during the
        // `await present(...)` above is the same utterance on another mic.
        routing = false;
        session.start();
        startTimer();
        startBatchTimer();
      } catch (err) {
        routing = false;
        const message = err instanceof Error ? err.message : 'The wake command could not start.';
        conclude();
        options.onError?.(message);
      }
    },
    setBuffer(text: string) {
      current?.setBuffer(text);
    },
    async submitAudio() {
      if (!current) return;
      const session = current;
      await session.submitAudio();
      if (session.state.status === 'submitted' || session.state.status === 'discarded') {
        stopTimer();
        options.onStateChange?.('idle');
      }
    },
    cancel() {
      current?.cancel();
      conclude();
    },
    async submit() {
      if (!current) return;
      const session = current;
      await session.submit();
      stopTimer();
      // Keep the review surface visible so the user sees the sent state; the
      // next wake supersedes it rather than being blocked by it.
      if (session.state.status === 'submitted' || session.state.status === 'discarded') {
        options.onStateChange?.('idle');
      }
    },
    timeout,
    getSession() {
      return current?.state ?? null;
    },
  } satisfies WakeChatRouter;
}

/** Exposed for hosts that need the session state shape. */
export type { SessionState };
