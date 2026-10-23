import { describe, expect, it } from 'vitest';
import { companionCursorToNdc, softenOffWindowNdc } from './companion-cursor.js';
import type { CompanionCursorCoords } from '../../shared/ipc.js';

function coords(x: number, y: number): CompanionCursorCoords {
  return {
    contactId: 'c',
    x,
    y,
    outside: x < 0 || x > 1 || y < 0 || y > 1,
    screenX: 0,
    screenY: 0,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
  };
}

describe('companionCursorToNdc', () => {
  it('maps the window center to the NDC origin', () => {
    expect(companionCursorToNdc(coords(0.5, 0.5))).toEqual({ x: 0, y: 0 });
  });

  it('maps left/right edges to -1/+1 and flips Y for NDC', () => {
    expect(companionCursorToNdc(coords(0, 0))).toEqual({ x: -1, y: 1 });
    expect(companionCursorToNdc(coords(1, 1))).toEqual({ x: 1, y: -1 });
  });

  it('keeps the direction of an off-window cursor (does not saturate early)', () => {
    const farRight = companionCursorToNdc(coords(2, 0.5));
    expect(farRight.x).toBeGreaterThan(1);
  });
});

describe('softenOffWindowNdc', () => {
  it('is nearly identity near the center', () => {
    const r = softenOffWindowNdc({ x: 0.1, y: 0.1 });
    expect(r.x).toBeCloseTo(0.1 * 0.7 * 1.35, 1);
  });

  it('is monotonic and bounded for far-off-window input', () => {
    const near = softenOffWindowNdc({ x: 1, y: 0 });
    const far = softenOffWindowNdc({ x: 10, y: 0 });
    expect(far.x).toBeGreaterThan(near.x);
    // tanh asymptote * gain: strictly bounded, never exploding to 10.
    expect(far.x).toBeLessThan(1.35);
  });

  it('preserves sign', () => {
    expect(softenOffWindowNdc({ x: -5, y: 0 }).x).toBeLessThan(0);
    expect(softenOffWindowNdc({ x: 0, y: -5 }).y).toBeLessThan(0);
  });
});
