import { defineConfig, devices } from '@playwright/test'

const useMockWebServer = process.env.E2E_MOCK_WEB_SERVER === '1'
const mockWebServerPort = Number(process.env.E2E_MOCK_PORT ?? '9527')
if (
  useMockWebServer &&
  (!Number.isSafeInteger(mockWebServerPort) || mockWebServerPort < 1)
)
  throw new Error('E2E_MOCK_PORT must be a positive integer')
const baseURL =
  process.env.E2E_BASE_URL ??
  `http://127.0.0.1:${useMockWebServer ? mockWebServerPort : 9527}`

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
          command: useMockWebServer
            ? `pnpm --filter @lx-sync/web exec vite --host 127.0.0.1 --port ${mockWebServerPort} --strictPort`
            : 'pnpm --filter @lx-sync/server start',
          url: useMockWebServer ? baseURL : `${baseURL}/health/ready`,
          reuseExistingServer: useMockWebServer ? false : !process.env.CI,
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
