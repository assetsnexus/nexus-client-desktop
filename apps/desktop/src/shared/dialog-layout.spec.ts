import { describe, expect, it } from 'vitest';
import { fitDialog } from './dialog-layout.js';

describe('fitDialog', () => {
  const base = { preferredWidth: 420, preferredMaxHeight: 500, edge: 12, minWidth: 300, minHeight: 200 };

  it('uses the preferred size on a large viewport', () => {
    const out = fitDialog({ ...base, viewportWidth: 1200, viewportHeight: 900 });
    expect(out.width).toBe(420);
    expect(out.maxHeight).toBe(500);
    expect(out.needsScroll).toBe(false);
  });

  it('clamps width to the viewport minus the edge margin', () => {
    const out = fitDialog({ ...base, viewportWidth: 360, viewportHeight: 900 });
    expect(out.width).toBe(360 - 24);
    expect(out.needsScroll).toBe(true);
  });

  it('clamps height to the viewport minus the edge margin', () => {
    const out = fitDialog({ ...base, viewportWidth: 1000, viewportHeight: 400 });
    expect(out.maxHeight).toBe(400 - 24);
    expect(out.needsScroll).toBe(true);
  });

  it('never exceeds a tiny viewport on either axis', () => {
    const out = fitDialog({ ...base, viewportWidth: 200, viewportHeight: 150 });
    expect(out.width).toBe(176);
    expect(out.maxHeight).toBe(126);
    expect(out.width).toBeLessThanOrEqual(200);
    expect(out.maxHeight).toBeLessThanOrEqual(150);
  });

  it('never returns a negative size for a degenerate viewport', () => {
    const out = fitDialog({ ...base, viewportWidth: 0, viewportHeight: 0 });
    expect(out.width).toBe(0);
    expect(out.maxHeight).toBe(0);
  });

  it('applies the minimum size when the preferred value is smaller', () => {
    const out = fitDialog({
      viewportWidth: 1200,
      viewportHeight: 900,
      preferredWidth: 100,
      preferredMaxHeight: 80,
      minWidth: 300,
      minHeight: 200,
    });
    expect(out.width).toBe(300);
    expect(out.maxHeight).toBe(200);
  });
});
