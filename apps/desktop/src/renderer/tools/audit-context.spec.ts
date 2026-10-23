import { describe, expect, it, beforeEach } from 'vitest';
import {
  getToolAuditContext,
  resetToolAuditContext,
  resolveToolAuditContext,
  setToolAuditContext,
} from './audit-context.js';

describe('resolveToolAuditContext', () => {
  it('prefers the active panel conversation and its agent contact', () => {
    const ctx = resolveToolAuditContext({
      panels: [{ contactId: 'contact-1', conversationId: 'conv-1' }],
      activePanelIndex: 0,
      conversationId: 'state-conv',
      contacts: [{ id: 'contact-1', agentId: 'agent-1' }],
    });
    expect(ctx).toEqual({ agentId: 'agent-1', conversationId: 'conv-1' });
  });

  it('falls back to the contact id when the agent id is absent', () => {
    const ctx = resolveToolAuditContext({
      panels: [{ contactId: 'contact-1', conversationId: null }],
      activePanelIndex: 0,
      conversationId: 'state-conv',
      contacts: [{ id: 'contact-1', agentId: null }],
    });
    expect(ctx.agentId).toBe('contact-1');
    expect(ctx.conversationId).toBe('state-conv');
  });

  it('returns nulls for an empty state', () => {
    expect(resolveToolAuditContext(null)).toEqual({ agentId: null, conversationId: null });
    expect(resolveToolAuditContext({})).toEqual({ agentId: null, conversationId: null });
  });
});

describe('tool audit context store', () => {
  beforeEach(() => resetToolAuditContext());

  it('sets, reads and clears the current context', () => {
    setToolAuditContext({ agentId: 'a1', conversationId: 'c1' });
    expect(getToolAuditContext()).toEqual({ agentId: 'a1', conversationId: 'c1' });
    setToolAuditContext(null);
    expect(getToolAuditContext()).toEqual({ agentId: null, conversationId: null });
  });

  it('normalises blank ids to null', () => {
    setToolAuditContext({ agentId: '   ', conversationId: '' });
    expect(getToolAuditContext()).toEqual({ agentId: null, conversationId: null });
  });
});
