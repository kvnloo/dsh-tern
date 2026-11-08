import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/host/tests/**/*.e2e.ts'],
    exclude: ['node_modules/**', 'lib/**', '_host/**'],
  },
})
