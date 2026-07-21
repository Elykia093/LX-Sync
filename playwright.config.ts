import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:9527'

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 7_500,
  },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  ...(process.env.E2E_SKIP_WEBSERVER === '1'
    ? {}
    : {
        webServer: {
          command: 'pnpm --filter @lx-sync/server start',
          url: `${baseURL}/health/ready`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
          gracefulShutdown: {
            signal: 'SIGTERM',
            timeout: 10_000,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      }),
})
