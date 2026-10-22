/**
 * Speech-engine binary install plan (@nexus/local-voice).
 *
 * The main process does the I/O (download, decompress, write, chmod); this module
 * is the pure description shared with it and with tests: given a
 * {@link VoiceBinaryAsset} and an install directory, what files must be written,
 * which one is the executable, and where do its runtime libraries live?
 *
 * whisper.cpp's prebuilt Linux tarballs ship `whisper-server` beside its shared
 * libraries with an `$ORIGIN` RUNPATH, so the whole bundle must be extracted into
 * one directory and the executable invoked from there — not copied out alone.
 */

import type { ArchiveEntry } from './archive.js';
import type { VoiceBinaryAsset, VoiceBinaryId } from './binary-catalog.js';
import { voiceBinaryFileName } from './binary-catalog.js';

export type VoiceBinaryPlanItem = {
  /** Path relative to the install directory. */
  path: string;
  mode: number;
  /** Present for regular files. */
  data?: Uint8Array;
  /** Present for symlinks (an entry that mirrors a real file). */
  symlinkTarget?: string;
  directory?: boolean;
};

export type VoiceBinaryPlan = {
  id: VoiceBinaryId;
  /** Absolute directory the bundle is extracted into (per-asset, not shared). */
  installDir: string;
  /** Relative path of the runnable executable inside {@link installDir}. */
  executablePath: string;
  items: VoiceBinaryPlanItem[];
  /** Total bytes that will be written (excluding symlinks/dirs). */
  totalBytes: number;
};

/**
 * Turn parsed archive {@link ArchiveEntry}s into a flat write plan. Directory
 * entries are kept so empty dirs and their modes survive, symlinks are preserved
 * (Linux bundles rely on `libfoo.so` → `libfoo.so.1`), and everything is placed
 * under `installDir`.
 */
export function buildVoiceBinaryPlan(input: {
  asset: VoiceBinaryAsset;
  installDir: string;
  entries: readonly ArchiveEntry[];
}): VoiceBinaryPlan {
  const { asset, installDir, entries } = input;
  const items: VoiceBinaryPlanItem[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.kind === 'dir') {
      items.push({ path: entry.path, mode: entry.mode, directory: true });
    } else if (entry.kind === 'symlink') {
      items.push({ path: entry.path, mode: entry.mode, symlinkTarget: entry.target });
    } else {
      items.push({ path: entry.path, mode: entry.mode, data: entry.data });
      totalBytes += entry.data.byteLength;
    }
  }
  const exeName = voiceBinaryFileName(asset.id, asset.platform);
  const wanted = new Set([...asset.executableNames, exeName].map((n) => n.toLowerCase()));
  // Prefer the shallowest path whose base name matches (the real binary, not a
  // helper of the same name nested in a samples/ or tests/ subfolder).
  let executablePath = exeName;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    const base = entry.path.split('/').pop()?.toLowerCase() ?? '';
    if (!wanted.has(base)) continue;
    const depth = entry.path.split('/').length;
    if (depth < bestDepth) {
      bestDepth = depth;
      executablePath = entry.path;
    }
  }
  return { id: asset.id, installDir, executablePath, items, totalBytes };
}

/**
 * Directory of the executable inside the plan, relative to `installDir` (`''`
 * when the binary sits at the root). The main process uses it to resolve the
 * sibling shared libraries a Linux/Windows bundle needs.
 */
export function planExecutableDir(plan: VoiceBinaryPlan): string {
  const idx = plan.executablePath.lastIndexOf('/');
  return idx === -1 ? '' : plan.executablePath.slice(0, idx);
}
