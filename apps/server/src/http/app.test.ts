import { afterEach, describe, expect, it } from 'vitest'
import type { AppConfig } from '../config.js'
import { type AppDependencies, buildApp, sessionCookieName } from './app.js'

const config = {
  NODE_ENV: 'test',
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
  LOG_LEVEL: 'silent',
} satisfies AppConfig

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('management authentication contract', () => {
  it('enforces Origin and an opaque HttpOnly Cookie lifecycle', async () => {
    const storedSessions = new Map<
      string,
      {
        sessionHash: string
        username: string
        expiresAt: Date
        lastSeenAt: Date
        createdAt: Date
        remoteAddress: string | null
      }
    >()
    const disabledUserId = '00000000-0000-4000-8000-000000000001'
    const auditActions: string[] = []
    const closeUserStarted = Promise.withResolvers<void>()
    const closeUserFinished = Promise.withResolvers<void>()
    const protocolAuthUsers: Array<string | null> = []

    const repository: AppDependencies['repository'] = {
      checkDatabase: async () => {},
      createSession: async (session, audit) => {
        const now = new Date()
        storedSessions.set(session.sessionHash, {
          ...session,
          lastSeenAt: now,
          createdAt: now,
        })
        if (audit) auditActions.push(audit.action)
      },
      getSession: async (sessionHash) => storedSessions.get(sessionHash),
      touchSession: async (sessionHash) => {
        const session = storedSessions.get(sessionHash)
        if (session) session.lastSeenAt = new Date()
      },
      deleteSession: async (sessionHash, audit) => {
        storedSessions.delete(sessionHash)
        if (audit) auditActions.push(audit.action)
      },
      listUsers: async () => [
        {
          id: disabledUserId,
          name: 'disabled user',
          enabled: false,
          maxSnapshots: 10,
          addMusicLocationType: 'bottom' as const,
          deviceCount: 1,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
      createUser: async (_input, audit) => {
        if (audit) auditActions.push(audit.action)
        return {
          id: '00000000-0000-4000-8000-000000000000',
          name: 'test',
        }
      },
      getUserSummary: async (userId) =>
        userId === disabledUserId
          ? {
              id: disabledUserId,
              name: 'disabled user',
              enabled: false,
              maxSnapshots: 10,
              addMusicLocationType: 'bottom',
              deviceCount: 1,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
            }
          : null,
      updateUser: async (userId, _patch, audit) => {
        if (userId !== disabledUserId) return false
        if (audit) auditActions.push(audit.action)
        return true
      },
      listDevices: async () => [],
      revokeDevice: async () => false,
      listSnapshots: async () => [],
      restoreSnapshot: async () => false,
      listAudit: async () => [],
    }
    const app = await buildApp({
      config,
      repository,
      auth: {
        authenticateHttp: async (input) => {
          protocolAuthUsers.push(input.userId ?? null)
          return {
            statusCode: 401,
            body: 'Auth failed',
          }
        },
      },
      registry: {
        count: () => 0,
        closeUser: async (userId) => {
          if (userId !== disabledUserId) return
          closeUserStarted.resolve()
          await closeUserFinished.promise
        },
        closeDevice: async () => {},
      },
      serverId: 'server-id',
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    apps.push(app)

    const rootHello = await app.inject({ method: 'GET', url: '/hello' })
    const scopedHello = await app.inject({
      method: 'GET',
      url: `/base/${disabledUserId}/hello`,
    })
    expect(scopedHello.body).toBe(rootHello.body)

    const rootId = await app.inject({ method: 'GET', url: '/id' })
    const scopedId = await app.inject({
      method: 'GET',
      url: `/base/${disabledUserId}/id`,
    })
    expect(scopedId.body).toBe(rootId.body)

    const invalidScopedPath = await app.inject({
      method: 'GET',
      url: '/base/not-a-user/hello',
    })
    expect(invalidScopedPath.statusCode).toBe(400)

    const uppercaseScopedUserId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    await app.inject({
      method: 'GET',
      url: `/base/${uppercaseScopedUserId}/ah`,
    })
    await app.inject({ method: 'GET', url: '/ah' })
    expect(protocolAuthUsers).toEqual([
      uppercaseScopedUserId.toLowerCase(),
      null,
    ])

    const rejectedOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://attacker.example' },
      payload: { username: 'admin', password: 'correct-horse-battery' },
    })
    expect(rejectedOrigin.statusCode).toBe(403)
    expect(rejectedOrigin.json().code).toBe('ORIGIN_INVALID')

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: config.PUBLIC_ORIGIN },
      payload: { username: 'admin', password: 'correct-horse-battery' },
    })
    expect(login.statusCode).toBe(200)
    const setCookie = login.headers['set-cookie']
    if (typeof setCookie !== 'string')
      throw new Error('Expected one session cookie')
    expect(setCookie).toContain(`${sessionCookieName}=`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    const cookie = setCookie.split(';')[0]
    if (!cookie) throw new Error('Expected cookie value')

    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    })
    expect(session.statusCode).toBe(200)
    expect(session.json()).toMatchObject({ username: 'admin' })

    const status = await app.inject({
      method: 'GET',
      url: '/api/v1/status',
      headers: { cookie },
    })
    expect(status.json()).toMatchObject({ syncBasePath: '/base' })

    const users = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: { cookie },
    })
    expect(users.json().data[0]).toMatchObject({
      syncPath: `/base/${disabledUserId}`,
    })

    const disableRequest = app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${disabledUserId}`,
      headers: { cookie, origin: config.PUBLIC_ORIGIN },
      payload: { enabled: false },
    })
    await closeUserStarted.promise
    expect(auditActions).not.toContain('user.update')
    closeUserFinished.resolve()
    const disabled = await disableRequest
    expect(disabled.statusCode).toBe(200)
    expect(disabled.json()).toMatchObject({
      syncPath: `/base/${disabledUserId}`,
    })
    expect(auditActions).toContain('user.update')

    const logoutWithoutOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie },
    })
    expect(logoutWithoutOrigin.statusCode).toBe(403)

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie, origin: config.PUBLIC_ORIGIN },
    })
    expect(logout.statusCode).toBe(204)
    expect(storedSessions.size).toBe(0)

    const expired = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    })
    expect(expired.statusCode).toBe(401)
  })
})
