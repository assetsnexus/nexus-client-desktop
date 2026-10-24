import { describe, expect, it } from 'vitest';
import {
  buildCompanionMenuItems,
  clampMenuPosition,
  CLOSED_COMPANION_MENU,
  companionMenuReducer,
  groupCompanionMenuItems,
} from './companion-scene-menu.js';

describe('buildCompanionMenuItems', () => {
  it('always exposes Avatars and Reset pose, even with debug off', () => {
    const items = buildCompanionMenuItems();
    const ids = items.map((i) => i.id);
    expect(ids).toContain('avatars');
    expect(ids).toContain('reset-pose');
    // No dev-only rows leak into the default menu.
    expect(items.some((i) => i.dev)).toBe(false);
  });

  it('leads with Reset pose escape hatch reachable and lists avatars first', () => {
    const items = buildCompanionMenuItems();
    expect(items[0]!.id).toBe('avatars');
    expect(items[1]!.id).toBe('reset-pose');
  });

  it('keeps the moved top-bar controls (motion / gestures / status) in the menu when debug is on', () => {
    // Regression guard: moving these out of the top bar must not drop them.
    const items = buildCompanionMenuItems({
      debugEnabled: { motionFeed: true, gestureTest: true, statusMotions: true },
    });
    const ids = items.map((i) => i.id);
    expect(ids).toContain('motion-feed');
    expect(ids).toContain('gestures');
    expect(ids).toContain('status-motions');
    // Avatars + Reset pose are never displaced by the dev rows.
    expect(ids).toContain('avatars');
    expect(ids).toContain('reset-pose');
  });

  it('includes only the debug rows that are enabled', () => {
    const items = buildCompanionMenuItems({ debugEnabled: { gestureTest: true } });
    const ids = items.map((i) => i.id);
    expect(ids).toContain('gestures');
    expect(ids).not.toContain('motion-feed');
    expect(ids).not.toContain('status-motions');
  });

  it('marks an open panel active so a toggle reads correctly', () => {
    const items = buildCompanionMenuItems({
      debugEnabled: { motionFeed: true },
      open: { motionFeedOpen: true, galleryOpen: true },
    });
    expect(items.find((i) => i.id === 'motion-feed')!.active).toBe(true);
    expect(items.find((i) => i.id === 'avatars')!.active).toBe(true);
    expect(items.find((i) => i.id === 'reset-pose')!.active).toBeUndefined();
  });

  it('disables Reset pose when no 3D stage is mounted', () => {
    const items = buildCompanionMenuItems({ poseResetAvailable: false });
    expect(items.find((i) => i.id === 'reset-pose')!.disabled).toBe(true);
    // Avatars stays usable even without a stage.
    expect(items.find((i) => i.id === 'avatars')!.disabled).toBeFalsy();
  });

  it('groups dev rows under a Developer section without reordering the essentials', () => {
    const groups = groupCompanionMenuItems(
      buildCompanionMenuItems({
        debugEnabled: { motionFeed: true, gestureTest: true, statusMotions: true },
      }),
    );
    expect(groups.map((g) => g.section)).toEqual(['Avatar', 'Pose', 'Developer']);
    expect(groups.at(-1)!.items).toHaveLength(3);
  });
});

describe('companionMenuReducer', () => {
  it('opens at the given anchor', () => {
    const next = companionMenuReducer(CLOSED_COMPANION_MENU, { type: 'open', x: 120, y: 44 });
    expect(next).toEqual({ open: true, x: 120, y: 44 });
  });

  it('re-opening at a new anchor moves the menu', () => {
    const first = companionMenuReducer(CLOSED_COMPANION_MENU, { type: 'open', x: 1, y: 1 });
    const second = companionMenuReducer(first, { type: 'open', x: 9, y: 9 });
    expect(second).toEqual({ open: true, x: 9, y: 9 });
  });

  it('close resets to a closed menu', () => {
    const open = companionMenuReducer(CLOSED_COMPANION_MENU, { type: 'open', x: 5, y: 5 });
    expect(companionMenuReducer(open, { type: 'close' })).toEqual(CLOSED_COMPANION_MENU);
  });

  it('close is a no-op (stable identity) when already closed', () => {
    expect(companionMenuReducer(CLOSED_COMPANION_MENU, { type: 'close' })).toBe(
      CLOSED_COMPANION_MENU,
    );
  });
});

describe('clampMenuPosition', () => {
  const menu = { width: 200, height: 160 };
  const viewport = { width: 560, height: 740 };

  it('leaves a comfortable anchor untouched', () => {
    expect(clampMenuPosition(40, 40, menu, viewport)).toEqual({ x: 40, y: 40 });
  });

  it('pulls the menu in from the bottom-right edge', () => {
    const { x, y } = clampMenuPosition(550, 730, menu, viewport);
    expect(x).toBe(viewport.width - menu.width - 8);
    expect(y).toBe(viewport.height - menu.height - 8);
  });

  it('keeps a top/left margin when the click is past the top-left corner', () => {
    expect(clampMenuPosition(-50, -20, menu, viewport)).toEqual({ x: 8, y: 8 });
  });

  it('falls back to the margin when the menu is larger than the viewport', () => {
    const huge = { width: 900, height: 900 };
    expect(clampMenuPosition(10, 10, huge, viewport)).toEqual({ x: 8, y: 8 });
  });
});
