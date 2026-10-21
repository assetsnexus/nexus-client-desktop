/**
 * Download planning (@nexus/local-voice).
 *
 * Downloads are executed by the Electron main process (streaming to disk), but
 * the *plan* — which files, resume offsets, integrity — is pure and testable.
 * This module turns a {@link LocalVoiceModel} into an ordered file plan with
 * resume offsets and a target directory name, so the manager and the UI agree.
 */

import type { LocalVoiceModel, LocalVoiceModelFile } from './catalog.js';

export type DownloadPlanItem = {
  file: LocalVoiceModelFile;
  /** Absolute-ish relative destination path under the model directory. */
  destPath: string;
  /** Byte offset to resume from when a partial file exists. */
  resumeFrom: number;
  /** Whether the file is already present and verified. */
  complete: boolean;
};

export type DownloadPlan = {
  modelId: string;
  dirName: string;
  items: DownloadPlanItem[];
  totalBytes: number | null;
  /** Bytes already on disk (complete files + partial offsets). */
  haveBytes: number;
  remainingBytes: number | null;
};

/** A filesystem-safe directory name derived from the model id. */
export function modelDirName(model: LocalVoiceModel): string {
  return model.id.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '');
}

function safeFileName(name: string): string {
  // Never allow a file entry to escape the model directory.
  const cleaned = name.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.' && p !== '..');
  return cleaned.join('/') || 'model';
}

export type ExistingFileState = {
  /** Relative path → bytes already downloaded. */
  existingBytes?: Record<string, number>;
};

/**
 * Build the download plan. A file is `complete` when the on-disk size already
 * matches a known size; otherwise it resumes from the on-disk offset.
 */
export function buildDownloadPlan(model: LocalVoiceModel, existing: ExistingFileState = {}): DownloadPlan {
  const dirName = modelDirName(model);
  const existingBytes = existing?.existingBytes ?? {};
  const items: DownloadPlanItem[] = model.files.map((file) => {
    const destPath = `${dirName}/${safeFileName(file.name)}`;
    const have = existingBytes[destPath] ?? 0;
    const known = typeof file.sizeBytes === 'number' ? file.sizeBytes : null;
    const complete = known != null && have >= known;
    return {
      file,
      destPath,
      resumeFrom: complete ? 0 : have,
      complete,
    };
  });
  const totalBytes =
    model.files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0) || model.sizeBytes || null;
  const haveBytes = items.reduce(
    (sum, it) => sum + (it.complete ? (it.file.sizeBytes ?? 0) : it.resumeFrom),
    0,
  );
  return {
    modelId: model.id,
    dirName,
    items,
    totalBytes,
    haveBytes,
    remainingBytes: totalBytes != null ? Math.max(0, totalBytes - haveBytes) : null,
  };
}

/** Percent complete (0..100) for the progress bar, or null when unknown. */
export function planPercent(plan: DownloadPlan): number | null {
  if (plan.totalBytes == null || plan.totalBytes <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((plan.haveBytes / plan.totalBytes) * 100)));
}

export type DownloadProgressEvent = {
  modelId: string;
  fileIndex: number;
  filePath: string;
  /** Bytes written for the current file. */
  fileBytes: number;
  fileTotalBytes: number | null;
  /** Aggregate bytes across the plan. */
  totalBytesWritten: number;
  totalBytes: number | null;
  percent: number | null;
};
