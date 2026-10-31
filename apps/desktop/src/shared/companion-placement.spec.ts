import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPANION_PLACEMENT_SETTINGS,
  avoidOverlap,
  clampToWorkArea,
  computeCompanionBounds,
  normalizeCompanionPlacementSettings,
  rectsOverlap,
  type PlacementRect,
} from './companion-placement.js';

const WORK: PlacementRect = { x: 0, y: 0, width: 1920, height: 1040 };
const SIZE = { width: 320, height: 420 };
const GAP = 16;

const place = (over: Partial<Parameters<typeof computeCompanionBounds>[0]> = {}) =>
  computeCompanionBounds({
    mode: 'bottom-right',
    size: SIZE,
    workArea: WORK,
    mainBounds: null,
    occupied: [],
    gapPx: GAP,
    remembered: null,
    ...over,
  });

describe('normalizeCompanionPlacementSettings', () => {
  it('returns defaults for a malformed block', () => {
    expect(normalizeCompanionPlacementSettings(null)).toEqual(DEFAULT_COMPANION_PLACEMENT_SETTINGS);
    expect(normalizeCompanionPlacementSettings({ mode: 'nowhere', gapPx: 'big' })).toEqual(
      DEFAULT_COMPANION_PLACEMENT_SETTINGS,
    );
  });

  it('keeps valid values and clamps the gap', () => {
    expect(normalizeCompanionPlacementSettings({ mode: 'center', gapPx: 9999 })).toEqual({
      mode: 'center',
      gapPx: 200,
      rememberPerAgent: false,
      bringMainToFront: false,
    });
    expect(normalizeCompanionPlacementSettings({ gapPx: -5 }).gapPx).toBe(0);
  });

  it('defaults to bottom-right without stealing focus', () => {
    expect(DEFAULT_COMPANION_PLACEMENT_SETTINGS.mode).toBe('bottom-right');
    expect(DEFAULT_COMPANION_PLACEMENT_SETTINGS.bringMainToFront).toBe(false);
  });
});

describe('clampToWorkArea', () => {
  it('pulls an off-screen point back inside', () => {
    expect(clampToWorkArea(SIZE, WORK, { x: 5000, y: 5000 })).toEqual({
      x: WORK.width - SIZE.width,
      y: WORK.height - SIZE.height,
    });
    expect(clampToWorkArea(SIZE, WORK, { x: -500, y: -500 })).toEqual({ x: 0, y: 0 });
  });

  it('honours a work area with a non-zero origin (secondary display left of primary)', () => {
    const leftDisplay: PlacementRect = { x: -1920, y: 0, width: 1920, height: 1040 };
    const point = clampToWorkArea(SIZE, leftDisplay, { x: 100, y: 100 });
    expect(point).toEqual({ x: -1920 + 1920 - SIZE.width, y: 100 });
  });
});

describe('rectsOverlap', () => {
  it('detects overlap and ignores touching edges', () => {
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 9, width: 10, height: 10 })).toBe(true);
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
  });
});

describe('computeCompanionBounds', () => {
  it('spawns bottom-right minus the gap on the primary work area', () => {
    expect(place()).toEqual({ x: WORK.width - SIZE.width - GAP, y: WORK.height - SIZE.height - GAP });
  });

  it('spawns the other corners and centre', () => {
    expect(place({ mode: 'bottom-left' })).toEqual({ x: GAP, y: WORK.height - SIZE.height - GAP });
    expect(place({ mode: 'top-right' })).toEqual({ x: WORK.width - SIZE.width - GAP, y: GAP });
    expect(place({ mode: 'top-left' })).toEqual({ x: GAP, y: GAP });
    expect(place({ mode: 'center' })).toEqual({
      x: Math.round((WORK.width - SIZE.width) / 2),
      y: Math.round((WORK.height - SIZE.height) / 2),
    });
  });

  it('shifts left of an already-open companion', () => {
    const first = place();
    const second = place({ occupied: [{ ...first, width: SIZE.width, height: SIZE.height }] });
    expect(second.y).toBe(first.y);
    expect(second.x).toBe(first.x - (SIZE.width + GAP));
  });

  it('keeps shifting left across several open companions', () => {
    const first = place();
    const step = SIZE.width + GAP;
    const occupied: PlacementRect[] = [0, 1].map((i) => ({
      x: first.x - i * step,
      y: first.y,
      width: SIZE.width,
      height: SIZE.height,
    }));
    expect(place({ occupied }).x).toBe(first.x - 2 * step);
  });

  it('wraps to the next row when a row is full', () => {
    const cols = Math.floor(WORK.width / (SIZE.width + GAP)) + 1;
    const first = place();
    const occupied: PlacementRect[] = [];
    for (let i = 0; i < cols; i += 1) {
      occupied.push({
        x: first.x - i * (SIZE.width + GAP),
        y: first.y,
        width: SIZE.width,
        height: SIZE.height,
      });
    }
    const wrapped = place({ occupied });
    expect(wrapped.y).toBe(first.y - (SIZE.height + GAP));
  });

  it('places right of the main window, flipping left when it would overflow', () => {
    const main: PlacementRect = { x: 100, y: 200, width: 800, height: 600 };
    expect(place({ mode: 'right-of-main', mainBounds: main })).toEqual({
      x: main.x + main.width + GAP,
      y: main.y,
    });
    // A main window whose right edge leaves no room: the companion flips to its
    // left instead of hanging off the display.
    const wideMain: PlacementRect = { x: 600, y: 0, width: 1000, height: 600 };
    expect(place({ mode: 'right-of-main', mainBounds: wideMain }).x).toBe(
      wideMain.x - SIZE.width - GAP,
    );
  });

  it('reuses a remembered point that is still on a connected display', () => {
    const remembered = { x: 300, y: 300 };
    expect(place({ mode: 'remember-last', remembered, allWorkAreas: [WORK] })).toEqual(remembered);
  });

  it('falls back to the default when the remembered monitor was disconnected', () => {
    const result = place({
      mode: 'remember-last',
      remembered: { x: 2500, y: 400 },
      allWorkAreas: [WORK],
      workArea: WORK,
    });
    // Not the remembered point (its display is gone) and still on-screen.
    expect(result).not.toEqual({ x: 2500, y: 400 });
    expect(rectsOverlap({ ...result, ...SIZE }, WORK)).toBe(true);
  });

  it('never returns a point outside the work area even when it is packed', () => {
    const occupied: PlacementRect[] = Array.from({ length: 60 }, (_, i) => ({
      x: WORK.x + (i % 6) * (SIZE.width + GAP),
      y: WORK.y + Math.floor(i / 6) * (SIZE.height + GAP),
      width: SIZE.width,
      height: SIZE.height,
    }));
    const result = place({ occupied });
    expect(result.x).toBeGreaterThanOrEqual(WORK.x);
    expect(result.y).toBeGreaterThanOrEqual(WORK.y);
    expect(result.x + SIZE.width).toBeLessThanOrEqual(WORK.x + WORK.width);
    expect(result.y + SIZE.height).toBeLessThanOrEqual(WORK.y + WORK.height);
  });
});

describe('avoidOverlap', () => {
  it('returns the same point when nothing is occupied', () => {
    expect(avoidOverlap({ x: 10, y: 10 }, SIZE, WORK, [], GAP)).toEqual({ x: 10, y: 10 });
  });
});
