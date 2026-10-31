/**
 * Companion-window spawn placement (shared/main + renderer).
 *
 * A companion window used to be created with no `x`/`y`, so Electron centred it
 * — which on a multi-monitor desk can land it across a bezel, and opening two
 * agents stacked them exactly on top of each other. This module holds the
 * user's placement preference and the **pure** geometry that turns a preference
 * into a concrete `{x, y}`.
 *
 * Everything here is Electron-free so the placement rules are unit-tested
 * directly: the main process injects the real display work areas and occupied
 * window rects, and this file decides where the window goes.
 */

/** Where a newly opened companion window should appear. */
export type CompanionPlacementMode =
  | 'bottom-right'
  | 'bottom-left'
  | 'top-right'
  | 'top-left'
  | 'center'
  /** Just right of the main window; flips to its left when that would be off-screen. */
  | 'right-of-main'
  /** Reopen at the position this agent was last dragged to (clamped on-screen). */
  | 'remember-last';

export const COMPANION_PLACEMENT_MODES: readonly CompanionPlacementMode[] = [
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
  'center',
  'right-of-main',
  'remember-last',
];

export type CompanionPlacementSettings = {
  /** Preferred spawn corner/edge. */
  mode: CompanionPlacementMode;
  /** Margin from the work-area edges, in pixels. */
  gapPx: number;
  /**
   * When true, the agent's last dragged position is remembered and reused the
   * next time its companion opens (only meaningful with `remember-last`, but
   * persisted independently so the toggle survives a mode change).
   */
  rememberPerAgent: boolean;
  /**
   * When true, a companion that opens on its own (wake word / pushed message)
   * also brings the main window forward. Off by default so an agent opening in
   * the background never steals focus from what the user is doing.
   */
  bringMainToFront: boolean;
};

export const DEFAULT_COMPANION_PLACEMENT_SETTINGS: CompanionPlacementSettings = {
  // Bottom-right is the conventional "small side companion" spot and, being the
  // far corner, is the least likely to cover the main window.
  mode: 'bottom-right',
  gapPx: 16,
  rememberPerAgent: false,
  bringMainToFront: false,
};

export const COMPANION_GAP_MIN_PX = 0;
export const COMPANION_GAP_MAX_PX = 200;

/** A rectangle in display space (top-left origin, matching Electron's `screen`). */
export type PlacementRect = { x: number; y: number; width: number; height: number };

/** A top-left spawn point. */
export type PlacementPoint = { x: number; y: number };

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function isMode(value: unknown): value is CompanionPlacementMode {
  return typeof value === 'string' && (COMPANION_PLACEMENT_MODES as readonly string[]).includes(value);
}

/**
 * Coerce a persisted/patched placement block field-by-field, so a hand-edited
 * settings file (or an older build's value) can never produce an invalid mode or
 * an absurd gap.
 */
export function normalizeCompanionPlacementSettings(raw: unknown): CompanionPlacementSettings {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const bool = (key: keyof CompanionPlacementSettings): boolean =>
    typeof value[key] === 'boolean'
      ? (value[key] as boolean)
      : (DEFAULT_COMPANION_PLACEMENT_SETTINGS[key] as boolean);
  return {
    mode: isMode(value.mode) ? value.mode : DEFAULT_COMPANION_PLACEMENT_SETTINGS.mode,
    gapPx: clampNumber(
      value.gapPx,
      DEFAULT_COMPANION_PLACEMENT_SETTINGS.gapPx,
      COMPANION_GAP_MIN_PX,
      COMPANION_GAP_MAX_PX,
    ),
    rememberPerAgent: bool('rememberPerAgent'),
    bringMainToFront: bool('bringMainToFront'),
  };
}

/** True when two rects overlap (touching edges do not count as overlap). */
export function rectsOverlap(a: PlacementRect, b: PlacementRect): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Clamp a spawn point so the whole window stays inside `workArea`.
 *
 * A window larger than the work area is pinned to the work-area origin (its far
 * edges overflow, but its top-left stays visible, which is the recoverable
 * choice — the user can still grab the title bar).
 */
export function clampToWorkArea(size: { width: number; height: number }, workArea: PlacementRect, point: PlacementPoint): PlacementPoint {
  const maxX = workArea.x + workArea.width - size.width;
  const maxY = workArea.y + workArea.height - size.height;
  return {
    x: Math.min(Math.max(point.x, workArea.x), Math.max(workArea.x, maxX)),
    y: Math.min(Math.max(point.y, workArea.y), Math.max(workArea.y, maxY)),
  };
}

/** The corner spawn point for a mode, before overlap/off-screen correction. */
function anchorForMode(
  mode: Exclude<CompanionPlacementMode, 'remember-last'>,
  size: { width: number; height: number },
  workArea: PlacementRect,
  mainBounds: PlacementRect | null,
  gap: number,
): PlacementPoint {
  const right = workArea.x + workArea.width - size.width - gap;
  const bottom = workArea.y + workArea.height - size.height - gap;
  const left = workArea.x + gap;
  const top = workArea.y + gap;
  const centerX = workArea.x + Math.round((workArea.width - size.width) / 2);
  const centerY = workArea.y + Math.round((workArea.height - size.height) / 2);

  switch (mode) {
    case 'bottom-left':
      return { x: left, y: bottom };
    case 'top-right':
      return { x: right, y: top };
    case 'top-left':
      return { x: left, y: top };
    case 'center':
      return { x: centerX, y: centerY };
    case 'right-of-main': {
      // Right of the main window; flip to its left when the right edge would
      // leave the work area (a full-width main window on a single monitor).
      if (!mainBounds) return { x: right, y: bottom };
      const y = clampToWorkArea(size, workArea, { x: 0, y: mainBounds.y }).y;
      const rightOfMain: PlacementPoint = { x: mainBounds.x + mainBounds.width + gap, y };
      if (rightOfMain.x + size.width <= workArea.x + workArea.width) return rightOfMain;
      return { x: mainBounds.x - size.width - gap, y };
    }
    case 'bottom-right':
    default:
      return { x: right, y: bottom };
  }
}

export type ComputeCompanionBoundsInput = {
  mode: CompanionPlacementMode;
  size: { width: number; height: number };
  /** Work area of the display the companion should appear on. */
  workArea: PlacementRect;
  /** Main window bounds, for `right-of-main`. */
  mainBounds: PlacementRect | null;
  /** Rects already occupied by open companion/tool windows on this display. */
  occupied: readonly PlacementRect[];
  gapPx: number;
  /** Remembered position for `remember-last`. */
  remembered: PlacementPoint | null;
  /**
   * Work areas of **every** display, used to validate a remembered point when
   * the monitor it was on has since been disconnected. Empty = skip validation.
   */
  allWorkAreas?: readonly PlacementRect[];
};

/**
 * Decide where a new companion goes.
 *
 * Order of operations:
 *  1. pick the anchor point for the mode (a remembered point when
 *     `remember-last` and it is still on a connected display);
 *  2. if that overlaps an existing window, walk left in `width + gap` steps,
 *     then wrap to the next row up, until a free spot is found;
 *  3. clamp the result into the work area so it is never off-screen.
 */
export function computeCompanionBounds(input: ComputeCompanionBoundsInput): PlacementPoint {
  const { size, workArea, occupied, gapPx } = input;
  const gap = Math.max(0, gapPx);

  let anchor: PlacementPoint;
  if (input.mode === 'remember-last' && input.remembered) {
    // A remembered point is only reused when it still lands on a connected
    // display; a monitor unplugged in the meantime must not strand the window.
    const areas = input.allWorkAreas && input.allWorkAreas.length ? input.allWorkAreas : [workArea];
    const onSomeDisplay = areas.some((area) =>
      input.remembered!.x >= area.x - size.width &&
      input.remembered!.x <= area.x + area.width &&
      input.remembered!.y >= area.y - size.height &&
      input.remembered!.y <= area.y + area.height,
    );
    anchor = onSomeDisplay
      ? input.remembered
      : anchorForMode('bottom-right', size, workArea, input.mainBounds, gap);
  } else {
    const mode = input.mode === 'remember-last' ? 'bottom-right' : input.mode;
    anchor = anchorForMode(mode, size, workArea, input.mainBounds, gap);
  }

  return clampToWorkArea(size, workArea, avoidOverlap(anchor, size, workArea, occupied, gap));
}

/**
 * Slide a spawn point left (then up a row) until it no longer overlaps any
 * occupied rect. Bounded so a fully-packed screen still terminates: after the
 * scan the caller's clamp keeps the result on-screen.
 */
export function avoidOverlap(
  point: PlacementPoint,
  size: { width: number; height: number },
  workArea: PlacementRect,
  occupied: readonly PlacementRect[],
  gap: number,
): PlacementPoint {
  const rectAt = (p: PlacementPoint): PlacementRect => ({
    x: p.x,
    y: p.y,
    width: size.width,
    height: size.height,
  });
  const stepX = size.width + Math.max(0, gap);
  const stepY = size.height + Math.max(0, gap);
  // Cap the search: at most one row per window height, one column per window
  // width — enough for any realistic number of open companions.
  const maxCols = Math.max(1, Math.ceil(workArea.width / Math.max(1, stepX)) + 1);
  const maxRows = Math.max(1, Math.ceil(workArea.height / Math.max(1, stepY)) + 1);

  let candidate = { ...point };
  for (let row = 0; row < maxRows; row += 1) {
    for (let col = 0; col < maxCols; col += 1) {
      // Stop the column walk as soon as it would leave the work area: a spot
      // off the left edge is not a free slot, it is the next row's job.
      if (candidate.x < workArea.x || candidate.y < workArea.y) break;
      const rect = rectAt(candidate);
      if (!occupied.some((other) => rectsOverlap(rect, other))) return candidate;
      candidate = { x: candidate.x - stepX, y: candidate.y };
    }
    // Wrapped off the left edge: start the next row up from the anchor column.
    candidate = { x: point.x, y: candidate.y - stepY };
  }
  return point;
}
