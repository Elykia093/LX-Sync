import { afterEach, describe, expect, it } from 'vitest'
import type { AppConfig } from '../config.js'
import type {
  AuditEventInput,
  PlaylistQualityUpdate,
  SnapshotRecord,
} from '../db/repository.js'
import { SnapshotConflictError } from '../db/repository.js'
import type { PlaylistQuality } from '../playlist-quality.js'
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

const userId = 'aaaaaaaa-0000-4000-8000-000000000010'
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
  const playlistQualities = new Map<string, PlaylistQuality>()
  const repositoryUserIds: string[] = []
  const exclusiveUserIds: string[] = []
  const broadcastUserIds: string[] = []

  async function saveSnapshot(input: {
    userId: string
    domain: 'list'
    data: ListData
    expectedSnapshotId?: string
    audit?: AuditEventInput
    playlistQualityUpdate?: PlaylistQualityUpdate
  }): Promise<SnapshotRecord<ListData>>
  async function saveSnapshot(input: {
    userId: string
    domain: 'dislike'
    data: DislikeRules
    expectedSnapshotId?: string
    audit?: AuditEventInput
    playlistQualityUpdate?: PlaylistQualityUpdate
  }): Promise<SnapshotRecord<DislikeRules>>
  async function saveSnapshot(input: {
    userId: string
    domain: SyncDomain
    data: ListData | DislikeRules
    expectedSnapshotId?: string
    audit?: AuditEventInput
    playlistQualityUpdate?: PlaylistQualityUpdate
  }): Promise<SnapshotRecord> {
    if (input.domain !== 'list' || typeof input.data === 'string')
      throw new Error('Unexpected dislike write')
    repositoryUserIds.push(input.userId)
    if (input.expectedSnapshotId !== head.id) throw new SnapshotConflictError()
    saves += 1
    head = listSnapshot(
      `00000000-0000-4000-8000-${String(saves + 11).padStart(12, '0')}`,
      input.data,
    )
    snapshots.set(head.id, head)
    if (input.audit) audits.push(input.audit)
    if (input.playlistQualityUpdate) {
      const { playlistId, quality } = input.playlistQualityUpdate
      if (quality === null) playlistQualities.delete(playlistId)
      else playlistQualities.set(playlistId, quality)
    }
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
    getUserSummary: async (requestedUserId) => {
      repositoryUserIds.push(requestedUserId)
      return requestedUserId === userId
        ? {
            id: userId,
            name: 'User',
            enabled: true,
            maxSnapshots: 10,
            addMusicLocationType: 'bottom' as const,
            deviceCount: 0,
            createdAt: new Date('2026-07-23T04:00:00.000Z'),
          }
        : null
    },
    updateUser: async () => false,
    listDevices: async () => [],
    revokeDevice: async () => false,
    getHead: async (_domain, requestedUserId) => {
      repositoryUserIds.push(requestedUserId)
      return head
    },
    getPlaylistQualities: async () => new Map(playlistQualities),
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
      forUser: (requestedUserId) => {
        broadcastUserIds.push(requestedUserId)
        return []
      },
      runExclusive: (requestedUserId, task) => {
        exclusiveUserIds.push(requestedUserId)
        return task()
      },
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
    repositoryUserIds,
    exclusiveUserIds,
    broadcastUserIds,
    getHead: () => head,
    getSaveCount: () => saves,
    getPlaylistQualities: () => new Map(playlistQualities),
  }
}

describe('playlist management HTTP API', () => {
  it('exports a complete historical playlist with original metadata and a safe filename', async () => {
    const metadata = {
      id: 'focus/../../"\r\nX-Filename: injected',
      name: '  历史 "歌单"\r\n名称  ',
      source: 'wy' as const,
      sourceListId: 'remote-list',
      locationUpdateTime: 123,
      extra: { retained: true, tags: ['original'] },
    }
    const songs = Array.from({ length: 125 }, (_, index) => ({
      id: index === 0 ? 2 : `song-${index}`,
      name: `Song ${index}`,
      meta: { songId: index, albumName: 'Original album', extra: [true, 0] },
      customField: { retained: true },
    }))
    const fixture = await createFixture({
      defaultList: [{ id: 'other-playlist-song' }],
      loveList: [],
      userList: [{ ...metadata, list: songs }],
    })
    const playlistId = `user:${metadata.id}`
    const playlistPath = `/api/v1/users/${userId}/playlists/${encodeURIComponent(playlistId)}`
    const changed = await fixture.app.inject({
      method: 'PATCH',
      url: playlistPath,
      headers: { cookie: fixture.cookie, origin: config.PUBLIC_ORIGIN },
      payload: {
        name: 'Current name',
        quality: 'hires',
        expectedSnapshotId: initialSnapshotId,
      },
    })
    expect(changed.statusCode).toBe(200)
    expect(fixture.getHead().id).not.toBe(initialSnapshotId)

    const filtered = await fixture.app.inject({
      method: 'GET',
      url: `${playlistPath}?snapshotId=${initialSnapshotId}&q=Song%201&limit=1`,
      headers: { cookie: fixture.cookie },
    })
    expect(filtered.statusCode).toBe(200)
    expect(filtered.json().data).toHaveLength(1)

    const response = await fixture.app.inject({
      method: 'GET',
      url: `${playlistPath}/export?snapshotId=${initialSnapshotId}`,
      headers: { cookie: fixture.cookie },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    )
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="lx-sync-playlist.json"',
    )
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.json()).toEqual({
      format: 'lx-sync.playlist',
      version: 1,
      userId,
      snapshotId: initialSnapshotId,
      snapshotCreatedAt: '2026-07-23T04:00:00.000Z',
      playlist: {
        id: playlistId,
        type: 'user',
        name: metadata.name.trim(),
        songCount: songs.length,
        metadata,
      },
      songs,
    })
    expect(fixture.getSaveCount()).toBe(1)
    expect(fixture.audits).toHaveLength(1)
    expect(fixture.broadcastUserIds).toEqual([userId])
  })

  it('exports built-in and reserved user playlist IDs independently', async () => {
    const reserved = {
      id: 'default',
      name: 'Reserved user playlist',
      locationUpdateTime: null,
      list: [{ id: 'reserved-song', meta: { retained: true } }],
    }
    const fixture = await createFixture({
      defaultList: [{ id: 2 }],
      loveList: [],
      userList: [reserved],
    })
    for (const [playlistId, songs, metadata] of [
      ['default', [{ id: 2 }], null],
      ['love', [], null],
      [
        'user:default',
        reserved.list,
        { id: reserved.id, name: reserved.name, locationUpdateTime: null },
      ],
    ] as const) {
      const response = await fixture.app.inject({
        method: 'GET',
        url: `/api/v1/users/${userId}/playlists/${encodeURIComponent(playlistId)}/export?snapshotId=${initialSnapshotId}`,
        headers: { cookie: fixture.cookie },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        playlist: { id: playlistId, songCount: songs.length, metadata },
        songs,
      })
      expect(response.json().playlist).not.toHaveProperty('quality')
    }
    expect(fixture.getSaveCount()).toBe(0)
    expect(fixture.audits).toEqual([])
    expect(fixture.broadcastUserIds).toEqual([])
  })

  it('requires authenticated export and preview requests and strict export parameters', async () => {
    const fixture = await createFixture()
    const exportPath = `/api/v1/users/${userId}/playlists/default/export`
    for (const query of [
      '',
      '?snapshotId=invalid',
      `?snapshotId=${initialSnapshotId}&snapshotId=${initialSnapshotId}`,
      ...[
        'q=2',
        'source=wy',
        'singer=test',
        'albumName=test',
        'offset=0',
        'limit=1',
        'unknown=1',
      ].map((query) => `?snapshotId=${initialSnapshotId}&${query}`),
    ]) {
      const response = await fixture.app.inject({
        method: 'GET',
        url: `${exportPath}${query}`,
        headers: { cookie: fixture.cookie },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().code).toBe('VALIDATION_FAILED')
    }
    const unauthorizedExport = await fixture.app.inject({
      method: 'GET',
      url: `${exportPath}?snapshotId=${initialSnapshotId}`,
    })
    expect(unauthorizedExport.statusCode).toBe(401)
    expect(unauthorizedExport.json().code).toBe('AUTH_INVALID')
    const unauthorizedPreview = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/users/${userId}/playlists/default/song-copy-previews`,
      headers: { origin: config.PUBLIC_ORIGIN },
      payload: {
        targetPlaylistId: 'love',
        songIds: [2],
        expectedSnapshotId: initialSnapshotId,
      },
    })
    expect(unauthorizedPreview.statusCode).toBe(401)
    expect(unauthorizedPreview.json().code).toBe('AUTH_INVALID')
    expect(fixture.getSaveCount()).toBe(0)
  })

  it('returns stable missing-resource and ambiguous-ID errors for playlist exports', async () => {
    const fixture = await createFixture()
    const missingId = '00000000-0000-4000-8000-999999999999'
    for (const [requestedUserId, playlistId, snapshotId, code] of [
      [missingId, 'default', initialSnapshotId, 'USER_NOT_FOUND'],
      [userId, 'default', missingId, 'SNAPSHOT_NOT_FOUND'],
      [userId, 'user:missing', initialSnapshotId, 'PLAYLIST_NOT_FOUND'],
    ]) {
      const response = await fixture.app.inject({
        method: 'GET',
        url: `/api/v1/users/${requestedUserId}/playlists/${encodeURIComponent(playlistId ?? '')}/export?snapshotId=${snapshotId}`,
        headers: { cookie: fixture.cookie },
      })
      expect(response.statusCode).toBe(404)
      expect(response.json().code).toBe(code)
      expect(response.headers['content-disposition']).toBeUndefined()
    }
    const duplicate = {
      id: 'duplicate',
      name: 'Duplicate',
      locationUpdateTime: null,
      list: [],
    }
    const ambiguous = await createFixture({
      defaultList: [],
      loveList: [],
      userList: [duplicate, { ...duplicate }],
    })
    const response = await ambiguous.app.inject({
      method: 'GET',
      url: `/api/v1/users/${userId}/playlists/user%3Aduplicate/export?snapshotId=${initialSnapshotId}`,
      headers: { cookie: ambiguous.cookie },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('PLAYLIST_ID_AMBIGUOUS')
    expect(ambiguous.getSaveCount()).toBe(0)
  })

  it('previews typed duplicates without side effects and reports actual copy counts', async () => {
    const songs = [
      { id: 2, meta: { original: 'number' } },
      { id: '2', meta: { original: 'string' } },
      { id: 'fresh', customField: ['preserved'] },
    ]
    const fixture = await createFixture({
      defaultList: songs,
      loveList: [{ id: 2, meta: { original: 'target' } }],
      userList: [],
    })
    const headers = { cookie: fixture.cookie, origin: config.PUBLIC_ORIGIN }
    const basePath = `/api/v1/users/${userId.toUpperCase()}/playlists/default`
    const payload = {
      targetPlaylistId: 'love',
      songIds: ['fresh', 2, '2'],
      expectedSnapshotId: initialSnapshotId,
    }
    const preview = await fixture.app.inject({
      method: 'POST',
      url: `${basePath}/song-copy-previews`,
      headers,
      payload,
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.headers['cache-control']).toBe('no-store')
    expect(preview.json()).toEqual({
      snapshotId: initialSnapshotId,
      snapshotCreatedAt: '2026-07-23T04:00:00.000Z',
      sourcePlaylistId: 'default',
      targetPlaylistId: 'love',
      requestedSongCount: 3,
      addedSongCount: 2,
      skippedSongCount: 1,
      existingSongIds: [2],
    })
    expect(fixture.getSaveCount()).toBe(0)
    expect(fixture.audits).toEqual([])
    expect(fixture.broadcastUserIds).toEqual([])
    expect(fixture.exclusiveUserIds).toEqual([userId])

    const copied = await fixture.app.inject({
      method: 'POST',
      url: `${basePath}/song-copies`,
      headers,
      payload,
    })
    expect(copied.statusCode).toBe(200)
    expect(copied.json()).toMatchObject({
      affectedSongCount: 3,
      addedSongCount: 2,
      skippedSongCount: 1,
    })
    expect(fixture.getHead().data.defaultList).toEqual(songs)
    expect(fixture.getHead().data.loveList).toEqual([
      { id: 2, meta: { original: 'target' } },
      songs[2],
      songs[1],
    ])

    const currentPayload = {
      ...payload,
      expectedSnapshotId: fixture.getHead().id,
    }
    const repeatedPreview = await fixture.app.inject({
      method: 'POST',
      url: `${basePath}/song-copy-previews`,
      headers,
      payload: currentPayload,
    })
    expect(repeatedPreview.statusCode).toBe(200)
    expect(repeatedPreview.json()).toMatchObject({
      requestedSongCount: 3,
      addedSongCount: 0,
      skippedSongCount: 3,
      existingSongIds: ['fresh', 2, '2'],
    })
    const repeatedCopy = await fixture.app.inject({
      method: 'POST',
      url: `${basePath}/song-copies`,
      headers,
      payload: currentPayload,
    })
    expect(repeatedCopy.statusCode).toBe(200)
    expect(repeatedCopy.json()).toMatchObject({
      affectedSongCount: 3,
      addedSongCount: 0,
      skippedSongCount: 3,
    })
    expect(fixture.getSaveCount()).toBe(2)
    expect(fixture.audits.map((audit) => audit.action)).toEqual([
      'playlist.songs.copy',
      'playlist.songs.copy',
    ])
    expect(fixture.broadcastUserIds).toEqual([userId, userId])
  })

  it('rejects invalid preview bodies and stale heads without creating mutations', async () => {
    const fixture = await createFixture()
    const url = `/api/v1/users/${userId}/playlists/default/song-copy-previews`
    const headers = { cookie: fixture.cookie, origin: config.PUBLIC_ORIGIN }
    const payload = {
      targetPlaylistId: 'love',
      songIds: [2],
      expectedSnapshotId: initialSnapshotId,
    }
    for (const invalidPayload of [
      { ...payload, unknown: true },
      { ...payload, songIds: [2, 2] },
      { ...payload, songIds: [] },
      {
        ...payload,
        songIds: Array.from({ length: 10_001 }, (_, index) => index),
      },
      { ...payload, songIds: [null] },
      { ...payload, expectedSnapshotId: 'invalid' },
      { ...payload, targetPlaylistId: '' },
    ]) {
      const rejected = await fixture.app.inject({
        method: 'POST',
        url,
        headers,
        payload: invalidPayload,
      })
      expect(rejected.statusCode).toBe(400)
      expect(rejected.json().code).toBe('VALIDATION_FAILED')
    }
    const noOrigin = await fixture.app.inject({
      method: 'POST',
      url,
      headers: { cookie: fixture.cookie },
      payload,
    })
    expect(noOrigin.statusCode).toBe(403)
    expect(noOrigin.json().code).toBe('ORIGIN_INVALID')
    const tooLarge = await fixture.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { ...payload, songIds: ['x'.repeat(1024 * 1024)] },
    })
    expect(tooLarge.statusCode).toBe(413)
    expect(tooLarge.json().code).toBe('PAYLOAD_TOO_LARGE')
    const stale = await fixture.app.inject({
      method: 'POST',
      url,
      headers,
      payload: {
        ...payload,
        expectedSnapshotId: '00000000-0000-4000-8000-999999999999',
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().code).toBe('SNAPSHOT_CONFLICT')
    expect(fixture.getSaveCount()).toBe(0)
    expect(fixture.audits).toEqual([])
    expect(fixture.broadcastUserIds).toEqual([])
  })

  it('shares copy capacity checks while allowing duplicate-only previews at the limit', async () => {
    const fixture = await createFixture({
      defaultList: [{ id: 2 }],
      loveList: Array.from({ length: 9999 }, (_, index) => ({
        id: index === 0 ? 2 : `existing-${index}`,
      })),
      userList: [
        { id: 'target', name: 'Target', locationUpdateTime: null, list: [] },
      ],
    })
    const headers = { cookie: fixture.cookie, origin: config.PUBLIC_ORIGIN }
    const basePath = `/api/v1/users/${userId}/playlists/default`
    const payload = {
      targetPlaylistId: 'user:target',
      songIds: [2],
      expectedSnapshotId: initialSnapshotId,
    }
    for (const action of ['song-copy-previews', 'song-copies']) {
      const rejected = await fixture.app.inject({
        method: 'POST',
        url: `${basePath}/${action}`,
        headers,
        payload,
      })
      expect(rejected.statusCode).toBe(409)
      expect(rejected.json().code).toBe('PLAYLIST_CAPACITY_EXCEEDED')
    }
    const allowed = await fixture.app.inject({
      method: 'POST',
      url: `${basePath}/song-copy-previews`,
      headers,
      payload: { ...payload, targetPlaylistId: 'love' },
    })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json()).toMatchObject({
      addedSongCount: 0,
      skippedSongCount: 1,
      existingSongIds: [2],
    })
    expect(fixture.getSaveCount()).toBe(0)
    expect(fixture.audits).toEqual([])
  })

  it('canonicalizes uppercase user UUIDs before writes and broadcasts', async () => {
    const fixture = await createFixture()
    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/users/${userId.toUpperCase()}/playlists`,
      headers: { cookie: fixture.cookie, origin: config.PUBLIC_ORIGIN },
      payload: {
        name: 'Canonical user',
        expectedSnapshotId: initialSnapshotId,
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.headers.location).toContain(`/api/v1/users/${userId}/`)
    expect(fixture.exclusiveUserIds).toEqual([userId])
    expect(fixture.repositoryUserIds).toEqual([userId, userId, userId])
    expect(fixture.broadcastUserIds).toEqual([userId])
  })

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

  it('validates and combines playlist-scoped song filters', async () => {
    const fixture = await createFixture({
      defaultList: [
        {
          id: 'match',
          name: 'Filtered song',
          singer: 'Target Artist',
          source: 'wy',
          meta: { albumName: 'Target Album' },
        },
        {
          id: 'other-source',
          name: 'Filtered song',
          singer: 'Target Artist',
          source: 'tx',
          meta: { albumName: 'Target Album' },
        },
      ],
      loveList: [],
      userList: [],
    })
    const response = await fixture.app.inject({
      method: 'GET',
      url: `/api/v1/users/${userId}/playlists/default?snapshotId=${initialSnapshotId}&q=filtered&source=wy&singer=target&albumName=album&offset=0&limit=25`,
      headers: { cookie: fixture.cookie },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      total: 1,
      data: [{ id: 'match', position: 1, source: 'wy' }],
    })

    const invalidSource = await fixture.app.inject({
      method: 'GET',
      url: `/api/v1/users/${userId}/playlists/default?snapshotId=${initialSnapshotId}&source=local`,
      headers: { cookie: fixture.cookie },
    })
    expect(invalidSource.statusCode).toBe(400)
    expect(invalidSource.json().code).toBe('VALIDATION_FAILED')

    const unknownFilter = await fixture.app.inject({
      method: 'GET',
      url: `/api/v1/users/${userId}/playlists/default?snapshotId=${initialSnapshotId}&artist=target`,
      headers: { cookie: fixture.cookie },
    })
    expect(unknownFilter.statusCode).toBe(400)
    expect(unknownFilter.json().code).toBe('VALIDATION_FAILED')
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

  it('updates a user playlist quality without changing the LX source fields', async () => {
    const fixture = await createFixture({
      defaultList: [],
      loveList: [],
      userList: [
        {
          id: 'target',
          name: 'Target',
          source: 'wy',
          sourceListId: 'remote-list',
          locationUpdateTime: null,
          list: [],
        },
      ],
    })
    const headers = { cookie: fixture.cookie, origin: config.PUBLIC_ORIGIN }
    const response = await fixture.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${userId}/playlists/user%3Atarget`,
      headers,
      payload: {
        name: 'Target',
        quality: 'hires',
        expectedSnapshotId: initialSnapshotId,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().playlist).toMatchObject({
      id: 'user:target',
      quality: 'hires',
    })
    expect(fixture.getHead().data.userList[0]).toMatchObject({
      source: 'wy',
      sourceListId: 'remote-list',
    })
    expect(fixture.audits).toEqual([
      expect.objectContaining({ action: 'playlist.update' }),
    ])

    const invalid = await fixture.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${userId}/playlists/user%3Atarget`,
      headers,
      payload: {
        name: 'Target',
        quality: 'invalid',
        expectedSnapshotId: fixture.getHead().id,
      },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().code).toBe('VALIDATION_FAILED')

    const createWithQuality = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/users/${userId}/playlists`,
      headers,
      payload: {
        name: 'Unexpected quality',
        quality: 'hires',
        expectedSnapshotId: fixture.getHead().id,
      },
    })
    expect(createWithQuality.statusCode).toBe(400)
    expect(createWithQuality.json().code).toBe('VALIDATION_FAILED')
    expect(fixture.getSaveCount()).toBe(1)

    const clear = await fixture.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${userId}/playlists/user%3Atarget`,
      headers,
      payload: {
        name: 'Target',
        quality: null,
        expectedSnapshotId: fixture.getHead().id,
      },
    })
    expect(clear.statusCode).toBe(200)
    expect(clear.json().playlist.quality).toBeNull()
    expect(fixture.getPlaylistQualities().has('target')).toBe(false)
  })

  it('adds a strictly validated platform song to a user playlist', async () => {
    const fixture = await createFixture({
      defaultList: [],
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
    const headers = { cookie: fixture.cookie, origin: config.PUBLIC_ORIGIN }
    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/users/${userId}/playlists/user%3Atarget/songs`,
      headers,
      payload: {
        id: 123456,
        source: 'wy',
        name: 'Added song',
        singer: 'Added singer',
        albumName: 'Added album',
        interval: '04:12',
        expectedSnapshotId: initialSnapshotId,
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.headers.location).toContain(
      `/api/v1/users/${userId}/playlists/user%3Atarget`,
    )
    expect(response.json()).toMatchObject({ affectedSongCount: 1 })
    expect(response.json()).not.toHaveProperty('addedSongCount')
    expect(response.json()).not.toHaveProperty('skippedSongCount')
    expect(fixture.getHead().data.userList[0]?.list[0]).toMatchObject({
      id: 123456,
      source: 'wy',
      meta: { songId: 123456, albumName: 'Added album' },
    })
    expect(fixture.audits).toEqual([
      expect.objectContaining({
        action: 'playlist.songs.add',
        metadata: {
          domain: 'list',
          affectedPlaylistCount: 1,
          affectedSongCount: 1,
        },
      }),
    ])
    expect(JSON.stringify(fixture.audits)).not.toContain('Added song')

    for (const invalidPayload of [
      {
        id: 'unknown_track',
        source: 'wy',
        name: 'Invalid ID',
        singer: 'Singer',
      },
      {
        id: 'track.mp3',
        source: 'wy',
        name: 'Filename fallback',
        singer: 'Singer',
      },
      {
        id: '---',
        source: 'wy',
        name: 'Separator-only ID',
        singer: 'Singer',
      },
      {
        id: 'valid-id',
        source: 'local',
        name: 'Invalid source',
        singer: 'Singer',
      },
      {
        id: 'valid-id',
        source: 'wy',
        name: 'Unknown field',
        singer: 'Singer',
        metadata: { injected: true },
      },
    ]) {
      const rejected = await fixture.app.inject({
        method: 'POST',
        url: `/api/v1/users/${userId}/playlists/user%3Atarget/songs`,
        headers,
        payload: {
          ...invalidPayload,
          expectedSnapshotId: fixture.getHead().id,
        },
      })
      expect(rejected.statusCode).toBe(400)
      expect(rejected.json().code).toBe('VALIDATION_FAILED')
    }
    expect(fixture.getSaveCount()).toBe(1)
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
    expect(removed.json()).not.toHaveProperty('addedSongCount')
    expect(removed.json()).not.toHaveProperty('skippedSongCount')
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
    expect(moved.json()).not.toHaveProperty('addedSongCount')
    expect(moved.json()).not.toHaveProperty('skippedSongCount')
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
