import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

const { createVoiceBinaryManager, whichOnPath } = await import('./voice-binaries.js');

const dirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-voice-bin-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A tiny ustar file entry. */
function tarFile(name: string, body: string, mode = 0o755): Uint8Array[] {
  const data = new TextEncoder().encode(body);
  const header = new Uint8Array(512);
  const enc = (o: number, text: string, len: number) => {
    for (let i = 0; i < text.length && i < len; i++) header[o + i] = text.charCodeAt(i);
  };
  enc(0, name, 100);
  enc(100, mode.toString(8).padStart(7, '0') + '\0', 8);
  enc(108, '0000000\0', 8);
  enc(116, '0000000\0', 8);
  enc(124, data.length.toString(8).padStart(11, '0') + '\0', 12);
  enc(136, '00000000000\0', 12);
  enc(148, '        ', 8);
  header[156] = '0'.charCodeAt(0);
  enc(257, 'ustar\0', 6);
  enc(263, '00', 2);
  let sum = 0;
  for (const b of header) sum += b;
  enc(148, sum.toString(8).padStart(6, '0') + '\0 ', 8);
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return [header, padded];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A gzipped tar containing a fake whisper-server bundle. */
function fakeTarball(inner = 'whisper-bin-ubuntu-x64'): Uint8Array {
  const parts = [
    ...tarFile(`${inner}/whisper-server`, '#!/bin/sh\necho hi\n'),
    ...tarFile(`${inner}/libwhisper.so.1`, 'lib'),
  ];
  parts.push(new Uint8Array(1024));
  return new Uint8Array(gzipSync(concat(parts)));
}

function fetchReturning(bytes: Uint8Array, headers: Record<string, string> = {}) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(bytes.byteLength), ...headers }),
    body: null,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })) as unknown as typeof fetch;
}

describe('whichOnPath', () => {
  it('finds a file on a POSIX PATH', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'whisper-server'), 'x');
    const found = whichOnPath('whisper-server', { PATH: `/nope${process.platform === 'win32' ? ';' : ':'}${dir}` }, 'linux', existsSync);
    expect(found).toBe(join(dir, 'whisper-server'));
  });

  it('returns null when absent', () => {
    expect(whichOnPath('nope-not-here', { PATH: '/tmp' }, 'linux', existsSync)).toBeNull();
  });
});

describe('voice binary manager', () => {
  it('reports missing with honest per-OS instructions', () => {
    const dir = tempDir();
    const mgr = createVoiceBinaryManager({
      dataDir: dir,
      platform: 'darwin',
      arch: 'arm64',
      whichFn: () => null,
    });
    const status = mgr.status();
    expect(status.installed).toBe(false);
    expect(status.source).toBe('missing');
    // macOS has no prebuilt server binary.
    expect(status.canInstall).toBe(false);
    expect(status.instructions.manualRequired).toBe(true);
    expect(status.instructions.expectsOnPath).toBe('whisper-server');
  });

  it('prefers an existing PATH install over the managed copy', () => {
    const dir = tempDir();
    const pathBin = join(tempDir(), 'whisper-server');
    writeFileSync(pathBin, 'x');
    const mgr = createVoiceBinaryManager({
      dataDir: dir,
      platform: 'linux',
      arch: 'x64',
      whichFn: () => pathBin,
    });
    expect(mgr.status().source).toBe('path');
    expect(mgr.status().path).toBe(pathBin);
    // resolveBinary leaves an unknown command untouched.
    expect(mgr.resolveBinary('piper')).toBe('piper');
    expect(mgr.resolveBinary('whisper-server')).toBe(pathBin);
  });

  it('downloads, extracts and marks the binary executable', async () => {
    const dir = tempDir();
    const tarball = fakeTarball();
    const mgr = createVoiceBinaryManager({
      dataDir: dir,
      platform: 'linux',
      arch: 'x64',
      whichFn: () => null,
      fetchFn: fetchReturning(tarball),
    });

    expect(mgr.status().installed).toBe(false);
    const after = await mgr.install();
    expect(after.installed).toBe(true);
    expect(after.source).toBe('managed');
    expect(after.error).toBeNull();
    expect(after.downloadPercent).toBe(100);

    // The executable must exist inside the bundle (with its sibling library).
    const exe = after.path!;
    expect(existsSync(exe)).toBe(true);
    expect(readFileSync(exe, 'utf8')).toContain('echo hi');
    expect(existsSync(join(exe, '..', 'libwhisper.so.1'))).toBe(true);
    expect(mgr.isInstalled()).toBe(true);
    expect(mgr.resolveBinary('whisper-server')).toBe(exe);
  });

  it('surfaces a download failure without throwing', async () => {
    const dir = tempDir();
    const mgr = createVoiceBinaryManager({
      dataDir: dir,
      platform: 'linux',
      arch: 'x64',
      whichFn: () => null,
      fetchFn: (async () => ({ ok: false, status: 503, headers: new Headers(), body: null })) as unknown as typeof fetch,
    });
    const after = await mgr.install();
    expect(after.installed).toBe(false);
    expect(after.state).toBe('error');
    expect(after.error).toContain('503');
  });

  it('remove() deletes the managed copy and falls back to missing', async () => {
    const dir = tempDir();
    const mgr = createVoiceBinaryManager({
      dataDir: dir,
      platform: 'linux',
      arch: 'x64',
      whichFn: () => null,
      fetchFn: fetchReturning(fakeTarball()),
    });
    await mgr.install();
    expect(mgr.isInstalled()).toBe(true);
    const removed = mgr.remove();
    expect(removed.installed).toBe(false);
    expect(removed.source).toBe('missing');
  });

  it('reports a manual-only error when no asset exists for the platform', async () => {
    const dir = tempDir();
    const mgr = createVoiceBinaryManager({
      dataDir: dir,
      platform: 'freebsd' as NodeJS.Platform,
      arch: 'x64',
      whichFn: () => null,
    });
    const after = await mgr.install();
    expect(after.state).toBe('error');
    expect(after.canInstall).toBe(false);
  });
});
