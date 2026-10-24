/**
 * Right-click scene menu model for the immersive companion window.
 *
 * The companion's top bar used to carry "Avatars", "Motion" and "Gestures"
 * (plus "Status") buttons, which crowded out the agent's name. Those controls
 * now live in a context menu opened by right-clicking the 3D scene surface, so
 * this module owns the menu's **structure** and **open/close geometry** as pure,
 * dependency-free functions — the reducer and item list are unit-testable
 * without React, jsdom, or Three.js.
 *
 * Nothing here touches the DOM: the component reads the viewport size and hands
 * it in, so a headless test can assert clamping without a real window.
 */

/** One actionable entry in the scene menu. */
export type CompanionMenuAction =
  /** Open the avatar gallery (3D model / profile image picker). */
  | 'avatars'
  /** Hard-reset the avatar to its idle rest pose ("Reset pose" / "Unstick"). */
  | 'reset-pose'
  /** Toggle the live motion feed (dev). */
  | 'motion-feed'
  /** Open the gesture tester (dev). */
  | 'gestures'
  /** Open the status-motions editor (dev). */
  | 'status-motions';

/** A rendered menu row. `section` groups rows under a heading. */
export type CompanionMenuItem = {
  id: CompanionMenuAction;
  label: string;
  hint?: string;
  section: string;
  /** Dev-only row; only present when the corresponding debug surface is on. */
  dev?: boolean;
  /** Toggle state: the panel this row opens is currently open. */
  active?: boolean;
  /** Row is present but cannot act (e.g. no 3D stage bound yet). */
  disabled?: boolean;
};

/** Which debug surfaces the user has enabled (mirrors `CompanionDebugSettings`). */
export type CompanionMenuDebugSettings = {
  motionFeed?: boolean;
  gestureTest?: boolean;
  statusMotions?: boolean;
};

/** Which of the menu's toggleable panels are currently open. */
export type CompanionMenuOpenState = {
  galleryOpen?: boolean;
  motionFeedOpen?: boolean;
  gestureTestOpen?: boolean;
  statusMotionsOpen?: boolean;
};

export type BuildCompanionMenuOptions = {
  debugEnabled?: CompanionMenuDebugSettings | null;
  open?: CompanionMenuOpenState;
  /** False when no 3D stage is mounted, so "Reset pose" cannot act. */
  poseResetAvailable?: boolean;
};

/**
 * Build the ordered row list. "Reset pose" always leads (it is the escape hatch
 * the user reaches for when the avatar is broken); the debug rows follow and are
 * omitted entirely unless the user enabled that surface, so the menu stays as
 * short as the top bar was crowded.
 */
export function buildCompanionMenuItems(
  opts: BuildCompanionMenuOptions = {},
): CompanionMenuItem[] {
  const debug = opts.debugEnabled ?? {};
  const open = opts.open ?? {};
  const items: CompanionMenuItem[] = [
    {
      id: 'avatars',
      label: 'Avatars…',
      hint: 'Choose a 3D model or profile image',
      section: 'Avatar',
      active: open.galleryOpen,
    },
    {
      id: 'reset-pose',
      label: 'Reset pose',
      hint: 'Unstick the avatar and return to idle',
      section: 'Pose',
      disabled: opts.poseResetAvailable === false,
    },
  ];

  if (debug.motionFeed) {
    items.push({
      id: 'motion-feed',
      label: 'Motion feed',
      hint: 'Live action feed',
      section: 'Developer',
      dev: true,
      active: open.motionFeedOpen,
    });
  }
  if (debug.gestureTest) {
    items.push({
      id: 'gestures',
      label: 'Gestures',
      hint: 'Play any loaded clip',
      section: 'Developer',
      dev: true,
      active: open.gestureTestOpen,
    });
  }
  if (debug.statusMotions) {
    items.push({
      id: 'status-motions',
      label: 'Status motions',
      hint: 'Clips cycled while the agent works',
      section: 'Developer',
      dev: true,
      active: open.statusMotionsOpen,
    });
  }
  return items;
}

/** Group ordered rows into sections, preserving first-seen order. */
export function groupCompanionMenuItems(
  items: readonly CompanionMenuItem[],
): Array<{ section: string; items: CompanionMenuItem[] }> {
  const groups: Array<{ section: string; items: CompanionMenuItem[] }> = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.section === item.section) last.items.push(item);
    else groups.push({ section: item.section, items: [item] });
  }
  return groups;
}

/** Open/close + anchor position for the menu. */
export type CompanionMenuState = {
  open: boolean;
  x: number;
  y: number;
};

export const CLOSED_COMPANION_MENU: CompanionMenuState = { open: false, x: 0, y: 0 };

export type CompanionMenuEvent =
  | { type: 'open'; x: number; y: number }
  | { type: 'close' };

/** Pure reducer: only `open`/`close`. Position is clamped by the component. */
export function companionMenuReducer(
  state: CompanionMenuState,
  event: CompanionMenuEvent,
): CompanionMenuState {
  switch (event.type) {
    case 'open':
      return { open: true, x: event.x, y: event.y };
    case 'close':
      return state.open ? CLOSED_COMPANION_MENU : state;
    default:
      return state;
  }
}

export type Size = { width: number; height: number };

/**
 * Keep the menu inside the viewport: shift it left/up when a click near the
 * bottom-right would push it off-screen. When the menu is larger than the
 * viewport the top/left margin wins (the menu scrolls instead).
 */
export function clampMenuPosition(
  x: number,
  y: number,
  menu: Size,
  viewport: Size,
  margin = 8,
): { x: number; y: number } {
  const maxX = viewport.width - menu.width - margin;
  const maxY = viewport.height - menu.height - margin;
  return {
    x: Math.max(margin, Math.min(x, Math.max(margin, maxX))),
    y: Math.max(margin, Math.min(y, Math.max(margin, maxY))),
  };
}
