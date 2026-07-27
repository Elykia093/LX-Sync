import { afterEach, describe, expect, it } from 'vitest'
import type { AppConfig } from '../config.js'
import type { AuditEventInput, SnapshotRecord } from '../db/repository.js'
import { SnapshotConflictError } from '../db/repository.js'
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
  LOG_LEVEL: 'silent',
} satisfies AppConfig

const userId = '00000000-0000-4000-8000-000000000010'
const initialSnapshotId = '00000000-0000-4000-8000-000000000011'
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function listSnapshot(id: string, data: ListData): SnapshotRecord<ListData> {
  return {
    id,
    hash: id,
    data,
    createdAt: new Date('2026-07-23T04:00:00.000Z'),
    itemCount: 1,
    byteSize: 100,
  }
}

async function createFixture(
  initialData: ListData = {
    defaultList: [{ id: 2, name: 'Numeric song', privateField: 'hidden' }],
    loveList: [],
    userList: [],
  },
) {
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
  const snapshots = new Map<string, SnapshotRecord<ListData>>()
  let head = listSnapshot(initialSnapshotId, initialData)
  snapshots.set(head.id, head)
  let saves = 0
  const audits: AuditEventInput[] = []

  async function saveSnapshot(input: {
    userId: string
    domain: 'list'
    data: ListData
    expectedSnapshotId?: string
    audit?: AuditEventInput
  }): Promise<SnapshotRecord<ListData>>
  async function saveSnapshot(input: {
    userId: string
    domain: 'dislike'
    data: DislikeRules
    expectedSnapshotId?: string
    audit?: AuditEventInput
  }): Promise<SnapshotRecord<DislikeRules>>
  async function saveSnapshot(input: {
    userId: string
    domain: SyncDomain
    data: ListData | DislikeRules
    expectedSnapshotId?: string
    audit?: AuditEventInput
  }): Promise<SnapshotRecord> {
    if (input.domain !== 'list' || typeof input.data === 'string')
      throw new Error('Unexpected dislike write')
    if (input.expectedSnapshotId !== head.id) throw new SnapshotConflictError()
    saves += 1
    head = listSnapshot(
      `00000000-0000-4000-8000-${String(saves + 11).padStart(12, '0')}`,
      input.data,
    )
    snapshots.set(head.id, head)
    if (input.audit) audits.push(input.audit)
    return head
  }

  async function getSnapshot(
    requestedUserId: string,
    domain: 'list',
    snapshotId: string,
  ): Promise<SnapshotRecord<ListData> | null>
  async function getSnapshot(
    requestedUserId: string,
    domain: 'dislike',
    snapshotId: string,
  ): Promise<SnapshotRecord<DislikeRules> | null>
  async function getSnapshot(
    requestedUserId: string,
    domain: SyncDomain,
    snapshotId: string,
  ): Promise<SnapshotRecord | null> {
    if (requestedUserId !== userId || domain !== 'list') return null
    return snapshots.get(snapshotId) ?? null
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
    createUser: async () => ({ id: userId, name: 'User' }),
    getUserSummary: async (requestedUserId) =>
      requestedUserId === userId
        ? {
            id: userId,
            name: 'User',
            enabled: true,
            maxSnapshots: 10,
            addMusicLocationType: 'bottom' as const,
            deviceCount: 0,
            createdAt: new Date('2026-07-23T04:00:00.000Z'),
          }
        : null,
    updateUser: async () => false,
    listDevices: async () => [],
    revokeDevice: async () => false,
    getHead: async () => head,
    saveSnapshot,
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
      runExclusive: (_requestedUserId, task) => task(),
    },
    serverId: 'server-id',
    startedAt: new Date('2026-07-23T04:00:00.000Z'),
  })
  apps.push(app)

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: config.PUBLIC_ORIGIN },
    payload: { username: 'admin', password: 'correct-horse-battery' },
  })
  const setCookie = login.headers['set-cookie']
  if (typeof setCookie !== 'string') throw new Error('Expected session cookie')

  return {
    app,
    cookie: setCookie.split(';')[0],
    audits,
    getHead: () => head,
    getSaveCount: () => saves,
  }
}

describe('playlist management HTTP API', () => {
  it('binds song details to the requested immutable snapshot', async () => {
    const fixture = await createFixture()
    const missingSnapshot = await fixture.app.inject({
      method: 'GET',
      url: `/api/v1/users/${userId}/playlists/default`,
      headers: { cookie: fixture.cookie },
    })
    expect(missingSnapshot.statusCode).toBe(400)

    const response = await fixture.app.inject({
      method: 'GET',
      url: `/api/v1/users/${userId}/playlists/default?snapshotId=${initialSnapshotId}&q=2&offset=0&limit=25`,
      headers: { cookie: fixture.cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      snapshotId: initialSnapshotId,
      total: 1,
      data: [{ id: 2, position: 1, name: 'Numeric song' }],
    })
    expect(response.body).not.toContain('privateField')
  })

  it('routes playlist IDs across the full LX identifier length boundary', async () => {
    const rawIds = ['a'.repeat(96), 'b'.repeat(1024)]
    const fixture = await createFixture({
      defaultList: [],
      loveList: [],
      userList: rawIds.map((id) => ({
        id,
        name: 'Long identifier',
        locationUpdateTime: null,
        list: [],
      })),
    })

    for (const rawId of rawIds) {
      const playlistId = encodeURIComponent(`user:${rawId}`)
      const response = await fixture.app.inject({
        method: 'GET',
        url: `/api/v1/users/${userId}/playlists/${playlistId}?snapshotId=${initialSnapshotId}`,
        headers: { cookie: fixture.cookie },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().playlist.id).toBe(`user:${rawId}`)
    }

    const overRouterLimit = encodeURIComponent('x'.repeat(2049))
    const rejected = await fixture.app.inject({
      method: 'GET',
      url: `/api/v1/users/${userId}/playlists/${overRouterLimit}?snapshotId=${initialSnapshotId}`,
      headers: { cookie: fixture.cookie },
    })
    expect([404, 414]).toContain(rejected.statusCode)
  })

  it('creates a namespaced user playlist and records a controlled audit', async () => {
    const fixture = await createFixture()
    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/users/${userId}/playlists`,
      headers: { cookie: fixture.cookie, origin: config.PUBLIC_ORIGIN },
      payload: {
        name: 'Road trip',
        expectedSnapshotId: initialSnapshotId,
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      playlist: { name: 'Road trip', type: 'user', songCount: 0 },
    })
    expect(response.json().playlist.id).toMatch(/^user:[0-9a-f-]{36}$/)
    expect(fixture.getHead().data.userList).toHaveLength(1)
    expect(fixture.audits).toEqual([
      expect.objectContaining({
        action: 'playlist.create',
        metadata: {
          domain: 'list',
          affectedPlaylistCount: 1,
          affectedSongCount: 0,
        },
      }),
    ])
    expect(JSON.stringify(fixture.audits)).not.toContain('Road trip')
  })

  it('routes rename, copy, remove, move, and delete mutations through successive snapshots', async () => {
    const fixture = await createFixture({
      defaultList: [
        { id: 2, name: 'Numeric song', privateField: { preserved: true } },
        { id: 'song-3', name: 'Movable song' },
      ],
      loveList: [],
      userList: [
        {
          id: 'target',
          name: 'Target',
          locationUpdateTime: null,
          list: [],
        },
      ],
    })
    const mutationHeaders = {
      cookie: fixture.cookie,
      origin: config.PUBLIC_ORIGIN,
    }

    const renamed = await fixture.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${userId}/playlists/user%3Atarget`,
      headers: mutationHeaders,
      payload: {
        name: 'Renamed target',
        expectedSnapshotId: fixture.getHead().id,
      },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().playlist.name).toBe('Renamed target')

    const copied = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/users/${userId}/playlists/default/song-copies`,
      headers: mutationHeaders,
      payload: {
        targetPlaylistId: 'user:target',
        songIds: [2],
        expectedSnapshotId: fixture.getHead().id,
      },
    })
    expect(copied.statusCode).toBe(200)
    expect(copied.json().affectedSongCount).toBe(1)
    expect(fixture.getHead().data.userList[0]?.list).toEqual([
      expect.objectContaining({
        id: 2,
        privateField: { preserved: true },
      }),
    ])

    const removed = await fixture.app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${userId}/playlists/user%3Atarget/songs`,
      headers: mutationHeaders,
      payload: {
        songIds: [2],
        expectedSnapshotId: fixture.getHead().id,
      },
    })
    expect(removed.statusCode).toBe(200)
    expect(removed.json().affectedSongCount).toBe(1)
    expect(fixture.getHead().data.userList[0]?.list).toEqual([])

    const moved = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/users/${userId}/playlists/default/song-moves`,
      headers: mutationHeaders,
      payload: {
        targetPlaylistId: 'user:target',
        songIds: ['song-3'],
        expectedSnapshotId: fixture.getHead().id,
      },
    })
    expect(moved.statusCode).toBe(200)
    expect(moved.json().affectedSongCount).toBe(1)
    expect(fixture.getHead().data.defaultList).toEqual([
      expect.objectContaining({ id: 2 }),
    ])
    expect(fixture.getHead().data.userList[0]?.list).toEqual([
      expect.objectContaining({ id: 'song-3' }),
    ])

    const deleted = await fixture.app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${userId}/playlists/user%3Atarget`,
      headers: mutationHeaders,
      payload: { expectedSnapshotId: fixture.getHead().id },
    })
    expect(deleted.statusCode).toBe(200)
    expect(fixture.getHead().data.userList).toEqual([])
    expect(fixture.getSaveCount()).toBe(5)
    expect(fixture.audits.map((audit) => audit.action)).toEqual([
      'playlist.rename',
      'playlist.songs.copy',
      'playlist.songs.remove',
      'playlist.songs.move',
      'playlist.delete',
    ])
  })

  it('returns stable Origin, validation, immutable, and conflict errors without writes', async () => {
    const fixture = await createFixture()
    const noOrigin = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/users/${userId}/playlists`,
      headers: { cookie: fixture.cookie },
      payload: { name: 'No origin', expectedSnapshotId: initialSnapshotId },
    })
    expect(noOrigin.statusCode).toBe(403)
    expect(noOrigin.json().code).toBe('ORIGIN_INVALID')

    const duplicateSongs = await fixture.app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${userId}/playlists/default/songs`,
      headers: { cookie: fixture.cookie, origin: config.PUBLIC_ORIGIN },
      payload: {
        songIds: [2, 2],
        expectedSnapshotId: initialSnapshotId,
      },
    })
    expect(duplicateSongs.statusCode).toBe(400)
    expect(duplicateSongs.json().code).toBe('VALIDATION_FAILED')

    const longName = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/users/${userId}/playlists`,
      headers: { cookie: fixture.cookie, origin: config.PUBLIC_ORIGIN },
      payload: {
        name: 'a'.repeat(65),
        expectedSnapshotId: initialSnapshotId,
      },
    })
    expect(longName.statusCode).toBe(400)
    expect(longName.json().code).toBe('VALIDATION_FAILED')

    const immutable = await fixture.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${userId}/playlists/default`,
      headers: { cookie: fixture.cookie, origin: config.PUBLIC_ORIGIN },
      payload: { name: 'Renamed', expectedSnapshotId: initialSnapshotId },
    })
    expect(immutable.statusCode).toBe(409)
    expect(immutable.json().code).toBe('PLAYLIST_IMMUTABLE')

    const stale = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/users/${userId}/playlists`,
      headers: { cookie: fixture.cookie, origin: config.PUBLIC_ORIGIN },
      payload: {
        name: 'Stale',
        expectedSnapshotId: '00000000-0000-4000-8000-999999999999',
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().code).toBe('SNAPSHOT_CONFLICT')
    expect(fixture.getSaveCount()).toBe(0)
  })
})
