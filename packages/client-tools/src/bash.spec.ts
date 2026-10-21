import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runBash } from './bash.js';
import { DEFAULT_BASH_POLICY, type BashPolicy } from './bash-policy.js';
import type { WorkspaceRoot } from './workspace.js';

let base: string;
let roots: WorkspaceRoot[];

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'nexus-bash-'));
  roots = [{ id: 'ws', label: 'ws', path: base, mode: 'read-write' }];
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const allowAll: BashPolicy = {
  allow: [{ commandPattern: '.*', action: 'allow' }],
  deny: [],
  fallback: 'allow',
};

describe('runBash', () => {
  it('runs an allowed command and captures stdout', async () => {
    const res = await runBash(
      { argv: ['node', '-e', 'process.stdout.write("hello")'], cwd: base },
      { roots, policy: allowAll },
    );
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe('hello');
    expect(res.exitCode).toBe(0);
  });

  it('captures stderr and a non-zero exit code without throwing', async () => {
    const res = await runBash(
      { argv: ['node', '-e', 'process.stderr.write("boom"); process.exit(2)'], cwd: base },
      { roots, policy: allowAll },
    );
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('boom');
  });

  it('refuses a denied command without spawning', async () => {
    const runFn = vi.fn();
    const res = await runBash(
      { argv: ['rm', '-rf', '/'], cwd: base },
      { roots, policy: DEFAULT_BASH_POLICY, runFn: runFn as never },
    );
    expect(res.ok).toBe(false);
    expect(res.denied).toBe('deny');
    expect(runFn).not.toHaveBeenCalled();
  });

  it('asks, and denies when the confirm callback says no', async () => {
    const confirm = vi.fn(async () => false);
    const res = await runBash(
      { argv: ['node', '-e', '0'], cwd: base },
      { roots, policy: DEFAULT_BASH_POLICY, confirm },
    );
    expect(res.denied).toBe('deny');
    expect(res.reason).toBe('not approved');
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('asks, and runs when the confirm callback says yes', async () => {
    const confirm = vi.fn(async () => true);
    const res = await runBash(
      { argv: ['node', '-e', 'process.stdout.write("ok")'], cwd: base },
      { roots, policy: DEFAULT_BASH_POLICY, confirm },
    );
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe('ok');
  });

  it('refuses a cwd outside every workspace root', async () => {
    const res = await runBash(
      { argv: ['node', '-e', '0'], cwd: '/', },
      { roots, policy: allowAll },
    );
    expect(res.ok).toBe(false);
    expect(res.denied).toBe('sandbox');
  });

  it('kills a command that exceeds its timeout', async () => {
    const res = await runBash(
      { argv: ['node', '-e', 'setTimeout(()=>{}, 60000)'], cwd: base, timeoutMs: 100 },
      { roots, policy: allowAll },
    );
    expect(res.timedOut).toBe(true);
    expect(res.ok).toBe(false);
  });

  it('does not leak non-allowlisted env vars', async () => {
    process.env.NEXUS_SECRET_LEAK = 'should-not-appear';
    const res = await runBash(
      { argv: ['node', '-e', 'process.stdout.write(String(process.env.NEXUS_SECRET_LEAK))'], cwd: base },
      { roots, policy: allowAll },
    );
    expect(res.stdout).toBe('undefined');
    delete process.env.NEXUS_SECRET_LEAK;
  });
});
