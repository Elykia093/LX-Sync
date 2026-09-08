import { defineConfig, devices } from '@playwright/test'

const useMockWebServer = process.env.E2E_MOCK_WEB_SERVER === '1'
if (!useMockWebServer) {
  if (process.env.ALLOW_TEST_DATABASE_WRITE !== '1')
    throw new Error('ALLOW_TEST_DATABASE_WRITE=1 is required for browser E2E')

  let databaseName: string
  try {
    const databaseUrl = new URL(process.env.DATABASE_URL ?? '')
    if (
      databaseUrl.protocol !== 'postgres:' &&
      databaseUrl.protocol !== 'postgresql:'
    )
      throw new Error('Unsupported database protocol')
    databaseName = decodeURI(databaseUrl.pathname.slice(1))
  } catch {
    throw new Error(
      'DATABASE_URL must be a valid PostgreSQL URL for browser E2E',
    )
  }
  if (!/(^|[-_])test([-_]|$)/i.test(databaseName))
    throw new Error(
      'DATABASE_URL must target a clearly named test database for browser E2E',
    )
  if (process.env.E2E_SKIP_WEBSERVER === '1')
    throw new Error('E2E_SKIP_WEBSERVER is only supported in mock mode')
}
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
  ...(useMockWebServer ? { testMatch: '**/*.mock.spec.ts' } : {}),
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
          reuseExistingServer: false,
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
