/**
 * Resolve the thread a wake should address (renderer).
 *
 * A wake for agent X must land in X's **most recent** conversation: the user
 * expects to carry on where they last spoke, and allocating a fresh thread on
 * every wake both fragments history and leaves the companion strip pointing at
 * a conversation nobody was reading.
 *
 * `chat.openLatest` is the resume call. It is run as a **pure lookup**
 * (`createIfMissing: false`) first, so resuming an existing thread can never
 * trigger `anx.communicate.conversations.create` — for an agent the viewer does
 * not own, that create is denied and used to surface as "conversations.create
 * failed" from what looked like a plain resume. Only when the lookup proves the
 * contact has no active thread does this bind through `chat.openContact`, which
 * resumes-or-creates exactly one and binds it into the chat store.
 *
 * The failure this replaces: a bare `catch {}` around `openLatest` swallowed a
 * failed resume and left the wake with **no** address at all, which later
 * surfaced as "No conversation or room to send to". A genuinely unresolvable
 * binding returns `null` — the caller must not invent an id.
 */

/** The slice of a chat controller this binding needs (kept structural for tests). */
export type WakeThreadChat = {
  openLatest(
    contact: { id: string },
    opts?: { createIfMissing?: boolean },
  ): Promise<{ conversationId: string; created?: boolean }>;
  openContact(contactId: string): Promise<{ conversationId?: string }>;
  getState(): { conversationId: string | null };
};

export type WakeThreadBinding = {
  /** The bound conversation, or `null` when nothing could be resolved. */
  conversationId: string | null;
  /** Which call bound it — useful for logs and for tests pinning "no fork". */
  via: 'resume' | 'create' | 'none';
};

const trimId = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/**
 * Bind the contact's latest active conversation (creating one only if the contact
 * has none) and return its id.
 *
 * Order matters: lookup → resume-or-create. The lookup cannot mint a thread, so a
 * wake for an agent with history never allocates a second one, and a denied create
 * can only come from the single "there is no thread yet" path.
 */
export async function bindWakeThread(
  chat: WakeThreadChat,
  contactId: string,
): Promise<WakeThreadBinding> {
  const id = trimId(contactId);
  if (!id) return { conversationId: null, via: 'none' };
  try {
    // Pure lookup: resuming an existing thread must never reach `create`.
    const found = await chat.openLatest({ id }, { createIfMissing: false });
    const conversationId = trimId(found?.conversationId);
    if (conversationId) return { conversationId, via: 'resume' };
  } catch {
    // Lookup failed (cold contact list, region hiccup). Fall through to the
    // resume-or-create path rather than handing the wake an unaddressed session.
  }
  try {
    // No active thread found: this resumes the same thread when the lookup was
    // merely unavailable, and creates the one conversation when there is none.
    const opened = await chat.openContact(id);
    const conversationId = trimId(opened?.conversationId) || trimId(chat.getState().conversationId);
    if (conversationId) return { conversationId, via: 'create' };
  } catch {
    // Both paths failed (region down / no permission). The caller still presents
    // the wake — a send retries the binding through its own preflight — but it
    // must not fabricate a conversation id.
  }
  return { conversationId: null, via: 'none' };
}

/**
 * The conversation a wake-originated send must target.
 *
 * The wake's bound id wins over whatever the chat store currently shows: the
 * session (and its mirrored companion strip) belongs to the thread the wake
 * resumed, while the store may since have been re-pointed by an unrelated panel
 * switch. Falling back to the store keeps a widget/chat wake working when the
 * binding was skipped (it is only set on a successful resume).
 */
export function resolveWakeSendConversationId(
  bound: string | null | undefined,
  storeConversationId: string | null | undefined,
): string | undefined {
  return trimId(bound) || trimId(storeConversationId) || undefined;
}
