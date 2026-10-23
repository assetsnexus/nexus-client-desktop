import { describe, expect, it } from 'vitest';
import { companionCursorToGazeNdc, companionCursorToNdc } from './companion-cursor.js';
import type { CompanionCursorCoords } from '../../shared/ipc.js';

/**
 * Realistic geometry: companion window at the right edge of a 3000x1400 screen.
 * This is exactly the case that broke window-relative normalization — most of
 * the screen is "left of the window", so the gaze used to pin at the cone edge.
 */
const display = { x: 0, y: 0, width: 3000, height: 1400 };
const bounds = { x: 2440, y: 300, width: 560, height: 740 };
const CENTER_X = bounds.x + bounds.width / 2;
const CENTER_Y = bounds.y + bounds.height / 2;

function coords(screenX: number, screenY: number): CompanionCursorCoords {
  return {
    contactId: 'c',
    x: screenX / display.width,
    y: screenY / display.height,
    outside: screenX < display.x || screenX > display.x + display.width || screenY < 0 || screenY > display.height,
    screenX,
    screenY,
    bounds,
    display,
  };
}

describe('companionCursorToNdc', () => {
  it('is neutral when the cursor is over the companion window center', () => {
    const ndc = companionCursorToNdc(coords(CENTER_X, CENTER_Y));
    expect(ndc.x).toBeCloseTo(0, 5);
    expect(ndc.y).toBeCloseTo(0, 5);
  });

  it('maps the screen edges to ±1 so the gaze sweeps its full clamped range', () => {
    // The gaze controller clamps NDC to [-1, 1]; edges must reach the cone edge.
    expect(companionCursorToNdc(coords(0, CENTER_Y)).x).toBeCloseTo(-1, 2);
    expect(companionCursorToNdc(coords(display.width, CENTER_Y)).x).toBeCloseTo(1, 2);
    expect(companionCursorToNdc(coords(CENTER_X, 0)).y).toBeCloseTo(1, 2);
    expect(companionCursorToNdc(coords(CENTER_X, display.height)).y).toBeCloseTo(-1, 2);
  });

  it('is strictly monotonic across the screen (no early saturation)', () => {
    const xs = [0, 600, 1200, 1800, 2400, 3000].map((x) => companionCursorToNdc(coords(x, CENTER_Y)).x);
    for (let i = 1; i < xs.length; i += 1) {
      expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
    }
  });

  it('keeps meaningful spread once the cursor leaves the window', () => {
    // Cursor just left the window vs at the far screen edge: clearly different.
    const justLeft = companionCursorToNdc(coords(bounds.x - 60, CENTER_Y)).x;
    const farLeft = companionCursorToNdc(coords(0, CENTER_Y)).x;
    expect(justLeft).toBeLessThan(0);
    expect(farLeft).toBeLessThan(justLeft);
    expect(justLeft - farLeft).toBeGreaterThan(0.2);
  });

  it('flips Y so a cursor above the window looks up (positive NDC)', () => {
    expect(companionCursorToNdc(coords(CENTER_X, 0)).y).toBeGreaterThan(0);
    expect(companionCursorToNdc(coords(CENTER_X, display.height)).y).toBeLessThan(0);
  });

  it('never exceeds the ±1 clamp even for far off-screen cursors', () => {
    const ndc = companionCursorToNdc(coords(-5000, -5000));
    expect(ndc.x).toBeGreaterThanOrEqual(-1);
    expect(ndc.y).toBeLessThanOrEqual(1);
  });

  it('falls back to the window box when display is missing', () => {
    const winCenterX = (bounds.width / 2) / bounds.width;
    const winCenterY = (bounds.height / 2) / bounds.height;
    const ndc = companionCursorToNdc({
      ...coords(CENTER_X, CENTER_Y),
      display: undefined as never,
      x: winCenterX,
      y: winCenterY,
    });
    expect(ndc.x).toBeCloseTo(0, 5);
    expect(ndc.y).toBeCloseTo(0, 5);
  });
});

describe('companionCursorToGazeNdc', () => {
  it('returns the clamped NDC unchanged (controller applies the cone limits)', () => {
    const c = coords(0, CENTER_Y);
    expect(companionCursorToGazeNdc(c)).toEqual(companionCursorToNdc(c));
  });
});
