import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}'],
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: '../../coverage/web',
      thresholds: {
        statements: 12,
        branches: 3,
        functions: 8,
        lines: 14,
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:9527',
      '/health': 'http://127.0.0.1:9527',
    },
  },
})
