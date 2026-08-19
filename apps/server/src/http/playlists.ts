import type { SnapshotRecord } from '../db/repository.js'
import { AppError } from '../errors.js'
import type { PlaylistQuality } from '../playlist-quality.js'
import type { ListData, MusicInfo } from '../protocol/index.js'

export type PlaylistType = 'default' | 'love' | 'user'

export interface PlaylistSummary {
  id: string
  name: string
  type: PlaylistType
  quality: PlaylistQuality | null
  songCount: number
}

export interface PlaylistSong {
  id: string | number
  position: number
  name: string | null
  singer: string | null
  albumName: string | null
  source: string | null
  interval: string | null
}

interface PlaylistRecord extends PlaylistSummary {
  wireId: string
  songs: MusicInfo[]
}

export function playlistSummaryResponse(
  head: SnapshotRecord<ListData>,
  qualities: ReadonlyMap<string, PlaylistQuality> = new Map(),
) {
  return {
    snapshotId: head.id,
    snapshotCreatedAt: head.createdAt.toISOString(),
    data: playlistRecords(head.data, qualities).map(
      ({ songs: _songs, wireId: _wireId, ...playlist }) => playlist,
    ),
  }
}

export function playlistDetailResponse(
  head: SnapshotRecord<ListData>,
  playlistId: string,
  query: {
    q: string
    source?: string | undefined
    singer?: string
    albumName?: string
    offset: number
    limit: number
  },
  qualities: ReadonlyMap<string, PlaylistQuality> = new Map(),
) {
  const record = playlistRecords(head.data, qualities).find(
    (playlist) => playlist.id === playlistId,
  )
  if (!record) return null

  const normalizedQuery = query.q.trim().toLocaleLowerCase()
  const normalizedSinger = query.singer?.trim().toLocaleLowerCase() ?? ''
  const normalizedAlbumName = query.albumName?.trim().toLocaleLowerCase() ?? ''
  const songs = record.songs
    .map(normalizeSong)
    .filter(
      (song) =>
        (normalizedQuery === '' ||
          [song.id, song.name, song.singer, song.albumName, song.source].some(
            (value) =>
              value !== null &&
              String(value).toLocaleLowerCase().includes(normalizedQuery),
          )) &&
        (query.source === undefined || song.source === query.source) &&
        (normalizedSinger === '' ||
          song.singer?.toLocaleLowerCase().includes(normalizedSinger) ===
            true) &&
        (normalizedAlbumName === '' ||
          song.albumName?.toLocaleLowerCase().includes(normalizedAlbumName) ===
            true),
    )

  const { songs: _songs, wireId: _wireId, ...playlist } = record
  return {
    snapshotId: head.id,
    snapshotCreatedAt: head.createdAt.toISOString(),
    playlist,
    offset: query.offset,
    limit: query.limit,
    total: songs.length,
    data: songs.slice(query.offset, query.offset + query.limit),
  }
}

function playlistRecords(
  data: ListData,
  qualities: ReadonlyMap<string, PlaylistQuality> = new Map(),
): PlaylistRecord[] {
  assertUnambiguousUserPlaylistIds(data)
  return [
    {
      id: 'default',
      wireId: 'default',
      name: '默认列表',
      type: 'default',
      quality: null,
      songCount: data.defaultList.length,
      songs: data.defaultList,
    },
    {
      id: 'love',
      wireId: 'love',
      name: '收藏列表',
      type: 'love',
      quality: null,
      songCount: data.loveList.length,
      songs: data.loveList,
    },
    ...data.userList.map((playlist) => ({
      id: userPlaylistApiId(playlist.id),
      wireId: playlist.id,
      name: playlist.name.trim() || '未命名歌单',
      type: 'user' as const,
      quality: qualities.get(playlist.id) ?? null,
      songCount: playlist.list.length,
      songs: playlist.list,
    })),
  ]
}

function normalizeSong(song: MusicInfo, index: number): PlaylistSong {
  const meta =
    typeof song.meta === 'object' &&
    song.meta !== null &&
    !Array.isArray(song.meta)
      ? song.meta
      : null
  return {
    id: song.id,
    position: index + 1,
    name: optionalString(song.name),
    singer: optionalString(song.singer),
    albumName:
      optionalString(meta?.albumName) ?? optionalString(song.albumName),
    source: optionalString(song.source),
    interval: optionalString(song.interval),
  }
}

export function userPlaylistApiId(wireId: string): string {
  return `user:${wireId}`
}

export function assertUnambiguousUserPlaylistIds(data: ListData): void {
  const ids = new Set<string>()
  for (const playlist of data.userList) {
    if (ids.has(playlist.id))
      throw new AppError(
        409,
        'PLAYLIST_ID_AMBIGUOUS',
        'Playlist identifier is ambiguous',
      )
    ids.add(playlist.id)
  }
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.trim() || null
}
