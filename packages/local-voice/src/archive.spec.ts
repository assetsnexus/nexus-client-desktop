import { describe, expect, it } from 'vitest';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  findExecutableEntry,
  isSafeSymlinkTarget,
  parseTar,
  parseZip,
  sanitizeArchivePath,
  type ArchiveEntry,
} from './archive.js';

/** Build a minimal ustar archive in memory (octal numeric fields). */
function tarBlock(name: string, size: number, typeflag: string, linkname = '', mode = 0o644): Uint8Array {
  const header = new Uint8Array(512);
  const enc = (offset: number, text: string, length: number) => {
    for (let i = 0; i < text.length && i < length; i++) header[offset + i] = text.charCodeAt(i);
  };
  enc(0, name, 100);
  enc(100, mode.toString(8).padStart(7, '0') + '\0', 8);
  enc(108, '0000000\0', 8); // uid
  enc(116, '0000000\0', 8); // gid
  enc(124, size.toString(8).padStart(11, '0') + '\0', 12);
  enc(136, '00000000000\0', 12); // mtime
  enc(148, '        ', 8); // checksum placeholder
  header[156] = typeflag.charCodeAt(0);
  enc(157, linkname, 100);
  enc(257, 'ustar\0', 6);
  enc(263, '00', 2);
  // Checksum: sum of bytes with the field treated as spaces.
  let sum = 0;
  for (const byte of header) sum += byte;
  enc(148, sum.toString(8).padStart(6, '0') + '\0 ', 8);
  return header;
}

function tarFile(name: string, data: Uint8Array): Uint8Array[] {
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return [tarBlock(name, data.length, '0'), padded];
}

describe('sanitizeArchivePath', () => {
  it('keeps ordinary relative paths and normalizes separators', () => {
    expect(sanitizeArchivePath('Release/whisper-server.exe')).toBe('Release/whisper-server.exe');
    expect(sanitizeArchivePath('a\\b\\c')).toBe('a/b/c');
    expect(sanitizeArchivePath('./a/./b')).toBe('a/b');
  });

  it('rejects traversal, absolute and drive-qualified paths', () => {
    expect(sanitizeArchivePath('../evil')).toBeNull();
    expect(sanitizeArchivePath('a/../../evil')).toBeNull();
    expect(sanitizeArchivePath('/etc/passwd')).toBeNull();
    expect(sanitizeArchivePath('C:/Windows/system32')).toBeNull();
    expect(sanitizeArchivePath('\\\\server\\share')).toBeNull();
    expect(sanitizeArchivePath('nul\0byte')).toBeNull();
    expect(sanitizeArchivePath('')).toBeNull();
  });
});

describe('isSafeSymlinkTarget', () => {
  it('allows same-directory and descendant targets', () => {
    expect(isSafeSymlinkTarget('bin/libfoo.so', 'libfoo.so.1')).toBe(true);
    expect(isSafeSymlinkTarget('a/b/link', 'c/d')).toBe(true);
  });

  it('refuses absolute targets and ones escaping the root', () => {
    expect(isSafeSymlinkTarget('bin/link', '/etc/passwd')).toBe(false);
    expect(isSafeSymlinkTarget('bin/link', '../../outside')).toBe(false);
    expect(isSafeSymlinkTarget('link', '../sibling')).toBe(false);
    // One level up from a nested dir is still inside the root.
    expect(isSafeSymlinkTarget('a/b/link', '../sibling')).toBe(true);
  });
});

describe('parseTar', () => {
  it('reads files, directories and symlinks', () => {
    const parts: Uint8Array[] = [
      tarBlock('dist/', 0, '5', '', 0o755),
      ...tarFile('dist/whisper-server', new TextEncoder().encode('ELF')),
      tarBlock('dist/libfoo.so', 0, '2', 'libfoo.so.1'),
    ];
    parts.push(new Uint8Array(1024)); // end-of-archive
    const archive = concat(parts);
    const entries = parseTar(archive);

    const file = entries.find((e) => e.path === 'dist/whisper-server');
    expect(file?.kind).toBe('file');
    expect(new TextDecoder().decode((file as Extract<ArchiveEntry, { kind: 'file' }>).data)).toBe('ELF');

    const dir = entries.find((e) => e.path === 'dist');
    expect(dir?.kind).toBe('dir');

    const link = entries.find((e) => e.path === 'dist/libfoo.so');
    expect(link?.kind).toBe('symlink');
    expect((link as Extract<ArchiveEntry, { kind: 'symlink' }>).target).toBe('libfoo.so.1');
  });

  it('drops entries that try to escape the root', () => {
    const parts = [...tarFile('../escape', new TextEncoder().encode('x'))];
    parts.push(new Uint8Array(1024));
    expect(parseTar(concat(parts))).toEqual([]);
  });
});

describe('parseZip', () => {
  it('reads stored and deflated entries and rejects traversal', () => {
    const stored = new TextEncoder().encode('hello');
    const deflated = new Uint8Array(deflateRawSync(new TextEncoder().encode('server-code')));
    const zip = buildZip([
      { name: 'Release/whisper-server.exe', data: deflated, deflate: true },
      { name: 'Release/readme.txt', data: stored, deflate: false },
      { name: '../evil', data: stored, deflate: false },
    ]);
    const entries = parseZip(zip, (raw) => new Uint8Array(inflateRawSync(raw)));

    const exe = entries.find((e) => e.path === 'Release/whisper-server.exe');
    expect(exe?.kind).toBe('file');
    expect(new TextDecoder().decode((exe as Extract<ArchiveEntry, { kind: 'file' }>).data)).toBe(
      'server-code',
    );
    expect(entries.some((e) => e.path.includes('evil'))).toBe(false);
  });
});

describe('findExecutableEntry', () => {
  const entries: ArchiveEntry[] = [
    { kind: 'file', path: 'deep/nested/whisper-server', mode: 0o755, size: 1, data: new Uint8Array(1) },
    { kind: 'file', path: 'whisper-server', mode: 0o755, size: 1, data: new Uint8Array(1) },
  ];

  it('prefers the shallowest matching executable', () => {
    expect(findExecutableEntry(entries, ['whisper-server'])?.path).toBe('whisper-server');
  });

  it('accepts the .exe variant on Windows', () => {
    const win: ArchiveEntry[] = [
      { kind: 'file', path: 'Release/whisper-server.exe', mode: 0o755, size: 1, data: new Uint8Array(1) },
    ];
    expect(findExecutableEntry(win, ['whisper-server'], 'win32')?.path).toBe(
      'Release/whisper-server.exe',
    );
    expect(findExecutableEntry(win, ['whisper-server'], 'linux')).toBeNull();
  });
});

// --- helpers ------------------------------------------------------------------

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Minimal stored/deflated zip writer for tests (no compression metadata). */
function buildZip(files: { name: string; data: Uint8Array; deflate: boolean }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    const method = file.deflate ? 8 : 0;
    const crc = crc32(file.data);
    const local = new Uint8Array(30 + nameBytes.length + file.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, file.data.length, true); // inflated size (approx for test)
    lv.setUint32(22, file.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(file.data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, file.data.length, true);
    cv.setUint32(24, file.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(38, 0o10_0755 << 16, true); // unix mode (regular file, 0755)
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = concat(centrals);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralDir.length, true);
  ev.setUint32(16, offset, true);
  return concat([...locals, centralDir, eocd]);
}

function crc32(data: Uint8Array): number {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
