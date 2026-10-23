/**
 * Map OS-global companion-cursor samples onto avatar gaze.
 *
 * The main process pushes window-relative normalized coordinates
 * (`x/y` in `[0,1]` inside the window, out of range off-window — see
 * `CompanionCursorCoords`). The VRM gaze cone wants NDC (`-1` left/bottom →
 * `+1` right/top), so this converts and lets off-window values clamp at the
 * cone edge: that is exactly what makes the head/eyes keep following the cursor
 * once it leaves the small companion window and moves across the whole display.
 *
 * Pure + dependency-free so it is unit-testable without Three.js or Electron.
 */

import type { CompanionCursorCoords } from '../../shared/ipc.js';

export type CompanionCursorNdc = { x: number; y: number };

/**
 * Coords → gaze NDC.
 *
 * `x`: `0` (window left) → `-1`, `1` (window right) → `+1`.
 * `y`: screen Y grows downward, NDC grows upward, so `0` (top) → `+1`,
 * `1` (bottom) → `-1`.
 *
 * Off-window samples are allowed to exceed ±1 (the gaze controller clamps at the
 * cone edge); this preserves the direction of a far-away cursor instead of
 * saturating every off-window position to the same edge value.
 */
export function companionCursorToNdc(coords: CompanionCursorCoords): CompanionCursorNdc {
  return {
    x: coords.x * 2 - 1,
    y: 1 - coords.y * 2,
  };
}

/**
 * Compress a gaze NDC so an off-window cursor still reads as a plausible aim.
 *
 * The raw mapping can produce large magnitudes (e.g. a cursor half a screen to
 * the right yields `x ≈ 3`); pushing that straight into the head cone makes the
 * avatar crane unnaturally. Tanh-style soft saturation keeps in-window motion
 * nearly linear while asymptotically bounding off-window excursions.
 */
export function softenOffWindowNdc(ndc: CompanionCursorNdc): CompanionCursorNdc {
  return {
    x: Math.tanh(ndc.x * 0.7) * 1.35,
    y: Math.tanh(ndc.y * 0.7) * 1.35,
  };
}
