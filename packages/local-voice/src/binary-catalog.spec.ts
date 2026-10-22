import { describe, expect, it } from 'vitest';
import {
  buildVoiceBinaryPlan,
  canAutoInstallVoiceBinary,
  findExecutableEntry,
  parseTar,
  planExecutableDir,
  resolveVoiceBinaryAsset,
  voiceBinaryFileName,
  voiceBinaryInstructions,
  type ArchiveEntry,
} from './index.js';

describe('voice binary catalog', () => {
  it('resolves a prebuilt asset for Linux and Windows, but not macOS', () => {
    expect(resolveVoiceBinaryAsset('linux', 'x64')?.archive).toBe('tar.gz');
    expect(resolveVoiceBinaryAsset('linux', 'arm64')?.archive).toBe('tar.gz');
    expect(resolveVoiceBinaryAsset('win32', 'x64')?.archive).toBe('zip');
    expect(resolveVoiceBinaryAsset('win32', 'arm64')?.archive).toBe('zip');
    // Homebrew builds whisper.cpp without the server, and there is no prebuilt.
    expect(resolveVoiceBinaryAsset('darwin', 'arm64')).toBeNull();
    expect(resolveVoiceBinaryAsset('darwin', 'x64')).toBeNull();
  });

  it('only claims auto-install where an asset exists', () => {
    expect(canAutoInstallVoiceBinary('linux', 'x64')).toBe(true);
    expect(canAutoInstallVoiceBinary('win32', 'x64')).toBe(true);
    expect(canAutoInstallVoiceBinary('darwin', 'arm64')).toBe(false);
  });

  it('pins a build tag that actually ships binaries (semver tags have none)', () => {
    const asset = resolveVoiceBinaryAsset('linux', 'x64')!;
    expect(asset.url).toContain('github.com/ggml-org/whisper.cpp/releases/download/b');
    expect(asset.url.endsWith('.tar.gz')).toBe(true);
  });

  it('names the executable per platform', () => {
    expect(voiceBinaryFileName('whisper-server', 'linux')).toBe('whisper-server');
    expect(voiceBinaryFileName('whisper-server', 'win32')).toBe('whisper-server.exe');
  });

  it('gives honest, per-OS instructions and flags the macOS dead-end', () => {
    const mac = voiceBinaryInstructions('darwin');
    expect(mac.manualRequired).toBe(true);
    expect(mac.steps.join(' ')).toContain('WHISPER_BUILD_SERVER=ON');
    expect(mac.expectsOnPath).toBe('whisper-server');

    const linux = voiceBinaryInstructions('linux');
    expect(linux.manualRequired).toBe(false);
    expect(linux.steps[0]).toContain('Install');

    const win = voiceBinaryInstructions('win32');
    expect(win.manualRequired).toBe(false);
    expect(win.steps.join(' ')).toContain('whisper-server.exe');
  });
});

describe('buildVoiceBinaryPlan', () => {
  const asset = resolveVoiceBinaryAsset('linux', 'x64')!;

  it('keeps the whole bundle together (libraries stay beside the binary)', () => {
    const entries: ArchiveEntry[] = [
      { kind: 'dir', path: 'bundle', mode: 0o755 },
      { kind: 'file', path: 'bundle/whisper-server', mode: 0o755, size: 3, data: new Uint8Array([1, 2, 3]) },
      { kind: 'file', path: 'bundle/libwhisper.so.1', mode: 0o644, size: 2, data: new Uint8Array([4, 5]) },
      { kind: 'symlink', path: 'bundle/libwhisper.so', mode: 0o777, target: 'libwhisper.so.1' },
    ];
    const plan = buildVoiceBinaryPlan({ asset, installDir: '/data/voice-bin/whisper-server', entries });
    expect(plan.executablePath).toBe('bundle/whisper-server');
    expect(plan.totalBytes).toBe(5);
    expect(plan.items.some((i) => i.symlinkTarget === 'libwhisper.so.1')).toBe(true);
    expect(planExecutableDir(plan)).toBe('bundle');
  });

  it('ignores a directory sharing the executable name', () => {
    const entries: ArchiveEntry[] = [
      { kind: 'dir', path: 'Release/whisper-server', mode: 0o755 },
      { kind: 'file', path: 'Release/whisper-server.exe', mode: 0o755, size: 1, data: new Uint8Array([9]) },
    ];
    const winAsset = resolveVoiceBinaryAsset('win32', 'x64')!;
    const plan = buildVoiceBinaryPlan({ asset: winAsset, installDir: '/d', entries });
    expect(plan.executablePath).toBe('Release/whisper-server.exe');
  });
});

describe('plan + parse integration (dependency-free round trip)', () => {
  it('parses a synthetic tar into a runnable plan', () => {
    // Reuse the archive parser through a minimal hand-built tar.
    const header = new Uint8Array(512);
    const enc = (o: number, text: string, len: number) => {
      for (let i = 0; i < text.length && i < len; i++) header[o + i] = text.charCodeAt(i);
    };
    const body = new TextEncoder().encode('#!/bin/sh\n');
    enc(0, 'whisper-server', 100);
    enc(100, '0000755\0', 8);
    enc(108, '0000000\0', 8);
    enc(116, '0000000\0', 8);
    enc(124, body.length.toString(8).padStart(11, '0') + '\0', 12);
    enc(136, '00000000000\0', 12);
    enc(148, '        ', 8);
    header[156] = '0'.charCodeAt(0);
    enc(257, 'ustar\0', 6);
    enc(263, '00', 2);
    let sum = 0;
    for (const b of header) sum += b;
    enc(148, sum.toString(8).padStart(6, '0') + '\0 ', 8);
    const padded = new Uint8Array(512);
    padded.set(body);
    const archive = new Uint8Array(1536);
    archive.set(header, 0);
    archive.set(padded, 512);

    const entries = parseTar(archive);
    expect(findExecutableEntry(entries, ['whisper-server'])?.path).toBe('whisper-server');

    const asset = resolveVoiceBinaryAsset('linux', 'x64')!;
    const plan = buildVoiceBinaryPlan({ asset, installDir: '/data', entries });
    expect(plan.executablePath).toBe('whisper-server');
    expect(planExecutableDir(plan)).toBe('');
  });
});
