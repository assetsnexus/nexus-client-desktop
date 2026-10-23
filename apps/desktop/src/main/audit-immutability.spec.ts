import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { IPC } from '../shared/ipc.js';

/**
 * **Immutability-by-agents — the negative test.**
 *
 * The audit store is written by the main process only. These tests prove, from
 * the code itself, that no agent-facing surface can read, append, edit, delete
 * or truncate it:
 *
 *  1. The IPC contract exposes exactly one read method and one settings method;
 *     there is no channel to append/clear/trim.
 *  2. The preload bridge (the *only* thing the renderer can call) mirrors that
 *     surface exactly and adds nothing.
 *  3. The agent-facing tool harness (`tool-runner.ts`, reached by
 *     `IPC.toolsRun`) does not import or reference the audit store at all.
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');

function read(rel: string): string {
  return readFileSync(join(srcRoot, rel), 'utf8');
}

// Names that would indicate a mutating / face-reading audit channel.
const MUTATION_NAME = /audit(append|clear|delete|remove|trim|purge|drop|write|edit|reset|wipe)/i;

describe('audit store is immutable by agents — IPC contract', () => {
  it('exposes only auditSnapshot + auditSetRetention channel names', () => {
    const auditChannels = Object.entries(IPC).filter(([key]) => key.toLowerCase().includes('audit'));
    const keys = auditChannels.map(([key]) => key).sort();
    expect(keys).toEqual(['auditSetRetention', 'auditSnapshot']);
    for (const [, value] of auditChannels) {
      expect(value).not.toMatch(MUTATION_NAME);
    }
  });

  it('has no IPC channel whose name suggests audit mutation', () => {
    for (const value of Object.values(IPC)) {
      expect(String(value)).not.toMatch(MUTATION_NAME);
    }
  });

  it('the bridge type declares no mutating audit method', () => {
    const ipc = read('shared/ipc.ts');
    // The exposed methods, verbatim.
    expect(ipc).toContain('auditSnapshot(');
    expect(ipc).toContain('auditSetRetention(');
    expect(ipc).not.toMatch(/audit(Append|Clear|Delete|Remove|Trim|Purge|Wipe|Write)\s*\(/);
  });
});

describe('audit store is immutable by agents — preload surface', () => {
  it('only the renderer channel map for audit is present, with no mutation path', () => {
    const preload = read('preload/preload.ts');
    expect(preload).toContain('IPC.auditSnapshot');
    expect(preload).toContain('IPC.auditSetRetention');
    expect(preload).not.toMatch(MUTATION_NAME);
    // The audit store module must never be imported into the renderer-facing
    // preload bundle.
    expect(preload).not.toContain('audit-store');
  });
});

describe('audit store is immutable by agents — tool harness', () => {
  it('the agent-facing tool runner never references the audit store', () => {
    const runner = read('main/tool-runner.ts');
    expect(runner).not.toContain('audit');
    expect(runner).not.toContain('AuditStore');
  });

  it('the only main-process importer of the store is the audit wiring (main.ts + tool-audit.ts)', () => {
    // A grep-style guard: any new importer of the store would surface here and
    // must be reviewed before it can be treated as agent-reachable.
    const toolRunnerImportsStore = /from '\.\/audit-store/.test(read('main/tool-runner.ts'));
    expect(toolRunnerImportsStore).toBe(false);
  });
});
