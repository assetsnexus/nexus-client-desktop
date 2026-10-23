/**
 * OS-global cursor tracker for companion windows (main process).
 *
 * A companion avatar should follow the mouse anywhere on the display, not only
 * while the pointer is inside the small companion window. Electron's
 * `screen.getCursorScreenPoint()` reports display-space coordinates regardless of
 * focus, so we sample it (throttled) while any companion is open and push a
 * per-window sample to each companion renderer.
 *
 * Normalization is relative to the **display work area** the companion lives on
 * (not the window). The companion is a small box on a large screen, so
 * window-relative coords would pin the gaze at the cone edge as soon as the
 * cursor left the window; screen-relative coords let the gaze sweep its full
 * range as the pointer crosses the whole display.
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
  /**
   * Focus-independent OS pointer source (see `global-pointer.ts`). When given,
   * its `start`/`stop` are driven alongside the sampler and it is preferred over
   * the Electron probe so gaze keeps tracking while another app has focus.
   */
  pointerSource?: {
    current: () => { x: number; y: number } | null;
    start?: () => void;
    stop?: () => void;
  };
  /**
   * Work area of the display a window sits on, in the same display space as the
   * cursor point. Injectable for tests; defaults to
   * `screen.getDisplayMatching(bounds).workArea`. Returning `null` falls back to
   * the window bounds so a headless/degenerate display still normalizes.
   */
  getDisplayWorkArea?: (
    bounds: { x: number; y: number; width: number; height: number },
  ) => { x: number; y: number; width: number; height: number } | null;
  /** Injectable for tests; defaults to `setInterval`. */
  setIntervalImpl?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  /** Injectable for tests; defaults to `clearInterval`. */
  clearIntervalImpl?: (handle: ReturnType<typeof setInterval>) => void;
};

/** Pure normalization: display point → box-relative coords. */
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
  previous:
    | { x: number; y: number; outside: boolean; withinWindow?: boolean; focused?: boolean }
    | null,
  next: { x: number; y: number; outside: boolean; withinWindow?: boolean; focused?: boolean },
  minMovePx = MIN_MOVE_PX,
  windowWidth = 1,
  windowHeight = 1,
): boolean {
  if (!previous) return true;
  if (previous.outside !== next.outside) return true;
  // The gaze frame flips on the in-window / focus edges; the renderer needs both
  // transitions even when the cursor barely moved across the boundary.
  if (previous.withinWindow !== next.withinWindow) return true;
  if (previous.focused !== next.focused) return true;
  const dx = Math.abs(next.x - previous.x) * windowWidth;
  const dy = Math.abs(next.y - previous.y) * windowHeight;
  return dx >= minMovePx || dy >= minMovePx;
}

export function createGlobalCursorTracker(options: GlobalCursorTrackerOptions) {
  // Electron's `getCursorScreenPoint()` freezes once no app window is focused on
  // X11, so prefer a focus-independent source when one is provided (see
  // `global-pointer.ts`) and fall back to the Electron probe only when the
  // native source has no reading yet / is unavailable. The source must win over
  // the probe: `main.ts` supplies both, and the probe would otherwise silently
  // shadow the live stream.
  const probe = options.getCursorPoint ?? (() => screen.getCursorScreenPoint());
  const getPoint = (): { x: number; y: number } => {
    const fromSource = options.pointerSource?.current?.();
    return fromSource ?? probe();
  };
  const getWorkArea =
    options.getDisplayWorkArea ??
    ((bounds) => {
      try {
        return screen.getDisplayMatching(bounds).workArea;
      } catch {
        return null;
      }
    });
  const startTimer = options.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const stopTimer = options.clearIntervalImpl ?? ((h) => clearInterval(h));
  /** Last pushed sample per contact, for jitter suppression. */
  const lastByContact = new Map<
    string,
    { x: number; y: number; outside: boolean; withinWindow: boolean; focused: boolean }
  >();
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
      // Normalize to the display work area, not the window: the renderer picks
      // the final gaze frame (window vs screen) from `withinWindow` / `focused`.
      // Fall back to the window box only if the display lookup fails.
      const area = getWorkArea(bounds) ?? bounds;
      const normalized = normalizeCursorToBounds(point, area);
      const withinWindow =
        point.x >= bounds.x &&
        point.x <= bounds.x + bounds.width &&
        point.y >= bounds.y &&
        point.y <= bounds.y + bounds.height;
      const focused = typeof window.isFocused === 'function' ? window.isFocused() : true;
      const sample = { ...normalized, withinWindow, focused };
      const previous = lastByContact.get(contactId) ?? null;
      if (!shouldEmitCursorSample(previous, sample, MIN_MOVE_PX, area.width, area.height)) {
        continue;
      }
      lastByContact.set(contactId, sample);
      const payload: CompanionCursorCoords = {
        contactId,
        x: normalized.x,
        y: normalized.y,
        outside: normalized.outside,
        withinWindow,
        focused,
        screenX: point.x,
        screenY: point.y,
        bounds: { ...bounds },
        display: { ...area },
      };
      if (typeof window.isDestroyed === 'function' && window.isDestroyed()) continue;
      window.webContents.send(IPC.companionGlobalCursor, payload);
    }
  }

  function start(): void {
    if (handle) return;
    options.pointerSource?.start?.();
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
    options.pointerSource?.stop?.();
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
