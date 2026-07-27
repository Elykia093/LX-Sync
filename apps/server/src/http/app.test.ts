import { afterEach, describe, expect, it } from 'vitest'
import type { AppConfig } from '../config.js'
import type { SnapshotRecord } from '../db/repository.js'
import type { ListData } from '../protocol/index.js'
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
    const createdUserId = '00000000-0000-4000-8000-000000000002'
    const auditActions: string[] = []
    const createdAuthKeys: string[] = []
    const closeUserStarted = Promise.withResolvers<void>()
    const closeUserFinished = Promise.withResolvers<void>()
    const protocolAuthUsers: Array<string | null> = []
    const listHead: SnapshotRecord<ListData> = {
      id: '00000000-0000-4000-8000-000000000003',
      hash: 'list-head-hash',
      itemCount: 2,
      byteSize: 128,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      data: {
        defaultList: [
          { id: 'song-1', name: 'First Song', singer: 'Singer A' },
          { id: 'song-2', name: 'Second Song', singer: 'Singer B' },
        ],
        loveList: [],
        userList: [],
      },
    }

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
      createUser: async (input, audit) => {
        createdAuthKeys.push(input.authKey)
        if (audit) auditActions.push(audit.action)
        return {
          id: createdUserId,
          name: 'test',
        }
      },
      getUserSummary: async (userId) => {
        if (userId === disabledUserId)
          return {
            id: disabledUserId,
            name: 'disabled user',
            enabled: false,
            maxSnapshots: 10,
            addMusicLocationType: 'bottom',
            deviceCount: 1,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          }
        if (userId === createdUserId)
          return {
            id: createdUserId,
            name: 'test',
            enabled: true,
            maxSnapshots: 10,
            addMusicLocationType: 'bottom',
            deviceCount: 0,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          }
        return null
      },
      updateUser: async (userId, _patch, audit) => {
        if (userId !== disabledUserId) return false
        if (audit) auditActions.push(audit.action)
        return true
      },
      listDevices: async () => [],
      revokeDevice: async () => false,
      getHead: async () => listHead,
      saveSnapshot: (async () =>
        listHead) as unknown as AppDependencies['repository']['saveSnapshot'],
      markDeviceSnapshot: async () => {},
      listSnapshots: async () => [],
      getSnapshot: (async (
        _userId: string,
        domain: string,
        snapshotId: string,
      ) =>
        domain === 'list' && snapshotId === listHead.id
          ? listHead
          : null) as unknown as AppDependencies['repository']['getSnapshot'],
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
        forUser: () => [],
        runExclusive: (_userId, task) => task(),
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

    const invalidJson = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: {
        'content-type': 'application/json',
        origin: config.PUBLIC_ORIGIN,
      },
      payload: '{"username":',
    })
    expect(invalidJson.statusCode).toBe(400)
    expect(invalidJson.headers['content-type']).toContain(
      'application/problem+json',
    )
    expect(invalidJson.json()).toMatchObject({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      code: 'INVALID_JSON',
      detail: 'Request body is not valid JSON',
    })

    const emptyJson = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: {
        'content-type': 'application/json',
        origin: config.PUBLIC_ORIGIN,
      },
      payload: '',
    })
    expect(emptyJson.statusCode).toBe(400)
    expect(emptyJson.json().code).toBe('INVALID_JSON')

    const oversizedJson = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: {
        'content-type': 'application/json',
        origin: config.PUBLIC_ORIGIN,
      },
      payload: `"${'a'.repeat(1024 * 1024)}"`,
    })
    expect(oversizedJson.statusCode).toBe(413)
    expect(oversizedJson.json()).toMatchObject({
      title: 'Payload Too Large',
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      detail: 'Request body exceeds the allowed size',
    })

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

    const playlists = await app.inject({
      method: 'GET',
      url: `/api/v1/users/${disabledUserId}/playlists`,
      headers: { cookie },
    })
    expect(playlists.statusCode).toBe(200)
    expect(playlists.json()).toMatchObject({
      snapshotId: listHead.id,
      data: [
        { id: 'default', songCount: 2 },
        { id: 'love', songCount: 0 },
      ],
    })

    const playlistSongs = await app.inject({
      method: 'GET',
      url: `/api/v1/users/${disabledUserId}/playlists/default?snapshotId=${listHead.id}&q=second&offset=0&limit=1`,
      headers: { cookie },
    })
    expect(playlistSongs.statusCode).toBe(200)
    expect(playlistSongs.json()).toMatchObject({
      playlist: { id: 'default', songCount: 2 },
      offset: 0,
      limit: 1,
      total: 1,
      data: [{ id: 'song-2', position: 2, name: 'Second Song' }],
    })

    const missingPlaylist = await app.inject({
      method: 'GET',
      url: `/api/v1/users/${disabledUserId}/playlists/missing?snapshotId=${listHead.id}`,
      headers: { cookie },
    })
    expect(missingPlaylist.statusCode).toBe(404)
    expect(missingPlaylist.json().code).toBe('PLAYLIST_NOT_FOUND')

    const invalidPlaylistOffset = await app.inject({
      method: 'GET',
      url: `/api/v1/users/${disabledUserId}/playlists/default?snapshotId=${listHead.id}&offset=10001`,
      headers: { cookie },
    })
    expect(invalidPlaylistOffset.statusCode).toBe(400)

    const acceptedConnectionCodes = ['密', ' ', `! ${'x'.repeat(257)} 🙂`]
    for (const [index, connectionCode] of acceptedConnectionCodes.entries()) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { cookie, origin: config.PUBLIC_ORIGIN },
        payload: {
          name: `unrestricted-code-${index}`,
          connectionCode,
        },
      })
      expect(created.statusCode).toBe(201)
      expect(created.body).not.toContain(connectionCode)
    }
    expect(createdAuthKeys).toHaveLength(acceptedConnectionCodes.length)

    const emptyConnectionCode = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { cookie, origin: config.PUBLIC_ORIGIN },
      payload: { name: 'empty-code', connectionCode: '' },
    })
    expect(emptyConnectionCode.statusCode).toBe(400)

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

    const rotated = await app.inject({
      method: 'PUT',
      url: `/api/v1/users/${disabledUserId}/connection-credential`,
      headers: { cookie, origin: config.PUBLIC_ORIGIN },
      payload: { connectionCode: ` ${'y'.repeat(257)} 符号!` },
    })
    expect(rotated.statusCode).toBe(204)

    const emptyRotation = await app.inject({
      method: 'PUT',
      url: `/api/v1/users/${disabledUserId}/connection-credential`,
      headers: { cookie, origin: config.PUBLIC_ORIGIN },
      payload: { connectionCode: '' },
    })
    expect(emptyRotation.statusCode).toBe(400)

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
