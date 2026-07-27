import { afterEach, describe, expect, it } from 'vitest'
import type { AppConfig } from '../config.js'
import type { SnapshotRecord } from '../db/repository.js'
import type { DislikeRules, ListData, SyncDomain } from '../protocol/index.js'
import { type AppDependencies, buildApp } from './app.js'

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

const userId = '00000000-0000-4000-8000-000000000010'
const snapshotId = '00000000-0000-4000-8000-000000000011'
const snapshotCreatedAt = new Date('2026-07-23T00:00:00.000Z')

type ExportSnapshot = SnapshotRecord<ListData> & {
  authKey: string
  deviceKey: string
  payload: string
}

const exportSnapshot: ExportSnapshot = {
  id: snapshotId,
  hash: '0123456789abcdef0123456789abcdef',
  itemCount: 1,
  byteSize: 25,
  createdAt: snapshotCreatedAt,
  data: {
    defaultList: [{ id: 'song-1', title: 'Song 1' }],
    loveList: [],
    userList: [],
  },
  // These fields model values that must stay repository/server-internal.
  authKey: 'do-not-leak-auth-key',
  deviceKey: 'do-not-leak-device-key',
  payload: '{"secret":"do-not-leak-raw-payload"}',
}

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

async function createFixture(options?: {
  userExists?: boolean
  snapshot?: SnapshotRecord<ListData> | null
}) {
  const sessions = new Map<
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
  const userExists = options?.userExists ?? true
  const snapshot =
    options?.snapshot === undefined ? exportSnapshot : options.snapshot
  let getSnapshotCalls = 0

  async function getSnapshot(
    requestedUserId: string,
    domain: 'list',
    requestedSnapshotId: string,
  ): Promise<SnapshotRecord<ListData> | null>
  async function getSnapshot(
    requestedUserId: string,
    domain: 'dislike',
    requestedSnapshotId: string,
  ): Promise<SnapshotRecord<DislikeRules> | null>
  async function getSnapshot(
    requestedUserId: string,
    domain: SyncDomain,
    requestedSnapshotId: string,
  ): Promise<SnapshotRecord | null> {
    getSnapshotCalls += 1
    if (
      requestedUserId !== userId ||
      domain !== 'list' ||
      requestedSnapshotId !== snapshotId
    )
      return null
    return snapshot
  }

  const repository: AppDependencies['repository'] = {
    checkDatabase: async () => {},
    createSession: async (session) => {
      const now = new Date()
      sessions.set(session.sessionHash, {
        ...session,
        lastSeenAt: now,
        createdAt: now,
      })
    },
    getSession: async (sessionHash) => sessions.get(sessionHash),
    touchSession: async () => {},
    deleteSession: async (sessionHash) => {
      sessions.delete(sessionHash)
    },
    listUsers: async () => [],
    createUser: async () => ({ id: userId, name: 'Export user' }),
    getUserSummary: async (requestedUserId) =>
      userExists && requestedUserId === userId
        ? {
            id: userId,
            name: 'Export user',
            enabled: true,
            maxSnapshots: 10,
            addMusicLocationType: 'bottom' as const,
            deviceCount: 0,
            createdAt: snapshotCreatedAt,
          }
        : null,
    updateUser: async () => false,
    listDevices: async () => [],
    revokeDevice: async () => false,
    getHead: async () => exportSnapshot,
    saveSnapshot: (async () =>
      exportSnapshot) as unknown as AppDependencies['repository']['saveSnapshot'],
    markDeviceSnapshot: async () => {},
    listSnapshots: async () => [],
    getSnapshot,
    restoreSnapshot: async () => false,
    listAudit: async () => [],
  }
  const app = await buildApp({
    config,
    repository,
    auth: {
      authenticateHttp: async () => ({ statusCode: 401, body: 'Auth failed' }),
    },
    registry: {
      count: () => 0,
      closeUser: async () => {},
      closeDevice: async () => {},
      forUser: () => [],
      runExclusive: (_userId, task) => task(),
    },
    serverId: 'server-id',
    startedAt: snapshotCreatedAt,
  })
  apps.push(app)

  return {
    app,
    getSnapshotCalls: () => getSnapshotCalls,
  }
}

async function signIn(app: Awaited<ReturnType<typeof buildApp>>) {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: config.PUBLIC_ORIGIN },
    payload: { username: 'admin', password: 'correct-horse-battery' },
  })
  expect(login.statusCode).toBe(200)
  const setCookie = login.headers['set-cookie']
  if (typeof setCookie !== 'string') throw new Error('Expected session cookie')
  return setCookie.split(';')[0]
}

const exportPath = `/api/v1/users/${userId}/sync-domains/list/snapshots/${snapshotId}/export`

describe('snapshot export management endpoint', () => {
  it('requires an admin session before reading snapshot data', async () => {
    const fixture = await createFixture()

    const response = await fixture.app.inject({
      method: 'GET',
      url: exportPath,
    })

    expect(response.statusCode).toBe(401)
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    )
    expect(response.json()).toMatchObject({
      status: 401,
      code: 'AUTH_INVALID',
      detail: 'Authentication failed',
    })
    expect(fixture.getSnapshotCalls()).toBe(0)
    expect(response.body).not.toContain('do-not-leak')
  })

  it('does not reveal whether a snapshot exists for an unknown user', async () => {
    const fixture = await createFixture({ userExists: false })
    const cookie = await signIn(fixture.app)

    const response = await fixture.app.inject({
      method: 'GET',
      url: exportPath,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({
      status: 404,
      code: 'USER_NOT_FOUND',
      detail: 'User was not found',
    })
    expect(fixture.getSnapshotCalls()).toBe(0)
    expect(response.body).not.toContain('do-not-leak')
  })

  it('returns a generic snapshot 404 without leaking its payload', async () => {
    const fixture = await createFixture({ snapshot: null })
    const cookie = await signIn(fixture.app)

    const response = await fixture.app.inject({
      method: 'GET',
      url: exportPath,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({
      status: 404,
      code: 'SNAPSHOT_NOT_FOUND',
      detail: 'Snapshot was not found',
    })
    expect(response.body).not.toContain('do-not-leak')
  })

  it('returns a JSON attachment containing only the public snapshot envelope', async () => {
    const fixture = await createFixture()
    const cookie = await signIn(fixture.app)

    const response = await fixture.app.inject({
      method: 'GET',
      url: exportPath,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="lx-sync-list-${snapshotId}.json"`,
    )
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({
      format: 'lx-sync.snapshot',
      version: 1,
      userId,
      domain: 'list',
      snapshot: {
        id: snapshotId,
        hash: exportSnapshot.hash,
        itemCount: exportSnapshot.itemCount,
        byteSize: exportSnapshot.byteSize,
        createdAt: snapshotCreatedAt.toISOString(),
        data: exportSnapshot.data,
      },
    })
    expect(response.body).not.toContain('do-not-leak-auth-key')
    expect(response.body).not.toContain('do-not-leak-device-key')
    expect(response.body).not.toContain('do-not-leak-raw-payload')
    expect(response.body).not.toContain('"payload"')
  })
})
