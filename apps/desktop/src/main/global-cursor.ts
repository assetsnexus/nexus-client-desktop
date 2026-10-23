/**
 * OS-global cursor tracker for companion windows (main process).
 *
 * A companion avatar should follow the mouse anywhere on the display, not only
 * while the pointer is inside the small companion window. Electron's
 * `screen.getCursorScreenPoint()` reports display-space coordinates regardless of
 * focus, so we sample it (throttled) while any companion is open and push a
 * per-window normalized sample to each companion renderer.
 *
 * Normalization is relative to each window's own bounds: the renderer maps
 * `x/y` in `[0,1]` onto its gaze NDC cone, and out-of-range values (cursor off
 * that side) let it clamp at the cone edge instead of losing tracking.
 *
 * Deliberately dependency-light and timer-driven (not `setInterval` per window):
 * one shared sampler keeps cost flat as companions are added/removed, and
 * `unref()` keeps the timer from holding the process open.
 */

import { screen, type BrowserWindow } from 'electron';
import { IPC, type CompanionCursorCoords } from '../shared/ipc.js';

/** Sampling cadence. ~30 Hz is smooth enough and keeps main idle-friendly. */
const SAMPLE_INTERVAL_MS = 33;

/**
 * Ignore sub-pixel jitter: a sample is only pushed when the cursor moved at
 * least this many device pixels since the last push for that window.
 */
const MIN_MOVE_PX = 1;

export type CompanionCursorWindow = {
  contactId: string;
  window: BrowserWindow;
};

export type GlobalCursorTrackerOptions = {
  /** Current companion windows (contact id + BrowserWindow). */
  listWindows: () => CompanionCursorWindow[];
  /** Injectable for tests; defaults to electron `screen.getCursorScreenPoint`. */
  getCursorPoint?: () => { x: number; y: number };
  /** Injectable for tests; defaults to `setInterval`. */
  setIntervalImpl?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  /** Injectable for tests; defaults to `clearInterval`. */
  clearIntervalImpl?: (handle: ReturnType<typeof setInterval>) => void;
};

/** Pure normalization: display point → window-relative coords. */
export function normalizeCursorToBounds(
  point: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
): { x: number; y: number; outside: boolean } {
  const width = bounds.width || 1;
  const height = bounds.height || 1;
  const x = (point.x - bounds.x) / width;
  const y = (point.y - bounds.y) / height;
  const outside = x < 0 || x > 1 || y < 0 || y > 1;
  return { x, y, outside };
}

/**
 * Whether a sample is worth pushing: any move beyond the jitter threshold, or an
 * inside/outside transition (so the renderer learns the cursor left the window
 * even if it was a tiny hop across the edge).
 */
export function shouldEmitCursorSample(
  previous: { x: number; y: number; outside: boolean } | null,
  next: { x: number; y: number; outside: boolean },
  minMovePx = MIN_MOVE_PX,
  windowWidth = 1,
  windowHeight = 1,
): boolean {
  if (!previous) return true;
  if (previous.outside !== next.outside) return true;
  const dx = Math.abs(next.x - previous.x) * windowWidth;
  const dy = Math.abs(next.y - previous.y) * windowHeight;
  return dx >= minMovePx || dy >= minMovePx;
}

export function createGlobalCursorTracker(options: GlobalCursorTrackerOptions) {
  const getPoint = options.getCursorPoint ?? (() => screen.getCursorScreenPoint());
  const startTimer = options.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const stopTimer = options.clearIntervalImpl ?? ((h) => clearInterval(h));
  /** Last pushed sample per contact, for jitter suppression. */
  const lastByContact = new Map<string, { x: number; y: number; outside: boolean }>();
  let handle: ReturnType<typeof setInterval> | null = null;

  function emit(): void {
    const targets = options.listWindows();
    const live = new Set(targets.map((t) => t.contactId));
    for (const key of lastByContact.keys()) {
      if (!live.has(key)) lastByContact.delete(key);
    }
    if (targets.length === 0) return;
    const point = getPoint();
    for (const { contactId, window } of targets) {
      if (window.isDestroyed?.()) continue;
      const bounds = window.getBounds();
      const normalized = normalizeCursorToBounds(point, bounds);
      const previous = lastByContact.get(contactId) ?? null;
      if (!shouldEmitCursorSample(previous, normalized, MIN_MOVE_PX, bounds.width, bounds.height)) {
        continue;
      }
      lastByContact.set(contactId, normalized);
      const payload: CompanionCursorCoords = {
        contactId,
        x: normalized.x,
        y: normalized.y,
        outside: normalized.outside,
        screenX: point.x,
        screenY: point.y,
        bounds: { ...bounds },
      };
      if (typeof window.isDestroyed === 'function' && window.isDestroyed()) continue;
      window.webContents.send(IPC.companionGlobalCursor, payload);
    }
  }

  function start(): void {
    if (handle) return;
    handle = startTimer(emit, SAMPLE_INTERVAL_MS);
    // Never let the sampler hold the process open on its own.
    if (handle && typeof (handle as { unref?: () => void }).unref === 'function') {
      ;(handle as { unref: () => void }).unref();
    }
  }

  function stop(): void {
    if (!handle) return;
    stopTimer(handle);
    handle = null;
    lastByContact.clear();
  }

  return {
    start,
    stop,
    isRunning: () => handle !== null,
    /** Visible for tests: one manual sample without owning a timer. */
    sampleOnce: emit,
  };
}
