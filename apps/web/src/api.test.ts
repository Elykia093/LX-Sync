import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api.js'

const userId = '00000000-0000-4000-8000-000000000001'
const snapshotId = '00000000-0000-4000-8000-000000000002'
const createdAt = '2026-07-23T02:00:00.000Z'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('playlist API client', () => {
  it('validates an immutable playlist detail response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        snapshotId,
        snapshotCreatedAt: createdAt,
        playlist: {
          id: 'user:road/trip',
          name: 'Road Trip',
          type: 'user',
          songCount: 1,
        },
        offset: 25,
        limit: 25,
        total: 26,
        data: [
          {
            id: 7,
            position: 26,
            name: 'Numeric song',
            singer: null,
            albumName: null,
            source: 'wy',
            interval: '03:20',
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const detail = await api.playlistSongs(userId, 'user:road/trip', {
      snapshotId,
      q: 'night song',
      offset: 25,
      limit: 25,
    })

    expect(detail.data).toEqual([
      expect.objectContaining({ id: 7, position: 26, source: 'wy' }),
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/users/${userId}/playlists/user%3Aroad%2Ftrip?snapshotId=${snapshotId}&q=night+song&offset=25&limit=25`,
      { headers: {} },
    )
  })

  it('sends strict JSON mutation bodies and parses the result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        {
          snapshotId,
          snapshotCreatedAt: createdAt,
          playlist: {
            id: 'user:new-playlist',
            name: 'New playlist',
            type: 'user',
            songCount: 0,
          },
        },
        { status: 201 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await api.createPlaylist(userId, {
      name: 'New playlist',
      expectedSnapshotId: snapshotId,
    })

    expect(result.playlist.id).toBe('user:new-playlist')
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/users/${userId}/playlists`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: 'New playlist',
          expectedSnapshotId: snapshotId,
        }),
        headers: { 'Content-Type': 'application/json' },
      },
    )
  })

  it('preserves stable Problem JSON fields on a conflict', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            status: 409,
            code: 'SNAPSHOT_CONFLICT',
            detail: 'Snapshot head changed; refresh and retry',
            requestId: 'request-1',
          },
          { status: 409 },
        ),
      ),
    )

    await expect(
      api.renamePlaylist(userId, 'user:road-trip', {
        name: 'Renamed',
        expectedSnapshotId: snapshotId,
      }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'SNAPSHOT_CONFLICT',
      message: 'Snapshot head changed; refresh and retry',
      requestId: 'request-1',
    })
  })
})
