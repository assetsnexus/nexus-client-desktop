// @vitest-environment jsdom
/**
 * StrictMode lifecycle regression test for `useStorageUploads`.
 *
 * Regression guard for the live defect where BOTH upload entry paths (OS
 * drag-and-drop and the file-picker "Upload" button) silently no-op'd in the
 * real Electron app: the hook created its queue with
 * `useMemo(() => createUploadQueue(...), [])` and disposed it from the
 * subscription effect's cleanup. Under `<StrictMode>` (which the real app
 * enables in `main.tsx`) React runs mount -> cleanup -> remount, so the cleanup
 * disposed the memoized queue that the surviving render kept using; `queue.add()`
 * then hit the `disposed` early-return in `upload-queue.ts` and returned `[]`,
 * enqueuing nothing.
 *
 * The unit specs passed while the feature was broken live, so this test renders
 * the REAL hook inside `<StrictMode>` and asserts that after the
 * mount -> cleanup -> remount cycle `enqueuePaths()` still adds items and the
 * upload actually proceeds to `done`. It fails against the old implementation
 * and passes against the fixed one.
 *
 * Vitest runs this app's suite in a `node` environment with no DOM, so this one
 * file opts into `jsdom` (a test-only devDependency) to run a real React tree.
 */
import { StrictMode, act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  uploadOne: vi.fn(),
  expandDrop: vi.fn(),
  transferCancel: vi.fn(),
}));

// The hook talks to the Electron preload bridge, which only exists in the real
// renderer. Swap in a faithful fake so the hook runs under Node/jsdom.
vi.mock('../bridge.js', () => ({
  bridge: {
    storageExpandDrop: (paths: string[]) => h.expandDrop(paths),
    storageUploadOne: (req: unknown) => h.uploadOne(req),
    storageTransferCancel: (id: string) => h.transferCancel(id),
    onStorageTransferProgress: () => () => undefined,
  },
}));

import { useStorageUploads, type UseStorageUploads } from './use-storage-uploads.js';

type UploadOneReq = {
  transferId: string;
  sizeBytes: number;
  name: string;
};

let latest: UseStorageUploads | null = null;

function Harness(): null {
  latest = useStorageUploads();
  return null;
}

/**
 * Read the *current* snapshot. `latest` is reassigned on every render, so read
 * it fresh after `act()` rather than capturing the object once — the captured
 * object's `snapshot` field would be stale.
 */
function current(): UseStorageUploads {
  if (!latest) throw new Error('hook not mounted');
  return latest;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  latest = null;
  h.uploadOne.mockReset();
  h.expandDrop.mockReset();
  h.transferCancel.mockReset();

  // A drop of `paths` expands to one plain file entry each.
  h.expandDrop.mockImplementation(async (paths: string[]) => ({
    entries: paths.map((p) => ({
      path: p,
      name: p.split('/').pop() ?? p,
      isDirectory: false,
      sizeBytes: 123,
    })),
  }));
  // Each upload lands successfully.
  h.uploadOne.mockImplementation(async (req: UploadOneReq) => ({
    transferId: req.transferId,
    ok: true,
    fileId: `file-${req.name}`,
    transport: 'stream',
    sentBytes: req.sizeBytes,
    indeterminate: false,
    cancelled: false,
  }));

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

/** Mount the hook inside `<StrictMode>` (mount -> cleanup -> remount). */
function mountStrict(): void {
  act(() => {
    root!.render(createElement(StrictMode, null, createElement(Harness)));
  });
}

describe('useStorageUploads under StrictMode', () => {
  it('still enqueues and uploads after the mount -> cleanup -> remount cycle', async () => {
    mountStrict();
    expect(latest).not.toBeNull();

    // Before the fix the memoized queue was disposed by StrictMode's cleanup,
    // so `add()` early-returned `[]` and nothing was ever queued.
    expect(current().snapshot.items).toHaveLength(0);

    let result: { planned: number } | undefined;
    await act(async () => {
      result = await current().enqueuePaths(['/tmp/drop/a.txt'], { workspaceId: 'w1', folderId: null });
    });
    // Let the runner's async work settle and the resulting state re-render.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result?.planned).toBe(1);
    // The regression: the queue survived StrictMode's remount and accepted work.
    expect(current().snapshot.items).toHaveLength(1);
    // It did not just sit queued — the fake transport actually ran and finished.
    expect(h.uploadOne).toHaveBeenCalledTimes(1);
    expect(current().snapshot.counts.done).toBe(1);
    expect(current().snapshot.items[0]?.fileId).toBe('file-a.txt');
  });

  it('does not throw or no-op a second drop after the first completes', async () => {
    mountStrict();

    await act(async () => {
      await current().enqueuePaths(['/tmp/drop/a.txt'], { workspaceId: 'w1', folderId: null });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await current().enqueuePaths(['/tmp/drop/b.txt'], { workspaceId: 'w1', folderId: null });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.uploadOne).toHaveBeenCalledTimes(2);
    expect(current().snapshot.counts.done).toBe(2);
  });
});
