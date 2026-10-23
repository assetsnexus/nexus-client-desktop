/**
 * Map OS-global companion-cursor samples onto avatar gaze.
 *
 * The main process pushes a cursor sample normalized to the **display work
 * area** (`x/y` in `[0,1]` across the screen — see `CompanionCursorCoords`),
 * plus the companion window bounds, that work area, and two flags: `withinWindow`
 * (cursor is inside the companion box) and `focused` (the companion has OS
 * focus).
 *
 * Two gaze scales, chosen per sample:
 *
 * - **inside** (cursor within the window **and** the window focused): map across
 *   the *window box*, re-centred on the window centre. This is the lively,
 *   sensitive scale — the head follows small in-window moves.
 * - **outside** (cursor left the window, or the window is unfocused): map across
 *   the *whole display*, re-centred on the window centre and scaled per-direction
 *   so the screen edges reach exactly `±1`. Because the gaze controller clamps
 *   NDC to `[-1, 1]`, mapping the edges to `±1` is what lets the head/eyes sweep
 *   their full range as the pointer crosses the screen.
 *
 * Both frames re-centre on the window so a cursor over the avatar reads as
 * "looking at the camera" (neutral). Pure + dependency-free for unit testing.
 */

import type { CompanionCursorCoords } from '../../shared/ipc.js';

export type CompanionCursorNdc = { x: number; y: number };

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

function centerFraction(origin: number, extent: number, size: number): number {
  if (!size) return 0.5;
  return (origin + extent / 2) / size;
}

/**
 * Rescale a signed offset from the window center so the nearer screen edge on
 * that side reaches ±1 (and anything past it clamps). `reach` is the
 * center-to-edge distance in the same normalized units; a zero/degenerate reach
 * collapses to a full turn so tracking still works on odd geometry.
 */
function rescale(offset: number, reach: number): number {
  if (!(reach > 1e-4)) return offset === 0 ? 0 : Math.sign(offset);
  return clamp(offset / reach, -1, 1);
}

/** Window-box frame: cursor position relative to the window, inverted to NDC. */
function windowFrame(coords: CompanionCursorCoords): CompanionCursorNdc {
  const left = coords.bounds.x / (coords.display.width || 1);
  const top = coords.bounds.y / (coords.display.height || 1);
  const w = coords.bounds.width / (coords.display.width || 1);
  const h = coords.bounds.height / (coords.display.height || 1);
  const cx = left + w / 2;
  const cy = top + h / 2;
  return {
    x: rescale(coords.x - cx, w / 2),
    y: rescale(-(coords.y - cy), h / 2),
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
    x: rescale(offsetX, offsetX < 0 ? cx : 1 - cx),
    y: rescale(offsetY, offsetY < 0 ? 1 - cy : cy),
  };
}

/**
 * Coords → gaze NDC. Picks the window-box scale while the cursor is inside a
 * focused companion, otherwise the whole-display scale.
 */
export function companionCursorToNdc(coords: CompanionCursorCoords): CompanionCursorNdc {
  const inside = coords.withinWindow !== false && coords.focused !== false;
  return inside ? windowFrame(coords) : screenFrame(coords);
}

/** Raw coords → gaze NDC in one step (already clamped to `[-1, 1]`). */
export function companionCursorToGazeNdc(coords: CompanionCursorCoords): CompanionCursorNdc {
  return companionCursorToNdc(coords);
}
