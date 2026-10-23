import { describe, expect, it } from 'vitest';
import {
  AUDIT_ENTRY_VERSION,
  DEFAULT_AUDIT_RETENTION,
  auditFacets,
  filterAuditEntries,
  normalizeAuditRetention,
  retentionCutoffMs,
  selectRetained,
  shapeAuditEntry,
  type ClientToolAuditEntry,
} from './audit.js';
import { REDACTED } from './redaction.js';

const DAY = 24 * 60 * 60 * 1000;

function entryAt(at: number, bytes = 100, tool = 'app.fs.read'): ClientToolAuditEntry {
  return {
    v: AUDIT_ENTRY_VERSION,
    id: `e-${at}`,
    at,
    tool,
    agentId: 'agent-1',
    conversationId: 'conv-1',
    source: 'desktop',
    outcome: 'ok',
    durationMs: 0,
    args: {},
    result: null,
    argsTruncated: false,
    resultTruncated: false,
    bytes,
  };
}

describe('shapeAuditEntry', () => {
  it('records agent, conversation, tool, outcome and timing', () => {
    const entry = shapeAuditEntry({
      id: 'id-1',
      tool: 'app.fs.read',
      agentId: 'agent-7',
      conversationId: 'conv-9',
      source: 'desktop',
      ok: true,
      args: { path: '/tmp/x' },
      result: { content: 'hello' },
      startedAt: 1_000,
      finishedAt: 1_037,
    });

    expect(entry.v).toBe(AUDIT_ENTRY_VERSION);
    expect(entry.id).toBe('id-1');
    expect(entry.tool).toBe('app.fs.read');
    expect(entry.agentId).toBe('agent-7');
    expect(entry.conversationId).toBe('conv-9');
    expect(entry.outcome).toBe('ok');
    expect(entry.durationMs).toBe(37);
    expect(entry.at).toBe(1_037);
    expect(entry.result).toEqual({ content: 'hello' });
    expect(entry.bytes).toBeGreaterThan(0);
  });

  it('coerces a missing correlation to null (a call outside a chat turn)', () => {
    const entry = shapeAuditEntry({
      id: 'id-2',
      tool: 'app.shell.run',
      agentId: undefined,
      conversationId: null,
      source: 'desktop',
      ok: false,
      args: { argv: ['ls'] },
      error: 'denied',
      startedAt: 5,
    });
    expect(entry.agentId).toBeNull();
    expect(entry.conversationId).toBeNull();
    expect(entry.outcome).toBe('error');
    expect(entry.error).toBe('denied');
  });

  it('redacts secrets in the args and result before they are stored', () => {
    const entry = shapeAuditEntry({
      id: 'id-3',
      tool: 'app.fs.write',
      agentId: 'a',
      conversationId: 'c',
      source: 'desktop',
      ok: true,
      args: { path: '/tmp/x', apiKey: 'sk-secret' },
      result: { token: 'nope' },
      startedAt: 0,
      finishedAt: 1,
    });
    expect((entry.args as Record<string, unknown>).apiKey).toBe(REDACTED);
    expect((entry.result as Record<string, unknown>).token).toBe(REDACTED);
    expect(JSON.stringify(entry)).not.toContain('sk-secret');
  });
});

describe('normalizeAuditRetention', () => {
  it('falls back per-field for garbage input', () => {
    expect(normalizeAuditRetention({ maxEntries: -5, maxAgeDays: 'x', maxBytes: null })).toEqual(
      DEFAULT_AUDIT_RETENTION,
    );
  });

  it('keeps valid values and allows 0 to disable a bound', () => {
    const next = normalizeAuditRetention({ maxEntries: 0, maxAgeDays: 7, maxBytes: 1024 });
    expect(next).toEqual({ maxEntries: 0, maxAgeDays: 7, maxBytes: 1024 });
  });
});

describe('retentionCutoffMs', () => {
  it('computes the age cutoff and returns null when unbounded', () => {
    const now = 1_000 * DAY;
    expect(retentionCutoffMs(now, 30)).toBe(now - 30 * DAY);
    expect(retentionCutoffMs(now, 0)).toBeNull();
  });
});

describe('selectRetained', () => {
  it('drops entries older than the age bound', () => {
    const now = 100 * DAY;
    const entries = [entryAt(now - 40 * DAY), entryAt(now - 5 * DAY), entryAt(now)];
    const { kept, dropped } = selectRetained(entries, now, { maxEntries: 0, maxAgeDays: 30, maxBytes: 0 });
    expect(kept.map((e) => e.at)).toEqual([now - 5 * DAY, now]);
    expect(dropped).toBe(1);
  });

  it('keeps only the newest N entries under the count bound', () => {
    const now = 100 * DAY;
    const entries = Array.from({ length: 20 }, (_, i) => entryAt(now - (20 - i) * 1000));
    const { kept, dropped } = selectRetained(entries, now, { maxEntries: 5, maxAgeDays: 0, maxBytes: 0 });
    expect(kept).toHaveLength(5);
    expect(kept[kept.length - 1]!.at).toBe(now - 1000);
    expect(dropped).toBe(15);
  });

  it('trims oldest first to stay under the byte bound', () => {
    const now = Date.now();
    const entries = [entryAt(now - 3, 400), entryAt(now - 2, 400), entryAt(now - 1, 400)];
    const { kept } = selectRetained(entries, now, { maxEntries: 0, maxAgeDays: 0, maxBytes: 800 });
    expect(kept).toHaveLength(2);
    expect(kept[0]!.at).toBe(now - 2);
  });

  it('applies all three bounds together', () => {
    const now = 100 * DAY;
    const entries = [
      entryAt(now - 40 * DAY, 500), // too old
      entryAt(now - 1 * DAY, 500),
      entryAt(now - 1 * DAY, 500),
      entryAt(now - 1 * DAY, 500),
    ];
    const { kept } = selectRetained(entries, now, { maxEntries: 2, maxAgeDays: 30, maxBytes: 0 });
    expect(kept).toHaveLength(2);
  });
});

describe('filterAuditEntries + auditFacets', () => {
  const now = Date.now();
  const entries: ClientToolAuditEntry[] = [
    { ...entryAt(now - 2, 10, 'app.fs.read'), id: 'a', agentId: 'agent-A', conversationId: 'conv-1' },
    { ...entryAt(now - 1, 10, 'app.fs.write'), id: 'b', agentId: 'agent-B', conversationId: 'conv-1' },
    { ...entryAt(now, 10, 'app.fs.read'), id: 'c', agentId: 'agent-A', conversationId: 'conv-2' },
  ];

  it('filters by agent and by conversation (the "trace to conversation" path)', () => {
    expect(filterAuditEntries(entries, { agentId: 'agent-A' }).map((e) => e.id)).toEqual(['c', 'a']);
    expect(filterAuditEntries(entries, { conversationId: 'conv-1' }).map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('returns newest-first', () => {
    expect(filterAuditEntries(entries, {}).map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });

  it('supports a free-text query and a limit', () => {
    expect(filterAuditEntries(entries, { query: 'app.fs.read' }).map((e) => e.id)).toEqual(['c', 'a']);
    expect(filterAuditEntries(entries, { limit: 1 }).map((e) => e.id)).toEqual(['c']);
  });

  it('summarises facets across the whole set for the UI dropdowns', () => {
    const facets = auditFacets(entries);
    expect(facets.agents).toEqual([
      { id: 'agent-A', count: 2 },
      { id: 'agent-B', count: 1 },
    ]);
    expect(facets.tools.map((t) => t.id).sort()).toEqual(['app.fs.read', 'app.fs.write']);
    expect(facets.conversations.map((c) => c.id).sort()).toEqual(['conv-1', 'conv-2']);
  });
});
