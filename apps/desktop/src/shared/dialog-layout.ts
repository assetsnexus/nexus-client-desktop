/**
 * Viewport clamping for centered dialogs.
 *
 * A dialog card that only sets a `max-width`/`max-height` in CSS can still
 * overflow a small window once its padding and border are added (and the shell
 * hides body overflow, so the clipped part is unreachable). `fitDialog` clamps
 * both axes to the viewport with a margin, and reports whether the content must
 * scroll internally — so a card is never taller/wider than the window it is in.
 *
 * Pure and framework-free so it is unit-testable.
 */

export type FitDialogInput = {
  viewportWidth: number;
  viewportHeight: number;
  /** Preferred content width before clamping. */
  preferredWidth: number;
  /** Preferred content height before clamping. */
  preferredMaxHeight: number;
  /** Viewport margin kept on every side. */
  edge?: number;
  /** Never shrink below this width (unless the viewport is smaller). */
  minWidth?: number;
  /** Never shrink below this height (unless the viewport is smaller). */
  minHeight?: number;
};

export type FitDialogResult = {
  /** Border-box width in px, always within `[0, viewportWidth - 2*edge]`. */
  width: number;
  /** Border-box max-height in px, always within `[0, viewportHeight - 2*edge]`. */
  maxHeight: number;
  /** True when the card has to scroll its own content to stay in view. */
  needsScroll: boolean;
};

export const DEFAULT_DIALOG_EDGE = 12;

/**
 * Clamp a dialog to the viewport. Both axes are clamped so the card (including
 * padding/border, which the caller must apply with `box-sizing: border-box`) fits
 * with `edge` px of margin on every side even at a tiny window size.
 */
export function fitDialog(input: FitDialogInput): FitDialogResult {
  const edge = Math.max(0, input.edge ?? DEFAULT_DIALOG_EDGE);
  const minWidth = Math.max(0, input.minWidth ?? 240);
  const minHeight = Math.max(0, input.minHeight ?? 120);

  const availableWidth = Math.max(0, input.viewportWidth - edge * 2);
  const availableHeight = Math.max(0, input.viewportHeight - edge * 2);

  const width = Math.max(0, Math.min(Math.max(input.preferredWidth, minWidth), availableWidth));
  const maxHeight = Math.max(
    0,
    Math.min(Math.max(input.preferredMaxHeight, minHeight), availableHeight),
  );

  return {
    width,
    maxHeight,
    // Clamp in either direction means the preferred content can no longer fit.
    needsScroll: input.preferredWidth > availableWidth || input.preferredMaxHeight > availableHeight,
  };
}
