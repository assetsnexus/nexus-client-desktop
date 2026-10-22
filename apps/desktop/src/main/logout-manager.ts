/**
 * Logout manager (Deliverable 5, main process).
 *
 * Executes the pure plan from `shared/logout.ts`: either "switch user" (keep
 * local data, optionally unmounting) or "permanent" (full local teardown). Each
 * step is wrapped so one failure never aborts the rest — a partial failure is
 * reported back so the user can retry exactly the steps that failed, and is
 * never left stuck.
 *
 * Deps are injected so the branching is unit-testable without Electron.
 */

import {
  planLogout,
  summariseLogout,
  type LogoutChoice,
  type LogoutReport,
  type LogoutStep,
  type LogoutStepResult,
} from '../shared/logout.js';

export type LogoutManagerDeps = {
  stopSync: () => void | Promise<void>;
  /** Unmount every session and forget it. Resolves even if some fail. */
  unmountAll: () => Promise<void>;
  clearSyncBindings: () => Promise<void>;
  clearWakeQueue: () => Promise<void>;
  /** Clear the multi-identity store entirely. */
  clearIdentityStore: () => void | Promise<void>;
  /** Delete secrets (token, device keys, PIN) from the secure store. */
  clearSecureStore: () => Promise<void>;
  /** End the active session (clear the in-memory + persisted token). */
  endSession: () => Promise<void>;
};

export type LogoutManager = {
  /** Run the plan for `choice` and return a per-step report. */
  run(choice: LogoutChoice): Promise<LogoutReport>;
  /** Retry only the steps a previous report listed as retryable. */
  retry(retryable: LogoutStep[], choice: LogoutChoice): Promise<LogoutReport>;
};

export function createLogoutManager(deps: LogoutManagerDeps): LogoutManager {
  async function runStep(step: LogoutStep): Promise<LogoutStepResult> {
    try {
      switch (step) {
        case 'stop_sync':
          await deps.stopSync();
          break;
        case 'unmount_all':
          await deps.unmountAll();
          break;
        case 'clear_sync_bindings':
          await deps.clearSyncBindings();
          break;
        case 'clear_wake_queue':
          await deps.clearWakeQueue();
          break;
        case 'clear_identity_store':
          await deps.clearIdentityStore();
          break;
        case 'clear_secure_store':
          await deps.clearSecureStore();
          break;
        case 'end_session':
          await deps.endSession();
          break;
      }
      return { step, ok: true, error: null };
    } catch (err) {
      return { step, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function runSteps(steps: LogoutStep[], choice: LogoutChoice): Promise<LogoutReport> {
    const results: LogoutStepResult[] = [];
    for (const step of steps) {
      results.push(await runStep(step));
    }
    return summariseLogout(choice, results);
  }

  return {
    run(choice) {
      return runSteps(planLogout(choice), choice);
    },
    retry(retryable, choice) {
      return runSteps(retryable, choice);
    },
  };
}
