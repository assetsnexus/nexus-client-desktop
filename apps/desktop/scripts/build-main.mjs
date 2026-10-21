/**
 * Bundle the Electron main + preload with esbuild.
 *
 * Main and preload run in Node, so `electron` stays external (provided by the
 * runtime) while `@nexus/node-core` (and its `@nexus/commands-client` dep) are
 * bundled in — they are workspace `file:` deps that would otherwise need to be
 * packaged into node_modules.
 */

import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
};

await build({
  ...shared,
  entryPoints: [resolve(root, 'src/main/main.ts')],
  outfile: resolve(root, 'dist-electron/main.cjs'),
});

await build({
  ...shared,
  entryPoints: [resolve(root, 'src/preload/preload.ts')],
  outfile: resolve(root, 'dist-electron/preload/preload.cjs'),
});

console.log('[build-main] done');
