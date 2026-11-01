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
  },
}));

import { StorageExplorer } from './StorageExplorer.js';

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
      baseUrl === undefined
        ? createElement(StorageExplorer)
        : createElement(StorageExplorer, { baseUrl }),
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
