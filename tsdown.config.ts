import { defineConfig } from 'tsdown'

// This input is emitted by tsc with real .js specifiers. Inline the qualified
// patched SDK; production consumers must never resolve public unpatched Tern.
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/startup.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  splitting: false,
  dts: false,
  clean: false,
  deps: { alwaysBundle: ['@stencil-hq/tern'] },
})
