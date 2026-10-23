/**
 * Map OS-global companion-cursor samples onto avatar gaze.
 *
 * The main process pushes a cursor sample normalized to the **display work
 * area** (`x/y` in `[0,1]` across the screen — see `CompanionCursorCoords`),
 * plus the companion window bounds and that work area.
 *
 * Why display-normalized rather than window-normalized: the companion is a small
 * box on a large screen. If we normalized to the window, the cursor would be far
 * outside `[0,1]` for almost the entire screen and the gaze would pin at the cone
 * edge the instant the pointer left the window.
 *
 * The emitted NDC is re-centered on the **window** (a cursor over the avatar
 * reads as "looking at the camera" = neutral) and scaled per-direction so the
 * **screen edges map to exactly ±1**. Because the gaze controller clamps NDC to
 * `[-1, 1]`, mapping the edges to ±1 is what makes the head/eyes sweep their full
 * range as the pointer crosses the display — with no premature saturation.
 *
 * Pure + dependency-free so it is unit-testable without Three.js or Electron.
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

/**
 * Coords → gaze NDC.
 *
 * `x`: cursor over the window center → `0`; the left screen edge → `-1`; the
 * right screen edge → `+1`.
 * `y`: screen Y grows downward while NDC grows upward, so `0` is the window
 * center, the top screen edge → `+1`, the bottom screen edge → `-1`.
 */
export function companionCursorToNdc(coords: CompanionCursorCoords): CompanionCursorNdc {
  const display = coords.display ?? coords.bounds;
  const width = display.width || 1;
  const height = display.height || 1;
  // Window center in display-normalized units (0..1 across the screen).
  const cx = centerFraction(coords.bounds.x - display.x, coords.bounds.width, width);
  const cy = centerFraction(coords.bounds.y - display.y, coords.bounds.height, height);
  const offsetX = coords.x - cx;
  // Screen Y grows downward; flip so up is positive NDC.
  const offsetY = -(coords.y - cy);
  return {
    x: rescale(offsetX, offsetX < 0 ? cx : 1 - cx),
    y: rescale(offsetY, offsetY < 0 ? 1 - cy : cy),
  };
}

/** Raw coords → gaze NDC in one step (already clamped to `[-1, 1]`). */
export function companionCursorToGazeNdc(coords: CompanionCursorCoords): CompanionCursorNdc {
  return companionCursorToNdc(coords);
}
