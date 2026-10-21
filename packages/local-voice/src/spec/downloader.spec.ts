import { describe, expect, it } from 'vitest';
import { buildDownloadPlan } from '../download.js';
import { parseLocalVoiceModel } from '../catalog.js';
import {
  runDownloadPlan,
  type DownloadFetchAdapter,
  type DownloadFsAdapter,
} from '../downloader.js';

function memoryFs(): DownloadFsAdapter & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    sizeOf: async (p) => files.get(p)?.byteLength ?? 0,
    appendChunk: async (p, chunk) => {
      const cur = files.get(p) ?? new Uint8Array(0);
      const next = new Uint8Array(cur.byteLength + chunk.byteLength);
      next.set(cur, 0);
      next.set(chunk, cur.byteLength);
      files.set(p, next);
    },
    resetPartial: async (p) => {
      files.delete(p);
    },
    commit: async (from, to) => {
      const data = files.get(from);
      if (!data) throw new Error(`missing ${from}`);
      files.set(to, data);
      files.delete(from);
    },
    remove: async (p) => {
      files.delete(p);
    },
    ensureDir: async () => {},
  };
}

/**
 * A fetch adapter streaming a body in fixed-size chunks. Honors a Range request
 * (starts at the offset) unless `acceptRange` is false, in which case it always
 * serves from 0 — mirroring a server that ignores `Range`.
 */
function streamingFetch(
  bodies: Record<string, Uint8Array>,
  opts: { acceptRange?: boolean; status?: number; chunkSize?: number } = {},
): DownloadFetchAdapter {
  const chunkSize = opts.chunkSize ?? 2;
  return async (url, init) => {
    if (opts.status && opts.status >= 400) {
      return { ok: false, status: opts.status, contentLength: null, acceptedRange: false, body: null };
    }
    const body = bodies[url];
    if (!body) {
      return { ok: false, status: 404, contentLength: null, acceptedRange: false, body: null };
    }
    let start = 0;
    const range = init.headers.Range;
    if (range && opts.acceptRange !== false) {
      start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
    }
    const slice = body.slice(start);
    async function* stream() {
      for (let i = 0; i < slice.byteLength; i += chunkSize) {
        yield slice.slice(i, i + chunkSize);
      }
    }
    return {
      ok: true,
      status: 200,
      contentLength: slice.byteLength,
      acceptedRange: Boolean(range) && opts.acceptRange !== false,
      body: stream(),
    };
  };
}

function twoFileModel() {
  return parseLocalVoiceModel({
    id: 'whisper',
    category: 'stt',
    files: [
      { name: 'a.bin', url: 'https://x/a.bin', sizeBytes: 6 },
      { name: 'b.txt', url: 'https://x/b.txt', sizeBytes: 4 },
    ],
  })!;
}

const A = new Uint8Array([1, 2, 3, 4, 5, 6]);
const B = new Uint8Array([7, 8, 9, 10]);

describe('runDownloadPlan', () => {
  it('downloads every file and commits on completion', async () => {
    const plan = buildDownloadPlan(twoFileModel());
    const fs = memoryFs();
    const result = await runDownloadPlan({
      plan,
      targetDir: '/root',
      fs,
      fetchFn: streamingFetch({ 'https://x/a.bin': A, 'https://x/b.txt': B }),
    });
    expect(result.ok).toBe(true);
    expect(result.completed).toEqual(['catalog_whisper/a.bin', 'catalog_whisper/b.txt']);
    expect(fs.files.get('/root/catalog_whisper/a.bin')?.byteLength).toBe(6);
    expect(fs.files.get('/root/catalog_whisper/b.txt')?.byteLength).toBe(4);
  });

  it('reports aggregate and per-file progress', async () => {
    const plan = buildDownloadPlan(twoFileModel());
    const written: number[] = [];
    await runDownloadPlan({
      plan,
      targetDir: '/root',
      fs: memoryFs(),
      fetchFn: streamingFetch({ 'https://x/a.bin': A, 'https://x/b.txt': B }),
      onProgress: (e) => written.push(e.totalBytesWritten),
    });
    // 2-byte chunks: a.bin → 2,4,6 then b.txt → 8,10.
    expect(written).toEqual([2, 4, 6, 8, 10]);
  });

  it('resumes a partial file via a Range request', async () => {
    const plan = buildDownloadPlan(twoFileModel(), { existingBytes: { 'catalog_whisper/a.bin': 3 } });
    const fs = memoryFs();
    fs.files.set('/root/catalog_whisper/a.bin.part', new Uint8Array([1, 2, 3]));
    const result = await runDownloadPlan({
      plan,
      targetDir: '/root',
      fs,
      fetchFn: streamingFetch({ 'https://x/a.bin': A, 'https://x/b.txt': B }),
    });
    expect(result.ok).toBe(true);
    expect([...fs.files.get('/root/catalog_whisper/a.bin')!]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('resets the partial when the server ignores the Range request', async () => {
    const plan = buildDownloadPlan(twoFileModel(), { existingBytes: { 'catalog_whisper/a.bin': 3 } });
    const fs = memoryFs();
    fs.files.set('/root/catalog_whisper/a.bin.part', new Uint8Array([9, 9, 9]));
    const result = await runDownloadPlan({
      plan,
      targetDir: '/root',
      fs,
      fetchFn: streamingFetch({ 'https://x/a.bin': A, 'https://x/b.txt': B }, { acceptRange: false }),
    });
    expect(result.ok).toBe(true);
    expect([...fs.files.get('/root/catalog_whisper/a.bin')!]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('skips files already complete', async () => {
    const plan = buildDownloadPlan(twoFileModel(), {
      existingBytes: { 'catalog_whisper/a.bin': 6, 'catalog_whisper/b.txt': 4 },
    });
    let called = 0;
    const result = await runDownloadPlan({
      plan,
      targetDir: '/root',
      fs: memoryFs(),
      fetchFn: async () => {
        called += 1;
        return { ok: true, status: 200, contentLength: 0, acceptedRange: false, body: null };
      },
    });
    expect(called).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.completed).toHaveLength(2);
  });

  it('fails (not throws) on an HTTP error', async () => {
    const result = await runDownloadPlan({
      plan: buildDownloadPlan(twoFileModel()),
      targetDir: '/root',
      fs: memoryFs(),
      fetchFn: streamingFetch({}, { status: 500 }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTTP 500/);
  });

  it('reports cancellation without committing', async () => {
    const fs = memoryFs();
    const controller = new AbortController();
    const result = await runDownloadPlan({
      plan: buildDownloadPlan(twoFileModel()),
      targetDir: '/root',
      fs,
      fetchFn: streamingFetch({ 'https://x/a.bin': A, 'https://x/b.txt': B }),
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    expect(result.cancelled).toBe(true);
    expect(fs.files.has('/root/catalog_whisper/a.bin')).toBe(false);
    // The partial is kept so a retry can resume.
    expect(fs.files.has('/root/catalog_whisper/a.bin.part')).toBe(true);
  });

  it('keeps the .part file when the checksum mismatches', async () => {
    const model = parseLocalVoiceModel({
      id: 'hashed',
      category: 'stt',
      files: [{ name: 'm.bin', url: 'https://x/m.bin', sizeBytes: 3, sha256: 'deadbeef' }],
    })!;
    const fs = memoryFs();
    const result = await runDownloadPlan({
      plan: buildDownloadPlan(model),
      targetDir: '/root',
      fs,
      fetchFn: streamingFetch({ 'https://x/m.bin': new Uint8Array([1, 2, 3]) }),
      sha256: async () => 'not-deadbeef',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/checksum/);
    expect(fs.files.has('/root/catalog_hashed/m.bin.part')).toBe(true);
    expect(fs.files.has('/root/catalog_hashed/m.bin')).toBe(false);
  });

  it('commits when the checksum matches (case-insensitive)', async () => {
    const model = parseLocalVoiceModel({
      id: 'hashed',
      category: 'stt',
      files: [{ name: 'm.bin', url: 'https://x/m.bin', sizeBytes: 3, sha256: 'abc123' }],
    })!;
    const fs = memoryFs();
    const result = await runDownloadPlan({
      plan: buildDownloadPlan(model),
      targetDir: '/root',
      fs,
      fetchFn: streamingFetch({ 'https://x/m.bin': new Uint8Array([1, 2, 3]) }),
      sha256: async () => 'ABC123',
    });
    expect(result.ok).toBe(true);
    expect(fs.files.has('/root/catalog_hashed/m.bin')).toBe(true);
  });
});
