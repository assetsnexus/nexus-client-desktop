import { describe, expect, it, vi } from 'vitest';
import {
  createTaskPoller,
  isTerminal,
  normalizeTaskSnapshot,
  parseLongRunningAccepted,
  renderProgress,
  waitForTask,
  type TaskSnapshot,
} from './long-running.js';

const snap = (over: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  id: 't1',
  status: 'running',
  percent: null,
  step: null,
  error: null,
  result: null,
  pollAfterMs: null,
  ...over,
});

describe('parseLongRunningAccepted', () => {
  it('reads the 102 accepted body', () => {
    const out = parseLongRunningAccepted({
      responseCode: 102,
      data: {
        accepted: true,
        taskId: 'task_1',
        status: 'queued',
        command: 'anx.export.run',
        statusCommand: 'anx.long-running.get',
        cancelCommand: 'anx.long-running.cancel',
        pollAfterMs: 1500,
      },
    });
    expect(out).toMatchObject({ taskId: 'task_1', pollAfterMs: 1500, status: 'queued' });
  });

  it('accepts a bare accepted body without an envelope code', () => {
    expect(parseLongRunningAccepted({ accepted: true, taskId: 't' })?.taskId).toBe('t');
  });

  it('returns null for a normal result or a missing taskId', () => {
    expect(parseLongRunningAccepted({ responseCode: 200, data: { ok: true } })).toBeNull();
    expect(parseLongRunningAccepted({ accepted: true })).toBeNull();
    expect(parseLongRunningAccepted(null)).toBeNull();
  });
});

describe('normalizeTaskSnapshot', () => {
  it('maps a LongRunningTaskView', () => {
    const s = normalizeTaskSnapshot(
      {
        responseObject: {
          taskId: 't1',
          status: 'running',
          progress: { percent: 40, step: 'rendering_pdf' },
          pollAfterMs: 2000,
        },
      },
      'fallback',
    );
    expect(s).toMatchObject({
      id: 't1',
      status: 'running',
      percent: 40,
      step: 'rendering_pdf',
      pollAfterMs: 2000,
    });
  });

  it('reads a structured error', () => {
    const s = normalizeTaskSnapshot({ status: 'failed', error: { code: 'X', message: 'boom' } });
    expect(s.status).toBe('failed');
    expect(s.error).toBe('boom');
  });

  it('falls back to an unknown snapshot for garbage', () => {
    expect(normalizeTaskSnapshot(null, 'fb')).toMatchObject({ id: 'fb', status: 'unknown' });
  });

  it('carries a terminal result reference', () => {
    const s = normalizeTaskSnapshot({ status: 'succeeded', result: { fileId: 'f1' } });
    expect(s.result).toEqual({ fileId: 'f1' });
  });
});

describe('createTaskPoller', () => {
  it('polls anx.long-running.get and normalizes', async () => {
    const send = vi.fn(async () => ({ taskId: 't9', status: 'succeeded' }));
    const poll = createTaskPoller(send as never);
    const s = await poll('t9');
    expect(send).toHaveBeenCalledWith('anx.long-running.get', { taskId: 't9' });
    expect(s.status).toBe('succeeded');
  });
});

describe('isTerminal', () => {
  it('knows the terminal statuses', () => {
    expect(isTerminal('succeeded')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('expired')).toBe(true);
    expect(isTerminal('running')).toBe(false);
  });
});

describe('waitForTask', () => {
  it('resolves when the task succeeds, honoring the region backoff', async () => {
    let calls = 0;
    const fetchTask = vi.fn(async () => {
      calls++;
      return snap({ status: calls < 3 ? 'running' : 'succeeded' });
    });
    const sleep = vi.fn(async () => {});
    const s = await waitForTask('t', { fetchTask, sleep, now: () => 0 });
    expect(s.status).toBe('succeeded');
    expect(fetchTask).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('uses the pollAfterMs from the snapshot to steer backoff', async () => {
    let calls = 0;
    const fetchTask = vi.fn(async () => {
      calls++;
      return snap({ status: calls < 2 ? 'running' : 'succeeded', pollAfterMs: 2500 });
    });
    const sleep = vi.fn(async () => {});
    await waitForTask('t', { fetchTask, sleep, now: () => 0 });
    expect(sleep).toHaveBeenCalledWith(2500);
  });

  it('returns failed on a terminal failure', async () => {
    const s = await waitForTask('t', {
      fetchTask: async () => snap({ status: 'failed', error: 'boom' }),
      sleep: async () => {},
      now: () => 0,
    });
    expect(s.status).toBe('failed');
    expect(s.error).toBe('boom');
  });

  it('returns cancelled when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const s = await waitForTask('t', {
      fetchTask: async () => snap(),
      signal: controller.signal,
      now: () => 0,
    });
    expect(s.status).toBe('cancelled');
  });

  it('retries through transient fetch errors', async () => {
    let calls = 0;
    const fetchTask = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('socket down');
      return snap({ status: 'succeeded' });
    });
    const s = await waitForTask('t', { fetchTask, sleep: async () => {}, now: () => 0 });
    expect(s.status).toBe('succeeded');
  });

  it('times out', async () => {
    let t = 0;
    const s = await waitForTask('t', {
      fetchTask: async () => snap(),
      sleep: async () => {
        t += 1000;
      },
      now: () => t,
      timeoutMs: 1500,
      pollAfterMs: 1000,
    });
    expect(s.error).toBe('timeout');
  });
});

describe('renderProgress', () => {
  it('renders status, percent, and step', () => {
    expect(renderProgress(snap({ status: 'running', percent: 42.6, step: 'rendering_pdf' }))).toBe(
      '[running 43%] — rendering_pdf',
    );
  });

  it('renders just the status without extras', () => {
    expect(renderProgress(snap({ status: 'queued' }))).toBe('[queued]');
  });
});
