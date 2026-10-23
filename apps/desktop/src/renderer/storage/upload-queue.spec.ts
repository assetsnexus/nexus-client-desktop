import { describe, expect, it } from 'vitest';
import {
  createUploadQueue,
  type UploadRunner,
  type UploadTask,
} from './upload-queue.js';

function task(overrides: Partial<UploadTask> = {}): UploadTask {
  return {
    absPath: '/tmp/a.txt',
    workspaceId: 'w1',
    folderId: null,
    prefix: '',
    name: 'a.txt',
    contentType: 'text/plain',
    sizeBytes: 100,
    ...overrides,
  };
}

/** A runner that never settles unless released, so we can observe concurrency. */
function gatedRunner() {
  const releases: Array<() => void> = [];
  let inFlight = 0;
  let peak = 0;
  const started: string[] = [];
  const runner: UploadRunner = async ({ task: t }) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    started.push(t.name);
    await new Promise<void>((resolve) => releases.push(resolve));
    inFlight -= 1;
    return { fileId: `file-${t.name}` };
  };
  return {
    runner,
    started,
    peak: () => peak,
    get inFlight() {
      return inFlight;
    },
    releaseOne: () => releases.shift()?.(),
    releaseAll: () => {
      while (releases.length) releases.shift()?.();
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createUploadQueue', () => {
  it('bounds concurrency to the configured worker count', async () => {
    const gate = gatedRunner();
    const queue = createUploadQueue({ runner: gate.runner, concurrency: 3 });
    queue.add(Array.from({ length: 10 }, (_, i) => task({ name: `f${i}.txt` })));

    await tick();
    expect(gate.inFlight).toBe(3);
    expect(gate.peak()).toBe(3);

    // Releasing one slot starts exactly one more (never more than the bound).
    gate.releaseAll();
    await tick();
    await tick();
    expect(gate.peak()).toBeLessThanOrEqual(3);

    gate.releaseAll();
    await tick();
    gate.releaseAll();
    await tick();
    // Anything still gated is still within the bound.
    expect(gate.inFlight).toBeLessThanOrEqual(3);
    gate.releaseAll();
  });

  it('handles hundreds of files without losing any', async () => {
    const gate = gatedRunner();
    const queue = createUploadQueue({ runner: gate.runner, concurrency: 5 });
    const tasks = Array.from({ length: 250 }, (_, i) => task({ name: `f${i}.txt`, sizeBytes: 1 }));
    queue.add(tasks);

    // Drain the queue in rounds, releasing everything each round.
    for (let i = 0; i < 60; i += 1) {
      gate.releaseAll();
      await tick();
    }

    const snap = queue.snapshot();
    expect(snap.items).toHaveLength(250);
    expect(snap.counts.done).toBe(250);
    expect(snap.counts.queued).toBe(0);
    expect(snap.active).toBe(false);
    expect(snap.totalBytes).toBe(250);
    expect(snap.sentBytes).toBe(250);
  });

  it('accepts late additions while uploads are in flight', async () => {
    const gate = gatedRunner();
    const queue = createUploadQueue({ runner: gate.runner, concurrency: 2 });
    queue.add([task({ name: 'a.txt' }), task({ name: 'b.txt' })]);
    await tick();
    expect(gate.inFlight).toBe(2);

    queue.add([task({ name: 'late.txt' })]);
    await tick();
    // The late item is queued, not run unbounded.
    expect(queue.snapshot().counts.queued + queue.snapshot().counts.uploading).toBe(3);
    expect(gate.inFlight).toBe(2);

    gate.releaseAll();
    await tick();
    gate.releaseAll();
    await tick();
    await tick();
    expect(queue.snapshot().counts.done).toBe(3);
  });

  it('isolates one failure so the rest still complete', async () => {
    const attempted: string[] = [];
    const runner: UploadRunner = async ({ task: t }) => {
      attempted.push(t.name);
      if (t.name === 'bad.txt') throw new Error('boom');
      return { fileId: t.name };
    };
    const queue = createUploadQueue({ runner, concurrency: 2 });
    queue.add([task({ name: 'a.txt' }), task({ name: 'bad.txt' }), task({ name: 'c.txt' })]);

    await tick();
    await tick();
    await tick();

    const snap = queue.snapshot();
    expect(attempted.sort()).toEqual(['a.txt', 'bad.txt', 'c.txt']);
    expect(snap.counts.done).toBe(2);
    expect(snap.counts.failed).toBe(1);
    const failed = snap.items.find((i) => i.state === 'failed');
    expect(failed?.name).toBe('bad.txt');
    expect(failed?.error).toBe('boom');
    expect(snap.active).toBe(false);
  });

  it('reports real byte progress through onProgress', async () => {
    const runner: UploadRunner = async ({ onProgress }) => {
      onProgress({ sentBytes: 25, totalBytes: 100, indeterminate: false });
      onProgress({ sentBytes: 50, totalBytes: 100, indeterminate: false });
      return {};
    };
    const queue = createUploadQueue({ runner, concurrency: 1 });
    let last = queue.snapshot();
    queue.subscribe((snap) => {
      last = snap;
    });
    queue.add([task({ sizeBytes: 100 })]);

    await tick();
    await tick();

    expect(last.counts.done).toBe(1);
    expect(last.sentBytes).toBe(100);
    expect(last.totalBytes).toBe(100);
  });

  it('flags indeterminate progress when the transport cannot count bytes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: UploadRunner = async ({ onProgress }) => {
      onProgress({ sentBytes: 0, totalBytes: 0, indeterminate: true });
      await gate;
      return {};
    };
    const queue = createUploadQueue({ runner, concurrency: 1 });
    queue.add([task({ sizeBytes: 4_000_000 })]);

    // The runner reported indeterminate before yielding; the row must reflect
    // that (an honest indeterminate bar, never a fake percentage).
    const mid = queue.snapshot();
    expect(mid.counts.uploading).toBe(1);
    expect(mid.indeterminate).toBe(true);
    expect(mid.sentBytes).toBe(0);

    release();
    await tick();
    expect(queue.snapshot().counts.done).toBe(1);
  });

  it('cancels in-flight work and drops the pending queue', async () => {
    const gate = gatedRunner();
    const queue = createUploadQueue({ runner: gate.runner, concurrency: 2 });
    queue.add([task({ name: 'a' }), task({ name: 'b' }), task({ name: 'c' }), task({ name: 'd' })]);
    await tick();
    expect(gate.inFlight).toBe(2);

    queue.cancelAll();
    gate.releaseAll();
    await tick();
    await tick();

    const snap = queue.snapshot();
    expect(snap.counts.cancelled).toBe(4);
    expect(snap.counts.done).toBe(0);
    expect(snap.active).toBe(false);
  });

  it('cancels a single item without touching the others', async () => {
    const gate = gatedRunner();
    const queue = createUploadQueue({ runner: gate.runner, concurrency: 2 });
    const ids = queue.add([task({ name: 'a' }), task({ name: 'b' }), task({ name: 'c' })]);
    await tick();

    queue.cancel(ids[0]);
    gate.releaseAll();
    await tick();
    gate.releaseAll();
    await tick();
    await tick();

    const snap = queue.snapshot();
    expect(snap.items.find((i) => i.id === ids[0])?.state).toBe('cancelled');
    expect(snap.items.find((i) => i.id === ids[1])?.state).toBe('done');
    expect(snap.items.find((i) => i.id === ids[2])?.state).toBe('done');
  });

  it('retries a failed item and only then succeeds', async () => {
    let fail = true;
    const runner: UploadRunner = async ({ task: t }) => {
      if (fail) throw new Error('transient');
      return { fileId: t.name };
    };
    const queue = createUploadQueue({ runner, concurrency: 1 });
    const [id] = queue.add([task({ name: 'a.txt' })]);

    await tick();
    expect(queue.snapshot().items[0].state).toBe('failed');

    fail = false;
    queue.retry(id);
    await tick();
    await tick();

    const item = queue.snapshot().items[0];
    expect(item.state).toBe('done');
    expect(item.attempt).toBe(2);
    expect(item.error).toBeNull();
  });

  it('retryAllFailed re-queues every failure', async () => {
    let fail = true;
    const runner: UploadRunner = async () => {
      if (fail) throw new Error('nope');
      return {};
    };
    const queue = createUploadQueue({ runner, concurrency: 4 });
    queue.add([task({ name: 'a' }), task({ name: 'b' })]);
    await tick();
    await tick();
    expect(queue.snapshot().counts.failed).toBe(2);

    fail = false;
    queue.retryAllFailed();
    await tick();
    await tick();
    expect(queue.snapshot().counts.done).toBe(2);
    expect(queue.snapshot().counts.failed).toBe(0);
  });

  it('accounts completed bytes as exactly the item size (no overcount)', async () => {
    const queue = createUploadQueue({ runner: async () => ({}), concurrency: 1 });
    queue.add([task({ name: 'a', sizeBytes: 100 }), task({ name: 'b', sizeBytes: 250 })]);
    await tick();
    await tick();
    const snap = queue.snapshot();
    expect(snap.counts.done).toBe(2);
    expect(snap.totalBytes).toBe(350);
    expect(snap.sentBytes).toBe(350);
    expect(snap.indeterminate).toBe(false);
  });
});

/**
 * Pins the disposal contract the `useStorageUploads` StrictMode bug tripped
 * over: once disposed, `add()` refuses to enqueue. This is the defensive
 * behavior that silently swallowed every upload when the hook disposed the
 * queue its surviving render still used — so the hook must dispose only on a
 * real unmount, never in a StrictMode-mountable effect cleanup.
 */
describe('createUploadQueue disposal contract', () => {
  it('add() returns enqueued ids while live', () => {
    const queue = createUploadQueue({ runner: async () => ({}), concurrency: 4 });
    const ids = queue.add([task({ name: 'a' })]);
    expect(ids).toHaveLength(1);
    expect(queue.snapshot().items).toHaveLength(1);
  });

  it('add() early-returns [] after dispose() (this is what no-op\'d the uploads)', () => {
    const queue = createUploadQueue({ runner: async () => ({}), concurrency: 4 });
    queue.dispose();
    expect(queue.add([task({ name: 'a' })])).toEqual([]);
    expect(queue.snapshot().items).toHaveLength(0);
  });

  it('dispose() drops queued items and cancels in-flight ones once they settle', async () => {
    const gate = gatedRunner();
    const queue = createUploadQueue({ runner: gate.runner, concurrency: 1 });
    queue.add([task({ name: 'a' }), task({ name: 'b' })]);
    await tick();
    expect(queue.snapshot().counts.uploading).toBe(1);

    // Dispose aborts the in-flight item and drops the still-queued one.
    queue.dispose();
    // The queued item is dropped immediately; the in-flight one flips to
    // cancelled once its aborted runner settles.
    expect(queue.snapshot().items.find((i) => i.name === 'b')?.state).toBe('cancelled');
    gate.releaseAll();
    await tick();
    const snap = queue.snapshot();
    expect(snap.counts.uploading).toBe(0);
    expect(snap.counts.cancelled).toBe(2);
  });
});
