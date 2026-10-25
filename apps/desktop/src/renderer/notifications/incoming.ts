/**
 * Renderer-side detection of inbound messages worth notifying about.
 *
 * The chat SDK exposes the active conversation's `messages` array plus a
 * `streaming` flag. This module is pure so the "is this a new message?" policy is
 * unit-testable without React or Electron; the component just diffs state and
 * forwards the result to the main process over IPC.
 *
 * We deliberately notify only for *assistant* messages: the user's own outgoing
 * messages are not news, and system notices are handled by their own surfaces.
 */

import { resolveCompanionLabelOrNull } from '../../shared/companion-label.js';

export type ObservableMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
};

/**
 * Message ids the caller has already reported, so a state replay (the SDK
 * re-emits on every patch) never double-notifies.
 */
export type SeenMessageIds = Set<string>;

export type SelectIncomingInput = {
  messages: ReadonlyArray<ObservableMessage>;
  /** True while the assistant is streaming into the newest message. */
  streaming: boolean;
  /** Ids already notified in this session. */
  seen: SeenMessageIds;
};

/**
 * Return the assistant messages that should raise a notification.
 *
 * A message qualifies when it is an assistant message with visible content, has
 * not been reported yet, and the turn is no longer streaming — waiting for
 * `streaming === false` avoids notifying with half a sentence. Messages that
 * arrive without a local stream (e.g. a pushed message while the app is in the
 * tray) are already complete, so they qualify immediately.
 *
 * Every returned message is added to `seen` so the caller stays idempotent.
 */
export function selectIncomingMessages(input: SelectIncomingInput): ObservableMessage[] {
  if (input.streaming) return [];
  const out: ObservableMessage[] = [];
  for (const message of input.messages) {
    if (message.role !== 'assistant') continue;
    if (!message.id || input.seen.has(message.id)) continue;
    const content = message.content?.trim();
    if (!content) continue;
    input.seen.add(message.id);
    out.push(message);
  }
  return out;
}

/**
 * Pick the best display name for the sender of a message in the active
 * conversation. Falls back through agent name, conversation title, then null so
 * the notification builder can supply its own generic title. An id-shaped value
 * is skipped (never a notification title) via the shared companion-label rule.
 */
export function resolveSenderName(input: {
  agentName?: string | null;
  conversationTitle?: string | null;
}): string | null {
  return (
    resolveCompanionLabelOrNull(input.agentName, input.conversationTitle) ?? null
  );
}

/** A snapshot of the chat state the watcher needs to make a decision. */
export type WatchState = {
  conversationId: string | null;
  messages: ReadonlyArray<ObservableMessage>;
  streaming: boolean;
  /** True while the SDK is paging history into `messages`. */
  historyLoading: boolean;
};

export type IncomingWatcher = {
  /** Feed the latest chat state; returns the messages to notify about. */
  observe(state: WatchState): ObservableMessage[];
  /** Drop all state (sign-out). */
  reset(): void;
};

/**
 * Stateful watcher that turns a stream of chat snapshots into notifications.
 *
 * The SDK replays the whole `messages` array on every patch, and it pages
 * history into that same array — so a naive diff would notify for every
 * historical message the moment a conversation opens. To avoid that, the
 * watcher establishes a baseline: until history has settled, message ids are
 * absorbed silently. Only messages that appear *after* the baseline (and after
 * the turn stops streaming) are reported.
 */
export function createIncomingWatcher(): IncomingWatcher {
  const seen: SeenMessageIds = new Set<string>();
  let conversationId: string | null = null;
  let baselineReady = false;

  const absorb = (messages: ReadonlyArray<ObservableMessage>): void => {
    for (const message of messages) if (message.id) seen.add(message.id);
  };

  return {
    observe(state) {
      // A different conversation is a fresh baseline: never carry `seen` across.
      if (state.conversationId !== conversationId) {
        conversationId = state.conversationId;
        seen.clear();
        baselineReady = false;
      }
      if (state.historyLoading || !baselineReady) {
        absorb(state.messages);
        // Only settle the baseline once history is no longer loading.
        if (!state.historyLoading) baselineReady = true;
        return [];
      }
      return selectIncomingMessages({
        messages: state.messages,
        streaming: state.streaming,
        seen,
      });
    },
    reset() {
      seen.clear();
      conversationId = null;
      baselineReady = false;
    },
  };
}
