/**
 * Map OS-global companion-cursor samples onto avatar gaze.
 *
 * The main process pushes a cursor sample normalized to the **display work
 * area** (`x/y` in `[0,1]` across the screen — see `CompanionCursorCoords`),
 * plus the companion window bounds, that work area, and two flags: `withinWindow`
 * (cursor is inside the companion box) and `focused` (the companion has OS
 * focus).
 *
 * Two gaze scales, chosen per sample by focus:
 *
 * - **focused** (the companion has OS focus): a *window-anchored* frame. The
 *   cursor maps across the window box, so small in-window moves are lively, and
 *   it keeps growing smoothly past the window edge until the far screen edge
 *   reaches `±1`. The head therefore keeps turning as the cursor roams the rest
 *   of the display instead of snapping/pinning at the window boundary.
 * - **unfocused**: a *whole-display* frame, re-centred on the window, scaled per
 *   direction so the screen edges reach exactly `±1`. Gentler, for when the
 *   companion is not the active surface.
 *
 * The key invariant: each frame is **continuous** across the window boundary.
 * The previous two-frame switch (window box while inside, screen box the moment
 * the cursor crossed the edge) jumped from `±1` to `±0.15`, which snapped the
 * head. Here the window edge maps to {@link FOCUSED_WINDOW_GAIN} of full range
 * and the outside portion continues from there to `±1` at the screen edge.
 *
 * Pure + dependency-free for unit testing.
 */

import type { CompanionCursorCoords } from '../../shared/ipc.js';

export type CompanionCursorNdc = { x: number; y: number };

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/**
 * Fraction of the gaze cone reached at the window edge while focused. Leaves
 * head-room (`1 - FOCUSED_WINDOW_GAIN`) so the head keeps turning smoothly as
 * the cursor crosses the rest of the display rather than pinning at the window
 * boundary. 0.5 keeps the in-window motion lively while giving the whole-screen
 * roam real travel.
 */
const FOCUSED_WINDOW_GAIN = 0.5;

function centerFraction(origin: number, extent: number, size: number): number {
  if (!size) return 0.5;
  return (origin + extent / 2) / size;
}

/**
 * One axis of the focused frame. Inside the window box: linear to
 * `±FOCUSED_WINDOW_GAIN` at the edge (lively). Outside: continue smoothly from
 * `±FOCUSED_WINDOW_GAIN` at the window edge to `±1` at the screen edge.
 * Continuous + monotonic across the boundary. `reach` is the center→screen-edge
 * distance on the cursor's side, in the same normalized units as `offset`.
 */
function focusedAxis(offset: number, half: number, reach: number): number {
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

/** Window-anchored, continuous frame used while the companion is focused. */
function focusedFrame(coords: CompanionCursorCoords): CompanionCursorNdc {
  const width = coords.display.width || 1;
  const height = coords.display.height || 1;
  const cx = centerFraction(coords.bounds.x - coords.display.x, coords.bounds.width, width);
  const cy = centerFraction(coords.bounds.y - coords.display.y, coords.bounds.height, height);
  const halfX = coords.bounds.width / 2 / width;
  const halfY = coords.bounds.height / 2 / height;
  const offsetX = coords.x - cx;
  // Screen Y grows downward; flip so up is positive NDC.
  const offsetY = -(coords.y - cy);
  return {
    // Center→edge distances: left/right for X, down/up for the flipped Y.
    x: focusedAxis(offsetX, halfX, offsetX < 0 ? Math.max(cx, 1e-4) : Math.max(1 - cx, 1e-4)),
    y: focusedAxis(offsetY, halfY, offsetY < 0 ? Math.max(1 - cy, 1e-4) : Math.max(cy, 1e-4)),
  };
}

/** Whole-display frame: cursor across the screen, scaled so the edges reach ±1. */
function screenFrame(coords: CompanionCursorCoords): CompanionCursorNdc {
  const width = coords.display.width || 1;
  const height = coords.display.height || 1;
  const cx = centerFraction(coords.bounds.x - coords.display.x, coords.bounds.width, width);
  const cy = centerFraction(coords.bounds.y - coords.display.y, coords.bounds.height, height);
  const offsetX = coords.x - cx;
  // Screen Y grows downward; flip so up is positive NDC.
  const offsetY = -(coords.y - cy);
  return {
    x: clamp(offsetX / (offsetX < 0 ? Math.max(cx, 1e-4) : Math.max(1 - cx, 1e-4)), -1, 1),
    y: clamp(offsetY / (offsetY < 0 ? Math.max(1 - cy, 1e-4) : Math.max(cy, 1e-4)), -1, 1),
  };
}

/**
 * Coords → gaze NDC. Uses the continuous window-anchored frame while the
 * companion is focused, otherwise the whole-display frame.
 */
export function companionCursorToNdc(coords: CompanionCursorCoords): CompanionCursorNdc {
  return coords.focused === false ? screenFrame(coords) : focusedFrame(coords);
}

/** Raw coords → gaze NDC in one step (already clamped to `[-1, 1]`). */
export function companionCursorToGazeNdc(coords: CompanionCursorCoords): CompanionCursorNdc {
  return companionCursorToNdc(coords);
}
