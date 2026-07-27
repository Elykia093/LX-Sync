import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import {
  applyLoggedOutState,
  invalidatePlaylistManagementQueries,
  playlistOffsetForTotal,
  queryKeys,
  sessionLoginError,
  syncAddress,
} from './App.js'
import {
  ApiError,
  parsePlaylistDetail,
  parseServerStatus,
  parseSyncUser,
  playlistDetailPath,
  type Session,
  shouldExpireSession,
  snapshotExportPath,
} from './api.js'

describe('applyLoggedOutState', () => {
  it('removes protected cache data and exposes an explicit logged-out state', () => {
    const queryClient = new QueryClient()
    const session: Session = {
      username: 'admin',
      expiresAt: '2026-07-18T00:00:00.000Z',
    }
    queryClient.setQueryData(queryKeys.session, session)
    queryClient.setQueryData(queryKeys.users, { data: [{ id: 'private' }] })

    applyLoggedOutState(queryClient)

    expect(queryClient.getQueryData(queryKeys.session)).toBeNull()
    expect(queryClient.getQueryData(queryKeys.users)).toBeUndefined()
  })

  it('uses the login surface for unauthenticated or unavailable sessions', () => {
    const unauthorized = new ApiError(401, 'AUTH_INVALID', 'Unauthorized')
    const badGateway = new ApiError(502, 'HTTP_ERROR', 'Bad Gateway')
    const unavailable = new ApiError(503, 'HTTP_ERROR', 'Unavailable')

    expect(sessionLoginError(unauthorized)).toBe(unauthorized)
    expect(sessionLoginError(badGateway)).toBe(badGateway)
    expect(sessionLoginError(unavailable)).toBe(unavailable)
    expect(
      sessionLoginError(new ApiError(500, 'INTERNAL_ERROR', 'Failed')),
    ).toBeNull()
    expect(sessionLoginError(new Error('Network failed'))).toBeNull()
  })

  it('expires cached sessions only for protected unauthorized requests', () => {
    const unauthorized = new ApiError(401, 'AUTH_INVALID', 'Unauthorized')
    const forbidden = new ApiError(403, 'ORIGIN_INVALID', 'Forbidden')

    expect(shouldExpireSession('/status', unauthorized)).toBe(true)
    expect(shouldExpireSession('/auth/session', unauthorized)).toBe(true)
    expect(shouldExpireSession('/auth/login', unauthorized)).toBe(false)
    expect(shouldExpireSession('/status', forbidden)).toBe(false)
  })
})

describe('syncAddress', () => {
  it('uses a scoped path when present and preserves the root fallback', () => {
    expect(
      syncAddress(
        'https://sync.example.test',
        '/base/00000000-0000-4000-8000-000000000001',
      ),
    ).toBe(
      'https://sync.example.test/base/00000000-0000-4000-8000-000000000001',
    )
    expect(syncAddress('https://sync.example.test', null)).toBe(
      'https://sync.example.test',
    )
  })

  it('treats scoped path fields omitted by an older server as disabled', () => {
    expect(
      parseServerStatus({
        serverId: 'server',
        serverName: 'LX Sync',
        startedAt: '2026-07-18T00:00:00.000Z',
        onlineDevices: 0,
      }).syncBasePath,
    ).toBeNull()
    expect(
      parseSyncUser({
        id: '00000000-0000-4000-8000-000000000001',
        name: 'User',
        enabled: true,
        maxSnapshots: 10,
        addMusicLocationType: 'bottom',
        deviceCount: 0,
        createdAt: '2026-07-18T00:00:00.000Z',
      }).syncPath,
    ).toBeNull()
  })
})

describe('snapshotExportPath', () => {
  it('builds an authenticated same-origin export endpoint', () => {
    expect(
      snapshotExportPath(
        '00000000-0000-4000-8000-000000000001',
        'list',
        '00000000-0000-4000-8000-000000000002',
      ),
    ).toBe(
      '/api/v1/users/00000000-0000-4000-8000-000000000001/sync-domains/list/snapshots/00000000-0000-4000-8000-000000000002/export',
    )
  })
})

describe('playlistDetailPath', () => {
  it('encodes playlist identifiers and search terms for the read-only API', () => {
    expect(
      playlistDetailPath('00000000-0000-4000-8000-000000000001', 'road/trip', {
        snapshotId: '00000000-0000-4000-8000-000000000002',
        q: '夜 曲',
        offset: 25,
        limit: 25,
      }),
    ).toBe(
      '/users/00000000-0000-4000-8000-000000000001/playlists/road%2Ftrip?snapshotId=00000000-0000-4000-8000-000000000002&q=%E5%A4%9C+%E6%9B%B2&offset=25&limit=25',
    )
  })

  it('preserves numeric and string song identifiers from the API', () => {
    const detail = parsePlaylistDetail({
      snapshotId: '00000000-0000-4000-8000-000000000002',
      snapshotCreatedAt: '2026-07-23T02:00:00.000Z',
      playlist: {
        id: 'user:road-trip',
        name: 'Road Trip',
        type: 'user',
        songCount: 2,
      },
      offset: 0,
      limit: 25,
      total: 2,
      data: [
        {
          id: 7,
          position: 1,
          name: 'Numeric',
          singer: null,
          albumName: null,
          source: null,
          interval: null,
        },
        {
          id: '7',
          position: 2,
          name: 'String',
          singer: null,
          albumName: null,
          source: null,
          interval: null,
        },
      ],
    })

    expect(detail.data.map((song) => song.id)).toEqual([7, '7'])
  })

  it('moves stale pages back to the last valid page after a head change', () => {
    expect(playlistOffsetForTotal(50, 60, 25)).toBe(50)
    expect(playlistOffsetForTotal(50, 26, 25)).toBe(25)
    expect(playlistOffsetForTotal(25, 0, 25)).toBe(0)
  })
})

describe('invalidatePlaylistManagementQueries', () => {
  it('invalidates every management consumer after a write', async () => {
    const queryClient = new QueryClient()
    const userId = '00000000-0000-4000-8000-000000000001'
    const snapshotId = '00000000-0000-4000-8000-000000000002'
    const keys = [
      queryKeys.playlists(userId),
      queryKeys.playlistSongs(userId, 'user:road-trip', snapshotId, '', 0, 25),
      queryKeys.snapshots(userId, 'list'),
      queryKeys.audit,
    ] as const
    for (const key of keys) queryClient.setQueryData(key, { private: true })

    await invalidatePlaylistManagementQueries(queryClient, userId)

    for (const key of keys)
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
  })
})
