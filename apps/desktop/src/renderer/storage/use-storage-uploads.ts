/**
 * Renderer upload orchestration hook.
 *
 * Wires the pure `createUploadQueue` (concurrency, retry, cancel, byte
 * accounting) to the Electron bridge:
 * - a drop's absolute paths are expanded in the main process (directory walk)
 *   into a flat upload plan, preserving relative folder prefixes;
 * - each file's bytes are streamed by main (`storageUploadOne`), which pushes
 *   real byte progress back on `onStorageTransferProgress`;
 * - cancelling a row aborts the in-flight request in main.
 *
 * The renderer only ever holds paths and progress numbers — never file bytes —
 * so a 200-file drop stays off the renderer heap.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../bridge.js';
import {
  plannerInputFromExpansion,
  planDropUploads,
  type PlannedUpload,
} from '../../shared/storage-transfer.js';
import {
  createUploadQueue,
  emptySnapshot,
  type UploadProgress,
  type UploadQueue,
  type UploadQueueSnapshot,
  type UploadTask,
} from './upload-queue.js';

export type UploadTarget = {
  workspaceId: string;
  folderId: string | null;
};

export type EnqueueResult = {
  planned: number;
  skipped: Array<{ path: string; reason: string }>;
  /** Set when the drop could not be expanded at all. */
  error?: string;
};

/** Map a planned upload to the queue task (adding the workspace target). */
export function toUploadTask(plan: PlannedUpload, target: UploadTarget): UploadTask {
  return {
    absPath: plan.absPath,
    workspaceId: target.workspaceId,
    folderId: target.folderId,
    prefix: plan.prefix,
    name: plan.name,
    contentType: plan.contentType,
    sizeBytes: plan.sizeBytes,
  };
}

export type UseStorageUploads = {
  snapshot: UploadQueueSnapshot;
  enqueuePaths: (paths: string[], target: UploadTarget) => Promise<EnqueueResult>;
  cancelAll: () => void;
  cancelOne: (id: string) => void;
  retryOne: (id: string) => void;
  retryAllFailed: () => void;
  clearFinished: () => void;
};

const UPLOAD_CONCURRENCY = 4;

export function useStorageUploads(): UseStorageUploads {
  // Progress pushed from main for one transfer, matched by id.
  const progressHandlers = useRef(new Map<string, (progress: UploadProgress) => void>());

  // The queue is created *inside* the subscription effect and disposed in that
  // same effect's cleanup, so its lifetime is exactly the effect's lifetime.
  //
  // Why not `useMemo(() => createUploadQueue(...), [])` + `queue.dispose()` in
  // the cleanup: under `<StrictMode>` React runs mount -> cleanup -> remount
  // (and it runs the cleanup of *every* effect, empty-deps included). Disposing
  // a memoized instance therefore kills the queue the surviving render still
  // holds; `add()` then hits the `disposed` early-return in `upload-queue.ts`
  // and returns `[]`, so both drop and picker uploads silently no-op.
  //
  // Creating in the effect keeps disposal semantics intact (a real unmount, or
  // StrictMode's throwaway instance, aborts in-flight uploads) while the
  // remount gets a fresh, live queue. `queueRef` lets the returned callbacks and
  // `enqueuePaths` reach whichever queue instance is currently live.
  const queueRef = useRef<UploadQueue | null>(null);

  const [snapshot, setSnapshot] = useState<UploadQueueSnapshot>(emptySnapshot);

  useEffect(() => {
    const queue = createUploadQueue({
      concurrency: UPLOAD_CONCURRENCY,
      runner: async ({ task, itemId, signal, onProgress }) => {
        progressHandlers.current.set(itemId, onProgress);
        const onAbort = () => {
          void bridge.storageTransferCancel(itemId).catch(() => undefined);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          const result = await bridge.storageUploadOne({
            transferId: itemId,
            workspaceId: task.workspaceId,
            folderId: task.folderId,
            prefix: task.prefix,
            name: task.name,
            absPath: task.absPath,
            contentType: task.contentType,
            sizeBytes: task.sizeBytes,
            mode: 'auto',
          });
          if (result.cancelled) throw new Error('cancelled');
          if (!result.ok) throw new Error(result.error ?? 'upload failed');
          return { fileId: result.fileId };
        } finally {
          progressHandlers.current.delete(itemId);
          signal.removeEventListener('abort', onAbort);
        }
      },
    });
    queueRef.current = queue;

    const unsubscribeQueue = queue.subscribe(setSnapshot);
    const unsubscribeProgress = bridge.onStorageTransferProgress((progress) => {
      // Relay main's byte counts into the queue's per-item row.
      progressHandlers.current.get(progress.transferId)?.({
        sentBytes: progress.sentBytes,
        totalBytes: progress.totalBytes,
        indeterminate: progress.indeterminate,
      });
    });
    return () => {
      unsubscribeQueue();
      unsubscribeProgress();
      if (queueRef.current === queue) queueRef.current = null;
      queue.dispose();
    };
  }, []);

  const enqueuePaths = useCallback(
    async (paths: string[], target: UploadTarget): Promise<EnqueueResult> => {
      const clean = paths.filter((p) => typeof p === 'string' && p.trim());
      if (!clean.length) return { planned: 0, skipped: [] };
      let expansion;
      try {
        expansion = await bridge.storageExpandDrop(clean);
      } catch (err) {
        return { planned: 0, skipped: [], error: err instanceof Error ? err.message : 'failed to read dropped items' };
      }
      const { dropped, walked } = plannerInputFromExpansion(expansion.entries ?? []);
      const plan = planDropUploads(dropped, walked);
      if (plan.entries.length) {
        queueRef.current?.add(plan.entries.map((entry) => toUploadTask(entry, target)));
      }
      return { planned: plan.entries.length, skipped: plan.skipped };
    },
    [],
  );

  return {
    snapshot,
    enqueuePaths,
    cancelAll: () => queueRef.current?.cancelAll(),
    cancelOne: (id) => queueRef.current?.cancel(id),
    retryOne: (id) => queueRef.current?.retry(id),
    retryAllFailed: () => queueRef.current?.retryAllFailed(),
    clearFinished: () => queueRef.current?.clearFinished(),
  };
}
