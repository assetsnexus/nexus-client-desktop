/**
 * Speak incoming agent messages aloud (opt-in "speak messages").
 *
 * The main process decides *whether* a message should be spoken (it owns the
 * settings and the unattended-window rule) and returns `speak: true` from
 * `notifyIncoming`; this renderer-side speaker turns that flag into audio.
 *
 * TTS model/voice resolution is per agent (a contact may pin its own voice), so a
 * controller is created per agent and reused. Speech is serialised through a
 * small queue: two replies arriving at once must not talk over each other, and a
 * cancelled turn (sign-out, window focus) drops the rest of the queue rather than
 * continuing to read stale messages.
 *
 * The TTS controller is injected, so the queue policy is unit-tested without a
 * region, audio device, or `@nexus/chat-core` import.
 */

/** Minimal contract of `createSpeakTurn` / `createSpeakTurnController`. */
export type SpeakController = {
  speak(text: string): Promise<void>;
  cancel(): Promise<void> | void;
};

export type SpeakTurnFactory = (input: { agentId: string | null }) => SpeakController;

export type MessageSpeaker = ReturnType<typeof createMessageSpeaker>;

/**
 * A tiny sequential speaker. One controller per agent; a new message for an
 * agent whose previous turn is still playing replaces its pending text (a burst
 * of replies reads as the latest one, not a backlog).
 */
export function createMessageSpeaker(deps: { createSpeakTurn: SpeakTurnFactory }) {
  const controllers = new Map<string, SpeakController>();
  /** Per-agent pending text; the newest message wins over an unstarted older one. */
  const pending = new Map<string, string>();
  const order: string[] = [];
  let running = false;
  let cancelled = false;

  const keyOf = (agentId: string | null): string => agentId ?? '__default__';

  function controllerFor(agentId: string | null): SpeakController {
    const key = keyOf(agentId);
    let controller = controllers.get(key);
    if (!controller) {
      controller = deps.createSpeakTurn({ agentId });
      controllers.set(key, controller);
    }
    return controller;
  }

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (order.length > 0) {
        if (cancelled) break;
        const agentId = order.shift() as string;
        const text = pending.get(agentId);
        pending.delete(agentId);
        if (!text) continue;
        try {
          await controllerFor(agentId === '__default__' ? null : agentId).speak(text);
        } catch {
          // A failed TTS turn (no model configured, device busy) must not wedge
          // the queue: drop it and move on to the next message.
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    /** Speak `text` for `agentId`; replaces this agent's not-yet-started text. */
    speak(text: string, agentId: string | null): void {
      const trimmed = String(text || '').trim();
      if (!trimmed) return;
      cancelled = false;
      const key = keyOf(agentId);
      if (!pending.has(key)) order.push(key);
      pending.set(key, trimmed);
      void drain();
    },

    /** Stop speaking and drop everything queued (focus regained, sign-out). */
    cancel(): void {
      cancelled = true;
      pending.clear();
      order.length = 0;
      for (const controller of controllers.values()) {
        try {
          void controller.cancel();
        } catch {
          /* best-effort */
        }
      }
    },

    /** Drop cached controllers (identity switch) so a stale voice is not reused. */
    reset(): void {
      this.cancel();
      controllers.clear();
    },

    /** True while a turn is playing or queued (for tests/diagnostics). */
    isBusy: () => running || order.length > 0,
  };
}
