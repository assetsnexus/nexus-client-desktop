import { describe, expect, it } from 'vitest';
import {
  applySwitchResult,
  beginSwitch,
  cancelSwitch,
  clearSwitchError,
  initialSwitchUiState,
  isSwitchPending,
} from './identity-switch-state.js';

describe('identity switch UI state', () => {
  it('marks the target pending immediately on begin', () => {
    const { state, seq } = beginSwitch(initialSwitchUiState, { key: 'identity:a', label: 'Acme' });
    expect(seq).toBe(1);
    expect(state.pendingKey).toBe('identity:a');
    expect(state.pendingLabel).toBe('Acme');
    expect(isSwitchPending(state, 'identity:a')).toBe(true);
    expect(isSwitchPending(state, 'identity:b')).toBe(false);
  });

  it('clears the pending flag and records success on the latest result', () => {
    const { state, seq } = beginSwitch(initialSwitchUiState, { key: 'identity:a', label: 'Acme' });
    const settled = applySwitchResult(state, seq, { ok: true });
    expect(settled.applied).toBe(true);
    expect(settled.state.pendingKey).toBeNull();
    expect(settled.state.error).toBeNull();
  });

  it('records the error message on failure', () => {
    const { state, seq } = beginSwitch(initialSwitchUiState, { key: 'identity:a', label: 'Acme' });
    const settled = applySwitchResult(state, seq, { ok: false, message: 'code rejected' });
    expect(settled.applied).toBe(true);
    expect(settled.state.pendingKey).toBeNull();
    expect(settled.state.error).toBe('code rejected');
  });

  it('drops the result of a superseded switch', () => {
    const first = beginSwitch(initialSwitchUiState, { key: 'identity:a', label: 'Acme' });
    const second = beginSwitch(first.state, { key: 'identity:b', label: 'Beta' });
    expect(second.seq).toBe(2);

    // A late response for the first target must not win.
    const lateForFirst = applySwitchResult(second.state, first.seq, { ok: true });
    expect(lateForFirst.applied).toBe(false);
    expect(lateForFirst.state.pendingKey).toBe('identity:b');

    // The current target still settles normally.
    const current = applySwitchResult(second.state, second.seq, { ok: true });
    expect(current.applied).toBe(true);
    expect(current.state.pendingKey).toBeNull();
  });

  it('clears a prior error when a new attempt begins', () => {
    const failed = applySwitchResult(
      beginSwitch(initialSwitchUiState, { key: 'identity:a', label: 'Acme' }).state,
      1,
      { ok: false, message: 'boom' },
    );
    const retry = beginSwitch(failed.state, { key: 'identity:a', label: 'Acme' });
    expect(retry.state.error).toBeNull();
    expect(retry.state.pendingKey).toBe('identity:a');
  });

  it('cancels cleanly and only clears an existing error when asked', () => {
    const pending = beginSwitch(initialSwitchUiState, { key: 'identity:a', label: 'Acme' }).state;
    const cancelled = cancelSwitch(pending);
    expect(cancelled.pendingKey).toBeNull();
    expect(cancelled.seq).toBe(pending.seq);

    const errored = { ...initialSwitchUiState, error: 'x' };
    expect(clearSwitchError(errored).error).toBeNull();
    // No-op returns the same reference (avoids needless renders).
    expect(clearSwitchError(initialSwitchUiState)).toBe(initialSwitchUiState);
  });
});
