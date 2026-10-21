/**
 * `@nexus/storage-browser` — headless Nexus storage client + explorer/mount model.
 *
 * Phase 2: explorer data model over `anx.file.*` / `anx.storage.*` with backend
 * capability fallbacks (shared by the desktop UI, the CLI, and Phase 3's mount
 * daemon).
 * Phase 3: the OS-agnostic mount plan + journal model the native daemon consumes.
 */

export {
  StorageCommandError,
  bytesToBase64,
  createStorageClient,
  envelopeFailed,
  parseFileRecord,
  toCollectionItemRef,
  unwrapEnvelope,
  type BackendCapabilities,
  type BucketFilePage,
  type FileRecord,
  type StorageCommandSender,
  type StorageClient,
  type StorageContract,
  type StorageWorkspace,
  type UploadInit,
} from './client.js';

export {
  buildMountPlan,
  driverForPlatform,
  isSafeMountRelPath,
  makeJournalEntry,
  orderJournal,
  type JournalEntry,
  type MountBinding,
  type MountDriver,
  type MountMode,
  type MountPlan,
} from './mount-plan.js';
