// @vitest-environment jsdom
/**
 * Selection + context-menu spec for the storage explorer.
 *
 * The requirement: a file list a desktop user recognises — Shift+click ranges,
 * Ctrl/Cmd+click toggles, a plain click replaces the selection — with a
 * right-click menu that adapts to single vs multi vs folder, and a "Copy Nexus
 * path" action that emits the canonical `bfstorage://<workspaceId>/<fileId>`
 * reference Nexus chat agents parse. These tests render the REAL explorer against
 * a fake preload bridge and assert on observable DOM plus the IPC arguments.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  workspaces: vi.fn(),
  listFiles: vi.fn(),
  folderList: vi.fn(),
  capabilities: vi.fn(),
  listRevisions: vi.fn(),
  previewBytes: vi.fn(),
  moveFile: vi.fn(),
  trashFile: vi.fn(),
  openExternal: vi.fn(),
  getConnectionConfig: vi.fn(),
  navigate: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('../bridge.js', () => ({
  bridge: {
    storageWorkspaces: () => h.workspaces(),
    storageListFiles: (input: unknown) => h.listFiles(input),
    storageFolderList: (workspaceId: string, folderId?: string | null) =>
      h.folderList(workspaceId, folderId),
    storageCapabilities: (kind: string, identityKey?: string) => h.capabilities(kind, identityKey),
    storageListRevisions: (fileId: string, limit: number, identityKey?: string) =>
      h.listRevisions(fileId, limit, identityKey),
    storageRevertRevision: async () => ({ ok: true }),
    storageTrashFile: (fileId: string, identityKey?: string) => h.trashFile(fileId, identityKey),
    storageRestoreFile: async () => undefined,
    storageRenameFile: async () => undefined,
    storageMoveFile: (fileId: string, folderId: string | null, identityKey?: string) =>
      h.moveFile(fileId, folderId, identityKey),
    storagePreviewBytes: (fileId: string, identityKey?: string) => h.previewBytes(fileId, identityKey),
    storagePrepareDrag: async () => ({ path: null }),
    storageStartDrag: async () => undefined,
    storageReleaseDrag: async () => undefined,
    storageSaveFile: async () => ({ saved: 0, cancelled: true }),
    storageSaveFilesToDir: async () => ({ saved: 0, cancelled: true, dir: null }),
    storageExpandDrop: async () => ({ entries: [] }),
    storageUploadOne: async () => ({ ok: true }),
    storageTransferCancel: async () => undefined,
    onStorageTransferProgress: () => () => undefined,
    getPathForFile: () => '/tmp/f.txt',
    getConnectionConfig: () => h.getConnectionConfig(),
    openExternal: (url: string) => h.openExternal(url),
    getUiSettings: async () => ({ locale: 'en' }),
    setUiSettings: async () => undefined,
  },
}));

import { StorageExplorer } from './StorageExplorer.js';
import { I18nProvider } from '../i18n/index.js';
import { StorageNavContext } from './storage-hub/sections.js';

const PERSONAL = {
  id: 'w-personal',
  name: 'My Storage',
  ownerUserId: null,
  orgId: null,
  memberUserIds: [],
  identityKey: 'personal',
  isOrg: false,
  orgName: null,
  orgLogo: null,
};

const ORG = {
  id: 'w-acme',
  name: 'Acme Shared',
  ownerUserId: null,
  orgId: 'org-acme',
  memberUserIds: [],
  identityKey: 'org:org-acme',
  isOrg: true,
  orgName: 'Acme Corp',
  orgLogo: null,
};

function file(id: string, name: string) {
  return {
    id,
    name,
    mimeType: 'text/plain',
    sizeBytes: 10,
    status: 'active',
    workspaceId: 'w-acme',
    folderId: null,
    encryptionTier: 'none',
    createdAt: null,
    revisionNo: 1,
  };
}

const FILES = [file('f-1', 'one.txt'), file('f-2', 'two.txt'), file('f-3', 'three.txt'), file('f-4', 'four.txt')];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const fn of Object.values(h)) fn.mockReset();

  h.workspaces.mockResolvedValue([ORG, PERSONAL]);
  h.capabilities.mockResolvedValue({ presignPut: true, presignGet: true, shareLinks: false });
  h.listRevisions.mockResolvedValue({ items: [], currentRevisionNo: 1, unsupported: false });
  h.previewBytes.mockResolvedValue({ ok: true, base64: '', contentType: 'image/png', sizeBytes: 0 });
  h.listFiles.mockResolvedValue({ items: FILES, total: FILES.length, nextCursor: null, encryptionSummary: {} });
  h.folderList.mockResolvedValue([]);
  h.getConnectionConfig.mockResolvedValue({ portalUrl: 'https://portal.example' });
  h.writeText.mockResolvedValue(undefined);

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: h.writeText },
  });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    root!.render(
      createElement(
        I18nProvider,
        null,
        createElement(
          StorageNavContext.Provider,
          { value: h.navigate },
          createElement(StorageExplorer),
        ),
      ),
    );
  });
  await settle();
}

function row(id: string): HTMLElement {
  const el = container!.querySelector(`[data-testid="storage-row-${id}"]`);
  expect(el, `row ${id}`).toBeTruthy();
  return el as HTMLElement;
}

function rowButton(id: string): HTMLButtonElement {
  const el = row(id).querySelector('button');
  expect(el, `row button ${id}`).toBeTruthy();
  return el as HTMLButtonElement;
}

function selectedIds(): string[] {
  return FILES.filter((f) => row(f.id).getAttribute('data-selected') === 'true').map((f) => f.id);
}

async function clickRow(id: string, modifiers: MouseEventInit = {}): Promise<void> {
  await act(async () => {
    rowButton(id).dispatchEvent(new MouseEvent('click', { bubbles: true, ...modifiers }));
  });
  await settle();
}

async function openRowMenu(id: string): Promise<void> {
  await act(async () => {
    row(id).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
    );
  });
  await settle();
}

function menuItems(): string[] {
  const menu = container!.querySelector('[data-testid="storage-context-menu"]');
  if (!menu) return [];
  return Array.from(menu.querySelectorAll('[role="menuitem"]')).map((el) =>
    (el.getAttribute('data-testid') ?? '').replace('storage-context-', ''),
  );
}

async function clickMenuItem(action: string): Promise<void> {
  const item = container!.querySelector(`[data-testid="storage-context-${action}"]`) as HTMLButtonElement | null;
  expect(item, `menu item ${action}`).toBeTruthy();
  await act(async () => {
    item!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

describe('storage explorer row selection', () => {
  it('selects a single row on a plain click and shows its details', async () => {
    await mount();
    await clickRow('f-2');
    expect(selectedIds()).toEqual(['f-2']);
    const detail = container!.querySelector('[data-testid="storage-detail-name"]');
    expect(detail?.textContent).toBe('two.txt');
  });

  it('extends the selection with Shift+click from the anchor', async () => {
    await mount();
    await clickRow('f-2');
    await clickRow('f-4', { shiftKey: true });
    expect(selectedIds()).toEqual(['f-2', 'f-3', 'f-4']);
  });

  it('toggles one row with Ctrl+click without dropping the rest', async () => {
    await mount();
    await clickRow('f-1');
    await clickRow('f-3', { ctrlKey: true });
    expect(selectedIds()).toEqual(['f-1', 'f-3']);

    await clickRow('f-1', { ctrlKey: true });
    expect(selectedIds()).toEqual(['f-3']);
  });

  it('treats Cmd+click as Ctrl+click (macOS)', async () => {
    await mount();
    await clickRow('f-1');
    await clickRow('f-2', { metaKey: true });
    expect(selectedIds()).toEqual(['f-1', 'f-2']);
  });

  it('replaces a multi-selection with a plain click', async () => {
    await mount();
    await clickRow('f-1');
    await clickRow('f-3', { ctrlKey: true });
    expect(selectedIds()).toEqual(['f-1', 'f-3']);
    await clickRow('f-2');
    expect(selectedIds()).toEqual(['f-2']);
  });

  it('offers a bulk save once more than one row is selected', async () => {
    await mount();
    await clickRow('f-1');
    await clickRow('f-2', { ctrlKey: true });
    const save = Array.from(container!.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Save 2…'),
    );
    expect(save, 'Save 2… bulk action').toBeTruthy();
  });
});

describe('storage explorer context menu', () => {
  it('offers the full single-file menu on a row', async () => {
    await mount();
    await openRowMenu('f-1');
    expect(menuItems()).toEqual(['copy-path', 'save', 'move', 'rename', 'delete', 'open-portal']);
  });

  it('drops rename and adds the bulk actions for a multi-selection', async () => {
    await mount();
    await clickRow('f-1');
    await clickRow('f-2', { ctrlKey: true });
    await openRowMenu('f-2');
    const items = menuItems();
    expect(items).toContain('move');
    expect(items).toContain('delete');
    expect(items).not.toContain('rename');
  });

  it('selects just the right-clicked row when it was not part of the selection', async () => {
    await mount();
    await clickRow('f-1');
    await openRowMenu('f-4');
    expect(selectedIds()).toEqual(['f-4']);
    expect(menuItems()).toContain('rename');
  });

  it('offers Refresh and a mount hand-off on the folder pane', async () => {
    await mount();
    const list = container!.querySelector('[data-testid="storage-file-list"]') as HTMLElement;
    await act(async () => {
      list.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    await settle();
    expect(menuItems()).toEqual(['refresh', 'mount-folder']);
  });

  it('hands "Mount to system dir" off to the Mounts section with the workspace prefilled', async () => {
    await mount();
    const list = container!.querySelector('[data-testid="storage-file-list"]') as HTMLElement;
    await act(async () => {
      list.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    await settle();
    await clickMenuItem('mount-folder');

    expect(h.navigate).toHaveBeenCalledWith({ section: 'mounts', workspaceId: 'w-acme', remoteFolderId: undefined });
  });

  it('closes the menu after an action runs', async () => {
    await mount();
    await openRowMenu('f-1');
    await clickMenuItem('copy-path');
    expect(container!.querySelector('[data-testid="storage-context-menu"]')).toBeNull();
  });

  it('closes the menu on Escape', async () => {
    await mount();
    await openRowMenu('f-1');
    expect(container!.querySelector('[data-testid="storage-context-menu"]')).toBeTruthy();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(container!.querySelector('[data-testid="storage-context-menu"]')).toBeNull();
    expect(container!.querySelector('[data-testid="storage-context-backdrop"]')).toBeNull();
  });

  it('leaves the selection untouched when Escape closes the menu', async () => {
    await mount();
    await clickRow('f-1');
    await clickRow('f-2', { ctrlKey: true });
    await openRowMenu('f-2');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(selectedIds()).toEqual(['f-1', 'f-2']);
  });

  it('ignores Escape when no menu is open', async () => {
    await mount();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(container!.querySelector('[data-testid="storage-context-menu"]')).toBeNull();
    expect(selectedIds()).toEqual([]);
  });
});

describe('copy Nexus path', () => {
  it('copies the canonical bfstorage reference for one file', async () => {
    await mount();
    await openRowMenu('f-2');
    await clickMenuItem('copy-path');
    expect(h.writeText).toHaveBeenCalledWith('bfstorage://w-acme/f-2');
  });

  it('copies one reference per line for a multi-selection', async () => {
    await mount();
    await clickRow('f-1');
    await clickRow('f-3', { ctrlKey: true });
    await openRowMenu('f-3');
    await clickMenuItem('copy-path');
    expect(h.writeText).toHaveBeenCalledWith('bfstorage://w-acme/f-1\nbfstorage://w-acme/f-3');
  });
});

describe('move, delete and portal hand-off', () => {
  it('moves the selection into the chosen folder', async () => {
    await mount();
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('f-target');
    await clickRow('f-1');
    await clickRow('f-2', { ctrlKey: true });
    await openRowMenu('f-2');
    await clickMenuItem('move');

    expect(h.moveFile).toHaveBeenCalledTimes(2);
    expect(h.moveFile).toHaveBeenCalledWith('f-1', 'f-target', 'org:org-acme');
    expect(h.moveFile).toHaveBeenCalledWith('f-2', 'f-target', 'org:org-acme');
    prompt.mockRestore();
  });

  it('cancels the move when the prompt is dismissed', async () => {
    await mount();
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
    await clickRow('f-1');
    await openRowMenu('f-1');
    await clickMenuItem('move');
    expect(h.moveFile).not.toHaveBeenCalled();
    prompt.mockRestore();
  });

  it('trashes every selected row after confirmation', async () => {
    await mount();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await clickRow('f-1');
    await clickRow('f-2', { ctrlKey: true });
    await openRowMenu('f-2');
    await clickMenuItem('delete');

    expect(h.trashFile).toHaveBeenCalledTimes(2);
    expect(h.trashFile).toHaveBeenCalledWith('f-1', 'org:org-acme');
    expect(h.trashFile).toHaveBeenCalledWith('f-2', 'org:org-acme');
    confirm.mockRestore();
  });

  it('does not trash anything when the confirmation is declined', async () => {
    await mount();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await clickRow('f-1');
    await clickRow('f-2', { ctrlKey: true });
    await openRowMenu('f-2');
    await clickMenuItem('delete');
    expect(h.trashFile).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('opens the file in the portal storage browser', async () => {
    await mount();
    await openRowMenu('f-2');
    await clickMenuItem('open-portal');
    expect(h.openExternal).toHaveBeenCalledWith(
      'https://portal.example/b2b/storage/browser/w-acme?file=f-2',
    );
  });
});

describe('folder navigation', () => {
  it('lists sub-folders and re-lists the bucket when one is opened', async () => {
    h.folderList.mockResolvedValue([{ id: 'fold-1', name: 'Reports', parentFolderId: null }]);
    await mount();

    const folderRow = container!.querySelector('[data-testid="storage-folder-row-fold-1"]');
    expect(folderRow, 'folder row rendered').toBeTruthy();
    const callsBefore = h.listFiles.mock.calls.length;

    await act(async () => {
      (folderRow!.querySelector('button') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await settle();

    expect(h.listFiles.mock.calls.length).toBe(callsBefore + 1);
    expect(h.listFiles.mock.calls.at(-1)?.[0]).toMatchObject({ workspaceId: 'w-acme', folderId: 'fold-1' });
  });
});
