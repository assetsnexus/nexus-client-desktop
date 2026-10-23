/**
 * Logout planning (Deliverable 5) — pure branching, host-agnostic.
 *
 * Logging out offers exactly two explicit choices, and neither may leave the user
 * stuck:
 *
 * - **Switch to another user (keep local data)** — keep this device's local
 *   state (multi-identity store, sync bindings, mounts, wake queue, secure store)
 *   and only end the active session. The user is additionally asked whether to
 *   unmount local storage dirs/mounts first.
 * - **Permanent logout** — remove every trace of local state: identity bindings,
 *   mounts, sync bindings, the wake-transcript queue, the secure store and the
 *   app-lock PIN.
 *
 * This module only *decides which steps run*; the main-process manager performs
 * them and reports partial failures so the user can retry.
 */

export type LogoutChoice =
  | {
      kind: 'switch_user';
      /**
       * Also unmount the local storage dirs/mounts while keeping other local
       * data. When false the mounts are left in place for the next user.
       */
      unmount: boolean;
    }
  | { kind: 'permanent' };

/**
 * One teardown step. Ordered from "least destructive" to "most destructive" so a
 * partial failure never wipes local data before the mounts sync has stopped.
 */
export type LogoutStep =
  /** Stop the background sync scheduler. */
  | 'stop_sync'
  /** Stop + forget every mount session (kernel helper or mirror). */
  | 'unmount_all'
  /** Remove the persisted sync bindings. */
  | 'clear_sync_bindings'
  /** Drop queued wake transcripts (`wake-queue.json`). */
  | 'clear_wake_queue'
  /** Remove this account from the multi-identity store. */
  | 'clear_identity_store'
  /** Delete secrets from the secure store (token, device keys, PIN). */
  | 'clear_secure_store'
  /** End the active session (clear the in-memory + persisted token). */
  | 'end_session';

/** The canonical step order, independent of the chosen branch. */
export const LOGOUT_STEP_ORDER: readonly LogoutStep[] = [
  'stop_sync',
  'unmount_all',
  'clear_sync_bindings',
  'clear_wake_queue',
  'clear_identity_store',
  'clear_secure_store',
  'end_session',
];

/**
 * Expand a choice into the ordered list of steps to run.
 *
 * - `switch_user` with `unmount: false` keeps *everything* except the session.
 * - `switch_user` with `unmount: true` additionally stops + clears the mounts.
 * - `permanent` runs the full teardown.
 */
export function planLogout(choice: LogoutChoice): LogoutStep[] {
  if (choice.kind === 'switch_user') {
    return choice.unmount ? ['stop_sync', 'unmount_all', 'end_session'] : ['end_session'];
  }
  return [...LOGOUT_STEP_ORDER];
}

/** Stable, human-readable label for a teardown step (shown in the report UI). */
export function stepLabel(step: LogoutStep): string {
  switch (step) {
    case 'stop_sync':
      return 'Stop background sync';
    case 'unmount_all':
      return 'Unmount local drives';
    case 'clear_sync_bindings':
      return 'Remove sync bindings';
    case 'clear_wake_queue':
      return 'Delete queued voice transcripts';
    case 'clear_identity_store':
      return 'Forget local accounts';
    case 'clear_secure_store':
      return 'Delete stored secrets';
    case 'end_session':
      return 'End the session';
  }
}

export type LogoutStepResult = {
  step: LogoutStep;
  ok: boolean;
  /** Reason when the step failed; null on success. */
  error: string | null;
};

export type LogoutReport = {
  choice: LogoutChoice;
  /** Per-step outcome, in the order the steps ran. */
  results: LogoutStepResult[];
  /** True when every step succeeded. */
  ok: boolean;
  /** The steps the user may retry (only the ones that failed). */
  retryable: LogoutStep[];
};

/** Build a report from per-step outcomes. */
export function summariseLogout(choice: LogoutChoice, results: LogoutStepResult[]): LogoutReport {
  const retryable = results.filter((r) => !r.ok).map((r) => r.step);
  return { choice, results, ok: retryable.length === 0, retryable };
}

/**
 * The subset of steps still worth retrying, given the steps already attempted.
 * Retrying only the failures avoids re-running a destructive step twice.
 */
export function retryPlan(report: LogoutReport): LogoutStep[] {
  return [...report.retryable];
}
