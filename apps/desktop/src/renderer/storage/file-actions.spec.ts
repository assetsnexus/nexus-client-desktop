/**
 * Selection + context-menu spec.
 *
 * These are the behaviours a desktop user expects from a file list and its
 * right-click menu: Shift ranges from the anchor, Ctrl/Cmd toggles a row, a
 * plain click replaces the selection, the menu adapts to single vs multi vs
 * folder vs trash, and "copy path" emits the canonical Nexus reference the chat
 * agents parse.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTION,
  STORAGE_ACTION_LABELS,
  applyRowClick,
  contextMenuActions,
  copyPathPayload,
  selectedRows,
  type SelectionState,
} from './file-actions.js';
import { formatStorageReference } from '../../shared/storage-reference.js';
import type { StorageFileRow } from '../../shared/ipc.js';

const ids = ['a', 'b', 'c', 'd', 'e'];

function row(id: string, name = `${id}.txt`): StorageFileRow {
  return {
    id,
    name,
    mimeType: 'text/plain',
    sizeBytes: 1,
    status: 'active',
    workspaceId: 'w-acme',
    folderId: null,
    encryptionTier: 'none',
    createdAt: null,
    revisionNo: 1,
  };
}

function click(clickedId: string, selection: SelectionState, modifiers: Record<string, boolean> = {}) {
  return applyRowClick({ orderedIds: ids, selection, clickedId, modifiers });
}

describe('applyRowClick — plain click', () => {
  it('selects exactly one row and anchors it', () => {
    const next = click('c', { selectedIds: ['a', 'b'], anchorId: 'a' });
    expect(next.selectedIds).toEqual(['c']);
    expect(next.anchorId).toBe('c');
  });

  it('collapses a multi-selection back to a single row', () => {
    const next = click('d', { selectedIds: ['a', 'b', 'c'], anchorId: 'b' });
    expect(next.selectedIds).toEqual(['d']);
  });
});

describe('applyRowClick — Ctrl/Cmd toggle', () => {
  it('adds a row to the selection', () => {
    const next = click('b', EMPTY_SELECTION, { ctrlKey: true });
    expect(next.selectedIds).toEqual(['b']);
    expect(next.anchorId).toBe('b');
  });

  it('removes an already-selected row', () => {
    const next = click('b', { selectedIds: ['a', 'b', 'c'], anchorId: 'a' }, { metaKey: true });
    expect(next.selectedIds).toEqual(['a', 'c']);
  });

  it('treats Cmd and Ctrl identically', () => {
    const start: SelectionState = { selectedIds: ['a'], anchorId: 'a' };
    expect(click('b', start, { ctrlKey: true })).toEqual(click('b', start, { metaKey: true }));
  });

  it('returns ids in list order however the selection was built', () => {
    let sel: SelectionState = EMPTY_SELECTION;
    sel = click('d', sel, { ctrlKey: true });
    sel = click('a', sel, { ctrlKey: true });
    expect(sel.selectedIds).toEqual(['a', 'd']);
  });
});

describe('applyRowClick — Shift range', () => {
  it('selects the inclusive range from the anchor to the clicked row', () => {
    const next = click('d', { selectedIds: ['b'], anchorId: 'b' }, { shiftKey: true });
    expect(next.selectedIds).toEqual(['b', 'c', 'd']);
    expect(next.anchorId).toBe('b');
  });

  it('ranges backwards when the clicked row is above the anchor', () => {
    const next = click('b', { selectedIds: ['d'], anchorId: 'd' }, { shiftKey: true });
    expect(next.selectedIds).toEqual(['b', 'c', 'd']);
  });

  it('degrades to a single selection without an anchor', () => {
    const next = click('c', EMPTY_SELECTION, { shiftKey: true });
    expect(next.selectedIds).toEqual(['c']);
    expect(next.anchorId).toBe('c');
  });

  it('degrades when the anchor is no longer in the list', () => {
    const next = click('c', { selectedIds: ['gone'], anchorId: 'gone' }, { shiftKey: true });
    expect(next.selectedIds).toEqual(['c']);
  });
});

describe('selectedRows', () => {
  it('returns the selected rows in list order', () => {
    const rows = [row('a'), row('b'), row('c')];
    expect(selectedRows(rows, { selectedIds: ['c', 'a'], anchorId: 'a' }).map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('is empty for an empty selection', () => {
    expect(selectedRows([row('a')], EMPTY_SELECTION)).toEqual([]);
  });
});

describe('contextMenuActions', () => {
  it('offers the full single-file menu in the active view', () => {
    expect(contextMenuActions({ target: 'file', selectionCount: 1, mode: 'active' })).toEqual([
      'copy-path',
      'save',
      'move',
      'rename',
      'delete',
      'open-portal',
    ]);
  });

  it('drops rename for a multi-selection', () => {
    const actions = contextMenuActions({ target: 'file', selectionCount: 3, mode: 'active' });
    expect(actions).toContain('move');
    expect(actions).toContain('delete');
    expect(actions).not.toContain('rename');
  });

  it('offers Restore and copy for trash rows, never delete/rename', () => {
    expect(contextMenuActions({ target: 'file', selectionCount: 1, mode: 'trash' })).toEqual([
      'restore',
      'copy-path',
    ]);
  });

  it('offers mount hand-off for a directory target', () => {
    expect(contextMenuActions({ target: 'folder', selectionCount: 0, mode: 'active' })).toEqual([
      'refresh',
      'mount-folder',
    ]);
  });

  it('has a human label for every action', () => {
    for (const id of contextMenuActions({ target: 'file', selectionCount: 1, mode: 'active' })) {
      expect(STORAGE_ACTION_LABELS[id]).toBeTruthy();
    }
    expect(STORAGE_ACTION_LABELS['copy-path']).toBe('Copy Nexus path');
    expect(STORAGE_ACTION_LABELS['mount-folder']).toBe('Mount to system dir…');
  });
});

describe('copyPathPayload', () => {
  it('copies the canonical bfstorage reference for one file', () => {
    expect(copyPathPayload('w-acme', [row('f_123')], formatStorageReference)).toBe('bfstorage://w-acme/f_123');
  });

  it('copies one reference per line for a multi-selection', () => {
    expect(
      copyPathPayload('w-acme', [row('f_1'), row('f_2')], formatStorageReference),
    ).toBe('bfstorage://w-acme/f_1\nbfstorage://w-acme/f_2');
  });

  it('is empty for no rows', () => {
    expect(copyPathPayload('w-acme', [], formatStorageReference)).toBe('');
  });
});
