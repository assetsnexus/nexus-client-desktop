/**
 * Screen-share source selection (Phase 7c).
 *
 * Electron needs a main-process `setDisplayMediaRequestHandler` for
 * `getDisplayMedia()` to resolve at all. The handler gets a list of desktop
 * sources and hands one back to the renderer. The *choice* is pure so it is
 * unit-testable without Electron: screens win over windows (a meeting shares a
 * display far more often than a single window), and within a kind we keep the
 * OS's ordering.
 */

export type DisplaySourceLike = {
  id: string;
  name?: string;
  thumbnail?: unknown;
};

export type DisplaySourceKind = 'screen' | 'window';

/**
 * Pick the source a `getDisplayMedia()` request should be answered with.
 * Returns `null` when there is nothing to share (the handler then denies).
 */
export function pickDisplaySource(sources: readonly DisplaySourceLike[]): DisplaySourceLike | null {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  // Electron returns screens first when asked for `['screen', 'window']`, but do
  // not rely on that: prefer whichever source has a screen-ish id prefix.
  const screen = sources.find((s) => typeof s.id === 'string' && s.id.startsWith('screen:'));
  return screen ?? sources[0];
}
