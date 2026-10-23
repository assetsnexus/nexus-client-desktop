import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditStore } from './audit-store.js';
import { createToolAuditor, toolArgsOf } from './tool-audit.js';
import { createToolsStore } from './tools-store.js';
import type { ToolInvocation } from '../shared/ipc.js';

function makeAuditor() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-tool-audit-'));
  const audit = createAuditStore({ filePath: join(dir, 'audit.jsonl'), trimIntervalMs: 0 });
  let clock = 1_000;
  const auditor = createToolAuditor({ audit, now: () => (clock += 7) });
  return { audit, auditor };
}

describe('toolArgsOf', () => {
  it('strips the routing/correlation fields, leaving only the tool args', () => {
    const req: ToolInvocation = {
      name: 'app.fs.read',
      path: '/tmp/x',
      agentId: 'agent-9',
      conversationId: 'conv-9',
    };
    expect(toolArgsOf(req)).toEqual({ path: '/tmp/x' });
  });
});

describe('createToolAuditor — the invocation choke point', () => {
  it('records one entry per invocation with the agent + conversation correlation', async () => {
    const { audit, auditor } = makeAuditor();
    const store = createToolsStore(join(tmpdir(), 'nonexistent-tools.json'));

    const result = await auditor.invoke(
      { name: 'app.fs.read', path: '/definitely/missing', agentId: 'agent-9', conversationId: 'conv-9' },
      { store },
    );

    // The tool result is passed through unchanged.
    expect(result.ok).toBe(false);
    const [entry] = audit.list();
    expect(entry).toBeDefined();
    expect(entry!.tool).toBe('app.fs.read');
    expect(entry!.agentId).toBe('agent-9');
    expect(entry!.conversationId).toBe('conv-9');
    expect(entry!.source).toBe('desktop');
    expect(entry!.outcome).toBe('error');
    expect(entry!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records a null correlation for a call outside a chat turn', async () => {
    const { audit, auditor } = makeAuditor();
    const store = createToolsStore(join(tmpdir(), 'nonexistent-tools.json'));
    await auditor.invoke({ name: 'app.fs.read', path: '/nope' }, { store });
    expect(audit.list()[0]!.agentId).toBeNull();
    expect(audit.list()[0]!.conversationId).toBeNull();
  });

  it('records the redacted args and never a secret', async () => {
    const { audit, auditor } = makeAuditor();
    const store = createToolsStore(join(tmpdir(), 'nonexistent-tools.json'));
    await auditor.invoke(
      { name: 'app.fs.write', path: '/x', content: 'ok', apiKey: 'sk-xyz', agentId: 'a', conversationId: 'c' },
      { store },
    );
    const entry = audit.list()[0]!;
    expect((entry.args as Record<string, unknown>).content).toBe('ok');
    expect((entry.args as Record<string, unknown>).apiKey).toBe('[redacted]');
    expect(JSON.stringify(entry)).not.toContain('sk-xyz');
  });

  it('records a thrown tool as an error outcome and rethrows', async () => {
    const { audit } = makeAuditor();
    const audit2 = audit;
    // Force a throw by passing a store whose get() throws.
    const auditor = createToolAuditor({
      audit: audit2,
      now: () => Date.now(),
    });
    const explodingStore = {
      get() {
        throw new Error('store exploded');
      },
    } as never;

    await expect(auditor.invoke({ name: 'app.fs.read', path: '/x', agentId: 'a' }, { store: explodingStore })).rejects.toThrow(
      /store exploded/,
    );
    expect(audit.list()[0]!.outcome).toBe('error');
    expect(audit.list()[0]!.error).toMatch(/store exploded/);
  });
});
