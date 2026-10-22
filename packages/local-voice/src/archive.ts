/**
 * Dependency-free archive reader (@nexus/local-voice).
 *
 * Speech-engine *binaries* (whisper.cpp's `whisper-server`) ship as `.tar.gz`
 * (Linux) and `.zip` (Windows) release assets. The desktop must be able to
 * unpack those without pulling a native/3rd-party extraction dependency into the
 * main bundle, so this module implements just enough of both formats.
 *
 * It is deliberately **pure**: it takes bytes and (for zip) an injected inflate
 * function, and returns a description of what to write. Node's `zlib`
 * (`gunzipSync` / `inflateRawSync`) is supplied by the caller in the main
 * process, which keeps this module free of `node:` imports so it stays portable
 * and trivially unit-testable.
 *
 * SECURITY: archive contents are untrusted input. {@link sanitizeArchivePath}
 * rejects absolute paths, `..` traversal and drive letters, and
 * {@link isSafeSymlinkTarget} refuses a symlink that would escape the root — so a
 * malicious archive can never write outside the install directory.
 */

export type ArchiveEntry =
  | { kind: 'file'; path: string; mode: number; size: number; data: Uint8Array }
  | { kind: 'dir'; path: string; mode: number }
  | { kind: 'symlink'; path: string; mode: number; target: string };

const TAR_BLOCK = 512;
/** Refuse absurd entries so a malformed header cannot balloon memory. */
const MAX_ENTRIES = 20_000;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/**
 * Normalize an archive path into a safe, relative, `/`-separated path, or return
 * null when it must be rejected (absolute, drive-qualified, or traversing).
 */
export function sanitizeArchivePath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  if (!raw || raw.includes('\0')) return null;
  // Windows-authored archives use backslashes; normalize before inspecting.
  const unified = raw.replace(/\\/g, '/');
  if (unified.startsWith('/')) return null;
  // Reject a drive letter or UNC-style prefix (`C:` / `C:/`).
  if (/^[a-zA-Z]:/.test(unified)) return null;
  const out: string[] = [];
  for (const segment of unified.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    out.push(segment);
  }
  return out.length ? out.join('/') : null;
}

/**
 * True when writing `target` as the body of the symlink at `entryPath` keeps the
 * link inside the extraction root. An absolute target or one that climbs above
 * the root is refused.
 */
export function isSafeSymlinkTarget(entryPath: string, target: string): boolean {
  if (typeof target !== 'string' || !target || target.includes('\0')) return false;
  const unified = target.replace(/\\/g, '/');
  if (unified.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(unified)) return false;
  // Resolve the target relative to the link's own directory and check depth.
  const dirDepth = entryPath.split('/').length - 1;
  let depth = dirDepth;
  for (const segment of unified.split('/')) {
    if (!segment || segment === '.') continue;
    depth += segment === '..' ? -1 : 1;
    if (depth < 0) return false;
  }
  return true;
}

/** Parse a POSIX/ustar `tar` buffer (already decompressed). Never throws. */
export function parseTar(buffer: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  const dec = new TextDecoder();
  let offset = 0;
  /** Pending GNU long name (`L`) applied to the next real entry. */
  let pendingName: string | null = null;
  /** Pending GNU long link target (`K`). */
  let pendingLink: string | null = null;

  while (offset + TAR_BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK);
    offset += TAR_BLOCK;
    // Two zero blocks terminate the archive.
    if (isZeroBlock(header)) break;

    const typeflag = String.fromCharCode(header[156] ?? 0);
    let name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = readTarNumber(header, 124, 12);
    const mode = readTarNumber(header, 100, 8) & 0o7777;
    const linkname = readTarString(header, 157, 100);
    const dataStart = offset;
    const padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    if (typeflag === 'L' || typeflag === 'K') {
      // GNU long name/link: the following block(s) hold the real string.
      const value = dec.decode(buffer.subarray(dataStart, dataStart + size)).replace(/\0+$/, '');
      if (typeflag === 'L') pendingName = value;
      else pendingLink = value;
      offset = dataStart + padded;
      continue;
    }
    // Skip pax extended headers and other metadata entries.
    if (typeflag === 'x' || typeflag === 'g') {
      offset = dataStart + padded;
      continue;
    }

    const finalName = pendingName ?? name;
    const finalLink = pendingLink ?? linkname;
    pendingName = null;
    pendingLink = null;

    if (entries.length >= MAX_ENTRIES) break;
    const safe = sanitizeArchivePath(finalName);
    if (!safe) {
      offset = dataStart + padded;
      continue;
    }

    if (typeflag === '5' || finalName.endsWith('/')) {
      entries.push({ kind: 'dir', path: safe, mode: mode || 0o755 });
    } else if (typeflag === '2') {
      if (isSafeSymlinkTarget(safe, finalLink)) {
        entries.push({ kind: 'symlink', path: safe, mode, target: finalLink });
      }
    } else if (typeflag === '1') {
      // Hard link: materialize as a copy, but enforce the same traversal guard.
      const target = sanitizeArchivePath(finalLink);
      if (target) entries.push({ kind: 'symlink', path: safe, mode, target });
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      if (size > MAX_ENTRY_BYTES) break;
      const data = buffer.subarray(dataStart, dataStart + size);
      entries.push({ kind: 'file', path: safe, mode: mode || 0o644, size, data });
    }
    offset = dataStart + padded;
  }
  return entries;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

function readTarString(header: Uint8Array, start: number, length: number): string {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  const bytes = end === -1 ? slice : slice.subarray(0, end);
  return new TextDecoder().decode(bytes).trim();
}

/**
 * Read a tar numeric field. Handles the octal form and the base-256 form used
 * by some tools for very large values.
 */
function readTarNumber(header: Uint8Array, start: number, length: number): number {
  const first = header[start] ?? 0;
  if (first & 0x80) {
    // base-256 (two's complement big-endian) — only sizes/modes use this.
    let value = first & 0x7f;
    for (let i = 1; i < length; i++) value = value * 256 + (header[start + i] ?? 0);
    return value;
  }
  const text = readTarString(header, start, length).replace(/\0/g, '').trim();
  const parsed = parseInt(text || '0', 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Parse a `zip` buffer. `inflate` must decompress a raw DEFLATE stream (Node's
 * `zlib.inflateRawSync`). Entries stored uncompressed need no inflate. Never
 * throws; unreadable entries are skipped.
 */
export function parseZip(
  buffer: Uint8Array,
  inflate: (deflated: Uint8Array) => Uint8Array,
): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const dec = new TextDecoder();

  // Locate the End Of Central Directory (scan back over the max comment size).
  let eocd = -1;
  const minEocd = Math.max(0, buffer.length - (0xffff + 22));
  for (let i = buffer.length - 22; i >= minEocd; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return entries;

  const entryCount = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const limit = Math.min(entryCount, MAX_ENTRIES);

  for (let n = 0; n < limit; n++) {
    if (ptr + 46 > buffer.length || view.getUint32(ptr, true) !== 0x02014b50) break;
    const flags = view.getUint16(ptr + 8, true);
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const uncompSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const externalAttrs = view.getUint32(ptr + 38, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const name = dec.decode(buffer.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;

    // Bit 0 set ⇒ encrypted; we cannot read it, so skip rather than mis-extract.
    if (flags & 0x1) continue;
    const unixMode = (externalAttrs >>> 16) & 0xffff;
    const fileType = unixMode & 0xf000;
    const safe = sanitizeArchivePath(name.replace(/\/+$/, ''));
    if (!safe) continue;

    if (name.endsWith('/')) {
      entries.push({ kind: 'dir', path: safe, mode: (unixMode & 0o777) || 0o755 });
      continue;
    }

    // Read the local header to find where the (variable-length) data starts.
    if (localOffset + 30 > buffer.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      continue;
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buffer.length) continue;
    const raw = buffer.subarray(dataStart, dataStart + compSize);

    let data: Uint8Array;
    if (method === 0) {
      data = raw;
    } else if (method === 8) {
      try {
        data = inflate(raw);
      } catch {
        continue;
      }
    } else {
      // Unsupported compression (bzip2/lzma/…): skip honestly.
      continue;
    }
    if (uncompSize > MAX_ENTRY_BYTES || data.byteLength > MAX_ENTRY_BYTES) continue;

    if (fileType === 0xa000) {
      // A symlink stored as a file whose contents are the target path.
      const target = dec.decode(data).replace(/\0+$/, '');
      if (isSafeSymlinkTarget(safe, target)) {
        entries.push({ kind: 'symlink', path: safe, mode: unixMode & 0o777, target });
      }
      continue;
    }
    entries.push({ kind: 'file', path: safe, mode: (unixMode & 0o777) || 0o644, size: data.byteLength, data });
  }
  return entries;
}

/**
 * Find an executable entry by base name (e.g. `whisper-server` /
 * `whisper-server.exe`), preferring the shallowest match so a bundled helper in
 * a subfolder does not win over the real binary.
 */
export function findExecutableEntry(
  entries: readonly ArchiveEntry[],
  baseNames: readonly string[],
  platform: NodeJS.Platform | string = process.platform,
): Extract<ArchiveEntry, { kind: 'file' }> | null {
  const wanted = new Set(baseNames.map((n) => n.toLowerCase()));
  let best: Extract<ArchiveEntry, { kind: 'file' }> | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    const base = entry.path.split('/').pop() ?? '';
    const lower = base.toLowerCase();
    // On Windows an `.exe` suffix is optional in the want-list and vice versa.
    const candidates =
      platform === 'win32' && lower.endsWith('.exe') ? [lower, lower.slice(0, -4)] : [lower];
    if (!candidates.some((c) => wanted.has(c))) continue;
    const depth = entry.path.split('/').length;
    if (depth < bestDepth) {
      best = entry;
      bestDepth = depth;
    }
  }
  return best;
}
