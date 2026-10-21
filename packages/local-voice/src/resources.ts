/**
 * System resource probe (@nexus/local-voice).
 *
 * Voice models are the reason to care about VRAM: a local Whisper/TTS engine
 * must be loaded while transcribing and unloaded afterwards, and the settings UI
 * shows how much headroom the machine has. This module turns raw probe output
 * (an injected runner so it is testable and never shells out during a unit test)
 * into a compact snapshot with stable parsing per platform.
 *
 * It never throws: an unavailable probe degrades to `available:false` so the UI
 * can hide the bar instead of showing bogus numbers.
 */

export type VramProbeResult =
  | { available: true; totalBytes: number; freeBytes: number; vendor: 'nvidia' | 'amd' | 'unknown' }
  | { available: false; reason: string };

export type ResourceSnapshot = {
  /** System RAM, always available when the OS reports it. */
  ram: { totalBytes: number; freeBytes: number } | null;
  /** GPU VRAM when a vendor tool answered. */
  vram: {
    totalBytes: number;
    freeBytes: number;
    vendor: 'nvidia' | 'amd' | 'unknown';
  } | null;
  vramReason: string | null;
  checkedAt: string;
};

/**
 * Parse `nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits`
 * (values in MiB, one line per GPU). Sums across GPUs so a multi-GPU machine
 * reports its whole pool. Returns null when the output has no parsable row.
 */
export function parseNvidiaSmi(output: string): { totalBytes: number; freeBytes: number } | null {
  const lines = String(output ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let totalMib = 0;
  let freeMib = 0;
  let seen = false;
  for (const line of lines) {
    const [totalRaw, freeRaw] = line.split(',').map((p) => p.trim());
    const total = Number(totalRaw);
    const free = Number(freeRaw);
    if (!Number.isFinite(total) || !Number.isFinite(free)) continue;
    totalMib += total;
    freeMib += free;
    seen = true;
  }
  if (!seen) return null;
  const MIB = 1024 * 1024;
  return { totalBytes: totalMib * MIB, freeBytes: freeMib * MIB };
}

/**
 * Parse AMD `rocm-smi --showmeminfo vram --csv` or `--json`. The CSV shape is
 * `card,VRAM Total Memory (B),VRAM Total Used Memory (B)`. Returns null when
 * nothing parsable is present.
 */
export function parseRocmSmi(output: string): { totalBytes: number; freeBytes: number } | null {
  const text = String(output ?? '');
  // JSON shape first (rocm-smi --json emits an object keyed by card).
  const jsonStart = text.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart)) as Record<string, Record<string, unknown>>;
      let total = 0;
      let used = 0;
      let seen = false;
      for (const card of Object.values(parsed)) {
        const t = Number(card['VRAM Total Memory (B)'] ?? card['vram_total']);
        const u = Number(card['VRAM Total Used Memory (B)'] ?? card['vram_used']);
        if (!Number.isFinite(t)) continue;
        total += t;
        used += Number.isFinite(u) ? u : 0;
        seen = true;
      }
      if (seen) return { totalBytes: total, freeBytes: Math.max(0, total - used) };
    } catch {
      // fall through to CSV
    }
  }
  let total = 0;
  let used = 0;
  let seen = false;
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 3) continue;
    const t = Number(parts[1]);
    const u = Number(parts[2]);
    if (!Number.isFinite(t)) continue;
    total += t;
    used += Number.isFinite(u) ? u : 0;
    seen = true;
  }
  return seen ? { totalBytes: total, freeBytes: Math.max(0, total - used) } : null;
}

export type ProbeRunners = {
  /** Returns stdout of the given command, or null when the command is absent. */
  run: (command: string, args: string[]) => Promise<string | null>;
  /** `os.totalmem()` / `os.freemem()`. */
  totalmem?: () => number;
  freemem?: () => number;
  platform?: NodeJS.Platform;
};

/**
 * Probe VRAM from the first vendor tool that answers, then RAM. Every failure is
 * captured as a reason string rather than thrown.
 */
export async function probeResources(runners: ProbeRunners): Promise<ResourceSnapshot> {
  const checkedAt = new Date().toISOString();
  let ram: ResourceSnapshot['ram'] = null;
  try {
    const total = runners.totalmem?.();
    const free = runners.freemem?.();
    if (typeof total === 'number' && typeof free === 'number') {
      ram = { totalBytes: total, freeBytes: free };
    }
  } catch {
    ram = null;
  }

  let vram: ResourceSnapshot['vram'] = null;
  let vramReason: string | null = null;

  const nvidia = await safeRun(runners, 'nvidia-smi', [
    '--query-gpu=memory.total,memory.free',
    '--format=csv,noheader,nounits',
  ]);
  if (nvidia) {
    const parsed = parseNvidiaSmi(nvidia);
    if (parsed) vram = { ...parsed, vendor: 'nvidia' };
  }

  if (!vram) {
    const amd = await safeRun(runners, 'rocm-smi', ['--showmeminfo', 'vram', '--json']);
    if (amd) {
      const parsed = parseRocmSmi(amd);
      if (parsed) vram = { ...parsed, vendor: 'amd' };
    }
  }

  if (!vram) {
    vramReason =
      runners.platform === 'darwin'
        ? 'Unified memory: VRAM is shared with system RAM on this platform.'
        : 'No NVIDIA/AMD VRAM tool responded. VRAM headroom is unknown.';
  }

  return { ram, vram, vramReason, checkedAt };
}

async function safeRun(runners: ProbeRunners, command: string, args: string[]): Promise<string | null> {
  try {
    return await runners.run(command, args);
  } catch {
    return null;
  }
}

/** Human "N.N GB" formatting shared by the settings UI. */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

/** Percentage free (0..100), or null when totals are unknown. */
export function freePercent(snapshot: { totalBytes: number; freeBytes: number } | null): number | null {
  if (!snapshot || !snapshot.totalBytes) return null;
  return Math.max(0, Math.min(100, Math.round((snapshot.freeBytes / snapshot.totalBytes) * 100)));
}
