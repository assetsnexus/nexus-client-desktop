/**
 * Dev launcher: start the Vite renderer dev server, bundle main/preload, then
 * launch Electron pointed at the dev server. Ctrl-C tears everything down.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function bundleMain() {
  const shared = {
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: true,
    external: ['electron'],
    logLevel: 'warning',
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
}

const server = await createServer({ configFile: resolve(root, 'vite.config.ts') });
await server.listen();
const info = server.resolvedUrls?.local?.[0] ?? `http://localhost:${server.config.server.port}/`;
console.log(`[dev] renderer at ${info}`);

await bundleMain();

const electronBin = (await import('electron')).default;
const child = spawn(electronBin, [resolve(root, 'dist-electron/main.cjs')], {
  stdio: 'inherit',
  env: { ...process.env, NEXUS_RENDERER_URL: info, NEXUS_OPEN_DEVTOOLS: '1' },
});

child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});

process.on('SIGINT', () => {
  child.kill('SIGINT');
});
