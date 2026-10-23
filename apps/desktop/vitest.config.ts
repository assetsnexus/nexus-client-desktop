import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The workspace links `@nexus/chat-react` at ../../.., so a spec that renders
  // a chat-react component would otherwise pull `react` from anx-npm-modules
  // and `react-dom` from this tree — two copies, and hooks blow up with
  // "Cannot read properties of null (reading 'useState')". Dedupe to one copy.
  resolve: {
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
