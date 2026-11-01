/**
 * Shared presentation bits for the storage hub's two portal-managed collection
 * sections (data rooms + cloud workspaces).
 *
 * They render the same row anatomy — a name, a couple of badges, a metric line,
 * and an action button — so the styles live here once instead of drifting between
 * the two files. Kept as plain style objects (like `settings-ui.tsx`) because the
 * hub is deliberately dependency-free.
 */

import type { CSSProperties } from 'react';

/** Small pill used for scope/visibility/access-mode badges. */
export const collectionBadge: CSSProperties = {
  fontSize: 11,
  padding: '1px 7px',
  borderRadius: 999,
  border: '1px solid #2f3b48',
  color: '#9aa7b5',
  background: '#131b23',
  whiteSpace: 'nowrap',
};

/** The row's name. */
export const collectionRowName: CSSProperties = { fontSize: 13, color: '#e8eef4' };

/** The metric line under a row (items / members / views…). */
export const collectionRowMeta: CSSProperties = {
  fontSize: 11,
  color: '#6b7784',
  display: 'flex',
  gap: 14,
  flexWrap: 'wrap',
};

/**
 * A filter toggle (Mine / Shared with me, Shared / All).
 *
 * Declared here rather than reusing `settingsButton`/`settingsGhostButton`
 * because those mix the `border` shorthand with a `borderColor` longhand, and
 * swapping between them on click makes React warn about a conflicting style
 * property during rerender. Using longhands throughout keeps a toggle silent.
 */
export function collectionFilterButton(active: boolean): CSSProperties {
  return {
    alignSelf: 'flex-start',
    padding: '8px 14px',
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: active ? '#3f6cb0' : '#3a4654',
    background: active ? '#2f5c9e' : '#1c2430',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: active ? 600 : 500,
  };
}
