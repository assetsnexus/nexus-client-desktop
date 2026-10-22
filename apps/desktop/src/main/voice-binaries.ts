/**
 * Speech-engine binary manager (main process).
 *
 * Downloads and installs the runner *executable* (`whisper-server`) the local
 * wake-word / STT engines need — the piece that previously had to be installed
 * by hand on the system `PATH`. Model weights were already downloadable; this
 * closes the gap so "download a Whisper model" is actually runnable.
 *
 * Resolution order for the binary:
 *  1. an explicit user override on `PATH` (respect an existing install), then
 *  2. the app-managed copy under `<userData>/voice-bin/`.
 *
 * The download is streamed to memory (the assets are ~4–11 MB), decompressed with
 * Node's `zlib`, and unpacked with the dependency-free parser in
 * `@nexus/local-voice`. The executable bit is restored on POSIX. Nothing here
 * shells out to `tar`/`unzip`, so it works the same on a locked-down machine.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { app } from 'electron';
import {
  buildVoiceBinaryPlan,
  parseTar,
  parseZip,
  resolveVoiceBinaryAsset,
  voiceBinaryFileName,
  voiceBinaryInstructions,
  type ArchiveEntry,
  type VoiceBinaryAsset,
  type VoiceBinaryId,
} from '@nexus/local-voice';

export type VoiceBinarySource = 'managed' | 'path' | 'missing';

export type VoiceBinaryStatus = {
  id: VoiceBinaryId;
  /** True when a runnable binary was found (managed copy or on PATH). */
  installed: boolean;
  /** Where it came from; `missing` when nothing was found. */
  source: VoiceBinarySource;
  /** Absolute path when found, else null. */
  path: string | null;
  /** Directory the app installs its own copy into (shown for transparency). */
  installDir: string;
  /** True when a one-click install is possible on this platform/arch. */
  canInstall: boolean;
  /** Platform label of the downloadable asset, when one exists. */
  assetLabel: string | null;
  assetSizeBytes: number | null;
  /** Live install progress. */
  state: 'idle' | 'downloading' | 'extracting' | 'installing' | 'error';
  downloadPercent: number | null;
  error: string | null;
  /** Honest per-OS manual instructions (always present). */
  instructions: {
    command: string | null;
    steps: string[];
    manualRequired: boolean;
    expectsOnPath: string;
  };
};

export type VoiceBinaryManagerOptions = {
  /** Overridable for tests. */
  dataDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Injected so tests never touch the network. */
  fetchFn?: typeof fetch;
  /** PATH lookup override (defaults to scanning `process.env.PATH`). */
  whichFn?: (command: string) => string | null;
  /** File existence check override (tests). */
  fileExists?: (path: string) => boolean;
};

export type VoiceBinaryManager = ReturnType<typeof createVoiceBinaryManager>;

/**
 * Resolve an executable on `PATH` without shelling out. Pure and injectable so
 * it is testable. On Windows both `name` and `name.exe` are tried.
 */
export function whichOnPath(
  command: string,
  env: { PATH?: string; PATHEXT?: string } = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string | null {
  if (!command || isAbsolute(command)) return exists(command) ? command : null;
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const exts =
    platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
      : [''];
  const hasExt = /\.[a-z0-9]+$/i.test(command);
  for (const dir of dirs) {
    const candidates =
      platform === 'win32' && !hasExt ? exts.map((ext) => `${command}${ext}`) : [command];
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      if (exists(full)) return full;
    }
  }
  // Case-insensitive match for Windows-style names stored with different casing.
  if (platform === 'win32') {
    for (const dir of dirs) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      const match = names.find((n) => n.toLowerCase() === command.toLowerCase());
      if (match) return join(dir, match);
    }
  }
  return null;
}

export function createVoiceBinaryManager(options: VoiceBinaryManagerOptions = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const dataDir = options.dataDir ?? app.getPath('userData');
  const binDir = join(dataDir, 'voice-bin');
  const doFetch = options.fetchFn ?? fetch;
  const fileExists = options.fileExists ?? existsSync;
  const which = options.whichFn ?? ((cmd: string) => whichOnPath(cmd, process.env, platform, fileExists));

  const id: VoiceBinaryId = 'whisper-server';
  const exeName = voiceBinaryFileName(id, platform);
  const asset = resolveVoiceBinaryAsset(platform, arch, id);

  let state: VoiceBinaryStatus['state'] = 'idle';
  let downloadPercent: number | null = null;
  let error: string | null = null;
  let controller: AbortController | null = null;

  /** Directory the managed bundle is unpacked into (kept whole for its libs). */
  function managedDir(): string {
    return join(binDir, id);
  }

  /** Locate a runnable binary: managed copy first, then an existing PATH install. */
  function locate(): { path: string | null; source: VoiceBinarySource } {
    const managed = findManagedExecutable();
    if (managed) return { path: managed, source: 'managed' };
    const onPath = which(exeName);
    if (onPath) return { path: onPath, source: 'path' };
    // A Linux bundle may sit one level down (e.g. `whisper-bin-ubuntu-x64/`).
    return { path: null, source: 'missing' };
  }

  /** True when `path` is a spawnable file (a regular file or a symlink to one). */
  function isExecutableFile(path: string): boolean {
    try {
      const stat = lstatSync(path);
      return stat.isFile() || stat.isSymbolicLink();
    } catch {
      return false;
    }
  }

  /** Search the managed dir (and one level down) for the executable file. */
  function findManagedExecutable(): string | null {
    const root = managedDir();
    const direct = join(root, exeName);
    if (isExecutableFile(direct)) return direct;
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const nested = join(root, entry.name, exeName);
        if (isExecutableFile(nested)) return nested;
      }
    } catch {
      /* not installed */
    }
    return null;
  }

  function status(): VoiceBinaryStatus {
    const found = locate();
    return {
      id,
      installed: found.path !== null,
      source: found.source,
      path: found.path,
      installDir: managedDir(),
      canInstall: asset !== null,
      assetLabel: asset?.label ?? null,
      assetSizeBytes: asset?.sizeBytes ?? null,
      state,
      downloadPercent,
      error,
      instructions: voiceBinaryInstructions(platform),
    };
  }

  /** Stream the archive into memory, reporting progress. Returns the bytes. */
  async function downloadArchive(a: VoiceBinaryAsset, signal: AbortSignal): Promise<Uint8Array> {
    const res = await doFetch(a.url, { redirect: 'follow', signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${a.label}`);
    const total = Number(res.headers.get('content-length')) || a.sizeBytes || null;
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.byteLength;
          downloadPercent = total ? Math.min(100, Math.round((received / total) * 100)) : null;
        }
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      chunks.push(buf);
      downloadPercent = 100;
    }
    const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }

  /** Decompress + parse the archive into entries (no disk writes yet). */
  function readArchive(a: VoiceBinaryAsset, bytes: Uint8Array): ArchiveEntry[] {
    if (a.archive === 'tar.gz') {
      return parseTar(new Uint8Array(gunzipSync(bytes)));
    }
    return parseZip(bytes, (raw) => new Uint8Array(inflateRawSync(raw)));
  }

  /** Write the parsed plan under the managed directory, restoring modes. */
  function writePlan(plan: ReturnType<typeof buildVoiceBinaryPlan>): void {
    rmSync(plan.installDir, { recursive: true, force: true });
    mkdirSync(plan.installDir, { recursive: true });
    for (const item of plan.items) {
      const dest = join(plan.installDir, item.path);
      if (!dest.startsWith(plan.installDir)) continue; // defense in depth
      if (item.directory) {
        mkdirSync(dest, { recursive: true });
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      if (item.symlinkTarget !== undefined) {
        // Recreate the link. Some filesystems (or Windows without privileges)
        // refuse a symlink; fall back to copying the target so the bundle still
        // runs. A missing target is skipped rather than failing the install.
        try {
          symlinkSync(item.symlinkTarget, dest);
        } catch {
          const target = join(dirname(dest), item.symlinkTarget);
          try {
            copyFileSync(target, dest);
          } catch {
            /* target missing: skip */
          }
        }
        continue;
      }
      writeFileSync(dest, item.data ?? new Uint8Array());
      if (platform !== 'win32') {
        try {
          chmodSync(dest, item.mode || 0o644);
        } catch {
          /* best-effort */
        }
      }
    }
    // The runner must be executable by its owner.
    if (platform !== 'win32') {
      const exe = join(plan.installDir, plan.executablePath);
      if (fileExists(exe)) {
        try {
          chmodSync(exe, 0o755);
        } catch {
          /* best-effort */
        }
      }
    }
  }

  async function install(): Promise<VoiceBinaryStatus> {
    if (!asset) {
      error = voiceBinaryInstructions(platform).manualRequired
        ? 'No prebuilt runner is published for this platform — follow the manual steps.'
        : 'No download available for this platform.';
      state = 'error';
      return status();
    }
    if (controller) return status();
    controller = new AbortController();
    error = null;
    downloadPercent = 0;
    state = 'downloading';
    try {
      const bytes = await downloadArchive(asset, controller.signal);
      state = 'extracting';
      const entries = readArchive(asset, bytes);
      if (!entries.length) throw new Error('The downloaded archive was empty or unreadable.');
      state = 'installing';
      const plan = buildVoiceBinaryPlan({ asset, installDir: managedDir(), entries });
      writePlan(plan);
      downloadPercent = 100;
      state = 'idle';
    } catch (err) {
      error = err instanceof Error ? err.message : 'Install failed.';
      state = 'error';
    } finally {
      controller = null;
    }
    return status();
  }

  return {
    status,
    /** The managed bin dir (kept for diagnostics / the settings copy). */
    binDirectory: () => binDir,

    /**
     * Resolve a command name to a concrete path for `spawn`: an absolute managed
     * path when the app installed it, otherwise the bare name so `spawn` uses
     * `PATH` exactly as before. Never returns null, so callers can spawn blindly
     * and surface a failure as "not ready".
     */
    resolveBinary(command: string): string {
      if (command !== exeName && command !== id) return command;
      const managed = findManagedExecutable();
      if (managed) return managed;
      const onPath = which(exeName);
      return onPath ?? command;
    },

    /** True when the runner can be spawned right now. */
    isInstalled(): boolean {
      return locate().path !== null;
    },

    install,

    cancelInstall(): VoiceBinaryStatus {
      controller?.abort();
      controller = null;
      state = 'idle';
      downloadPercent = null;
      return status();
    },

    remove(): VoiceBinaryStatus {
      try {
        rmSync(managedDir(), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      state = 'idle';
      downloadPercent = null;
      error = null;
      return status();
    },
  };
}
