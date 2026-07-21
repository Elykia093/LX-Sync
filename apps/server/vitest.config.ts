import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.integration.test.ts'],
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: '../../coverage/server',
      thresholds: {
        statements: 41,
        branches: 39,
        functions: 39,
        lines: 42,
      },
    },
  },
})
