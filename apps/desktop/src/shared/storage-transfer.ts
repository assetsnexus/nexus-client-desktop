/**
 * Drag-and-drop storage transfer model (pure, framework-free).
 *
 * Shared by the renderer upload queue and the main-process transfer executor so
 * both agree on what a drop expands into. Nothing here touches `fs`, Electron or
 * the region: it is the *plan* — which files an OS drop yields, where each lands
 * relative to the target workspace folder, and how their size is reported.
 *
 * Kept pure so the folder-recursion + relative-path rules are unit-testable
 * without a running Electron or a real region.
 */

/** One top-level entry the OS handed us from a drop. */
export type DropNode = {
  /** Absolute path on disk (from `webUtils.getPathForFile`). */
  path: string;
  /** Base name (last path segment). */
  name: string;
  isDirectory: boolean;
  /** Size in bytes for a plain file drop (unknown for directories). */
  sizeBytes?: number;
};

/** One file discovered by walking a dropped directory. */
export type WalkedFile = {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the dropped directory root (POSIX, no leading slash). */
  relPath: string;
  sizeBytes: number;
};

/** A planned upload: where one file lands inside the target workspace. */
export type PlannedUpload = {
  /** Absolute path on disk to read the bytes from. */
  absPath: string;
  /** File name as stored in the workspace. */
  name: string;
  /**
   * Folder prefix inside the workspace, POSIX, `''` for the target folder
   * itself (e.g. `photos/2024` for a dropped `photos` containing `2024/a.png`).
   */
  prefix: string;
  /** `prefix` + `name`, the path relative to the target folder. */
  relPath: string;
  sizeBytes: number;
  contentType: string;
};

export type DropSkipReason = 'empty-directory' | 'unreadable' | 'duplicate';

export type DroppedSkip = { path: string; reason: DropSkipReason };

export type DropPlan = {
  entries: PlannedUpload[];
  skipped: DroppedSkip[];
};

/** POSIX dirname (never returns a trailing slash; `''` for a bare name). */
export function posixDirname(relPath: string): string {
  const normalized = normalizeRelPath(relPath);
  const at = normalized.lastIndexOf('/');
  return at <= 0 ? '' : normalized.slice(0, at);
}

/** POSIX basename. */
export function posixBasename(relPath: string): string {
  const normalized = normalizeRelPath(relPath);
  const at = normalized.lastIndexOf('/');
  return at === -1 ? normalized : normalized.slice(at + 1);
}

/** Collapse separators, drop a leading `/` and `.` segments. */
export function normalizeRelPath(relPath: string): string {
  return String(relPath ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .join('/');
}

/** Join two POSIX relative paths without doubling separators. */
export function joinRelPath(base: string, rel: string): string {
  const b = normalizeRelPath(base);
  const r = normalizeRelPath(rel);
  if (!b) return r;
  if (!r) return b;
  return `${b}/${r}`;
}

/** Split a folder prefix into individual segment names (`photos/2024` -> 2). */
export function prefixSegments(prefix: string): string[] {
  return normalizeRelPath(prefix).split('/').filter(Boolean);
}

const CONTENT_TYPES: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/typescript',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/** Best-effort content type from a file extension; never throws. */
export function guessContentType(name: string): string {
  const dot = String(name ?? '').lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  const ext = name.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Turn a set of dropped OS entries into the flat upload plan.
 *
 * - A dropped **file** becomes one upload into the target folder (`prefix ''`).
 * - A dropped **directory** is expanded from `walkedByRoot[dir.path]`, and the
 *   directory name becomes the first prefix segment so the tree is preserved.
 * - Empty directories are reported as `skipped` rather than silently dropped.
 * - Duplicate destinations (same `relPath`) are collapsed to the first entry.
 */
export function planDropUploads(
  dropped: DropNode[],
  walkedByRoot: Record<string, WalkedFile[]> = {},
): DropPlan {
  const entries: PlannedUpload[] = [];
  const skipped: DroppedSkip[] = [];
  const seen = new Set<string>();

  for (const node of dropped) {
    if (!node?.path) continue;
    const name = node.name || posixBasename(node.path);
    if (!node.isDirectory) {
      const relPath = normalizeRelPath(name);
      if (!relPath) continue;
      if (seen.has(relPath)) {
        skipped.push({ path: node.path, reason: 'duplicate' });
        continue;
      }
      seen.add(relPath);
      entries.push({
        absPath: node.path,
        name,
        prefix: '',
        relPath,
        sizeBytes: Math.max(0, node.sizeBytes ?? 0),
        contentType: guessContentType(name),
      });
      continue;
    }

    const walked = walkedByRoot[node.path] ?? [];
    if (!walked.length) {
      skipped.push({ path: node.path, reason: 'empty-directory' });
      continue;
    }
    // The dropped folder name is the first prefix segment, so a folder drop
    // nests under a folder of the same name instead of flattening into the root.
    const rootPrefix = normalizeRelPath(name);
    for (const file of walked) {
      const rel = normalizeRelPath(file.relPath);
      if (!rel) continue;
      const relPath = joinRelPath(rootPrefix, rel);
      if (seen.has(relPath)) {
        skipped.push({ path: file.path, reason: 'duplicate' });
        continue;
      }
      seen.add(relPath);
      const fileName = posixBasename(rel);
      entries.push({
        absPath: file.path,
        name: fileName,
        prefix: posixDirname(relPath),
        relPath,
        sizeBytes: Math.max(0, file.sizeBytes ?? 0),
        contentType: guessContentType(fileName),
      });
    }
  }

  return { entries, skipped };
}

/**
 * Map a main-process drop expansion (`storageExpandDrop` result) onto the
 * planner inputs. Kept pure so the shape conversion is unit-tested without
 * Electron.
 */
export function plannerInputFromExpansion(
  entries: Array<{
    path: string;
    name: string;
    isDirectory: boolean;
    sizeBytes: number;
    children?: Array<{ path: string; relPath: string; sizeBytes: number }>;
  }>,
): { dropped: DropNode[]; walked: Record<string, WalkedFile[]> } {
  const dropped: DropNode[] = [];
  const walked: Record<string, WalkedFile[]> = {};
  for (const entry of entries) {
    dropped.push({
      path: entry.path,
      name: entry.name,
      isDirectory: entry.isDirectory,
      sizeBytes: entry.sizeBytes,
    });
    if (entry.isDirectory) {
      walked[entry.path] = (entry.children ?? []).map((child) => ({
        path: child.path,
        relPath: child.relPath,
        sizeBytes: child.sizeBytes,
      }));
    }
  }
  return { dropped, walked };
}

/** Human-readable byte count (compact, one decimal above 10 units). */
export function formatBytes(n: number): string {
  const value = Number.isFinite(n) && n > 0 ? n : 0;
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / 1024 ** i;
  return `${scaled >= 10 || i === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[i]}`;
}

/**
 * Percentage for a transfer row: a real fraction when the transport reports
 * byte granularity, otherwise `null` so the UI shows an indeterminate bar
 * instead of a fabricated number.
 */
export function transferPercent(
  sentBytes: number,
  totalBytes: number,
  indeterminate: boolean,
): number | null {
  if (indeterminate) return null;
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  const ratio = Math.min(1, Math.max(0, sentBytes / totalBytes));
  return Math.round(ratio * 100);
}
