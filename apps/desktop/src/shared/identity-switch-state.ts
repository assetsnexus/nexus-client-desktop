/**
 * Immediate-feedback state for the identity / org-membership switcher.
 *
 * The switcher's actions are all async IPC round-trips (and a membership list is
 * a region call). Without a local pending state the row shows *nothing* until the
 * round-trip resolves, which reads as a "delayed / dead" reaction. This reducer
 * models a small state machine so the UI can react on the very first click:
 *
 *  - `beginSwitch` marks the clicked target pending **before** awaiting;
 *  - `applySwitchResult` only applies the result of the *latest* switch (a
 *    monotonic `seq` drops a late response for a target the user already
 *    superseded) and clears the pending flag.
 *
 * Pure and framework-free so it is unit-testable.
 */

export type SwitchUiState = {
  /** Target currently in flight (`null` when idle). Namespaced by surface. */
  pendingKey: string | null;
  /** Human label of the pending target, shown next to the spinner. */
  pendingLabel: string | null;
  /** Monotonic request id; a response is ignored unless it matches the latest. */
  seq: number;
  /** Last failure to display; cleared on a new attempt. */
  error: string | null;
};

export const initialSwitchUiState: SwitchUiState = {
  pendingKey: null,
  pendingLabel: null,
  seq: 0,
  error: null,
};

/**
 * Enter the pending state for `target`. Bumps `seq` so any earlier in-flight
 * response is recognised as stale. Returns the next state and the request id the
 * caller must pass back to {@link applySwitchResult}.
 */
export function beginSwitch(
  prev: SwitchUiState,
  target: { key: string; label: string },
): { state: SwitchUiState; seq: number } {
  const seq = prev.seq + 1;
  return {
    state: { pendingKey: target.key, pendingLabel: target.label, seq, error: null },
    seq,
  };
}

/**
 * Settle the switch identified by `seq`. A result from a superseded switch
 * (`seq !== state.seq`) is dropped — `applied` is false — so a slow response for
 * the earlier target can never flip the UI back after the user picked another.
 */
export function applySwitchResult(
  prev: SwitchUiState,
  seq: number,
  result: { ok: true } | { ok: false; message: string },
): { state: SwitchUiState; applied: boolean } {
  if (seq !== prev.seq) return { state: prev, applied: false };
  return {
    state: {
      ...prev,
      pendingKey: null,
      pendingLabel: null,
      error: result.ok ? null : result.message,
    },
    applied: true,
  };
}

/** Abandon the current attempt without an error (e.g. the user cancelled). */
export function cancelSwitch(prev: SwitchUiState): SwitchUiState {
  return { ...prev, pendingKey: null, pendingLabel: null, error: null };
}

/** Clear only the error, keeping any pending target untouched. */
export function clearSwitchError(prev: SwitchUiState): SwitchUiState {
  return prev.error === null ? prev : { ...prev, error: null };
}

/** True when `key` is the target of the in-flight switch. */
export function isSwitchPending(state: SwitchUiState, key: string): boolean {
  return state.pendingKey === key;
}
