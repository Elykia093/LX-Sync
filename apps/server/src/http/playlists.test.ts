import { describe, expect, it } from 'vitest'
import type { SnapshotRecord } from '../db/repository.js'
import type { ListData } from '../protocol/index.js'
import { playlistDetailResponse, playlistSummaryResponse } from './playlists.js'

const head: SnapshotRecord<ListData> = {
  id: '00000000-0000-4000-8000-000000000020',
  hash: 'hash',
  itemCount: 4,
  byteSize: 256,
  createdAt: new Date('2026-07-23T02:00:00.000Z'),
  data: {
    defaultList: [
      {
        id: 'song-1',
        name: 'First Song',
        singer: 'Alpha Singer',
        source: 'wy',
        interval: '03:10',
        meta: { albumName: 'First Album' },
        secretField: 'must-not-be-returned',
      },
      { id: 2, name: 'Second Song', singer: 42, meta: null },
    ],
    loveList: [{ id: 'loved-song' }],
    userList: [
      {
        id: 'focus',
        name: '  ',
        locationUpdateTime: null,
        list: [{ id: 'focus-song', name: 'Focus Song' }],
      },
    ],
  },
}

describe('playlist management projections', () => {
  it('summarizes built-in and user playlists from the current list head', () => {
    expect(playlistSummaryResponse(head)).toEqual({
      snapshotId: head.id,
      snapshotCreatedAt: '2026-07-23T02:00:00.000Z',
      data: [
        { id: 'default', name: '默认列表', type: 'default', songCount: 2 },
        { id: 'love', name: '收藏列表', type: 'love', songCount: 1 },
        {
          id: 'user:focus',
          name: '未命名歌单',
          type: 'user',
          songCount: 1,
        },
      ],
    })
  })

  it('normalizes only public song fields while preserving source positions', () => {
    expect(
      playlistDetailResponse(head, 'default', {
        q: '',
        offset: 1,
        limit: 1,
      }),
    ).toMatchObject({
      playlist: {
        id: 'default',
        name: '默认列表',
        type: 'default',
        songCount: 2,
      },
      offset: 1,
      limit: 1,
      total: 2,
      data: [
        {
          id: 2,
          position: 2,
          name: 'Second Song',
          singer: null,
          albumName: null,
          source: null,
          interval: null,
        },
      ],
    })
    expect(
      JSON.stringify(
        playlistDetailResponse(head, 'default', {
          q: '',
          offset: 0,
          limit: 10,
        }),
      ),
    ).not.toContain('secretField')
  })

  it('searches normalized metadata and returns null for unknown playlists', () => {
    expect(
      playlistDetailResponse(head, 'default', {
        q: '2',
        offset: 0,
        limit: 10,
      }),
    ).toMatchObject({
      total: 1,
      data: [{ id: 2, position: 2 }],
    })
    expect(
      playlistDetailResponse(head, 'default', {
        q: 'first album',
        offset: 0,
        limit: 10,
      }),
    ).toMatchObject({
      total: 1,
      data: [{ id: 'song-1', position: 1 }],
    })
    expect(
      playlistDetailResponse(head, 'missing', {
        q: '',
        offset: 0,
        limit: 10,
      }),
    ).toBeNull()
  })

  it('combines source, singer, and album filters within one playlist', () => {
    const filteredHead: SnapshotRecord<ListData> = {
      ...head,
      data: {
        ...head.data,
        defaultList: [
          ...head.data.defaultList,
          {
            id: 'legacy-song',
            name: 'Legacy Song',
            singer: 'Beta Artist',
            source: 'tx',
            albumName: 'Top-level Album',
          },
        ],
      },
    }

    expect(
      playlistDetailResponse(filteredHead, 'default', {
        q: 'song',
        source: 'tx',
        singer: 'beta',
        albumName: 'top-level',
        offset: 0,
        limit: 10,
      }),
    ).toMatchObject({
      total: 1,
      data: [
        {
          id: 'legacy-song',
          position: 3,
          albumName: 'Top-level Album',
        },
      ],
    })
    expect(
      playlistDetailResponse(filteredHead, 'default', {
        q: '',
        source: 'wy',
        singer: 'beta',
        albumName: '',
        offset: 0,
        limit: 10,
      }),
    ).toMatchObject({ total: 0, data: [] })
  })

  it('rejects snapshots whose user playlist IDs cannot be resolved uniquely', () => {
    const [userPlaylist] = head.data.userList
    if (!userPlaylist) throw new Error('Expected a user playlist fixture')
    const duplicateHead: SnapshotRecord<ListData> = {
      ...head,
      data: {
        ...head.data,
        userList: [...head.data.userList, { ...userPlaylist }],
      },
    }

    expect(() => playlistSummaryResponse(duplicateHead)).toThrowError(
      'Playlist identifier is ambiguous',
    )
    expect(() =>
      playlistDetailResponse(duplicateHead, 'user:focus', {
        q: '',
        offset: 0,
        limit: 10,
      }),
    ).toThrowError('Playlist identifier is ambiguous')
  })
})
