/**
 * Main-process storage explorer adapter (Phase 2).
 *
 * Wraps `@nexus/storage-browser` around the authenticated region command sender
 * so the renderer can browse buckets without touching tokens or transport. The
 * capability fallbacks (presign-PUT -> base64, presign-GET -> proxy) live in the
 * shared package, not here.
 */

import { createStorageClient, type StorageCommandSender } from '@nexus/storage-browser';
import type {
  StorageCapabilities,
  StorageFileRow,
  StorageFolderRow,
  StoragePage,
  StorageUploadRequest,
  StorageWorkspaceRow,
} from '../shared/ipc.js';

export type StorageManagerOptions = {
  /** Resolve the token-bearing region sender (from the auth manager). */
  getSender: () => Promise<{ send: StorageCommandSender }>;
  /** Region base URL, used for the non-presign proxy fallback. */
  getRegionUrl: () => string;
  /** Optional fetch override for tests. */
  fetchFn?: typeof fetch;
};

export type StorageManager = ReturnType<typeof createStorageManager>;

export function createStorageManager(options: StorageManagerOptions) {
  const client = async () => {
    const sender = await options.getSender();
    // The sender exposes `.send`; adapt it to the narrow storage function shape.
    const adapter: StorageCommandSender = (command, payload) => sender.send(command, payload);
    return createStorageClient(adapter);
  };

  return {
    async workspaces(): Promise<StorageWorkspaceRow[]> {
      const rows = await (await client()).listWorkspaces();
      return rows.map((w) => ({
        id: w.id,
        name: w.name,
        ownerUserId: w.ownerUserId,
        orgId: w.orgId,
        memberUserIds: w.memberUserIds,
      }));
    },

    async folderList(workspaceId: string, parentFolderId?: string | null): Promise<StorageFolderRow[]> {
      return (await client()).folderList(workspaceId, parentFolderId);
    },

    async listFiles(input: {
      workspaceId?: string;
      folderId?: string | null;
      cursor?: string | null;
      search?: string;
      status?: string;
      limit?: number;
    }): Promise<StoragePage> {
      const page = await (await client()).listBucketFiles(input);
      return {
        items: page.items.map(toRow),
        total: page.total,
        nextCursor: page.nextCursor,
        encryptionSummary: page.encryptionSummary,
      };
    },

    async capabilities(kind?: string): Promise<StorageCapabilities> {
      return (await client()).backendCapabilities(kind);
    },

    async upload(req: StorageUploadRequest): Promise<StorageFileRow> {
      const bytes = Buffer.from(req.base64Data, 'base64');
      const file = await (await client()).upload({
        workspaceId: req.workspaceId,
        folderId: req.folderId,
        name: req.name,
        contentType: req.contentType,
        bytes: new Uint8Array(bytes),
        fetchFn: options.fetchFn,
      });
      return toRow(file);
    },

    async downloadUrl(fileId: string) {
      return (await client()).resolveDownloadUrl({ fileId, regionBaseUrl: options.getRegionUrl() });
    },

    async trashFile(fileId: string) {
      await (await client()).trashFile(fileId);
    },

    async restoreFile(fileId: string) {
      await (await client()).restoreFile(fileId);
    },

    async renameFile(fileId: string, newName: string) {
      await (await client()).renameFile(fileId, newName);
    },

    async moveFile(fileId: string, targetFolderId: string | null) {
      await (await client()).moveFile({ fileId, targetFolderId });
    },
  };
}

function toRow(f: {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  workspaceId: string | null;
  folderId: string | null;
  encryptionTier: string;
  createdAt: string | null;
  revisionNo: number | null;
}): StorageFileRow {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    sizeBytes: f.sizeBytes,
    status: f.status,
    workspaceId: f.workspaceId,
    folderId: f.folderId,
    encryptionTier: f.encryptionTier,
    createdAt: f.createdAt,
    revisionNo: f.revisionNo,
  };
}
