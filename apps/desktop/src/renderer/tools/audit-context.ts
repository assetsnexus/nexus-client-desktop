/**
 * Renderer-side correlation context for the client-tool audit trail.
 *
 * The chat host knows, at the moment a tool runs, which agent and which
 * conversation the turn belongs to. The tool handlers (created once, in
 * `descriptors.ts`) read this context and attach it to the `runTool` payload so
 * the **main** process can record an audit entry that traces a call back to its
 * conversation.
 *
 * These values are audit metadata only: they grant no authority and are never
 * consulted for policy. Kept dependency-free so it is unit-testable.
 */

export type ToolAuditContext = {
  /** Agent (contact) id the open conversation is with, when known. */
  agentId: string | null;
  /** Conversation id of the active panel, when known. */
  conversationId: string | null;
};

const EMPTY: ToolAuditContext = { agentId: null, conversationId: null };

let current: ToolAuditContext = EMPTY;

/** Replace the current context (the chat host calls this on every state change). */
export function setToolAuditContext(next: Partial<ToolAuditContext> | null | undefined): void {
  if (!next) {
    current = EMPTY;
    return;
  }
  current = {
    agentId: normalizeId(next.agentId),
    conversationId: normalizeId(next.conversationId),
  };
}

/** The current context (read by the tool handlers when forwarding a call). */
export function getToolAuditContext(): ToolAuditContext {
  return current;
}

/** Reset to empty (used by tests and on sign-out). */
export function resetToolAuditContext(): void {
  current = EMPTY;
}

function normalizeId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Resolve the agent + conversation correlation for a tool call from a chat state
 * snapshot. Pure: given `{ panels, activePanelIndex, contacts, conversationId }`
 * it returns the ids, preferring the active panel's conversation and the agent
 * contact it points at.
 */
export function resolveToolAuditContext(state: {
  panels?: Array<{ contactId?: string | null; conversationId?: string | null }>;
  activePanelIndex?: number;
  conversationId?: string | null;
  contacts?: Array<{ id: string; agentId?: string | null }>;
} | null | undefined): ToolAuditContext {
  if (!state) return EMPTY;
  const panel = state.panels?.[state.activePanelIndex ?? 0] ?? null;
  const conversationId = normalizeId(panel?.conversationId ?? state.conversationId);
  const contact = panel?.contactId
    ? state.contacts?.find((c) => c.id === panel.contactId) ?? null
    : null;
  const agentId = normalizeId(contact?.agentId ?? panel?.contactId ?? null);
  return { agentId, conversationId };
}
