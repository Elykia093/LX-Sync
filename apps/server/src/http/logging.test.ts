import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../config.js'
import { type AppDependencies, buildApp } from './app.js'

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('HTTP access log redaction', () => {
  it('does not emit scoped identifiers, protocol headers, or query values', async () => {
    const lines: string[] = []
    const config = {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: 9527,
      SERVER_NAME: 'Test Sync',
      DATABASE_URL: 'postgresql://test.invalid/test',
      MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'correct-horse-battery',
      SESSION_TTL_HOURS: 24,
      MAX_SNAPSHOTS: 10,
      TRUST_PROXY: false,
      PUBLIC_ORIGIN: 'https://sync.example.test',
      SYNC_BASE_PATH: '/base',
      LOG_LEVEL: 'info',
    } satisfies AppConfig
    const app = await buildApp({
      config,
      repository: {
        checkDatabase: async () => {},
      } as AppDependencies['repository'],
      auth: {
        authenticateHttp: async () => ({
          statusCode: 401,
          body: 'Auth failed',
        }),
      },
      registry: {
        count: () => 0,
        closeUser: async () => {},
        closeDevice: async () => {},
        forUser: () => [],
        runExclusive: (_userId, task) => task(),
      },
      serverId: 'server-id',
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      loggerStream: {
        write: (message) => lines.push(message),
      },
    })

    try {
      await app.inject({
        method: 'GET',
        url: `/base/${userId}/ah?i=raw-device&t=raw-token`,
        headers: { m: 'raw-auth-message' },
      })
    } finally {
      await app.close()
    }

    const serialized = lines.join('')
    expect(serialized).toContain('[Redacted]')
    expect(serialized).not.toContain(userId)
    expect(serialized).not.toContain('raw-device')
    expect(serialized).not.toContain('raw-token')
    expect(serialized).not.toContain('raw-auth-message')
  })
})
