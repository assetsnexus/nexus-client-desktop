import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Mirror `vite.config.ts`: the VRM/cluster/notification peers are consumed from
// source. The broad `@nexus/character-kit` alias below matches by *prefix*, so
// the `asset-cache` / `presence-moods` subpaths MUST be declared BEFORE it —
// otherwise `@nexus/character-kit/asset-cache` (imported by `@nexus/chat-react`)
// is rewritten to `<kit>/src/index.ts/asset-cache` and resolution fails.
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
const notificationsCore = resolve(
  repoRoot,
  'anx-npm-modules/packages/notifications-core/src/index.ts',
);

export default defineConfig({
  // The workspace links `@nexus/chat-react` at ../../.., so a spec that renders
  // a chat-react component would otherwise pull `react` from anx-npm-modules
  // and `react-dom` from this tree — two copies, and hooks blow up with
  // "Cannot read properties of null (reading 'useState')". Dedupe to one copy.
  resolve: {
    // Subpath aliases must precede the broad `@nexus/character-kit` alias (Vite
    // matches aliases by prefix, in order).
    alias: {
      '@nexus/character-react': characterReact,
      '@nexus/character-kit/asset-cache': characterKitAssetCache,
      '@nexus/character-kit/presence-moods': characterKitPresenceMoods,
      '@nexus/character-kit': characterKit,
      '@nexus/cluster-scene-react': clusterSceneReact,
      '@nexus/scene-client': sceneClient,
      '@nexus/notifications-core': notificationsCore,
    },
    dedupe: ['react', 'react-dom'],
  },
  // The app itself is built with the automatic JSX runtime (vite react plugin);
  // component specs run through esbuild here, so opt into the same runtime.
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
  },
});
