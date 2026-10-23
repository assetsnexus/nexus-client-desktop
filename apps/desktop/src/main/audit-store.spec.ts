import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditStore, readAuditFile } from './audit-store.js';
import { DEFAULT_AUDIT_RETENTION } from '../shared/audit.js';
import { REDACTED } from '../shared/redaction.js';

function storeOptions() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-audit-'));
  return { filePath: join(dir, 'audit', 'client-tools.jsonl') };
}

function append(store: ReturnType<typeof createAuditStore>, tool = 'app.fs.read', at = Date.now()) {
  return store.append({
    tool,
    agentId: 'agent-1',
    conversationId: 'conv-1',
    source: 'desktop',
    ok: true,
    args: { path: '/tmp/x', token: 'sk-should-be-redacted' },
    result: { content: 'ok' },
    startedAt: at,
    finishedAt: at,
  });
}

describe('createAuditStore — append-only persistence', () => {
  it('appends entries as JSONL and reloads them', () => {
    const opts = storeOptions();
    const store = createAuditStore({ ...opts, trimIntervalMs: 0 });
    append(store, 'app.fs.read');
    append(store, 'app.shell.run');

    const reloaded = readAuditFile(opts.filePath);
    expect(reloaded).toHaveLength(2);
    expect(reloaded.map((e) => e.tool)).toEqual(['app.fs.read', 'app.shell.run']);
  });

  it('redacts secrets before writing to disk', () => {
    const opts = storeOptions();
    const store = createAuditStore({ ...opts, trimIntervalMs: 0 });
    append(store);

    const raw = readFileSync(opts.filePath, 'utf8');
    expect(raw).not.toContain('sk-should-be-redacted');
    expect(raw).toContain(REDACTED);
  });

  it('lists newest-first and filters by agent + conversation', () => {
    const store = createAuditStore({ ...storeOptions(), trimIntervalMs: 0 });
    const now = Date.now();
    store.append({ tool: 'a', agentId: 'A', conversationId: 'c1', source: 'desktop', ok: true, args: {}, startedAt: now - 2, finishedAt: now - 2 });
    store.append({ tool: 'b', agentId: 'B', conversationId: 'c1', source: 'desktop', ok: true, args: {}, startedAt: now - 1, finishedAt: now - 1 });
    store.append({ tool: 'c', agentId: 'A', conversationId: 'c2', source: 'desktop', ok: true, args: {}, startedAt: now, finishedAt: now });

    expect(store.list().map((e) => e.tool)).toEqual(['c', 'b', 'a']);
    expect(store.list({ agentId: 'A' }).map((e) => e.tool)).toEqual(['c', 'a']);
    expect(store.list({ conversationId: 'c1' }).map((e) => e.tool)).toEqual(['b', 'a']);
  });
});

describe('createAuditStore — retention', () => {
  it('defaults to the safe retention window', () => {
    const store = createAuditStore({ ...storeOptions(), trimIntervalMs: 0 });
    expect(store.getRetention()).toEqual(DEFAULT_AUDIT_RETENTION);
  });

  it('persists a retention change and re-trims immediately', () => {
    const opts = storeOptions();
    const store = createAuditStore({ ...opts, trimIntervalMs: 0 });
    const now = Date.now();
    for (let i = 0; i < 10; i += 1) append(store, `app.t${i}`, now + i);

    const next = store.setRetention({ maxEntries: 3, maxAgeDays: 0, maxBytes: 0 });
    expect(next.maxEntries).toBe(3);
    expect(store.count()).toBe(3);
    expect(store.list().map((e) => e.tool)).toEqual(['app.t9', 'app.t8', 'app.t7']);

    // A fresh store over the same file must see the persisted retention.
    const reopened = createAuditStore({ ...opts, trimIntervalMs: 0 });
    expect(reopened.getRetention().maxEntries).toBe(3);
  });

  it('trims the on-disk file, leaving only retained entries', () => {
    const opts = storeOptions();
    const store = createAuditStore({ ...opts, trimIntervalMs: 0 });
    for (let i = 0; i < 6; i += 1) append(store, `app.t${i}`);
    store.setRetention({ maxEntries: 2, maxAgeDays: 0, maxBytes: 0 });
    expect(readAuditFile(opts.filePath)).toHaveLength(2);
  });

  it('caps the file at a very small count bound', () => {
    const store = createAuditStore({ ...storeOptions(), trimIntervalMs: 0 });
    store.setRetention({ maxEntries: 1, maxAgeDays: 0, maxBytes: 0 });
    append(store, 'app.one');
    append(store, 'app.two');
    // append() does not trim inline, but an explicit pass does.
    store.trimNow();
    expect(store.count()).toBe(1);
    expect(store.list()[0]!.tool).toBe('app.two');
  });
});
