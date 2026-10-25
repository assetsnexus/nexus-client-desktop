import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..', '..', '..');
const characterReact = resolve(
  repoRoot,
  'anx-libs/nexus-collaboration-vr/packages/character-react/src/index.ts',
);
const characterKit = resolve(
  repoRoot,
  'anx-libs/nexus-collaboration-vr/packages/character-kit/src/index.ts',
);
const characterKitAssetCache = resolve(
  repoRoot,
  'anx-libs/nexus-collaboration-vr/packages/character-kit/src/asset-cache.ts',
);
const characterKitPresenceMoods = resolve(
  repoRoot,
  'anx-libs/nexus-collaboration-vr/packages/character-kit/src/presence-moods.ts',
);
const clusterSceneReact = resolve(
  repoRoot,
  'anx-libs/nexus-collaboration-vr/packages/cluster-scene-react/src/index.ts',
);
const sceneClient = resolve(repoRoot, 'anx-npm-modules/packages/scene-client/src/index.ts');

/**
 * Renderer build. Mirrors `chat-react/vite.webview.config.ts` aliasing so the
 * VRM / cluster chunks resolve from source instead of published dist.
 */
export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  resolve: {
    alias: {
      '@nexus/character-react': characterReact,
      '@nexus/character-kit/asset-cache': characterKitAssetCache,
      '@nexus/character-kit/presence-moods': characterKitPresenceMoods,
      '@nexus/character-kit': characterKit,
      '@nexus/cluster-scene-react': clusterSceneReact,
      '@nexus/scene-client': sceneClient,
    },
    dedupe: ['three', 'react', 'react-dom'],
  },
  optimizeDeps: {
    esbuildOptions: { target: 'esnext' },
  },
  build: {
    target: 'esnext',
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // React must own a dedicated chunk. Without this Rollup folds the
          // single React copy into whichever manual chunk happens to reference
          // it first (here `cluster-scene`), and because `cluster-scene-react`
          // in turn imports `@nexus/character-react`, the two manual chunks
          // form a cycle: character-voice -> cluster-scene -> character-voice.
          // In the emitted cycle one chunk evaluates while the other is still
          // initialising, so `character-voice` reads React's namespace (its
          // `createContext`) before React is initialised -> undefined -> black
          // screen on boot of the built renderer.
          if (
            id.includes('/node_modules/react/') ||
            id.includes('/node_modules/react-dom/') ||
            id.includes('/node_modules/scheduler/')
          ) {
            return 'react-vendor';
          }
          if (id.includes('character-kit') && id.includes('asset-cache')) {
            return 'avatar-asset-cache';
          }
          if (
            id.includes('character-react') ||
            id.includes('character-kit') ||
            id.includes('node_modules/three') ||
            id.includes('@pixiv/three-vrm') ||
            id.includes('three-vrm-lip-sync')
          ) {
            return 'character-voice';
          }
          if (id.includes('cluster-scene-react') || id.includes('scene-client')) {
            return 'cluster-scene';
          }
        },
      },
    },
  },
  server: {
    port: 5280,
    strictPort: true,
  },
});
