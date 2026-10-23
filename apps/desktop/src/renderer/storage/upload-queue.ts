/**
 * Upload queue (pure, framework-free).
 *
 * Owns the *orchestration* of many concurrent uploads: a bounded worker pool,
 * per-item state, byte accounting, cancellation and retry. The actual byte
 * transport is injected as an `UploadRunner`, so this module is fully
 * unit-testable (no Electron, no IPC, no region) and the renderer can swap in a
 * real IPC-backed runner.
 *
 * Guarantees, all covered by `upload-queue.spec.ts`:
 * - **Bounded concurrency**: never more than `concurrency` runners in flight.
 * - **Many files**: hundreds can be enqueued at once without unbounded fan-out.
 * - **Late drops**: `add()` while uploads are in flight is safe and starts work
 *   as slots free up.
 * - **Failure isolation**: one failing item never aborts the others.
 * - **Cancel**: in-flight items are aborted and queued items are dropped.
 * - **Retry**: failed items can be re-queued (individually or all at once).
 */

export type UploadItemState = 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled';

/** The immutable input for one queued upload. */
export type UploadTask = {
  /** Absolute path on disk to read bytes from (main process reads it). */
  absPath: string;
  /** Destination workspace. */
  workspaceId: string;
  /** Target folder id, or null for the workspace root. */
  folderId: string | null;
  /** Folder prefix inside the target folder (`''` for the root). */
  prefix: string;
  /** File name as stored in the workspace. */
  name: string;
  contentType: string;
  sizeBytes: number;
};

export type UploadItem = UploadTask & {
  id: string;
  state: UploadItemState;
  /** Bytes the transport has confirmed sent (0 when indeterminate). */
  sentBytes: number;
  /**
   * True when the transport cannot report byte granularity (e.g. a single
   * base64 command). The UI must then show an indeterminate bar rather than a
   * fabricated percentage.
   */
  indeterminate: boolean;
  /** Failure reason for `failed` items. */
  error: string | null;
  /** 1 for the first try, incremented by each retry. */
  attempt: number;
  /** Region file id once the upload completes. */
  fileId: string | null;
};

export type UploadProgress = {
  sentBytes: number;
  totalBytes: number;
  /** True when the runner cannot count bytes (single-shot command upload). */
  indeterminate: boolean;
};

/** The injected transport for one item. Must reject on abort/failure. */
export type UploadRunner = (ctx: {
  task: UploadTask;
  itemId: string;
  signal: AbortSignal;
  onProgress: (progress: UploadProgress) => void;
}) => Promise<{ fileId?: string | null }>;

export type UploadQueueSnapshot = {
  items: UploadItem[];
  /** Sum of queued/uploading/failed/done item sizes (the accepted total). */
  totalBytes: number;
  /**
   * Bytes accounted as transferred: for finished items their real size, for
   * in-flight items their reported `sentBytes`. Cancelled items contribute 0.
   */
  sentBytes: number;
  counts: Record<UploadItemState, number>;
  /** True while any item is uploading or queued. */
  active: boolean;
  /** At least one item has no byte granularity, so the aggregate is a floor. */
  indeterminate: boolean;
};

export type UploadQueueOptions = {
  runner: UploadRunner;
  /** Parallel uploads; clamped to 1..64. Defaults to 4. */
  concurrency?: number;
  /** Deterministic id generator (injectable for tests). */
  newId?: () => string;
};

export type UploadQueue = ReturnType<typeof createUploadQueue>;

type InternalItem = UploadItem & { controller: AbortController | null };

const DEFAULT_CONCURRENCY = 4;

/**
 * Create an upload queue. Work starts immediately as items are added; call
 * `dispose()` to abort everything and detach listeners.
 */
/**
 * A fresh, empty, all-zero snapshot. Used as the pre-subscription initial state
 * by `useStorageUploads` (whose queue is created inside an effect, so the first
 * render has no queue yet). Returning a new object each call keeps callers from
 * sharing/mutating a module-level singleton.
 */
export function emptySnapshot(): UploadQueueSnapshot {
  return {
    items: [],
    totalBytes: 0,
    sentBytes: 0,
    counts: { queued: 0, uploading: 0, done: 0, failed: 0, cancelled: 0 },
    active: false,
    indeterminate: false,
  };
}

export function createUploadQueue(options: UploadQueueOptions) {
  const concurrency = clampConcurrency(options.concurrency);
  const newId = options.newId ?? (() => `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const items: InternalItem[] = [];
  const listeners = new Set<(snapshot: UploadQueueSnapshot) => void>();

  let running = 0;
  let disposed = false;

  function notify(): void {
    if (!listeners.size) return;
    const snapshot = buildSnapshot();
    for (const listener of listeners) listener(snapshot);
  }

  function buildSnapshot(): UploadQueueSnapshot {
    const counts: Record<UploadItemState, number> = {
      queued: 0,
      uploading: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    };
    let totalBytes = 0;
    let sentBytes = 0;
    let indeterminate = false;

    for (const item of items) {
      counts[item.state] += 1;
      if (item.state === 'cancelled') continue;
      totalBytes += item.sizeBytes;
      if (item.state === 'done') {
        sentBytes += item.sizeBytes;
      } else if (item.state === 'uploading') {
        if (item.indeterminate) indeterminate = true;
        sentBytes += item.sentBytes;
      }
      if (item.indeterminate && item.state === 'uploading') indeterminate = true;
    }

    return {
      items: items.map(toPublicItem),
      totalBytes,
      sentBytes,
      counts,
      active: counts.queued > 0 || counts.uploading > 0,
      indeterminate,
    };
  }

  /** Fill free worker slots from the head of the queue. */
  function pump(): void {
    if (disposed) return;
    while (running < concurrency) {
      const next = items.find((item) => item.state === 'queued');
      if (!next) break;
      void start(next);
    }
    notify();
  }

  async function start(item: InternalItem): Promise<void> {
    running += 1;
    item.state = 'uploading';
    item.error = null;
    item.indeterminate = false;
    const controller = new AbortController();
    item.controller = controller;
    notify();

    try {
      const result = await options.runner({
        task: toTask(item),
        itemId: item.id,
        signal: controller.signal,
        onProgress: (progress) => {
          if (item.state !== 'uploading') return;
          item.sentBytes = Math.max(0, Math.min(progress.sentBytes, item.sizeBytes || progress.totalBytes));
          item.indeterminate = progress.indeterminate;
          notify();
        },
      });
      if (controller.signal.aborted) {
        item.state = 'cancelled';
      } else {
        item.state = 'done';
        item.sentBytes = item.sizeBytes;
        item.fileId = result?.fileId ?? null;
      }
    } catch (err) {
      if (controller.signal.aborted) {
        item.state = 'cancelled';
      } else {
        item.state = 'failed';
        item.error = err instanceof Error ? err.message : String(err ?? 'upload failed');
      }
    } finally {
      item.controller = null;
      running -= 1;
      // A queued item may have arrived while this one ran.
      pump();
    }
  }

  return {
    /** Enqueue tasks; returns their ids in the same order. */
    add(tasks: UploadTask[]): string[] {
      if (disposed) return [];
      const ids: string[] = [];
      for (const task of tasks) {
        const id = newId();
        ids.push(id);
        items.push({
          ...task,
          absPath: String(task.absPath ?? ''),
          name: String(task.name ?? 'file'),
          prefix: task.prefix ?? '',
          contentType: task.contentType || 'application/octet-stream',
          sizeBytes: Math.max(0, Number(task.sizeBytes) || 0),
          id,
          state: 'queued',
          sentBytes: 0,
          indeterminate: false,
          error: null,
          attempt: 1,
          fileId: null,
          controller: null,
        });
      }
      pump();
      return ids;
    },

    /** Abort in-flight items and drop everything still queued. */
    cancelAll(): void {
      for (const item of items) {
        if (item.state === 'queued') item.state = 'cancelled';
        else if (item.state === 'uploading') item.controller?.abort();
      }
      notify();
    },

    /** Cancel one item: abort it if running, otherwise drop it from the queue. */
    cancel(id: string): void {
      const item = items.find((entry) => entry.id === id);
      if (!item) return;
      if (item.state === 'uploading') item.controller?.abort();
      else if (item.state === 'queued') item.state = 'cancelled';
      notify();
    },

    /** Re-queue one failed (or cancelled) item. */
    retry(id: string): void {
      const item = items.find((entry) => entry.id === id);
      if (!item) return;
      if (item.state !== 'failed' && item.state !== 'cancelled') return;
      item.state = 'queued';
      item.sentBytes = 0;
      item.error = null;
      item.attempt += 1;
      pump();
    },

    /** Re-queue every failed/cancelled item, preserving order. */
    retryAllFailed(): void {
      let touched = false;
      for (const item of items) {
        if (item.state === 'failed' || item.state === 'cancelled') {
          item.state = 'queued';
          item.sentBytes = 0;
          item.error = null;
          item.attempt += 1;
          touched = true;
        }
      }
      if (touched) pump();
    },

    /** Remove finished (done/cancelled/failed) items from the list. */
    clearFinished(): void {
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const state = items[i].state;
        if (state === 'done' || state === 'cancelled' || state === 'failed') items.splice(i, 1);
      }
      notify();
    },

    snapshot(): UploadQueueSnapshot {
      return buildSnapshot();
    },

    subscribe(listener: (snapshot: UploadQueueSnapshot) => void): () => void {
      listeners.add(listener);
      listener(buildSnapshot());
      return () => {
        listeners.delete(listener);
      };
    },

    /** Abort everything and detach listeners; the queue is unusable afterwards. */
    dispose(): void {
      disposed = true;
      for (const item of items) {
        if (item.state === 'uploading') item.controller?.abort();
        else if (item.state === 'queued') item.state = 'cancelled';
      }
      listeners.clear();
    },
  };
}

function toTask(item: UploadItem): UploadTask {
  return {
    absPath: item.absPath,
    workspaceId: item.workspaceId,
    folderId: item.folderId,
    prefix: item.prefix,
    name: item.name,
    contentType: item.contentType,
    sizeBytes: item.sizeBytes,
  };
}

function toPublicItem(item: InternalItem): UploadItem {
  const { controller: _controller, ...rest } = item;
  return rest;
}

function clampConcurrency(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_CONCURRENCY;
  return Math.min(64, Math.max(1, Math.floor(value as number)));
}
