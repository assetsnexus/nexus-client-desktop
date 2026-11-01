import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTool } from './tool-runner.js';
import type { ToolsStore } from './tools-store.js';
import type { ToolsConfig } from '../shared/ipc.js';

/**
 * The per-agent ACL is enforced here, in the one place a client tool runs. A
 * store stub keeps the test independent of the real `client-tools.json`.
 */
function storeWith(workspaces: ToolsConfig['workspaces']): ToolsStore {
  return {
    get: () => ({ workspaces, localCommands: [] }) as ToolsConfig,
    setWorkspaces: () => ({ workspaces, localCommands: [] }) as ToolsConfig,
    setLocalCommands: () => ({ workspaces, localCommands: [] }) as ToolsConfig,
  };
}

function makeRoots() {
  const base = mkdtempSync(join(tmpdir(), 'nexus-acl-'));
  const shared = join(base, 'shared');
  const privateDir = join(base, 'private');
  mkdirSync(shared, { recursive: true });
  mkdirSync(privateDir, { recursive: true });
  writeFileSync(join(shared, 'shared.txt'), 'shared');
  writeFileSync(join(privateDir, 'secret.txt'), 'secret');
  return { shared, privateDir };
}

describe('runTool — per-agent workspace ACL', () => {
  it('allows an agent to read inside a root granted to it', async () => {
    const { shared } = makeRoots();
    const store = storeWith([
      { id: 'shared', label: 'Shared', path: shared, mode: 'read-only', agentContactIds: ['*'] },
    ]);
    const result = await runTool(
      { name: 'app.fs.read', path: join(shared, 'shared.txt') },
      { store, agentContactId: 'c1' },
    );
    expect(result.ok).toBe(true);
  });

  it('denies access to a root granted only to a different agent', async () => {
    const { privateDir } = makeRoots();
    const store = storeWith([
      { id: 'private', label: 'Private', path: privateDir, mode: 'read-write', agentContactIds: ['c2'] },
    ]);
    const result = await runTool(
      { name: 'app.fs.read', path: join(privateDir, 'secret.txt') },
      { store, agentContactId: 'c1' },
    );
    expect(result.ok).toBe(false);
  });

  it('fails closed when no agent id is supplied (no private roots)', async () => {
    const { privateDir } = makeRoots();
    const store = storeWith([
      { id: 'private', label: 'Private', path: privateDir, mode: 'read-write', agentContactIds: ['c1'] },
    ]);
    const result = await runTool(
      { name: 'app.fs.read', path: join(privateDir, 'secret.txt') },
      { store },
    );
    expect(result.ok).toBe(false);
  });

  it('still allows a shared "*" root without an agent id', async () => {
    const { shared } = makeRoots();
    const store = storeWith([
      { id: 'shared', label: 'Shared', path: shared, mode: 'read-only', agentContactIds: ['*'] },
    ]);
    const result = await runTool(
      { name: 'app.fs.read', path: join(shared, 'shared.txt') },
      { store, agentContactId: null },
    );
    expect(result.ok).toBe(true);
  });

  it('treats a legacy root (no agentContactIds) as shared with everyone', async () => {
    const { shared } = makeRoots();
    // A root persisted before the ACL — no `agentContactIds` at all.
    const store = storeWith([
      { id: 'shared', label: 'Shared', path: shared, mode: 'read-write' } as never,
    ]);
    const result = await runTool(
      { name: 'app.fs.list', path: shared },
      { store, agentContactId: 'anyone' },
    );
    expect(result.ok).toBe(true);
  });
});
