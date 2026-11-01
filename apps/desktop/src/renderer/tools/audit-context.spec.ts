import { describe, expect, it, beforeEach } from 'vitest';
import {
  getToolAuditContext,
  resetToolAuditContext,
  resolveToolAuditContext,
  setToolAuditContext,
} from './audit-context.js';

describe('resolveToolAuditContext', () => {
  it('prefers the active panel conversation and its contact id', () => {
    const ctx = resolveToolAuditContext({
      panels: [{ contactId: 'contact-1', conversationId: 'conv-1' }],
      activePanelIndex: 0,
      conversationId: 'state-conv',
      contacts: [{ id: 'contact-1', agentId: 'agent-1' }],
    });
    // The contact id (not the region agent id) is the ACL key.
    expect(ctx).toEqual({ agentId: 'contact-1', conversationId: 'conv-1' });
  });

  it('leaves the agent id null when the panel has no contact', () => {
    const ctx = resolveToolAuditContext({
      panels: [{ conversationId: null }],
      activePanelIndex: 0,
      conversationId: 'state-conv',
      contacts: [{ id: 'contact-1', agentId: 'agent-1' }],
    });
    expect(ctx.agentId).toBeNull();
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
