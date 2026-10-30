import { describe, expect, it, vi } from 'vitest';
import { createLogoutManager, type LogoutManagerDeps } from './logout-manager.js';
import type { LogoutStepResult } from '../shared/logout.js';

type Harness = {
  deps: LogoutManagerDeps;
  calls: string[];
  failOn: Set<string>;
};

function harness(opts: { failOn?: string[] } = {}): Harness {
  const calls: string[] = [];
  const failOn = new Set(opts.failOn ?? []);
  const track = (name: string) => {
    calls.push(name);
    if (failOn.has(name)) throw new Error(`${name} failed`);
  };
  const deps: LogoutManagerDeps = {
    stopSync: () => track('stopSync'),
    unmountAll: async () => track('unmountAll'),
    clearSyncBindings: async () => track('clearSyncBindings'),
    clearWakeQueue: async () => track('clearWakeQueue'),
    clearChatCache: async () => track('clearChatCache'),
    clearIdentityStore: () => track('clearIdentityStore'),
    clearSecureStore: async () => track('clearSecureStore'),
    endSession: async () => track('endSession'),
  };
  return { deps, calls, failOn };
}

const stepOf = (results: LogoutStepResult[], step: LogoutStepResult['step']) =>
  results.find((r) => r.step === step);

describe('createLogoutManager — switch user (keep local data)', () => {
  it('only ends the session + drops the chat cache, keeping every local datum', async () => {
    const h = harness();
    const report = await createLogoutManager(h.deps).run({ kind: 'switch_user', unmount: false });
    expect(report.ok).toBe(true);
    expect(h.calls).toEqual(['clearChatCache', 'endSession']);
  });

  it('stops sync and unmounts when the user also asked to unmount', async () => {
    const h = harness();
    const report = await createLogoutManager(h.deps).run({ kind: 'switch_user', unmount: true });
    expect(report.ok).toBe(true);
    expect(h.calls).toEqual(['stopSync', 'unmountAll', 'clearChatCache', 'endSession']);
    // Identity / secure store / wake queue must survive a keep-data switch.
    expect(h.calls).not.toContain('clearIdentityStore');
    expect(h.calls).not.toContain('clearSecureStore');
    expect(h.calls).not.toContain('clearWakeQueue');
  });

  it('still ends the session even when the unmount fails (never stuck)', async () => {
    const h = harness({ failOn: ['unmountAll'] });
    const report = await createLogoutManager(h.deps).run({ kind: 'switch_user', unmount: true });
    expect(report.ok).toBe(false);
    expect(h.calls).toContain('endSession');
    expect(stepOf(report.results, 'unmount_all')?.error).toMatch(/failed/);
    expect(report.retryable).toEqual(['unmount_all']);
  });
});

describe('createLogoutManager — permanent logout', () => {
  it('runs the full ordered teardown', async () => {
    const h = harness();
    const report = await createLogoutManager(h.deps).run({ kind: 'permanent' });
    expect(report.ok).toBe(true);
    expect(h.calls).toEqual([
      'stopSync',
      'unmountAll',
      'clearSyncBindings',
      'clearWakeQueue',
      'clearChatCache',
      'clearIdentityStore',
      'clearSecureStore',
      'endSession',
    ]);
  });

  it('continues past a failure and reports exactly what could not be cleared', async () => {
    const h = harness({ failOn: ['clearSecureStore'] });
    const report = await createLogoutManager(h.deps).run({ kind: 'permanent' });
    expect(report.ok).toBe(false);
    expect(report.retryable).toEqual(['clear_secure_store']);
    // Every later step still ran (no early abort).
    expect(h.calls).toContain('endSession');
    expect(h.calls).toContain('clearWakeQueue');
  });

  it('retries only the failed steps', async () => {
    const h = harness({ failOn: ['unmountAll'] });
    const manager = createLogoutManager(h.deps);
    const first = await manager.run({ kind: 'permanent' });
    const retryCalls = h.calls.length;
    h.failOn.clear();
    const second = await manager.retry(first.retryable, { kind: 'permanent' });
    expect(second.ok).toBe(true);
    // Only the one failed step re-ran.
    expect(h.calls.slice(retryCalls)).toEqual(['unmountAll']);
  });

  it('catches a synchronous throw from a step', async () => {
    const h = harness();
    const failing: LogoutManagerDeps = {
      ...h.deps,
      clearIdentityStore: () => {
        throw new Error('store locked');
      },
    };
    const report = await createLogoutManager(failing).run({ kind: 'permanent' });
    expect(stepOf(report.results, 'clear_identity_store')).toEqual({
      step: 'clear_identity_store',
      ok: false,
      error: 'store locked',
    });
    expect(report.ok).toBe(false);
  });

  it('reports a fully-clean run with no retryable steps', async () => {
    const h = harness();
    const spy = vi.fn();
    const report = await createLogoutManager({ ...h.deps, endSession: async () => spy() }).run({
      kind: 'permanent',
    });
    expect(spy).toHaveBeenCalledOnce();
    expect(report.retryable).toEqual([]);
  });
});
