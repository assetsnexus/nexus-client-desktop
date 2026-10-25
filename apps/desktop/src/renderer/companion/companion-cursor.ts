/**
 * Map OS-global companion-cursor samples onto avatar gaze.
 *
 * The main process pushes a cursor sample normalized to the **display work
 * area** (`x/y` in `[0,1]` across the screen — see `CompanionCursorCoords`),
 * plus the companion window bounds and the work area. This module turns that
 * into the gaze NDC the avatar's controller consumes.
 *
 * ## One writer, one frame
 *
 * The avatar has exactly **one** source of truth for aim: the main-process
 * OS-global sampler, pushed through `setPointerNdc` (see `CompanionView` +
 * `setExternalPointerEnabled`). The in-webview DOM `pointermove` path is a
 * strict no-op while that feed is armed.
 *
 * Earlier this module picked between *two* frames per sample — a
 * window-anchored frame while the companion had OS focus, and a gentler
 * whole-display frame when it did not. Focus is **not** evidence of where the
 * cursor is, and the two frames disagree at the window edge, so the same cursor
 * position produced two different aims depending on which window owned the
 * keyboard. That is the "sometimes one works, sometimes the other" flap the
 * user saw: inside the webview the aim silently depended on OS focus.
 *
 * There is now a single **window-anchored frame** used for every sample,
 * regardless of `focused` / `withinWindow`:
 *
 * - neutral over the window center (the avatar looks at you),
 * - linear to ±{@link FOCUSED_WINDOW_GAIN} at the window edge (lively in-window
 *   motion), then
 * - continuing smoothly to ±1 at the screen edge, so the head keeps turning as
 *   the cursor roams the rest of the display.
 *
 * The frame is continuous and monotonic across the window boundary, so crossing
 * the edge never snaps or flaps — and because it does not consult focus, the
 * same cursor position always yields the same aim.
 *
 * Pure + dependency-free for unit testing.
 */

import type { CompanionCursorCoords } from '../../shared/ipc.js';

export type CompanionCursorNdc = { x: number; y: number };

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/**
 * Fraction of the gaze cone reached at the window edge. Leaves head-room
 * (`1 - FOCUSED_WINDOW_GAIN`) so the head keeps turning smoothly as the cursor
 * crosses the rest of the display rather than pinning at the window boundary.
 * 0.5 keeps the in-window motion lively while giving the whole-screen roam real
 * travel.
 */
const FOCUSED_WINDOW_GAIN = 0.5;

function centerFraction(origin: number, extent: number, size: number): number {
  if (!size) return 0.5;
  return (origin + extent / 2) / size;
}

/**
 * One axis of the window-anchored frame. Inside the window box: linear to
 * `±FOCUSED_WINDOW_GAIN` at the edge (lively). Outside: continue smoothly from
 * `±FOCUSED_WINDOW_GAIN` at the window edge to `±1` at the screen edge.
 * Continuous + monotonic across the boundary. `reach` is the center→screen-edge
 * distance on the cursor's side, in the same normalized units as `offset`.
 */
function frameAxis(offset: number, half: number, reach: number): number {
  const a = Math.abs(offset);
  const sign = offset < 0 ? -1 : 1;
  if (half > 1e-4 && a <= half) {
    return clamp((offset / half) * FOCUSED_WINDOW_GAIN, -1, 1);
  }
  const span = Math.max(reach - half, 1e-4);
  const t = Math.min(Math.max(a - half, 0) / span, 1);
  const mag = FOCUSED_WINDOW_GAIN + (1 - FOCUSED_WINDOW_GAIN) * t;
  return sign * clamp(mag, 0, 1);
}

/**
 * The single window-anchored, focus-independent gaze frame. `display`/`bounds`
 * are carried in the payload so the renderer never needs another IPC round-trip.
 */
function windowAnchoredFrame(coords: CompanionCursorCoords): CompanionCursorNdc {
  const width = coords.display?.width || 1;
  const height = coords.display?.height || 1;
  const cx = centerFraction(coords.bounds.x - coords.display.x, coords.bounds.width, width);
  const cy = centerFraction(coords.bounds.y - coords.display.y, coords.bounds.height, height);
  const halfX = coords.bounds.width / 2 / width;
  const halfY = coords.bounds.height / 2 / height;
  const offsetX = coords.x - cx;
  // Screen Y grows downward; flip so up is positive NDC.
  const offsetY = -(coords.y - cy);
  return {
    // Center→edge distances: left/right for X, down/up for the flipped Y.
    x: frameAxis(offsetX, halfX, offsetX < 0 ? Math.max(cx, 1e-4) : Math.max(1 - cx, 1e-4)),
    y: frameAxis(offsetY, halfY, offsetY < 0 ? Math.max(1 - cy, 1e-4) : Math.max(cy, 1e-4)),
  };
}

/**
 * Coords → gaze NDC. A single focus-independent frame (see the module doc), so
 * the same cursor position always maps to the same aim and crossing the window
 * edge is continuous.
 */
export function companionCursorToNdc(coords: CompanionCursorCoords): CompanionCursorNdc {
  return windowAnchoredFrame(coords);
}

/** Raw coords → gaze NDC in one step (already clamped to `[-1, 1]`). */
export function companionCursorToGazeNdc(coords: CompanionCursorCoords): CompanionCursorNdc {
  return companionCursorToNdc(coords);
}
