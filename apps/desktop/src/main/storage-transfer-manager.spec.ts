import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createStorageTransferManager } from './storage-transfer-manager.js';

const dirs: string[] = [];
function tmpDir(prefix = 'nexus-tr-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A tiny HTTP origin that accepts a PUT and records how many bytes arrived. */
function putServer(): Promise<{ server: Server; url: () => string; received: () => number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    let received = 0;
    const server = createServer((req, res) => {
      if (req.method === 'PUT') {
        req.on('data', (c) => {
          received += c.length;
        });
        req.on('end', () => {
          res.statusCode = 200;
          res.end('ok');
        });
        return;
      }
      res.statusCode = 404;
      res.end('no');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        server,
        url: () => `http://127.0.0.1:${port}/put`,
        received: () => received,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

type SendFn = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;

/** A fake region: root + one nested folder, presign PUT/complete, presign GET. */
function fakeSender(opts: { presignPut: boolean; putUrl?: string }) {
  const folders: Array<{ id: string; name: string; parentFolderId: string | null }> = [];
  const commands: Array<{ command: string; payload: Record<string, unknown> }> = [];
  const send: SendFn = vi.fn(async (command, payload = {}) => {
    commands.push({ command, payload });
    switch (command) {
      case 'anx.storage.workspace.folder.list':
        return { ok: true, data: { items: folders.filter((f) => (f.parentFolderId ?? null) === (payload.parentFolderId ?? null)) } };
      case 'anx.storage.workspace.folder.create': {
        const created = { id: `fx-${payload.name}`, name: String(payload.name), parentFolderId: (payload.parentFolderId as string) ?? null };
        folders.push(created);
        return { ok: true, data: { folder: created } };
      }
      case 'anx.file.upload-init':
        return {
          ok: true,
          data: {
            fileId: 'file-1',
            storageKey: 'ops/file-1.bin',
            presignPut: opts.presignPut,
            url: opts.putUrl,
          },
        };
      case 'anx.storage.presign.put':
        return opts.putUrl ? { ok: true, data: { url: opts.putUrl } } : { ok: true, data: {} };
      case 'anx.file.upload-complete-presign':
        return { ok: true, data: { fileId: 'file-1' } };
      case 'anx.file.upload-complete':
        return { ok: true, data: { fileId: 'file-1' } };
      case 'anx.storage.presign.get':
        return { ok: true, data: { url: opts.putUrl } };
      default:
        return { ok: true, data: {} };
    }
  });
  return { send, commands };
}

const progress: Array<{ transferId: string; sentBytes: number; totalBytes: number; indeterminate: boolean }> = [];

function manager(send: SendFn, tempDir: string, overrides: Record<string, unknown> = {}) {
  progress.length = 0;
  return createStorageTransferManager({
    getSender: async () => ({ send }),
    getRegionUrl: () => 'https://127.0.0.1:3005',
    getWebContents: () =>
      ({
        isDestroyed: () => false,
        send: (_channel: string, payload: unknown) => progress.push(payload as never),
      }) as never,
    tempDir,
    ...overrides,
  });
}

describe('expandDrop', () => {
  it('recurses a directory and reports files relative to its root', () => {
    const root = tmpDir();
    mkdirSync(join(root, 'drop', 'nested'), { recursive: true });
    writeFileSync(join(root, 'drop', 'a.txt'), 'aaa');
    writeFileSync(join(root, 'drop', 'nested', 'b.bin'), 'bbbb');
    const loose = join(root, 'loose.md');
    writeFileSync(loose, 'x');

    const m = manager(fakeSender({ presignPut: false }).send, tmpDir());
    const out = m.expandDrop([join(root, 'drop'), loose]);

    const dir = out.entries.find((e) => e.isDirectory);
    expect(dir?.name).toBe('drop');
    expect(dir?.children?.map((c) => c.relPath).sort()).toEqual(['a.txt', 'nested/b.bin']);
    expect(dir?.children?.find((c) => c.relPath === 'a.txt')?.sizeBytes).toBe(3);

    const file = out.entries.find((e) => !e.isDirectory);
    expect(file).toMatchObject({ name: 'loose.md', isDirectory: false, sizeBytes: 1 });
  });

  it('flags a missing path instead of throwing', () => {
    const m = manager(fakeSender({ presignPut: false }).send, tmpDir());
    const out = m.expandDrop([join(tmpDir(), 'does-not-exist')]);
    expect(out.entries[0].error).toBe('unreadable');
  });
});

describe('uploadOne', () => {
  it('streams via presign-PUT with byte-accurate progress', async () => {
    const server = await putServer();
    const root = tmpDir();
    const file = join(root, 'big.bin');
    writeFileSync(file, Buffer.alloc(64 * 1024, 7));

    const { send, commands } = fakeSender({ presignPut: true, putUrl: server.url() });
    const m = manager(send, tmpDir());

    const result = await m.uploadOne({
      transferId: 't1',
      workspaceId: 'w1',
      folderId: null,
      prefix: '',
      name: 'big.bin',
      absPath: file,
      contentType: 'application/octet-stream',
      sizeBytes: 64 * 1024,
    });

    expect(result).toMatchObject({ ok: true, transport: 'stream', indeterminate: false, fileId: 'file-1' });
    expect(result.sentBytes).toBe(64 * 1024);
    // The server really received every byte.
    expect(server.received()).toBe(64 * 1024);
    // Progress was pushed and ended at the full size.
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toMatchObject({ transferId: 't1', sentBytes: 64 * 1024, indeterminate: false });
    expect(commands.some((c) => c.command === 'anx.storage.presign.put')).toBe(true);
    await server.close();
  });

  it('materializes nested prefixes as folders and passes the id to upload-init', async () => {
    const server = await putServer();
    const root = tmpDir();
    const file = join(root, 'f.bin');
    writeFileSync(file, 'hi');

    const { send, commands } = fakeSender({ presignPut: true, putUrl: server.url() });
    const m = manager(send, tmpDir());
    await m.uploadOne({
      transferId: 't2',
      workspaceId: 'w1',
      folderId: null,
      prefix: 'photos/2024',
      name: 'f.bin',
      absPath: file,
      contentType: 'application/octet-stream',
      sizeBytes: 2,
    });

    const created = commands.filter((c) => c.command === 'anx.storage.workspace.folder.create').map((c) => c.payload.name);
    expect(created).toEqual(['photos', '2024']);
    const init = commands.find((c) => c.command === 'anx.file.upload-init');
    expect(init?.payload.folderId).toBe('fx-2024');
    await server.close();
  });

  it('falls back to base64 and reports honestly indeterminate progress', async () => {
    const root = tmpDir();
    const file = join(root, 'small.txt');
    writeFileSync(file, 'hello');

    const { send, commands } = fakeSender({ presignPut: false });
    const m = manager(send, tmpDir());

    const result = await m.uploadOne({
      transferId: 't3',
      workspaceId: 'w1',
      folderId: null,
      prefix: '',
      name: 'small.txt',
      absPath: file,
      contentType: 'text/plain',
      sizeBytes: 5,
    });

    expect(result).toMatchObject({ ok: true, transport: 'buffer', indeterminate: true });
    // No fabricated percentage: the only push is an explicit indeterminate one.
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ transferId: 't3', indeterminate: true, sentBytes: 0 });
    const complete = commands.find((c) => c.command === 'anx.file.upload-complete');
    expect(Buffer.from(String(complete?.payload.base64Data), 'base64').toString('utf8')).toBe('hello');
  });

  it('reports a region failure as a per-file error, not a throw', async () => {
    const root = tmpDir();
    const file = join(root, 'x.txt');
    writeFileSync(file, 'x');
    const send: SendFn = async (command) => {
      if (command === 'anx.file.upload-init') {
        return { ok: false, responseCode: 403, errorObjects: [{ code: 'FORBIDDEN', message: 'no write' }] };
      }
      return { ok: true, data: {} };
    };
    const m = manager(send, tmpDir());
    const result = await m.uploadOne({
      transferId: 't4',
      workspaceId: 'w1',
      folderId: null,
      prefix: '',
      name: 'x.txt',
      absPath: file,
      contentType: 'text/plain',
      sizeBytes: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('FORBIDDEN');
  });

  it('cancels an in-flight stream and reports it as cancelled', async () => {
    // A server that never finishes the response keeps the PUT open.
    const server = createServer((req) => {
      req.on('data', () => {
        /* swallow, never end */
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const root = tmpDir();
    const file = join(root, 'slow.bin');
    writeFileSync(file, Buffer.alloc(256 * 1024, 1));

    const { send } = fakeSender({ presignPut: true, putUrl: `http://127.0.0.1:${port}/put` });
    const m = manager(send, tmpDir());
    const promise = m.uploadOne({
      transferId: 't5',
      workspaceId: 'w1',
      folderId: null,
      prefix: '',
      name: 'slow.bin',
      absPath: file,
      contentType: 'application/octet-stream',
      sizeBytes: 256 * 1024,
    });
    // Give the stream a moment to start, then cancel.
    await new Promise((r) => setTimeout(r, 20));
    expect(m.cancel('t5')).toEqual({ transferId: 't5', cancelled: true });
    const result = await promise;
    expect(result.cancelled).toBe(true);
    expect(m.activeCount()).toBe(0);
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe('saveFile / saveFilesToDir', () => {
  function httpFileServer(body: Buffer): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
    return new Promise((resolve) => {
      const server = createServer((_req, res) => {
        res.setHeader('content-type', 'application/octet-stream');
        res.end(body);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve({ server, url: `http://127.0.0.1:${port}/f`, close: () => new Promise<void>((r) => server.close(() => r())) });
      });
    });
  }

  it('streams a downloaded file to the chosen path', async () => {
    const payload = Buffer.from('downloaded-content');
    const origin = await httpFileServer(payload);
    const { send } = fakeSender({ presignPut: true, putUrl: origin.url });
    const m = manager(send, tmpDir());

    const target = join(tmpDir(), 'out.bin');
    const result = await m.saveFile('file-1', 'out.bin', async () => target);
    expect(result).toMatchObject({ saved: true, cancelled: false, bytes: payload.byteLength });
    expect(readFileSync(target).toString('utf8')).toBe('downloaded-content');
    await origin.close();
  });

  it('reports a cancelled save dialog without erroring', async () => {
    const m = manager(fakeSender({ presignPut: false }).send, tmpDir());
    const result = await m.saveFile('file-1', 'x.bin', async () => null);
    expect(result).toMatchObject({ saved: false, cancelled: true, path: null });
  });

  it('saves many files into a directory with collision-safe names', async () => {
    const origin = await httpFileServer(Buffer.from('dup'));
    const { send } = fakeSender({ presignPut: true, putUrl: origin.url });
    const m = manager(send, tmpDir());
    const targetDir = tmpDir();
    writeFileSync(join(targetDir, 'a.txt'), 'preexisting');

    const result = await m.saveFilesToDir(
      [
        { fileId: 'f1', name: 'a.txt' },
        { fileId: 'f2', name: 'a.txt' },
      ],
      async () => targetDir,
    );
    expect(result.saved).toBe(2);
    expect(result.dir).toBe(targetDir);
    // Existing file untouched; the two downloads got unique names.
    expect(readFileSync(join(targetDir, 'a.txt')).toString('utf8')).toBe('preexisting');
    expect(existsSync(join(targetDir, 'a (1).txt'))).toBe(true);
    expect(existsSync(join(targetDir, 'a (2).txt'))).toBe(true);
    await origin.close();
  });
});

/** A local origin that serves one fixed body for every GET. */
async function byteServer(body: Buffer) {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(body.byteLength));
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/obj`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** The exact body MinIO returns for a missing object (see the storage drill). */
const S3_NO_SUCH_KEY =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message>' +
  '<Key>chat-attachment/1789386413041-mus85vk0m.jpg</Key>' +
  '<BucketName>anx-eu-west-free-tier</BucketName></Error>';

/** A real, valid 8x8 PNG (its magic bytes satisfy the payload guard). */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJUlEQVR42u3NMQEAAAgDoC251a1g' +
    'D0hgblXVvXsAAAAAAAAAAADAzwEfZQABq3VKzQAAAABJRU5ErkJggg==',
  'base64',
);
/** Real magic-byte-correct stand-ins so a name/extension matches its bytes. */
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-probe-bytes'.repeat(4))]);
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Size 1>>\n%%EOF\n', 'utf8');

/**
 * A `Send` whose `anx.storage.presign.get` points at a throwaway local HTTP
 * origin that answers every GET with `handler`. Lets a spec serve an XML error
 * body (or a real image) without a live region.
 */
async function presignGetTo(handler: (res: ServerResponse) => void): Promise<SendFn> {
  const server = createServer((_req, res) => handler(res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/obj`;
  return async (command: string) =>
    command === 'anx.storage.presign.get' ? { ok: true, data: { url } } : { ok: true, data: {} };
}

describe('drag staging', () => {
  it('stages a temp file, starts a drag through the driver, then cleans up', async () => {
    const origin = await new Promise<{ server: Server; url: string; close: () => Promise<void> }>((resolve) => {
      const server = createServer((_req, res) => res.end('drag-me'));
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve({ server, url: `http://127.0.0.1:${port}/f`, close: () => new Promise<void>((r) => server.close(() => r())) });
      });
    });
    const { send } = fakeSender({ presignPut: true, putUrl: origin.url });
    const m = manager(send, tmpDir('nexus-drag-'));

    const prepared = await m.prepareDrag('file-1', 'note.txt');
    expect(prepared.path).toBeTruthy();
    expect(existsSync(prepared.path!)).toBe(true);

    const started: Array<{ file: string; icon: unknown }> = [];
    const ok = m.startDrag('file-1', { startDrag: (item) => started.push(item), icon: 'icon' });
    expect(ok).toBe(true);
    expect(started[0].file).toBe(prepared.path);

    m.releaseDrag('file-1');
    expect(existsSync(prepared.path!)).toBe(false);
    await origin.close();
  });

  /**
   * The reported bug: the OS-visible drop name is the **basename** of the path
   * handed to `webContents.startDrag`. These cases assert the staged basename
   * really is the file's own name (so the drop can never land as a generic
   * `dropped text.txt`), and that the staged bytes equal the source bytes.
   */
  const names: Array<{ label: string; name: string; bytes: Buffer }> = [
    { label: 'real name + extension', name: 'ai_dragon.jpg', bytes: JPEG_BYTES },
    { label: 'no extension', name: 'README', bytes: Buffer.from('plain readme bytes') },
    { label: 'spaces', name: 'PV array 6 modules.png', bytes: PNG_BYTES },
    { label: 'unicode', name: 'café-münchen-ファイル.pdf', bytes: PDF_BYTES },
    { label: 'leading dot in stem', name: 'v1.2.3.tar.gz', bytes: Buffer.from('gzip-ish bytes') },
  ];

  for (const { label, name, bytes } of names) {
    it(`stages basename + bytes faithfully for ${label}`, async () => {
      // Bytes are magic-correct for the extension, so the payload guard accepts
      // them and these cases keep testing name fidelity, not content sniffing.
      const payload = bytes;
      const origin = await byteServer(payload);
      const { send } = fakeSender({ presignPut: true, putUrl: origin.url });
      const root = tmpDir('nexus-drag-');
      const m = manager(send, root);

      const prepared = await m.prepareDrag('file-1', name);
      expect(prepared.path).toBeTruthy();
      // The dropped file is named exactly after the real file...
      expect(basename(prepared.path!)).toBe(name);
      // ...inside its own directory (so same-named files never collide)...
      expect(dirname(prepared.path!)).not.toBe(root);
      // ...and holds the real bytes, not the file name as text.
      const onDisk = readFileSync(prepared.path!);
      expect(sha256(onDisk)).toBe(sha256(payload));
      expect(onDisk.toString('utf8')).not.toBe(name);

      // startDrag gets that exact path; the OS shows its basename.
      const started: Array<{ file: string; icon: unknown }> = [];
      expect(m.startDrag('file-1', { startDrag: (i) => started.push(i), icon: 'icon' })).toBe(true);
      expect(started).toHaveLength(1);
      expect(started[0].file).toBe(prepared.path);

      m.releaseDrag('file-1');
      expect(existsSync(prepared.path!)).toBe(false);
      // No orphan temp directory is left behind after release.
      expect(existsSync(dirname(prepared.path!))).toBe(false);
      await origin.close();
    });
  }

  it('keeps same-named files apart and never renames the dragged file', async () => {
    const origin = await byteServer(PDF_BYTES);
    const { send } = fakeSender({ presignPut: true, putUrl: origin.url });
    const m = manager(send, tmpDir('nexus-drag-'));

    const a = await m.prepareDrag('f1', 'report.pdf');
    const b = await m.prepareDrag('f2', 'report.pdf');
    expect(a.path).not.toBe(b.path);
    expect(basename(a.path!)).toBe('report.pdf');
    expect(basename(b.path!)).toBe('report.pdf');
    // Distinct private dirs, so neither copy can overwrite the other.
    expect(dirname(a.path!)).not.toBe(dirname(b.path!));

    m.releaseDrag('f1');
    m.releaseDrag('f2');
    expect(existsSync(a.path!)).toBe(false);
    expect(existsSync(b.path!)).toBe(false);
    await origin.close();
  });

  it('sanitises a hostile name into a safe basename inside the staging dir', async () => {
    const origin = await byteServer(Buffer.from('safe'));
    const { send } = fakeSender({ presignPut: true, putUrl: origin.url });
    const root = tmpDir('nexus-drag-');
    const m = manager(send, root);

    const prepared = await m.prepareDrag('file-1', '../../etc/passwd.txt');
    expect(prepared.path).toBeTruthy();
    expect(basename(prepared.path!)).toBe('passwd.txt');
    expect(prepared.path!.startsWith(root)).toBe(true);

    m.releaseDrag('file-1');
    await origin.close();
  });

  it('falls back to a neutral name when the region name has no usable basename', async () => {
    const origin = await byteServer(Buffer.from('x'));
    const { send } = fakeSender({ presignPut: true, putUrl: origin.url });
    const m = manager(send, tmpDir('nexus-drag-'));

    const prepared = await m.prepareDrag('file-1', '   ');
    expect(basename(prepared.path!)).toBe('file');
    m.releaseDrag('file-1');
    await origin.close();
  });

  it('reuses an already-staged copy instead of downloading twice', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.end('once');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const { send } = fakeSender({ presignPut: true, putUrl: `http://127.0.0.1:${port}/o` });
    const m = manager(send, tmpDir('nexus-drag-'));

    const first = await m.prepareDrag('file-1', 'warm.txt');
    const second = await m.prepareDrag('file-1', 'warm.txt');
    expect(second.path).toBe(first.path);
    expect(hits).toBe(1);

    m.releaseDrag('file-1');
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('reports a staging error and leaves no partial temp dir behind', async () => {
    const { send } = fakeSender({ presignPut: true, putUrl: 'http://127.0.0.1:1/nope' });
    const root = tmpDir('nexus-drag-');
    const m = manager(send, root);
    const prepared = await m.prepareDrag('file-1', 'broken.bin');
    expect(prepared.path).toBeNull();
    expect(prepared.error).toBeTruthy();
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses to start a drag for a file that was never staged', () => {
    const m = manager(fakeSender({ presignPut: false }).send, tmpDir());
    expect(m.startDrag('nope', { startDrag: () => undefined, icon: null })).toBe(false);
  });

  it('sweeps orphan staging dirs from a previous process at startup', () => {
    const root = tmpDir('nexus-drag-');
    const stale = join(root, 'stale-orphan');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'leftover.txt'), 'from a crash');
    const old = Date.now() / 1000 - 3 * 60 * 60;
    utimesSync(stale, old, old);

    manager(fakeSender({ presignPut: false }).send, tmpDir(), { tempDir: root });
    expect(existsSync(stale)).toBe(false);
    // The root itself survives so the next staging has somewhere to land.
    expect(existsSync(root)).toBe(true);
  });
});

describe('readBytesForPreview', () => {
  it('returns the real bytes, base64-encoded, with the served content type', async () => {
    const payload = Buffer.from('preview-me-'.repeat(32));
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'image/png');
      res.end(payload);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const { send } = fakeSender({ presignPut: true, putUrl: `http://127.0.0.1:${port}/img` });
    const m = manager(send, tmpDir());

    const result = await m.readBytesForPreview('file-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contentType).toBe('image/png');
      expect(Buffer.from(result.base64, 'base64')).toEqual(payload);
      expect(result.sizeBytes).toBe(payload.byteLength);
    }
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('refuses a file above the byte cap without buffering it', async () => {
    const payload = Buffer.alloc(4096, 3);
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/pdf');
      res.setHeader('content-length', String(payload.byteLength));
      res.end(payload);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const { send } = fakeSender({ presignPut: true, putUrl: `http://127.0.0.1:${port}/big` });
    const m = manager(send, tmpDir());

    const result = await m.readBytesForPreview('file-1', { maxBytes: 1024 });
    expect(result).toEqual({ ok: false, tooLarge: true });
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('reports a transport failure instead of throwing', async () => {
    const { send } = fakeSender({ presignPut: true, putUrl: 'http://127.0.0.1:1/none' });
    const m = manager(send, tmpDir());
    const result = await m.readBytesForPreview('file-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
  });

  it('reports a failing presign command as an error, not a crash', async () => {
    const send: SendFn = async () => ({ ok: false, responseCode: 500, message: 'boom' });
    const m = manager(send, tmpDir());
    const result = await m.readBytesForPreview('file-1');
    expect(result.ok).toBe(false);
  });

  it('refuses an S3 XML error body served for an image (never renders it)', async () => {
    const send = await presignGetTo(async (res) => {
      res.setHeader('content-type', 'application/xml');
      res.end(S3_NO_SUCH_KEY);
    });
    const m = manager(send, tmpDir());
    const result = await m.readBytesForPreview('file-1', { fallbackType: 'image/jpeg' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('NoSuchKey');
  });

  it('refuses an error body even when the host lies with 200 + content-type: image/jpeg', async () => {
    const send = await presignGetTo(async (res) => {
      res.setHeader('content-type', 'image/jpeg');
      res.end(S3_NO_SUCH_KEY);
    });
    const m = manager(send, tmpDir());
    const result = await m.readBytesForPreview('file-1', { fallbackType: 'image/jpeg' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('NoSuchKey');
  });

  it('refuses a zero-length body for a typed file but still accepts real bytes', async () => {
    const send = await presignGetTo(async (res) => {
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.alloc(0));
    });
    const m = manager(send, tmpDir());
    const empty = await m.readBytesForPreview('file-1', { fallbackType: 'image/png' });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain('empty');

    const realSend = await presignGetTo(async (res) => {
      res.setHeader('content-type', 'image/png');
      res.end(PNG_BYTES);
    });
    const ok = await manager(realSend, tmpDir()).readBytesForPreview('file-1', { fallbackType: 'image/png' });
    expect(ok.ok).toBe(true);
  });
});

describe('download/save payload guard', () => {
  it('does not write an S3 error body to disk as the user file', async () => {
    const send = await presignGetTo(async (res) => {
      res.setHeader('content-type', 'application/xml');
      res.end(S3_NO_SUCH_KEY);
    });
    const m = manager(send, tmpDir());
    const dir = tmpDir();
    const target = join(dir, 'dragon.jpg');
    const result = await m.saveFile('file-1', 'dragon.jpg', async () => target);
    expect(result.saved).toBe(false);
    expect(result.error).toContain('NoSuchKey');
    expect(existsSync(target)).toBe(false);
    // No internal temp artifact left behind either.
    expect(readdirSync(dir)).toEqual([]);
  });

  it('does not stage an S3 error body for a drag-out', async () => {
    const send = await presignGetTo(async (res) => {
      res.setHeader('content-type', 'application/xml');
      res.end(S3_NO_SUCH_KEY);
    });
    const m = manager(send, tmpDir('nexus-drag-guard-'));
    const prepared = await m.prepareDrag('file-1', 'dragon.jpg');
    expect(prepared.path).toBeNull();
    expect(prepared.error).toContain('NoSuchKey');
  });

  it('still writes real image bytes to disk', async () => {
    const send = await presignGetTo(async (res) => {
      res.setHeader('content-type', 'image/png');
      res.end(PNG_BYTES);
    });
    const m = manager(send, tmpDir());
    const target = join(tmpDir(), 'real.png');
    const result = await m.saveFile('file-1', 'real.png', async () => target);
    expect(result).toMatchObject({ saved: true, bytes: PNG_BYTES.byteLength });
    expect(readFileSync(target)).toEqual(PNG_BYTES);
  });
});
