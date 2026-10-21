import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  freePercent,
  parseNvidiaSmi,
  parseRocmSmi,
  probeResources,
  type ProbeRunners,
} from '../resources.js';

const MIB = 1024 * 1024;

describe('parseNvidiaSmi', () => {
  it('sums multiple GPUs and converts MiB to bytes', () => {
    const out = '24576, 20000\n8192, 4096\n';
    expect(parseNvidiaSmi(out)).toEqual({
      totalBytes: (24576 + 8192) * MIB,
      freeBytes: (20000 + 4096) * MIB,
    });
  });

  it('returns null without a parsable row', () => {
    expect(parseNvidiaSmi('')).toBeNull();
    expect(parseNvidiaSmi('n/a')).toBeNull();
  });
});

describe('parseRocmSmi', () => {
  it('parses the JSON shape', () => {
    const out = JSON.stringify({
      card0: {
        'VRAM Total Memory (B)': '17163091968',
        'VRAM Total Used Memory (B)': '1000000000',
      },
    });
    const parsed = parseRocmSmi(out)!;
    expect(parsed.totalBytes).toBe(17163091968);
    expect(parsed.freeBytes).toBe(16163091968);
  });

  it('parses the CSV shape', () => {
    const parsed = parseRocmSmi('card,VRAM Total Memory (B),VRAM Total Used Memory (B)\n0,1000,400\n')!;
    expect(parsed).toEqual({ totalBytes: 1000, freeBytes: 600 });
  });

  it('returns null when nothing matches', () => {
    expect(parseRocmSmi('no gpu here')).toBeNull();
  });
});

describe('probeResources', () => {
  const base = { totalmem: () => 16 * 1024 ** 3, freemem: () => 8 * 1024 ** 3, platform: 'linux' as const };

  it('prefers nvidia-smi and reports RAM', async () => {
    const runners: ProbeRunners = {
      ...base,
      run: async (cmd) => (cmd === 'nvidia-smi' ? '16384, 8192\n' : null),
    };
    const snap = await probeResources(runners);
    expect(snap.ram!.totalBytes).toBe(16 * 1024 ** 3);
    expect(snap.vram!.vendor).toBe('nvidia');
    expect(snap.vram!.freeBytes).toBe(8192 * MIB);
    expect(snap.vramReason).toBeNull();
  });

  it('falls back to rocm-smi', async () => {
    const runners: ProbeRunners = {
      ...base,
      run: async (cmd) => (cmd === 'rocm-smi' ? 'card,VRAM Total Memory (B),VRAM Total Used Memory (B)\n0,2000,500\n' : null),
    };
    const snap = await probeResources(runners);
    expect(snap.vram!.vendor).toBe('amd');
    expect(snap.vram!.freeBytes).toBe(1500);
  });

  it('captures a reason instead of throwing when no GPU tool answers', async () => {
    const runners: ProbeRunners = { ...base, run: async () => null };
    const snap = await probeResources(runners);
    expect(snap.vram).toBeNull();
    expect(snap.vramReason).toBeTruthy();
  });

  it('swallows a runner that throws', async () => {
    const runners: ProbeRunners = {
      ...base,
      run: async () => {
        throw new Error('spawn ENOENT');
      },
    };
    const snap = await probeResources(runners);
    expect(snap.vram).toBeNull();
    expect(snap.vramReason).toBeTruthy();
  });

  it('explains unified memory on macOS', async () => {
    const runners: ProbeRunners = { ...base, platform: 'darwin', run: async () => null };
    const snap = await probeResources(runners);
    expect(snap.vramReason).toMatch(/Unified memory/);
  });
});

describe('formatting helpers', () => {
  it('formats GB and MB', () => {
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB');
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB');
    expect(formatBytes(null)).toBe('—');
  });

  it('computes free percent', () => {
    expect(freePercent({ totalBytes: 100, freeBytes: 25 })).toBe(25);
    expect(freePercent(null)).toBeNull();
    expect(freePercent({ totalBytes: 0, freeBytes: 0 })).toBeNull();
  });
});
