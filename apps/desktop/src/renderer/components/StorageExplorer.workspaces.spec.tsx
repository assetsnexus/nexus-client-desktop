// @vitest-environment jsdom
/**
 * Workspace rail spec for the storage explorer.
 *
 * The requirement: the Browse view must list **every** storage the signed-in
 * user can reach — the personal workspace plus one per organisation membership —
 * let each be selected, show the org's logo (or an initials monogram) beside org
 * rows, and route every command for the open workspace to that workspace's
 * identity context (`identityKey`). This suite renders the REAL explorer against
 * a fake preload bridge and asserts on observable DOM + the IPC arguments.
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
}));

vi.mock('../bridge.js', () => ({
  bridge: {
    storageWorkspaces: () => h.workspaces(),
    storageListFiles: (input: unknown) => h.listFiles(input),
    storageCapabilities: (kind: string, identityKey?: string) => h.capabilities(kind, identityKey),
    storageListRevisions: (fileId: string, limit: number, identityKey?: string) =>
      h.listRevisions(fileId, limit, identityKey),
    storageRevertRevision: async () => ({ ok: true }),
    storageTrashFile: async () => undefined,
    storageRestoreFile: async () => undefined,
    storageRenameFile: async () => undefined,
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
    getUiSettings: async () => ({ locale: 'en' }),
    setUiSettings: async () => undefined,
  },
}));

import { StorageExplorer } from './StorageExplorer.js';
import { I18nProvider } from '../i18n/index.js';

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

const ORG_LOGO = {
  id: 'w-acme',
  name: 'Acme Shared',
  ownerUserId: null,
  orgId: 'org-acme',
  memberUserIds: [],
  identityKey: 'org:org-acme',
  isOrg: true,
  orgName: 'Acme Corp',
  orgLogo: 'https://cdn.example/acme.png',
};

const ORG_NO_LOGO = {
  id: 'w-beta',
  name: 'Beta Files',
  ownerUserId: null,
  orgId: 'org-beta',
  memberUserIds: [],
  identityKey: 'org:org-beta',
  isOrg: true,
  orgName: 'Beta Industries',
  orgLogo: null,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const fn of Object.values(h)) fn.mockReset();

  h.workspaces.mockResolvedValue([ORG_LOGO, PERSONAL]);
  h.capabilities.mockResolvedValue({ presignPut: true, presignGet: true, shareLinks: false });
  h.listRevisions.mockResolvedValue({ items: [], currentRevisionNo: 1, unsupported: false });
  h.previewBytes.mockResolvedValue({ ok: true, base64: '', contentType: 'image/png', sizeBytes: 0 });
  h.listFiles.mockResolvedValue({ items: [], total: 0 });

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

async function mount(baseUrl?: string | null): Promise<void> {
  await act(async () => {
    root!.render(
      createElement(
        I18nProvider,
        null,
        baseUrl === undefined
          ? createElement(StorageExplorer)
          : createElement(StorageExplorer, { baseUrl }),
      ),
    );
  });
  await settle();
}

function workspaceButton(id: string): HTMLButtonElement {
  const el = container!.querySelector(`[data-testid="storage-workspace-${id}"]`);
  expect(el, `workspace button ${id}`).toBeTruthy();
  return el as HTMLButtonElement;
}

describe('storage explorer workspace rail', () => {
  it('lists every identity workspace (personal + each org), not just the active one', async () => {
    await mount();
    expect(workspaceButton('w-personal')).toBeTruthy();
    expect(workspaceButton('w-acme')).toBeTruthy();
  });

  it('defaults the selection to the first workspace so a bucket is always open', async () => {
    await mount();
    // Org storage sorts first; it is selected without any click, and its files load.
    expect(workspaceButton('w-acme').getAttribute('data-active')).toBe('true');
    expect(h.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w-acme', identityKey: 'org:org-acme' }),
    );
  });

  it('selects a different workspace on click and loads it with its identity key', async () => {
    await mount();
    await act(async () => {
      workspaceButton('w-personal').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    expect(workspaceButton('w-personal').getAttribute('data-active')).toBe('true');
    expect(h.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w-personal' }),
    );
    // A personal workspace never routes through an org context.
    const lastCall = h.listFiles.mock.calls.at(-1)?.[0] as { identityKey?: string };
    expect(lastCall.identityKey ?? undefined).toBeUndefined();
  });

  it('shows the organisation logo beside an org workspace', async () => {
    await mount();
    const img = container!.querySelector('[data-testid="storage-workspace-logo-w-acme"]') as HTMLImageElement | null;
    expect(img, 'org logo image').toBeTruthy();
    expect(img!.getAttribute('src')).toBe('https://cdn.example/acme.png');
    expect(container!.querySelector('[data-testid="storage-workspace-initials-w-acme"]')).toBeNull();
  });

  it('falls back to an initials monogram for an org without a logo', async () => {
    h.workspaces.mockResolvedValue([ORG_NO_LOGO, PERSONAL]);
    await mount();

    const badge = container!.querySelector('[data-testid="storage-workspace-initials-w-beta"]');
    expect(badge, 'initials monogram').toBeTruthy();
    expect(badge!.textContent).toBe('BI');
    expect(container!.querySelector('[data-testid="storage-workspace-logo-w-beta"]')).toBeNull();
  });

  it('absolutises a relative org logo against the supplied base URL', async () => {
    h.workspaces.mockResolvedValue([
      { ...ORG_LOGO, orgLogo: '/public-files/orgs/acme.png' },
      PERSONAL,
    ]);
    await mount('https://region.example');

    const img = container!.querySelector('[data-testid="storage-workspace-logo-w-acme"]') as HTMLImageElement | null;
    expect(img!.getAttribute('src')).toBe('https://region.example/public-files/orgs/acme.png');
  });

  it('does not emit a bogus image src for a relative logo when no base URL is known', async () => {
    h.workspaces.mockResolvedValue([
      { ...ORG_LOGO, orgLogo: '/public-files/orgs/acme.png' },
      PERSONAL,
    ]);
    await mount();

    // No base URL to absolutise against → fall back to the monogram, never a
    // broken relative <img> that resolves against the Vite dev origin.
    expect(container!.querySelector('[data-testid="storage-workspace-logo-w-acme"]')).toBeNull();
    expect(container!.querySelector('[data-testid="storage-workspace-initials-w-acme"]')).toBeTruthy();
  });

  it('offers a Retry when the workspace list cannot be loaded (not a blank list)', async () => {
    h.workspaces.mockRejectedValueOnce(new Error('Could not reach the region to list storage.'));
    await mount();

    // The empty rail must be actionable, not a dead end.
    const retry = Array.from(container!.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === 'Retry',
    );
    expect(retry, 'retry button in the workspace rail').toBeTruthy();

    // Clicking Retry re-issues the list call and renders the workspaces.
    h.workspaces.mockResolvedValue([ORG_LOGO, PERSONAL]);
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(workspaceButton('w-acme')).toBeTruthy();
  });
});

function fileRow(id: string, name: string) {
  return {
    id,
    name,
    mimeType: 'text/plain',
    sizeBytes: 12,
    status: 'active',
    workspaceId: null,
    folderId: null,
    encryptionTier: 'none',
    createdAt: null,
    revisionNo: 1,
  };
}

function pageOf(items: ReturnType<typeof fileRow>[]) {
  return { items, total: items.length, nextCursor: null, encryptionSummary: {} };
}

function listRowNames(): string[] {
  const list = container!.querySelector('[data-testid="storage-file-list"]');
  if (!list) return [];
  return Array.from(list.querySelectorAll('span'))
    .map((el) => (el.textContent ?? '').trim())
    .filter((text) => text.endsWith('.txt'));
}

describe('storage explorer workspace switch: reload, loading and cache', () => {
  it('reloads the bucket when a different workspace is selected', async () => {
    await mount();
    const callsBefore = h.listFiles.mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0);

    await act(async () => {
      workspaceButton('w-personal').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    expect(h.listFiles.mock.calls.length).toBe(callsBefore + 1);
    expect(h.listFiles.mock.calls.at(-1)?.[0]).toMatchObject({ workspaceId: 'w-personal' });
  });

  it('clears the previous workspace rows and shows a loading skeleton while the switch loads', async () => {
    // First workspace resolves immediately with a row; the second stays pending
    // so we can observe the in-flight pane.
    h.listFiles.mockResolvedValueOnce(pageOf([fileRow('f-acme', 'acme-notes.txt')]));
    await mount();
    expect(listRowNames()).toContain('acme-notes.txt');

    let release: ((value: unknown) => void) | null = null;
    h.listFiles.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await act(async () => {
      workspaceButton('w-personal').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    // Stale org rows are gone and the pane advertises its loading state.
    expect(listRowNames()).not.toContain('acme-notes.txt');
    expect(container!.querySelector('[data-testid="storage-listing-skeleton"]')).toBeTruthy();
    // It is a loading state, not the empty state.
    expect(container!.querySelector('[data-testid="storage-listing-empty"]')).toBeNull();

    await act(async () => {
      release?.(pageOf([fileRow('f-personal', 'personal-notes.txt')]));
    });
    await settle();

    expect(container!.querySelector('[data-testid="storage-listing-skeleton"]')).toBeNull();
    expect(listRowNames()).toContain('personal-notes.txt');
  });

  it('renders a cached listing instantly and skips the refetch within the TTL', async () => {
    await mount();
    const afterMount = h.listFiles.mock.calls.length;

    // Switch away and straight back: the org listing was cached on first load.
    await act(async () => {
      workspaceButton('w-personal').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    await act(async () => {
      workspaceButton('w-acme').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    // Only the switch to the uncached personal workspace hit the region; the
    // return to the cached org workspace was served from memory.
    expect(h.listFiles.mock.calls.length).toBe(afterMount + 1);
    expect(h.listFiles.mock.calls.at(-1)?.[0]).toMatchObject({ workspaceId: 'w-personal' });
  });

  it('busts the current view cache and reloads when Refresh is used', async () => {
    await mount();
    const beforeRefresh = h.listFiles.mock.calls.length;
    const refresh = container!.querySelector('[data-testid="storage-refresh"]') as HTMLButtonElement | null;
    expect(refresh, 'toolbar refresh button').toBeTruthy();

    await act(async () => {
      refresh!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    // An explicit refresh always goes back to the region, cache or not.
    expect(h.listFiles.mock.calls.length).toBe(beforeRefresh + 1);
    expect(h.listFiles.mock.calls.at(-1)?.[0]).toMatchObject({ workspaceId: 'w-acme' });
  });

  it('keys the cache by view mode as well as workspace, so Trash never reuses Files', async () => {
    await mount();
    const afterMount = h.listFiles.mock.calls.length;

    const trash = Array.from(container!.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === 'Trash',
    );
    expect(trash, 'trash toggle').toBeTruthy();
    await act(async () => {
      trash!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    // A different view of the same workspace is a different cache entry.
    expect(h.listFiles.mock.calls.length).toBe(afterMount + 1);
    expect(h.listFiles.mock.calls.at(-1)?.[0]).toMatchObject({ workspaceId: 'w-acme', status: 'deleted' });

    const files = Array.from(container!.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === 'Files',
    );
    await act(async () => {
      files!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    // Returning to Files within the TTL is served from the cache: no refetch.
    expect(h.listFiles.mock.calls.length).toBe(afterMount + 1);
  });

  it('exposes Refresh in the file-browser context menu too', async () => {
    await mount();
    const list = container!.querySelector('[data-testid="storage-file-list"]') as HTMLElement | null;
    expect(list).toBeTruthy();

    await act(async () => {
      list!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
      );
    });
    await settle();

    const item = container!.querySelector('[data-testid="storage-context-refresh"]') as HTMLButtonElement | null;
    expect(item, 'context-menu refresh item').toBeTruthy();
    const beforeRefresh = h.listFiles.mock.calls.length;

    await act(async () => {
      item!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    expect(h.listFiles.mock.calls.length).toBe(beforeRefresh + 1);
  });
});

describe('storage explorer failed-vs-empty listing', () => {
  it('shows a retryable failure state, never the empty copy, when the listing fails', async () => {
    h.listFiles.mockRejectedValueOnce(new Error('Could not reach the region to list storage.'));
    await mount();

    const failure = container!.querySelector('[data-testid="storage-listing-error"]');
    expect(failure, 'failure state').toBeTruthy();
    expect((failure!.textContent ?? '')).toContain("Couldn't load this folder.");
    // A failed load must never masquerade as an empty folder.
    expect(container!.querySelector('[data-testid="storage-listing-empty"]')).toBeNull();
    expect(container!.querySelector('[data-testid="storage-listing-retry"]')).toBeTruthy();
  });

  it('re-issues the listing and paints rows when Retry is clicked after a failure', async () => {
    h.listFiles.mockRejectedValueOnce(new Error('Could not reach the region to list storage.'));
    await mount();
    const failedCalls = h.listFiles.mock.calls.length;

    h.listFiles.mockResolvedValue(pageOf([fileRow('f-retry', 'retried-notes.txt')]));
    const retry = container!.querySelector('[data-testid="storage-listing-retry"]') as HTMLButtonElement | null;
    expect(retry, 'retry button').toBeTruthy();
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    // Retry is a real reload (it busts the cache), not a no-op.
    expect(h.listFiles.mock.calls.length).toBe(failedCalls + 1);
    expect(listRowNames()).toContain('retried-notes.txt');
    expect(container!.querySelector('[data-testid="storage-listing-error"]')).toBeNull();
  });

  it('still shows "No files yet." for a genuinely empty successful listing', async () => {
    h.listFiles.mockResolvedValue(pageOf([]));
    await mount();

    const empty = container!.querySelector('[data-testid="storage-listing-empty"]');
    expect(empty, 'empty state').toBeTruthy();
    expect((empty!.textContent ?? '')).toContain('No files yet.');
    expect(container!.querySelector('[data-testid="storage-listing-error"]')).toBeNull();
  });

  it('still shows "Trash is empty." for an empty trash folder', async () => {
    h.listFiles.mockResolvedValue(pageOf([]));
    await mount();

    const trash = Array.from(container!.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === 'Trash',
    );
    expect(trash, 'trash toggle').toBeTruthy();
    await act(async () => {
      trash!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    const empty = container!.querySelector('[data-testid="storage-listing-empty"]');
    expect(empty, 'trash empty state').toBeTruthy();
    expect((empty!.textContent ?? '')).toContain('Trash is empty.');
    expect(container!.querySelector('[data-testid="storage-listing-error"]')).toBeNull();
  });

  it('clears a previous failure once a later load succeeds', async () => {
    h.listFiles.mockRejectedValueOnce(new Error('Could not reach the region to list storage.'));
    await mount();
    expect(container!.querySelector('[data-testid="storage-listing-error"]')).toBeTruthy();

    h.listFiles.mockResolvedValue(pageOf([fileRow('f-ok', 'recovered.txt')]));
    const refresh = container!.querySelector('[data-testid="storage-refresh"]') as HTMLButtonElement | null;
    await act(async () => {
      refresh!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    expect(container!.querySelector('[data-testid="storage-listing-error"]')).toBeNull();
    expect(listRowNames()).toContain('recovered.txt');
  });
});
