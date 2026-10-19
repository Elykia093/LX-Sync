import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, playlistExportPath } from './api.js'

const userId = '00000000-0000-4000-8000-000000000001'
const snapshotId = '00000000-0000-4000-8000-000000000002'
const createdAt = '2026-07-23T02:00:00.000Z'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('playlist API client', () => {
  it('exports the complete playlist from a fixed snapshot with encoded identifiers', () => {
    expect(playlistExportPath(userId, 'user:旅行/#?', snapshotId)).toBe(
      `/api/v1/users/${userId}/playlists/user%3A%E6%97%85%E8%A1%8C%2F%23%3F/export?snapshotId=${snapshotId}`,
    )
  })

  it('validates a typed copy preview and forwards query cancellation', async () => {
    const controller = new AbortController()
    const preview = {
      snapshotId,
      snapshotCreatedAt: createdAt,
      sourcePlaylistId: 'user:road/trip',
      targetPlaylistId: 'love',
      requestedSongCount: 2,
      addedSongCount: 1,
      skippedSongCount: 1,
      existingSongIds: [2],
    }
    const fetchMock = vi.fn().mockResolvedValue(Response.json(preview))
    vi.stubGlobal('fetch', fetchMock)
    const input = {
      targetPlaylistId: 'love',
      songIds: [2, '2'],
      expectedSnapshotId: snapshotId,
    }

    expect(
      await api.previewPlaylistSongCopy(
        userId,
        'user:road/trip',
        input,
        controller.signal,
      ),
    ).toEqual(preview)
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/users/${userId}/playlists/user%3Aroad%2Ftrip/song-copy-previews`,
      {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      },
    )
  })

  it.each([
    { snapshotId: userId },
    { sourcePlaylistId: 'other' },
    { targetPlaylistId: 'other' },
    { requestedSongCount: 2, addedSongCount: 1 },
    { addedSongCount: -1 },
    { addedSongCount: 1 },
    { existingSongIds: ['2'] },
    { existingSongIds: [2, 2], skippedSongCount: 2, requestedSongCount: 2 },
    { existingSongIds: [] },
  ])(
    'rejects a copy preview that does not describe the current selection: %j',
    async (change) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          Response.json({
            snapshotId,
            snapshotCreatedAt: createdAt,
            sourcePlaylistId: 'default',
            targetPlaylistId: 'love',
            requestedSongCount: 1,
            addedSongCount: 0,
            skippedSongCount: 1,
            existingSongIds: [2],
            ...change,
          }),
        ),
      )

      await expect(
        api.previewPlaylistSongCopy(userId, 'default', {
          targetPlaylistId: 'love',
          songIds: [2],
          expectedSnapshotId: snapshotId,
        }),
      ).rejects.toThrow()
    },
  )

  it('keeps copy counts separate from the existing affected count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          snapshotId,
          snapshotCreatedAt: createdAt,
          affectedSongCount: 2,
          addedSongCount: 0,
          skippedSongCount: 2,
        }),
      ),
    )
    expect(
      await api.copyPlaylistSongs(userId, 'default', {
        targetPlaylistId: 'love',
        songIds: [2, '2'],
        expectedSnapshotId: snapshotId,
      }),
    ).toMatchObject({
      affectedSongCount: 2,
      addedSongCount: 0,
      skippedSongCount: 2,
    })
  })

  it('does not invent added or skipped counts for an older copy response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          snapshotId,
          snapshotCreatedAt: createdAt,
          affectedSongCount: 2,
        }),
      ),
    )
    expect(
      await api.copyPlaylistSongs(userId, 'default', {
        targetPlaylistId: 'love',
        songIds: [2, '2'],
        expectedSnapshotId: snapshotId,
      }),
    ).toMatchObject({
      affectedSongCount: 2,
      addedSongCount: null,
      skippedSongCount: null,
    })
  })

  it('rejects inconsistent copy result counts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          snapshotId,
          snapshotCreatedAt: createdAt,
          affectedSongCount: 2,
          addedSongCount: 2,
          skippedSongCount: 1,
        }),
      ),
    )
    await expect(
      api.copyPlaylistSongs(userId, 'default', {
        targetPlaylistId: 'love',
        songIds: [2, '2'],
        expectedSnapshotId: snapshotId,
      }),
    ).rejects.toThrow()
  })

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
      source: 'wy',
      singer: 'artist',
      albumName: 'album',
      offset: 25,
      limit: 25,
    })

    expect(detail.data).toEqual([
      expect.objectContaining({ id: 7, position: 26, source: 'wy' }),
    ])
    expect(detail.playlist.quality).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/users/${userId}/playlists/user%3Aroad%2Ftrip?snapshotId=${snapshotId}&q=night+song&source=wy&singer=artist&albumName=album&offset=25&limit=25`,
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

  it('preserves the selected string or numeric platform song ID', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        Response.json(
          {
            snapshotId,
            snapshotCreatedAt: createdAt,
            affectedSongCount: 1,
          },
          { status: 201 },
        ),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const baseInput = {
      source: 'wy' as const,
      name: 'Managed song',
      singer: 'Managed singer',
      albumName: '',
      interval: null,
      expectedSnapshotId: snapshotId,
    }
    await api.addPlaylistSong(userId, 'user:target', {
      ...baseInput,
      id: '2',
    })
    await api.addPlaylistSong(userId, 'user:target', {
      ...baseInput,
      id: 2,
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/v1/users/${userId}/playlists/user%3Atarget/songs`,
      {
        method: 'POST',
        body: JSON.stringify({ ...baseInput, id: '2' }),
        headers: { 'Content-Type': 'application/json' },
      },
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/v1/users/${userId}/playlists/user%3Atarget/songs`,
      {
        method: 'POST',
        body: JSON.stringify({ ...baseInput, id: 2 }),
        headers: { 'Content-Type': 'application/json' },
      },
    )
  })

  it('sends a playlist quality replacement in the PATCH body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        snapshotId,
        snapshotCreatedAt: createdAt,
        playlist: {
          id: 'user:target',
          name: 'Target',
          type: 'user',
          quality: 'hires',
          songCount: 0,
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await api.renamePlaylist(userId, 'user:target', {
      name: 'Target',
      quality: 'hires',
      expectedSnapshotId: snapshotId,
    })

    expect(result.playlist.quality).toBe('hires')
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/users/${userId}/playlists/user%3Atarget`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          name: 'Target',
          quality: 'hires',
          expectedSnapshotId: snapshotId,
        }),
        headers: { 'Content-Type': 'application/json' },
      },
    )
  })

  it('sends null to clear a playlist quality override', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        snapshotId,
        snapshotCreatedAt: createdAt,
        playlist: {
          id: 'user:target',
          name: 'Target',
          type: 'user',
          quality: null,
          songCount: 0,
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await api.renamePlaylist(userId, 'user:target', {
      name: 'Target',
      quality: null,
      expectedSnapshotId: snapshotId,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/users/${userId}/playlists/user%3Atarget`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          name: 'Target',
          quality: null,
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
