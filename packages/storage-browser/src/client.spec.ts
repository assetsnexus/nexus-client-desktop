import { describe, expect, it, vi } from 'vitest';
import {
  StorageCommandError,
  bytesToBase64,
  createStorageClient,
  envelopeFailed,
  parseFileRecord,
  toCollectionItemRef,
  unwrapEnvelope,
} from './client.js';

const sender = (map: Record<string, unknown>) =>
  vi.fn(async (command: string) => {
    if (!(command in map)) throw new Error(`unexpected command ${command}`);
    return map[command];
  });

describe('unwrapEnvelope', () => {
  it('prefers responseObject then data then the raw object', () => {
    expect(unwrapEnvelope({ responseObject: { a: 1 } })).toEqual({ a: 1 });
    expect(unwrapEnvelope({ data: { b: 2 } })).toEqual({ b: 2 });
    expect(unwrapEnvelope({ c: 3 })).toEqual({ c: 3 });
  });
});

describe('envelopeFailed', () => {
  it('treats ok:false as failure and reads code/message', () => {
    expect(envelopeFailed({ ok: false, code: 'X', message: 'nope' })).toEqual({
      failed: true,
      code: 'X',
      message: 'nope',
    });
  });

  it('treats a non-2xx responseCode as failure and reads the first error object', () => {
    const out = envelopeFailed({
      responseCode: 403,
      errorObjects: [{ code: 'FORBIDDEN', message: 'denied' }],
    });
    expect(out.failed).toBe(true);
    expect(out.code).toBe('FORBIDDEN');
    expect(out.message).toBe('denied');
  });

  it('passes a 200 envelope', () => {
    expect(envelopeFailed({ responseCode: 200, responseObject: {} }).failed).toBe(false);
  });
});

describe('parseFileRecord + toCollectionItemRef', () => {
  it('maps the region file record shape', () => {
    const file = parseFileRecord({
      _id: 'f1',
      originalName: 'report.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1234,
      status: 'ready',
      workspaceId: 'w1',
      folderId: 'd1',
      encryptionTier: 'org',
      createdAt: '2026-01-01T00:00:00.000Z',
      revisionNo: 3,
    });
    expect(file).toMatchObject({
      id: 'f1',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1234,
      revisionNo: 3,
    });
    expect(toCollectionItemRef(file)).toMatchObject({
      id: 'f1',
      kind: 'file',
      source: 'storage_bucket',
      label: 'report.pdf',
      revisionNo: 3,
    });
  });

  it('falls back to safe defaults', () => {
    expect(parseFileRecord({})).toMatchObject({
      id: '',
      name: 'file',
      mimeType: 'application/octet-stream',
      sizeBytes: 0,
    });
  });
});

describe('listBucketFiles', () => {
  it('parses a page and passes filters', async () => {
    const send = sender({
      'anx.storage.bucket.list-files': {
        responseCode: 200,
        responseObject: {
          items: [{ _id: 'f1', originalName: 'a.txt', status: 'ready' }],
          total: 1,
          nextCursor: 'cursor-2',
          encryptionSummary: { org: 1 },
        },
      },
    });
    const client = createStorageClient(send as never);
    const page = await client.listBucketFiles({ workspaceId: 'w1', search: 'a', limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('cursor-2');
    expect(page.encryptionSummary).toEqual({ org: 1 });
    expect(send).toHaveBeenCalledWith('anx.storage.bucket.list-files', {
      workspaceId: 'w1',
      search: 'a',
      limit: 10,
    });
  });

  it('throws a typed error on envelope failure', async () => {
    const send = sender({
      'anx.storage.bucket.list-files': {
        responseCode: 403,
        errorObjects: [{ code: 'FORBIDDEN', message: 'nope' }],
      },
    });
    const client = createStorageClient(send as never);
    await expect(client.listBucketFiles({ workspaceId: 'w1' })).rejects.toBeInstanceOf(
      StorageCommandError,
    );
  });
});

describe('listWorkspaces / listContracts', () => {
  it('parses workspaces from items', async () => {
    const send = sender({
      'anx.storage.workspace.list': {
        responseCode: 200,
        responseObject: { items: [{ _id: 'w1', name: 'My Storage', memberUserIds: ['u1'] }] },
      },
    });
    const client = createStorageClient(send as never);
    const rows = await client.listWorkspaces();
    expect(rows[0]).toMatchObject({ id: 'w1', name: 'My Storage', memberUserIds: ['u1'] });
  });

  it('parses contracts and flags the free tier', async () => {
    const send = sender({
      'anx.storage.contracts.list-mine': {
        responseCode: 200,
        responseObject: { contracts: [{ _id: 'c1', kind: 'user', isFreeTier: true, region: 'eu-west' }] },
      },
    });
    const client = createStorageClient(send as never);
    const rows = await client.listContracts();
    expect(rows[0]).toMatchObject({ id: 'c1', kind: 'user', isFreeTier: true });
  });
});

describe('backendCapabilities', () => {
  it('reads the capability matrix with safe defaults', async () => {
    const send = sender({
      'anx.storage.backend.capabilities': {
        responseCode: 200,
        responseObject: { capability: { presignPut: false, presignGet: true, read: true } },
      },
    });
    const client = createStorageClient(send as never);
    const caps = await client.backendCapabilities('local');
    expect(caps.presignPut).toBe(false);
    expect(caps.presignGet).toBe(true);
    expect(caps.read).toBe(true);
    expect(send).toHaveBeenCalledWith('anx.storage.backend.capabilities', { kind: 'local' });
  });
});

describe('upload', () => {
  it('uses presign-PUT + upload-complete-presign when the backend supports it', async () => {
    const put = vi.fn(async () => ({ ok: true, status: 200 }));
    const send = sender({
      'anx.file.upload-init': {
        responseCode: 200,
        responseObject: { fileId: 'f1', presignPut: true, presignUrl: 'https://s3/put' },
      },
      'anx.file.upload-complete-presign': {
        responseCode: 200,
        responseObject: { file: { _id: 'f1', originalName: 'x.bin', status: 'ready' } },
      },
    });
    const client = createStorageClient(send as never);
    const file = await client.upload({
      workspaceId: 'w1',
      name: 'x.bin',
      contentType: 'application/octet-stream',
      bytes: new Uint8Array([1, 2, 3]),
      fetchFn: put as unknown as typeof fetch,
    });
    expect(put).toHaveBeenCalledWith('https://s3/put', expect.objectContaining({ method: 'PUT' }));
    expect(send).toHaveBeenCalledWith('anx.file.upload-complete-presign', expect.anything());
    expect(file.id).toBe('f1');
  });

  it('falls back to base64 upload-complete when presignPut is false', async () => {
    const send = sender({
      'anx.file.upload-init': {
        responseCode: 200,
        responseObject: { fileId: 'f2', presignPut: false },
      },
      'anx.file.upload-complete': {
        responseCode: 200,
        responseObject: { file: { _id: 'f2', originalName: 'y.bin', status: 'ready' } },
      },
    });
    const client = createStorageClient(send as never);
    const file = await client.upload({
      workspaceId: 'w1',
      name: 'y.bin',
      contentType: 'application/octet-stream',
      bytes: new Uint8Array([9, 9]),
    });
    expect(send).toHaveBeenCalledWith('anx.file.upload-complete', {
      fileId: 'f2',
      base64Data: 'CQk=',
    });
    expect(file.id).toBe('f2');
  });

  it('throws when the presigned PUT fails', async () => {
    const put = vi.fn(async () => ({ ok: false, status: 500 }));
    const send = sender({
      'anx.file.upload-init': {
        responseCode: 200,
        responseObject: { fileId: 'f3', presignPut: true, presignUrl: 'https://s3/put' },
      },
    });
    const client = createStorageClient(send as never);
    await expect(
      client.upload({
        name: 'z.bin',
        contentType: 'application/octet-stream',
        bytes: new Uint8Array([1]),
        fetchFn: put as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/presigned PUT failed/);
  });
});

describe('resolveDownloadUrl', () => {
  it('returns a presigned URL when available', async () => {
    const send = sender({
      'anx.storage.presign.get': {
        responseCode: 200,
        responseObject: { url: 'https://s3/get' },
      },
    });
    const client = createStorageClient(send as never);
    expect(await client.resolveDownloadUrl({ fileId: 'f1', regionBaseUrl: 'https://r' })).toEqual({
      url: 'https://s3/get',
      presigned: true,
    });
  });

  it('falls back to the region proxy when the backend cannot presign', async () => {
    const send = sender({
      'anx.storage.presign.get': {
        responseCode: 400,
        errorObjects: [{ code: 'STORAGE_CAPABILITY_UNSUPPORTED', message: 'no presignGet' }],
      },
    });
    const client = createStorageClient(send as never);
    expect(
      await client.resolveDownloadUrl({ fileId: 'f1', regionBaseUrl: 'https://r/' }),
    ).toEqual({ url: 'https://r/files/f1', presigned: false });
  });
});

describe('file operations', () => {
  it('rename / move / copy / trash / restore send the right commands', async () => {
    const send = sender({
      'anx.storage.bucket.rename-file': { responseCode: 200, responseObject: { ok: true } },
      'anx.storage.bucket.move-file': { responseCode: 200, responseObject: { ok: true } },
      'anx.storage.bucket.copy-file': { responseCode: 200, responseObject: { ok: true } },
      'anx.storage.bucket.trash-file': { responseCode: 200, responseObject: { ok: true } },
      'anx.storage.bucket.restore-file': { responseCode: 200, responseObject: { ok: true } },
    });
    const client = createStorageClient(send as never);
    await client.renameFile('f1', 'new.txt');
    await client.moveFile({ fileId: 'f1', targetFolderId: 'd2' });
    await client.copyFile({ fileId: 'f1' });
    await client.trashFile('f1');
    await client.restoreFile('f1');
    expect(send).toHaveBeenCalledWith('anx.storage.bucket.rename-file', {
      fileId: 'f1',
      newName: 'new.txt',
    });
    expect(send).toHaveBeenCalledWith('anx.storage.bucket.trash-file', { fileId: 'f1' });
  });

  it('listTrash filters status=deleted', async () => {
    const send = sender({
      'anx.storage.bucket.list-files': {
        responseCode: 200,
        responseObject: { items: [] },
      },
    });
    const client = createStorageClient(send as never);
    await client.listTrash({ workspaceId: 'w1' });
    expect(send).toHaveBeenCalledWith(
      'anx.storage.bucket.list-files',
      expect.objectContaining({ status: 'deleted' }),
    );
  });
});

describe('bytesToBase64', () => {
  it('encodes bytes', () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
  });
});
