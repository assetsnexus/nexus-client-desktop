/**
 * Wake → transcript policy (renderer, pure).
 *
 * The whole "what happens to what I said" decision lives here, framework-free and
 * dependency-injected, so it is unit-testable without a microphone, the region,
 * or React:
 *  - accumulate successive transcripts into one buffer (the user may speak in
 *    several bursts before submitting),
 *  - recognise a trailing *submit phrase* ("… submit", "… answer now") and strip
 *    it, so speaking the phrase ends the turn instead of being sent as text,
 *  - route a transcript that begins with an agent's name ("Bob, do this") to that
 *    agent, overriding the wake word's static binding,
 *  - decide what an unsubmitted buffer becomes once the timeout fires.
 *
 * TRUST: nothing here authenticates or approves anything. It only decides which
 * *user* message to pre-fill (or send) into a conversation the user can already
 * write to. A wake word is never authority.
 */

/** One mappable agent, reduced to what routing needs (from `WakeAgentRow`). */
export type TranscriptAgent = {
  contactId: string;
  name: string;
};

export type SubmitMatch = {
  /** Transcript with the trailing submit phrase removed and trimmed. */
  text: string;
  /** True when a submit phrase was recognized. */
  submitted: boolean;
  /** The phrase that matched, lowercased, or null. */
  matched: string | null;
};

export type AgentRoute = {
  /** Agent the utterance is addressed to. */
  agentId: string;
  agentName: string;
  /** Transcript with the leading agent-name address removed. */
  text: string;
};

/**
 * Match a trailing submit phrase. Both sides are compared case-insensitively;
 * trailing punctuation on the phrase ("submit." / "submit!") is tolerated, and a
 * bare phrase with no other content still counts as an (empty) submit request.
 */
export function matchSubmitPhrase(input: string, phrases: readonly string[]): SubmitMatch {
  const text = (input ?? '').trim();
  const cleaned = phrases
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0)
    // Longest first so "answer now" wins over "now".
    .sort((a, b) => b.length - a.length);
  if (!text || !cleaned.length) return { text, submitted: false, matched: null };

  const lower = text.toLowerCase();
  for (const phrase of cleaned) {
    // Allow trailing punctuation after the phrase, and require a boundary before
    // it so "presubmit" does not match "submit".
    const at = lower.lastIndexOf(phrase);
    if (at === -1) continue;
    const after = text.slice(at + phrase.length);
    if (!/^[\s.!?,;:]*$/.test(after)) continue;
    const before = text[at - 1];
    if (before && /[a-z0-9]/i.test(before)) continue;
    const remaining = text.slice(0, at).trim().replace(/[,\s]+$/, '');
    return { text: remaining, submitted: true, matched: phrase };
  }
  return { text, submitted: false, matched: null };
}

/** Strip a leading address ("Bob, …" / "Bob …") when it names a known agent. */
export function stripAgentAddress(text: string, agentName: string): string | null {
  const name = agentName.trim();
  if (!name) return null;
  const pattern = new RegExp(
    `^\\s*${escapeRegExp(name)}\\s*[,:!?]?\\s+`,
    'i',
  );
  if (!pattern.test(text)) return null;
  return text.replace(pattern, '').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * If the utterance opens by naming an agent, route to that agent and return the
 * remaining instruction. Longest name wins so "Bob Smith" beats "Bob". Returns
 * null when no known agent is addressed, leaving the caller's binding in place.
 */
export function resolveAgentByName(
  input: string,
  agents: readonly TranscriptAgent[],
): AgentRoute | null {
  const text = (input ?? '').trim();
  if (!text || !agents.length) return null;
  const candidates = [...agents]
    .filter((a) => a.name.trim().length > 0)
    .sort((a, b) => b.name.trim().length - a.name.trim().length);
  for (const agent of candidates) {
    const stripped = stripAgentAddress(text, agent.name);
    // Require some instruction after the name: "Bob" alone is a wake, not a task.
    if (stripped && stripped.length) {
      return { agentId: agent.contactId, agentName: agent.name.trim(), text: stripped };
    }
  }
  return null;
}

/** Append a new transcript burst to the running buffer. */
export function appendTranscript(buffer: string, incoming: string): string {
  const addition = (incoming ?? '').trim();
  if (!addition) return buffer;
  if (!buffer.trim()) return addition;
  return /\s$/.test(buffer) ? `${buffer}${addition}` : `${buffer} ${addition}`;
}

export type UnsentResolution = {
  /** 'send' (submit now), 'queue' (keep for review), or 'discard' (drop). */
  action: 'send' | 'queue' | 'discard';
  /** The text to act on (empty when discarding nothing). */
  text: string;
};

/**
 * Decide what an unsubmitted buffer becomes when the timeout fires. A `submit`
 * request always sends; otherwise the user's `unsentPolicy` decides. `send` is
 * only ever produced by an explicit submit request, never by a timeout, so an
 * accidental background activation can never auto-post on the timer.
 */
export function resolveUnsent(input: {
  buffer: string;
  policy: 'discard' | 'queue';
  submitted: boolean;
}): UnsentResolution {
  const text = (input.buffer ?? '').trim();
  if (input.submitted && text) return { action: 'send', text };
  if (!text) return { action: 'discard', text: '' };
  return input.policy === 'queue' ? { action: 'queue', text } : { action: 'discard', text };
}

/** One queued (unsubmitted) transcript, surfaced the next time chat opens. */
export type { QueuedUtterance } from '../../shared/wake.js';
export {
  MAX_QUEUED_UTTERANCES,
  dequeueUtterance,
  enqueueUtterance,
} from '../../shared/wake.js';
