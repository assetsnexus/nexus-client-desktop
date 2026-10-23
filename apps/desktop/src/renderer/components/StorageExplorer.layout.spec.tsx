// @vitest-environment jsdom
/**
 * Layout regression spec for the storage explorer's **right-hand detail column**.
 *
 * The requirement: the file/image/PDF preview must render in a column *beside*
 * the file list, never stacked underneath it. These tests render the REAL
 * explorer against a fake preload bridge and assert on observable DOM structure:
 *
 *  - the detail/preview pane is a **sibling of the file-list section inside the
 *    same horizontal flex row** (so it is visibly alongside, not below), and
 *  - the image preview `<img>` actually receives a `blob:` URL from the fetched
 *    bytes, and
 *  - an unsupported type (text) shows the non-preview placeholder, and
 *  - no file selected shows a coherent empty detail pane.
 *
 * The suite runs in `node` by default; this file opts into `jsdom`.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  workspaces: vi.fn(),
  listFiles: vi.fn(),
  capabilities: vi.fn(),
  listRevisions: vi.fn(),
  previewBytes: vi.fn(),
  prepareDrag: vi.fn(),
  startDrag: vi.fn(),
  releaseDrag: vi.fn(),
  saveFile: vi.fn(),
  saveFilesToDir: vi.fn(),
}));

vi.mock('../bridge.js', () => ({
  bridge: {
    storageWorkspaces: () => h.workspaces(),
    storageListFiles: (input: unknown) => h.listFiles(input),
    storageCapabilities: () => h.capabilities(),
    storageListRevisions: (fileId: string, limit: number) => h.listRevisions(fileId, limit),
    storageRevertRevision: async () => ({ ok: true }),
    storageTrashFile: async () => undefined,
    storageRestoreFile: async () => undefined,
    storageRenameFile: async () => undefined,
    storagePreviewBytes: (fileId: string) => h.previewBytes(fileId),
    storagePrepareDrag: (fileId: string, name: string) => h.prepareDrag(fileId, name),
    storageStartDrag: (fileId: string, name: string) => h.startDrag(fileId, name),
    storageReleaseDrag: (fileId: string) => h.releaseDrag(fileId),
    storageSaveFile: (fileId: string, name: string) => h.saveFile(fileId, name),
    storageSaveFilesToDir: (files: unknown) => h.saveFilesToDir(files),
    storageExpandDrop: async () => ({ entries: [] }),
    storageUploadOne: async () => ({ ok: true }),
    storageTransferCancel: async () => undefined,
    onStorageTransferProgress: () => () => undefined,
    getPathForFile: () => '/tmp/f.txt',
  },
}));

import { StorageExplorer } from './StorageExplorer.js';

// jsdom has no object-URL implementation; a faithful in-memory stub lets the
// hook build and revoke real `blob:` strings so we can assert what the `<img>`
// is pointed at (the remote URL is never used).
let revoked: string[] = [];
function stubObjectUrls(): void {
  revoked = [];
  let n = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: () => `blob:nexus-preview/${(n += 1)}`,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: (url: string) => {
      revoked.push(url);
    },
  });
}

const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

function file(over: Record<string, unknown> = {}) {
  return {
    id: 'f-img',
    name: 'ai_dragon.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 84_291,
    status: 'ready',
    workspaceId: 'w1',
    folderId: null,
    encryptionTier: 'region',
    createdAt: null,
    revisionNo: 1,
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  stubObjectUrls();
  for (const fn of Object.values(h)) fn.mockReset();

  h.workspaces.mockResolvedValue([{ id: 'w1', name: 'My Storage', ownerUserId: null, orgId: null, memberUserIds: [] }]);
  h.capabilities.mockResolvedValue({ presignPut: true, presignGet: true, shareLinks: false });
  h.listRevisions.mockResolvedValue({ items: [], currentRevisionNo: 1, unsupported: false });
  h.previewBytes.mockResolvedValue({ ok: true, base64: PNG, contentType: 'image/png', sizeBytes: 8 });
  h.listFiles.mockResolvedValue({ items: [file()], total: 1 });
  h.prepareDrag.mockResolvedValue({ path: '/tmp/staged/ai_dragon.jpg', name: 'ai_dragon.jpg' });
  h.startDrag.mockResolvedValue(undefined);
  h.releaseDrag.mockResolvedValue(undefined);

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

/** Mount, let the workspaces + file list settle, then click a row by name. */
async function mountAndSelect(name: string): Promise<void> {
  await act(async () => {
    root!.render(createElement(StorageExplorer));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  const row = Array.from(container!.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').includes(name),
  );
  expect(row, `row button for ${name}`).toBeTruthy();
  await act(async () => {
    row!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('storage explorer two-pane layout', () => {
  it('renders the detail/preview pane as a sibling of the file list, not below it', async () => {
    await mountAndSelect('ai_dragon.jpg');

    const explorer = container!.querySelector('[data-testid="storage-explorer"]')!;
    const detail = explorer.querySelector('[data-testid="storage-detail-column"]');
    expect(detail, 'right-hand detail column present').toBeTruthy();

    // The file-list section is the one holding the row buttons; the detail
    // column must share its parent (the horizontal flex row) — i.e. it is
    // beside the list. If it were stacked underneath it would be a descendant
    // of that section instead.
    const listSection = Array.from(explorer.querySelectorAll('section')).find((s) =>
      (s.textContent ?? '').includes('ai_dragon.jpg'),
    );
    expect(listSection, 'file list section').toBeTruthy();
    expect(detail!.parentElement).toBe(listSection!.parentElement);
    expect(listSection!.contains(detail!)).toBe(false);

    // ...and it comes after the list in DOM order (right, not left).
    const siblings = Array.from(detail!.parentElement!.children);
    expect(siblings.indexOf(detail!)).toBeGreaterThan(siblings.indexOf(listSection!));

    // The parent is a horizontal flex row, which is what makes it a column.
    expect((detail!.parentElement as HTMLElement).style.display).toBe('flex');
  });

  it('renders the image preview from a blob: URL inside the right column', async () => {
    await mountAndSelect('ai_dragon.jpg');

    const detail = container!.querySelector('[data-testid="storage-detail-column"]')!;
    const img = detail.querySelector('[data-testid="storage-preview-image"]') as HTMLImageElement | null;
    expect(img, 'image preview rendered in the detail column').toBeTruthy();
    expect(img!.getAttribute('src')!.startsWith('blob:')).toBe(true);
    // The bytes were fetched honestly through the main-process bridge...
    expect(h.previewBytes).toHaveBeenCalledWith('f-img');
    // ...and the viewer is never pointed at the remote storage URL.
    expect(img!.getAttribute('src')).not.toMatch(/^https?:/);
  });

  it('revokes the object URL when the selection clears', async () => {
    await mountAndSelect('ai_dragon.jpg');
    expect(revoked).toHaveLength(0);
    act(() => {
      root!.unmount();
    });
    root = null;
    expect(revoked.length).toBeGreaterThan(0);
  });

  it('shows the non-preview placeholder for an unsupported (text) file', async () => {
    h.listFiles.mockResolvedValue({ items: [file({ id: 'f-txt', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 12 })], total: 1 });
    await mountAndSelect('notes.txt');

    const detail = container!.querySelector('[data-testid="storage-detail-column"]')!;
    expect(detail.querySelector('[data-testid="storage-preview-unsupported"]')).toBeTruthy();
    expect(detail.querySelector('[data-testid="storage-preview-image"]')).toBeNull();
    expect(h.previewBytes).not.toHaveBeenCalled();
  });

  it('renders the PDF in the right column through an inline viewer', async () => {
    h.listFiles.mockResolvedValue({ items: [file({ id: 'f-pdf', name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 209 })], total: 1 });
    h.previewBytes.mockResolvedValue({ ok: true, base64: PNG, contentType: 'application/pdf', sizeBytes: 8 });
    await mountAndSelect('report.pdf');

    const detail = container!.querySelector('[data-testid="storage-detail-column"]')!;
    const frame = detail.querySelector('[data-testid="storage-preview-pdf"]') as HTMLIFrameElement | null;
    expect(frame, 'PDF viewer iframe in the detail column').toBeTruthy();
    expect(frame!.getAttribute('src')!.startsWith('blob:')).toBe(true);
  });

  it('keeps a coherent empty detail pane when nothing is selected', async () => {
    await act(async () => {
      root!.render(createElement(StorageExplorer));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const empty = container!.querySelector('[data-testid="storage-detail-empty"]');
    expect(empty).toBeTruthy();
    expect(container!.querySelector('[data-testid="storage-detail-column"]')).toBeNull();
    expect((empty!.textContent ?? '')).toContain('No file selected');
  });

  it('degrades to an overlay (not a squashed list) at narrow widths', async () => {
    // jsdom never lays out, so drive the measurable width explicitly: a narrow
    // explorer must switch the detail pane to the overlay variant.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 700 });
    try {
      await mountAndSelect('ai_dragon.jpg');
      const detail = container!.querySelector('[data-testid="storage-detail-column"]') as HTMLElement;
      expect(detail.getAttribute('data-compact')).toBe('true');
      expect(detail.style.position).toBe('absolute');
      // The list stays a real sibling column, never resized to nothing.
      const listSection = Array.from(container!.querySelectorAll('section'))[0] as HTMLElement;
      expect(listSection.style.flex).toBe('1 1 0%');
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'clientWidth', original);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    }
  });

  it('keeps Save…, Drag out and multi-select wired in the new layout', async () => {
    h.listFiles.mockResolvedValue({
      items: [file(), file({ id: 'f-2', name: 'second.jpg', mimeType: 'image/jpeg' })],
      total: 2,
    });
    await mountAndSelect('ai_dragon.jpg');

    const detail = container!.querySelector('[data-testid="storage-detail-column"]')!;
    expect(detail.querySelector('[data-testid="storage-detail-save"]')).toBeTruthy();
    const drag = detail.querySelector('[data-testid="storage-detail-drag"]') as HTMLElement;
    expect(drag.getAttribute('draggable')).toBe('true');

    // Multi-select still shows the "Save N…" action in the list toolbar.
    const boxes = Array.from(container!.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes.length).toBe(2);
    await act(async () => {
      boxes[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(Array.from(container!.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes('Save 1…'))).toBe(true);
  });

  it('shows a clear, retryable state when revision history hits a transport drop', async () => {
    // Reproduces the reported failure: a dropped/reset socket must surface as a
    // clean, retryable message — never the raw `RegionAuthError: read ECONNRESET`.
    h.listRevisions.mockResolvedValue({
      fileId: 'f-img',
      currentRevisionNo: null,
      sha256: null,
      items: [],
      unsupported: false,
      transportFailed: true,
      transportMessage: 'Connection to the region was reset mid-request. (ECONNRESET)',
    });
    await mountAndSelect('ai_dragon.jpg');

    const detail = container!.querySelector('[data-testid="storage-detail-column"]')!;
    const state = detail.querySelector('[data-testid="storage-revisions-transport-error"]');
    expect(state, 'retryable transport state rendered').toBeTruthy();
    expect(state!.textContent).toMatch(/reset mid-request/i);
    expect(state!.textContent).not.toMatch(/RegionAuthError/);
    expect(detail.querySelector('[data-testid="storage-revisions-retry"]')).toBeTruthy();
  });

  it('reloads the revision history when the user retries after a transport drop', async () => {
    h.listRevisions
      .mockResolvedValueOnce({
        fileId: 'f-img',
        currentRevisionNo: null,
        sha256: null,
        items: [],
        unsupported: false,
        transportFailed: true,
        transportMessage: 'Connection to the region was reset mid-request.',
      })
      .mockResolvedValueOnce({
        fileId: 'f-img',
        currentRevisionNo: 2,
        sha256: 'cur',
        items: [{ revisionNo: 2, parentRevisionNo: 1, sizeBytes: 5, sha256: 'r2', contentType: 'image/jpeg', command: 'anx.file.upload-complete', reason: null, createdAt: null }],
        unsupported: false,
        transportFailed: false,
      });
    await mountAndSelect('ai_dragon.jpg');

    const retry = container!.querySelector('[data-testid="storage-revisions-retry"]') as HTMLButtonElement;
    await act(async () => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.listRevisions).toHaveBeenCalledTimes(2);
    expect(container!.querySelector('[data-testid="storage-revisions-transport-error"]')).toBeNull();
    expect(container!.querySelector('[data-testid="storage-detail-column"]')!.textContent).toContain('rev 2');
  });
});
