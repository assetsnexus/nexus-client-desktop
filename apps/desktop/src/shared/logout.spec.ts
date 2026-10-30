import { describe, expect, it } from 'vitest';
import {
  LOGOUT_STEP_ORDER,
  planLogout,
  retryPlan,
  stepLabel,
  summariseLogout,
  type LogoutStepResult,
} from './logout.js';

describe('planLogout', () => {
  it('keeps local data but drops the regenerable chat cache when switching user', () => {
    // The metadata-only chat cache is regenerable server data, so it is dropped
    // on every sign-out; nothing user-authored is touched.
    expect(planLogout({ kind: 'switch_user', unmount: false })).toEqual([
      'clear_chat_cache',
      'end_session',
    ]);
  });

  it('stops sync and clears mounts when switching user with unmounting', () => {
    const plan = planLogout({ kind: 'switch_user', unmount: true });
    expect(plan).toEqual(['stop_sync', 'unmount_all', 'clear_chat_cache', 'end_session']);
    // The destructive full-teardown steps must NOT run on a keep-data switch.
    expect(plan).not.toContain('clear_identity_store');
    expect(plan).not.toContain('clear_secure_store');
    expect(plan).not.toContain('clear_wake_queue');
  });

  it('runs the full ordered teardown for a permanent logout', () => {
    expect(planLogout({ kind: 'permanent' })).toEqual([...LOGOUT_STEP_ORDER]);
    // Ordering matters: stop the scheduler before unmounting, and end the session last.
    expect(LOGOUT_STEP_ORDER[0]).toBe('stop_sync');
    expect(LOGOUT_STEP_ORDER[LOGOUT_STEP_ORDER.length - 1]).toBe('end_session');
    expect(LOGOUT_STEP_ORDER).toContain('clear_chat_cache');
  });
});

describe('summariseLogout', () => {
  const ok = (step: LogoutStepResult['step']): LogoutStepResult => ({ step, ok: true, error: null });
  const fail = (step: LogoutStepResult['step'], error: string): LogoutStepResult => ({
    step,
    ok: false,
    error,
  });

  it('reports success when every step passed', () => {
    const report = summariseLogout({ kind: 'permanent' }, [ok('stop_sync'), ok('end_session')]);
    expect(report.ok).toBe(true);
    expect(report.retryable).toEqual([]);
  });

  it('lists exactly the failed steps as retryable (never stuck)', () => {
    const report = summariseLogout({ kind: 'permanent' }, [
      ok('stop_sync'),
      fail('unmount_all', 'device busy'),
      ok('clear_wake_queue'),
      fail('clear_secure_store', 'keychain locked'),
    ]);
    expect(report.ok).toBe(false);
    expect(report.retryable).toEqual(['unmount_all', 'clear_secure_store']);
    expect(report.results[1].error).toBe('device busy');
  });
});

describe('retryPlan', () => {
  it('returns only the step subset that failed', () => {
    const report = summariseLogout({ kind: 'permanent' }, [
      { step: 'stop_sync', ok: true, error: null },
      { step: 'unmount_all', ok: false, error: 'busy' },
    ]);
    expect(retryPlan(report)).toEqual(['unmount_all']);
  });

  it('is empty when there is nothing to retry', () => {
    const report = summariseLogout({ kind: 'permanent' }, [
      { step: 'stop_sync', ok: true, error: null },
    ]);
    expect(retryPlan(report)).toEqual([]);
  });
});

describe('stepLabel', () => {
  it('gives every step a distinct, non-empty label', () => {
    const labels = LOGOUT_STEP_ORDER.map(stepLabel);
    expect(labels.every((l) => l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(LOGOUT_STEP_ORDER.length);
  });
});
