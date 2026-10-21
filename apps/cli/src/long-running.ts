/**
 * Long-running task handling (region envelope `102`).
 *
 * Region commands can return envelope **102** (accepted-but-incomplete) instead
 * of a result. The only sanctioned follow-up is polling `anx.long-running.get`
 * with the returned `taskId` (push is best-effort, poll is authoritative).
 * See `anx-region-node_2/docs/ai_agents/contexts/29_long_running_tasks.md`.
 *
 * This module is pure/injectable so the poll loop is unit-testable without a
 * network.
 */

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'unknown';

export type TaskSnapshot = {
  id: string;
  status: TaskStatus;
  /** 0-100, when the region estimated completion. */
  percent: number | null;
  /** Human-readable current step, e.g. `rendering_pdf`. */
  step: string | null;
  error: string | null;
  /** Set once terminal `succeeded`; references only, never secrets. */
  result: Record<string, unknown> | null;
  /** Advisory backoff before the next poll, from the region. */
  pollAfterMs: number | null;
};

/** The `102` accepted body (`LongRunningAcceptedBodyV1`). */
export type LongRunningAccepted = {
  accepted: true;
  taskId: string;
  status: TaskStatus;
  command: string;
  statusCommand: string;
  cancelCommand: string;
  pollAfterMs: number;
};

/** Detect an accepted-but-incomplete (`102`) send result and read its body. */
export function parseLongRunningAccepted(raw: unknown): LongRunningAccepted | null {
  const r = asRecord(raw);
  if (!r) return null;
  const envelopeCode = typeof r.responseCode === 'number' ? r.responseCode : null;
  const body = asRecord(r.data) ?? asRecord(r.responseObject) ?? r;
  const is102 = envelopeCode === 102 || body?.accepted === true;
  if (!is102) return null;
  const taskId = typeof body?.taskId === 'string' ? body.taskId : '';
  if (!taskId) return null;
  return {
    accepted: true,
    taskId,
    status: normalizeStatus(body?.status),
    command: typeof body?.command === 'string' ? body.command : '',
    statusCommand:
      typeof body?.statusCommand === 'string' ? body.statusCommand : 'anx.long-running.get',
    cancelCommand:
      typeof body?.cancelCommand === 'string' ? body.cancelCommand : 'anx.long-running.cancel',
    pollAfterMs: typeof body?.pollAfterMs === 'number' ? body.pollAfterMs : 1000,
  };
}

export type PollOptions = {
  fetchTask: (taskId: string) => Promise<TaskSnapshot>;
  /** Advisory backoff from the original `102`; used until the region answers. */
  pollAfterMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onTick?: (snapshot: TaskSnapshot) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const DEFAULT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function isTerminal(status: TaskStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'expired';
}

/**
 * Poll until the task reaches a terminal status, the timeout elapses, or the
 * signal aborts. A transient fetch error is retried until the deadline so a
 * flaky socket does not fail a long job (poll is authoritative).
 */
export async function waitForTask(taskId: string, options: PollOptions): Promise<TaskSnapshot> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;

  let delay = options.pollAfterMs ?? DEFAULT_POLL_MS;
  let last: TaskSnapshot = emptySnapshot(taskId);

  while (now() < deadline) {
    if (options.signal?.aborted) return { ...last, status: 'cancelled' };
    try {
      last = await options.fetchTask(taskId);
    } catch (err) {
      last = { ...last, error: err instanceof Error ? err.message : 'poll failed' };
    }
    options.onTick?.(last);
    if (isTerminal(last.status)) return last;
    // The region may steer the backoff (e.g. back off on a long export).
    if (last.pollAfterMs != null && last.pollAfterMs > 0) delay = last.pollAfterMs;
    await sleep(delay);
  }
  return { ...last, error: last.error ?? 'timeout' };
}

/** Build a poller bound to a command sender (`anx.long-running.get`). */
export function createTaskPoller(send: (command: string, payload: Record<string, unknown>) => Promise<unknown>) {
  return async (taskId: string): Promise<TaskSnapshot> => {
    const raw = await send('anx.long-running.get', { taskId });
    return normalizeTaskSnapshot(raw, taskId);
  };
}

/** Normalize `anx.long-running.get` output (`LongRunningTaskView`) into a snapshot. */
export function normalizeTaskSnapshot(raw: unknown, fallbackId = ''): TaskSnapshot {
  const r = asRecord(raw);
  if (!r) return emptySnapshot(fallbackId);
  const body = asRecord(r.responseObject) ?? asRecord(r.data) ?? r;
  const progress = asRecord(body.progress);
  const error = body.error;
  return {
    id: typeof body.taskId === 'string' && body.taskId ? body.taskId : fallbackId,
    status: normalizeStatus(body.status),
    percent: typeof progress?.percent === 'number' ? progress.percent : null,
    step: typeof progress?.step === 'string' ? progress.step : null,
    error:
      typeof error === 'string'
        ? error
        : typeof asRecord(error)?.message === 'string'
          ? (asRecord(error)!.message as string)
          : null,
    result: asRecord(body.result),
    pollAfterMs: typeof body.pollAfterMs === 'number' ? body.pollAfterMs : null,
  };
}

/** One-line progress renderer for a status line. */
export function renderProgress(snapshot: TaskSnapshot): string {
  const pct = snapshot.percent != null ? ` ${Math.round(snapshot.percent)}%` : '';
  const step = snapshot.step ? ` — ${snapshot.step}` : '';
  const err = snapshot.error ? ` (${snapshot.error})` : '';
  return `[${snapshot.status}${pct}]${step}${err}`;
}

function emptySnapshot(id: string): TaskSnapshot {
  return { id, status: 'unknown', percent: null, step: null, error: null, result: null, pollAfterMs: null };
}

function normalizeStatus(raw: unknown): TaskStatus {
  return raw === 'queued' ||
    raw === 'running' ||
    raw === 'succeeded' ||
    raw === 'failed' ||
    raw === 'cancelled' ||
    raw === 'expired'
    ? raw
    : 'unknown';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
