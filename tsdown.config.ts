import { defineConfig } from 'tsdown'

/**
 * A published dsh TUI cannot rely on the root pnpm patchedDependencies map:
 * clean npm consumers install the unpatched registry Tern 0.1.0. Inline the
 * locked and patched SDK here so the shipped lib/index.js retains its wire,
 * child-forget, ACK-progress and strict hello behavior.
 */
export default defineConfig({
  entry: ['lib/types/{index,startup}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    alwaysBundle: ['@stencil-hq/tern'],
  },
})
