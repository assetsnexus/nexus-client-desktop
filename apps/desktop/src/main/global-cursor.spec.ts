import { describe, expect, it } from 'vitest';
import {
  normalizeCursorToBounds,
  shouldEmitCursorSample,
  createGlobalCursorTracker,
} from './global-cursor.js';

describe('normalizeCursorToBounds', () => {
  const bounds = { x: 100, y: 200, width: 400, height: 300 };

  it('maps the window top-left to (0,0) and bottom-right to (1,1)', () => {
    expect(normalizeCursorToBounds({ x: 100, y: 200 }, bounds)).toEqual({
      x: 0,
      y: 0,
      outside: false,
    });
    expect(normalizeCursorToBounds({ x: 500, y: 500 }, bounds)).toEqual({
      x: 1,
      y: 1,
      outside: false,
    });
  });

  it('maps the window center to (0.5, 0.5)', () => {
    expect(normalizeCursorToBounds({ x: 300, y: 350 }, bounds)).toEqual({
      x: 0.5,
      y: 0.5,
      outside: false,
    });
  });

  it('reports out-of-window cursors with out-of-range coords, not clamped ones', () => {
    // Cursor far left and above the window: the direction must survive.
    const left = normalizeCursorToBounds({ x: 0, y: 100 }, bounds);
    expect(left.outside).toBe(true);
    expect(left.x).toBeLessThan(0);
    expect(left.y).toBeLessThan(0);
  });

  it('never divides by zero on a degenerate window', () => {
    const r = normalizeCursorToBounds({ x: 10, y: 10 }, { x: 0, y: 0, width: 0, height: 0 });
    expect(Number.isFinite(r.x)).toBe(true);
    expect(Number.isFinite(r.y)).toBe(true);
  });
});

describe('shouldEmitCursorSample', () => {
  const inside = { x: 0.5, y: 0.5, outside: false };

  it('always emits the first sample', () => {
    expect(shouldEmitCursorSample(null, inside)).toBe(true);
  });

  it('suppresses sub-pixel jitter', () => {
    const next = { x: 0.5001, y: 0.5, outside: false };
    // 0.0001 * 400px window = 0.04px < 1px threshold.
    expect(shouldEmitCursorSample(inside, next, 1, 400, 300)).toBe(false);
  });

  it('emits once a real move crosses the threshold', () => {
    const next = { x: 0.51, y: 0.5, outside: false };
    expect(shouldEmitCursorSample(inside, next, 1, 400, 300)).toBe(true);
  });

  it('always emits on an inside/outside transition even if nearly stationary', () => {
    const justOutside = { x: -0.0001, y: 0.5, outside: true };
    expect(shouldEmitCursorSample(inside, justOutside, 5, 400, 300)).toBe(true);
  });
});

describe('createGlobalCursorTracker', () => {
  function makeWindow(overrides: Record<string, unknown> = {}) {
    const sent: unknown[] = [];
    return {
      sent,
      window: {
        isDestroyed: () => false,
        getBounds: () => ({ x: 0, y: 0, width: 400, height: 300 }),
        webContents: { send: (_ch: string, payload: unknown) => sent.push(payload) },
        ...overrides,
      } as never,
    };
  }

  it('sends a normalized sample to each live companion window', () => {
    const a = makeWindow();
    const tracker = createGlobalCursorTracker({
      listWindows: () => [{ contactId: 'contact-a', window: a.window }],
      getCursorPoint: () => ({ x: 200, y: 150 }),
    });
    tracker.sampleOnce();
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0]).toMatchObject({ contactId: 'contact-a', x: 0.5, y: 0.5, outside: false });
  });

  it('skips destroyed windows', () => {
    const dead = makeWindow({ isDestroyed: () => true });
    const tracker = createGlobalCursorTracker({
      listWindows: () => [{ contactId: 'dead', window: dead.window }],
      getCursorPoint: () => ({ x: 0, y: 0 }),
    });
    tracker.sampleOnce();
    expect(dead.sent).toHaveLength(0);
  });

  it('does not invoke the cursor probe when there are no windows', () => {
    let probed = 0;
    const tracker = createGlobalCursorTracker({
      listWindows: () => [],
      getCursorPoint: () => {
        probed += 1;
        return { x: 0, y: 0 };
      },
    });
    tracker.sampleOnce();
    expect(probed).toBe(0);
  });

  it('starts and stops the shared timer exactly once', () => {
    let started = 0;
    let cleared = 0;
    const tracker = createGlobalCursorTracker({
      listWindows: () => [],
      setIntervalImpl: () => {
        started += 1;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalImpl: () => {
        cleared += 1;
      },
    });
    tracker.start();
    tracker.start();
    expect(started).toBe(1);
    expect(tracker.isRunning()).toBe(true);
    tracker.stop();
    expect(cleared).toBe(1);
    expect(tracker.isRunning()).toBe(false);
  });
});
