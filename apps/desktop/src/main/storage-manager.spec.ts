import { describe, expect, it, vi } from 'vitest';
import { createStorageManager } from './storage-manager.js';

function senderReturning(map: Record<string, unknown>) {
  const send = vi.fn(async (command: string) => {
    if (!(command in map)) throw new Error(`unexpected command ${command}`);
    return map[command];
  });
  return { send };
}

function managerWith(map: Record<string, unknown>) {
  const sender = senderReturning(map);
  const manager = createStorageManager({
    getSender: async () => sender,
    getRegionUrl: () => 'https://region.test',
  });
  return { manager, sender };
}

describe('createStorageManager', () => {
  it('maps workspaces to serializable rows', async () => {
    const { manager } = managerWith({
      'anx.storage.workspace.list': {
        responseCode: 200,
        responseObject: { items: [{ _id: 'w1', name: 'Docs', memberUserIds: ['u1'], ownerUserId: 'u1' }] },
      },
    });
    const rows = await manager.workspaces();
    expect(rows).toEqual([
      { id: 'w1', name: 'Docs', ownerUserId: 'u1', orgId: null, memberUserIds: ['u1'] },
    ]);
  });

  it('maps files and passes a status filter for trash', async () => {
    const { manager, sender } = managerWith({
      'anx.storage.bucket.list-files': {
        responseCode: 200,
        responseObject: { items: [{ _id: 'f1', originalName: 'a.txt', sizeBytes: 10 }], total: 1 },
      },
    });
    const page = await manager.listFiles({ workspaceId: 'w1', status: 'deleted' });
    expect(page.items[0]).toMatchObject({ id: 'f1', name: 'a.txt', sizeBytes: 10 });
    expect(sender.send).toHaveBeenCalledWith(
      'anx.storage.bucket.list-files',
      expect.objectContaining({ status: 'deleted' }),
    );
  });

  it('uploads via the base64 fallback when the backend cannot presign', async () => {
    const { manager, sender } = managerWith({
      'anx.file.upload-init': { responseCode: 200, responseObject: { fileId: 'f1', presignPut: false } },
      'anx.file.upload-complete': {
        responseCode: 200,
        responseObject: { file: { _id: 'f1', originalName: 'hi.txt' } },
      },
    });
    const file = await manager.upload({
      workspaceId: 'w1',
      name: 'hi.txt',
      contentType: 'text/plain',
      base64Data: Buffer.from('hi').toString('base64'),
    });
    expect(file.id).toBe('f1');
    expect(sender.send).toHaveBeenCalledWith(
      'anx.file.upload-complete',
      expect.objectContaining({ base64Data: Buffer.from('hi').toString('base64') }),
    );
  });

  it('falls back to the region proxy for downloads when presign is unsupported', async () => {
    const { manager } = managerWith({
      'anx.storage.presign.get': {
        responseCode: 400,
        errorObjects: [{ code: 'STORAGE_CAPABILITY_UNSUPPORTED' }],
      },
    });
    const out = await manager.downloadUrl('f 1');
    expect(out).toEqual({ url: 'https://region.test/files/f%201', presigned: false });
  });

  it('propagates capability matrices', async () => {
    const { manager } = managerWith({
      'anx.storage.backend.capabilities': {
        responseCode: 200,
        responseObject: { capability: { presignPut: true, presignGet: true } },
      },
    });
    const caps = await manager.capabilities('local');
    expect(caps.presignPut).toBe(true);
    expect(caps.read).toBe(true);
  });

  it('sends rename / move / trash / restore commands', async () => {
    const { manager, sender } = managerWith({
      'anx.storage.bucket.rename-file': { responseCode: 200, responseObject: {} },
      'anx.storage.bucket.move-file': { responseCode: 200, responseObject: {} },
      'anx.storage.bucket.trash-file': { responseCode: 200, responseObject: {} },
      'anx.storage.bucket.restore-file': { responseCode: 200, responseObject: {} },
    });
    await manager.renameFile('f1', 'b.txt');
    await manager.moveFile('f1', 'd2');
    await manager.trashFile('f1');
    await manager.restoreFile('f1');
    expect(sender.send).toHaveBeenCalledWith('anx.storage.bucket.move-file', {
      fileId: 'f1',
      targetFolderId: 'd2',
    });
  });
});
