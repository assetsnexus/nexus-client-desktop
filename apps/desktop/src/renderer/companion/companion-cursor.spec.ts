import { describe, expect, it } from 'vitest';
import { companionCursorToGazeNdc, companionCursorToNdc } from './companion-cursor.js';
import type { CompanionCursorCoords } from '../../shared/ipc.js';

/**
 * Realistic geometry: companion window near the right edge of a 3000x1400 screen.
 * This is the case that broke window-only normalization — most of the screen sits
 * left of the window, so an out-of-window cursor must map across the whole screen.
 */
const display = { x: 0, y: 0, width: 3000, height: 1400 };
const bounds = { x: 2440, y: 300, width: 560, height: 740 };
const CENTER_X = bounds.x + bounds.width / 2;
const CENTER_Y = bounds.y + bounds.height / 2;

function coords(
  screenX: number,
  screenY: number,
  extra: Partial<CompanionCursorCoords> = {},
): CompanionCursorCoords {
  return {
    contactId: 'c',
    x: screenX / display.width,
    y: screenY / display.height,
    outside: false,
    withinWindow:
      screenX >= bounds.x &&
      screenX <= bounds.x + bounds.width &&
      screenY >= bounds.y &&
      screenY <= bounds.y + bounds.height,
    focused: true,
    screenX,
    screenY,
    bounds,
    display,
    ...extra,
  };
}

describe('companionCursorToNdc — window scale (focused + inside)', () => {
  it('is neutral over the window center', () => {
    const ndc = companionCursorToNdc(coords(CENTER_X, CENTER_Y));
    expect(ndc.x).toBeCloseTo(0, 3);
    expect(ndc.y).toBeCloseTo(0, 3);
  });

  it('reaches ±1 at the window edges (lively, sensitive scale)', () => {
    expect(companionCursorToNdc(coords(bounds.x, CENTER_Y)).x).toBeCloseTo(-1, 2);
    expect(companionCursorToNdc(coords(bounds.x + bounds.width, CENTER_Y)).x).toBeCloseTo(1, 2);
    expect(companionCursorToNdc(coords(CENTER_X, bounds.y)).y).toBeCloseTo(1, 2);
    expect(companionCursorToNdc(coords(CENTER_X, bounds.y + bounds.height)).y).toBeCloseTo(-1, 2);
  });

  it('moves more per pixel inside the window than the screen scale would', () => {
    // A 60px in-window move should swing the head much more than 60px on screen.
    const inWindow = companionCursorToNdc(coords(CENTER_X, CENTER_Y));
    const inWindowShift = companionCursorToNdc(coords(CENTER_X + 60, CENTER_Y));
    expect(inWindowShift.x - inWindow.x).toBeGreaterThan(0.15);
  });
});

describe('companionCursorToNdc — screen scale (outside window or unfocused)', () => {
  it('uses the whole screen when the cursor leaves the window', () => {
    const leftEdge = companionCursorToNdc(coords(0, CENTER_Y, { withinWindow: false }));
    expect(leftEdge.x).toBeCloseTo(-1, 2);
  });

  it('uses the coarser whole-screen scale when the window is unfocused', () => {
    // A central window: its half-width is much smaller than the distance to the
    // screen edges, so the screen scale is clearly gentler per pixel.
    const central = { x: 1200, y: 600, width: 560, height: 740 };
    const cx = central.x + central.width / 2;
    const cy = central.y + central.height / 2;
    const at = (extra: Partial<CompanionCursorCoords>) =>
      coords(cx + 60, cy, { bounds: central, ...extra });
    const focusedMove = companionCursorToNdc(at({ focused: true, withinWindow: true }));
    const unfocusedMove = companionCursorToNdc(at({ focused: false }));
    expect(Math.abs(unfocusedMove.x)).toBeLessThan(Math.abs(focusedMove.x));
  });

  it('maps screen edges to ±1 so the clamped gaze sweeps its full range', () => {
    expect(companionCursorToNdc(coords(0, CENTER_Y, { withinWindow: false })).x).toBeCloseTo(-1, 2);
    expect(
      companionCursorToNdc(coords(display.width, CENTER_Y, { withinWindow: false })).x,
    ).toBeCloseTo(1, 2);
    expect(companionCursorToNdc(coords(CENTER_X, 0, { withinWindow: false })).y).toBeCloseTo(1, 2);
    expect(
      companionCursorToNdc(coords(CENTER_X, display.height, { withinWindow: false })).y,
    ).toBeCloseTo(-1, 2);
  });

  it('is monotonic across the screen', () => {
    const xs = [0, 600, 1200, 1800, 2400, 3000].map(
      (x) => companionCursorToNdc(coords(x, CENTER_Y, { withinWindow: false })).x,
    );
    for (let i = 1; i < xs.length; i += 1) {
      expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
    }
  });

  it('never exceeds the ±1 clamp for far off-screen cursors', () => {
    const ndc = companionCursorToNdc(coords(-5000, -5000, { withinWindow: false }));
    expect(ndc.x).toBeGreaterThanOrEqual(-1);
    expect(ndc.y).toBeLessThanOrEqual(1);
  });
});

describe('companionCursorToGazeNdc', () => {
  it('returns the clamped NDC unchanged (controller applies the cone limits)', () => {
    const c = coords(0, CENTER_Y, { withinWindow: false });
    expect(companionCursorToGazeNdc(c)).toEqual(companionCursorToNdc(c));
  });
});
