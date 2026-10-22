#!/usr/bin/env node
/**
 * Build the native `nexus-mount` helper and stage it next to the packaged app.
 *
 * The helper is optional at runtime: when the binary is absent the mount daemon
 * falls back to its pure-JS mirror mode. This script therefore **never fails a
 * packaging run** just because the Rust toolchain or libfuse headers are
 * missing — it logs and exits 0, leaving the daemon in mirror mode.
 *
 * Output: `dist-native/<platform>-<arch>/nexus-mount[.exe]`, which the main
 * process resolves via `resolveNativeHelperPath()`.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repoRoot = resolve(appDir, '..', '..');
const nativeDir = join(repoRoot, 'native');
const outDir = join(appDir, 'dist-native', `${process.platform}-${process.arch}`);

function log(msg) {
  process.stdout.write(`[build:native] ${msg}\n`);
}

function haveCargo() {
  const r = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

if (!existsSync(join(nativeDir, 'Cargo.toml'))) {
  log('no native/Cargo.toml — skipping (mirror mode will be used)');
  process.exit(0);
}

if (!haveCargo()) {
  log('cargo not found — skipping native helper build (mirror mode will be used)');
  process.exit(0);
}

log(`building nexus-mount for ${process.platform}-${process.arch}`);
const build = spawnSync('cargo', ['build', '--release', '-p', 'nexus-mount'], {
  cwd: nativeDir,
  stdio: 'inherit',
  env: process.env,
});

if (build.status !== 0) {
  // FUSE headers, a missing linker, or a locked toolchain must not break
  // packaging — the app is fully functional in mirror mode.
  log('cargo build failed — continuing without the kernel helper');
  process.exit(0);
}

const binName = process.platform === 'win32' ? 'nexus-mount.exe' : 'nexus-mount';
const built = join(nativeDir, 'target', 'release', binName);
if (!existsSync(built)) {
  log(`build produced no ${binName} — continuing without it`);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
cpSync(built, join(outDir, binName));
log(`staged ${join(outDir, binName)}`);
