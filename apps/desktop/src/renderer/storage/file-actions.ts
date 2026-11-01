/**
 * Selection + context-menu rules for the storage explorer's file list.
 *
 * Kept pure and outside the component so the behaviour a user relies on —
 * Shift extends a range from the anchor, Ctrl/Cmd toggles one row, a plain click
 * replaces the selection — is unit-testable without rendering, and so the
 * context menu shown for a single file, a multi-selection and a folder is one
 * decision table rather than scattered conditionals in JSX.
 */

import type { StorageFileRow } from '../../shared/ipc.js';

/** Keyboard modifiers a row click carries. */
export type SelectionModifiers = {
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
};

/** The current selection plus the row a Shift range extends from. */
export type SelectionState = {
  selectedIds: string[];
  anchorId: string | null;
};

export const EMPTY_SELECTION: SelectionState = { selectedIds: [], anchorId: null };

function toggleKey(modifiers: SelectionModifiers): boolean {
  // Cmd on macOS, Ctrl elsewhere — both mean "toggle this one row".
  return Boolean(modifiers.metaKey || modifiers.ctrlKey);
}

/**
 * Resolve the selection after a click on `clickedId`.
 *
 * - Ctrl/Cmd+click toggles that row and moves the anchor to it.
 * - Shift+click selects the inclusive range from the anchor to the clicked row,
 *   replacing the previous selection (the file-manager convention). Without an
 *   anchor it degrades to a plain single selection.
 * - A plain click selects only that row and sets the anchor.
 *
 * Ids are always returned in list order, so a multi-selection reads top-to-bottom
 * regardless of the order the user built it in.
 */
export function applyRowClick(params: {
  orderedIds: readonly string[];
  selection: SelectionState;
  clickedId: string;
  modifiers?: SelectionModifiers;
}): SelectionState {
  const { orderedIds, selection, clickedId } = params;
  const modifiers = params.modifiers ?? {};

  if (toggleKey(modifiers)) {
    const has = selection.selectedIds.includes(clickedId);
    const nextIds = has
      ? selection.selectedIds.filter((id) => id !== clickedId)
      : [...selection.selectedIds, clickedId];
    const ordered = orderedIds.filter((id) => nextIds.includes(id));
    // Keep an anchor that is still selected; otherwise fall back to the row we
    // just toggled so a following Shift+click ranges from a sensible place.
    const anchorId = has ? (ordered.length ? ordered[ordered.length - 1] : null) : clickedId;
    return { selectedIds: ordered, anchorId };
  }

  if (modifiers.shiftKey && selection.anchorId) {
    const from = orderedIds.indexOf(selection.anchorId);
    const to = orderedIds.indexOf(clickedId);
    if (from >= 0 && to >= 0) {
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      return { selectedIds: orderedIds.slice(lo, hi + 1), anchorId: selection.anchorId };
    }
  }

  return { selectedIds: [clickedId], anchorId: clickedId };
}

/** Ids currently selected, in list order. */
export function selectedRows(
  rows: readonly StorageFileRow[],
  selection: SelectionState,
): StorageFileRow[] {
  if (!selection.selectedIds.length) return [];
  const wanted = new Set(selection.selectedIds);
  return rows.filter((row) => wanted.has(row.id));
}

/** What the context menu was opened on. */
export type ContextTargetKind = 'file' | 'folder';

export type ContextMenuContext = {
  target: ContextTargetKind;
  /** How many files the open selection covers (1 for a single row). */
  selectionCount: number;
  /** The explorer's active/trash view; Trash offers Restore instead of Delete. */
  mode: 'active' | 'trash';
};

/** Every action the file context menu can offer. */
export type StorageActionId =
  | 'copy-path'
  | 'save'
  | 'move'
  | 'rename'
  | 'delete'
  | 'restore'
  | 'mount-folder'
  | 'open-portal'
  | 'refresh';

/**
 * Context-menu decision table.
 *
 * Files in the active view: copy the Nexus path, save (download), move to
 * another folder, rename (single row only — a batch rename has no unambiguous
 * name), delete, and open the file in the portal. Trash rows only offer Restore
 * and copy. A folder target offers Refresh plus "Mount to system dir", which
 * hands off to the Mounts section rather than reimplementing mounting here.
 */
export function contextMenuActions(context: ContextMenuContext): StorageActionId[] {
  const { target, selectionCount, mode } = context;
  const many = selectionCount > 1;

  if (target === 'folder') {
    return mode === 'active' ? ['refresh', 'mount-folder'] : ['refresh'];
  }

  if (mode === 'trash') return ['restore', 'copy-path'];

  const actions: StorageActionId[] = ['copy-path', 'save'];
  if (many) {
    actions.push('move', 'delete');
  } else {
    actions.push('move', 'rename', 'delete', 'open-portal');
  }
  return actions;
}

/** English labels for the actions above (the explorer's copy is not localized yet). */
export const STORAGE_ACTION_LABELS: Record<StorageActionId, string> = {
  'copy-path': 'Copy Nexus path',
  save: 'Save to…',
  move: 'Move to…',
  rename: 'Rename',
  delete: 'Delete',
  restore: 'Restore',
  'mount-folder': 'Mount to system dir…',
  'open-portal': 'Open in portal',
  refresh: 'Refresh',
};

/** Actions that change data and should be styled/labelled as destructive. */
export const DESTRUCTIVE_ACTIONS: readonly StorageActionId[] = ['delete'];

/**
 * Copy payload for the selection.
 *
 * A single file copies its canonical `bfstorage://<workspaceId>/<fileId>`
 * reference — the exact form Nexus chat agents parse. A multi-selection copies
 * one reference per line, in list order, so pasting a batch into chat gives the
 * agent an unambiguous list rather than a comma-joined blob.
 */
export function copyPathPayload(
  workspaceId: string,
  rows: readonly Pick<StorageFileRow, 'id'>[],
  format: (workspaceId: string, fileId: string) => string,
): string {
  return rows.map((row) => format(workspaceId, row.id)).join('\n');
}
