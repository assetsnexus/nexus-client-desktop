/**
 * Bind a companion window to the thread a wake resolved (companion renderer).
 *
 * A companion window keeps its own chat controller, so an incoming wake's
 * `conversationId` is only an *address* — it means nothing until this window's
 * chat store points at that conversation. `chat.reopenConversation(id)` does not
 * do that: it flips the server-side status of a conversation and nothing else, so
 * the store's `conversationId` stayed `null` and the window looked unbound (an
 * empty transcript, and any send from it with no address at all).
 *
 * Binding here therefore means: read the thread, then `rehydrateTurns(...,
 * { conversationId })`, which is the call that actually sets the store (and the
 * active panel) to that conversation. When the thread cannot be read — archived
 * by someone else, not ours to resume, a region hiccup — fall back to
 * `openContact`, which resumes the contact's latest active thread (creating one
 * only when the contact has none) and binds it the same way. That keeps the
 * "resume, don't fork" rule: no path here mints a conversation on every wake.
 *
 * TRUST: this only *reads* a thread the viewer can already read and binds the
 * local view to it. It never authenticates or dispatches a privileged command.
 */

/** The slice of a chat controller this binding needs (kept structural for tests). */
export type CompanionThreadChat = {
  getState(): { conversationId: string | null };
  reopenConversation(conversationId: string): Promise<void>;
  listMessages(conversationId: string, opts?: { limit?: number }): Promise<unknown[]>;
  rehydrateTurns(
    rows: Array<Record<string, unknown>>,
    opts: { conversationId: string; detachStream?: boolean },
  ): void;
  openContact(contactId: string): Promise<{ conversationId?: string }>;
};

export type CompanionThreadBinding = {
  /** The conversation this window is now bound to, or `null` when nothing bound. */
  conversationId: string | null;
  /** Which path bound it (`resume` = an existing thread, never a fork). */
  via: 'resume' | 'create' | 'none';
  /** True when the wake's thread was read and handed to the caller to render. */
  loaded: boolean;
};

/** Map one region conversation message onto the turn shape `rehydrateTurns` takes. */
export function toRehydratedTurns(messages: unknown[]): Array<Record<string, unknown>> {
  return (Array.isArray(messages) ? messages : []).map((raw) => {
    const m = (raw ?? {}) as Record<string, unknown>;
    const role = m.role === 'user' || m.role === 'system' ? m.role : 'assistant';
    return {
      id: m.id as string | undefined,
      role,
      content: String(m.content ?? m.text ?? ''),
      toolCalls: Array.isArray(m.toolCalls) ? m.toolCalls : undefined,
      attachments: m.attachments,
      createdAt: (m.createdAt as string) || null,
      senderId: (m.senderId as string) || null,
      senderName: (m.senderName as string) || null,
    };
  });
}

/**
 * Bind this window to `conversationId` when the wake carried one, else to the
 * contact's latest thread. Returns the effective id and whether its turns were
 * loaded, so the caller can surface a link failure without blanking the stage.
 */
export async function bindCompanionThread(
  chat: CompanionThreadChat,
  input: { contactId: string; conversationId?: string | null },
): Promise<CompanionThreadBinding> {
  const wanted = typeof input.conversationId === 'string' ? input.conversationId.trim() : '';
  if (wanted) {
    // Already bound (a second wake for the same thread): nothing to do.
    if (chat.getState().conversationId === wanted) {
      return { conversationId: wanted, via: 'resume', loaded: true };
    }
    try {
      const messages = await chat.listMessages(wanted, { limit: 60 });
      chat.rehydrateTurns(toRehydratedTurns(messages), {
        conversationId: wanted,
        detachStream: true,
      });
      // Reopening keeps the thread addressable/streamable for the next turn; a
      // failure still leaves a bound, readable conversation, so it is best-effort.
      await chat.reopenConversation(wanted).catch(() => undefined);
      const bound = chat.getState().conversationId;
      if (bound === wanted) return { conversationId: wanted, via: 'resume', loaded: true };
    } catch {
      // The wake's thread was not readable here; fall through to the resume path
      // so the window still binds to *a* real thread rather than none.
    }
  }
  // A final binding failure is surfaced to the caller: it reports a link error
  // instead of leaving the composer silently unaddressed (which is exactly the
  // state that produced "No conversation or room to send to").
  const opened = await chat.openContact(input.contactId);
  const bound = (opened?.conversationId ?? chat.getState().conversationId ?? '').trim();
  if (!bound) return { conversationId: null, via: 'none', loaded: false };
  return { conversationId: bound, via: 'resume', loaded: false };
}
