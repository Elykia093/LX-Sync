import { randomUUID } from 'node:crypto'
import {
  type Repository,
  SnapshotConflictError,
  type SnapshotRecord,
  type UserSummary,
} from '../db/repository.js'
import { AppError } from '../errors.js'
import type {
  ListAction,
  ListData,
  MusicInfo,
  UserListInfoFull,
} from '../protocol/index.js'
import { broadcastListAction } from '../sync/broadcast.js'
import type { SyncLogger } from '../sync/logging.js'
import {
  applyListAction,
  parseListData,
  syncLimits,
  toUserListInfo,
} from '../sync/snapshot.js'
import type { ConnectionHub } from '../sync/types.js'
import {
  assertUnambiguousUserPlaylistIds,
  type PlaylistSummary,
  playlistSummaryResponse,
  userPlaylistApiId,
} from './playlists.js'

type PlaylistManagementRepository = Pick<
  Repository,
  'getUserSummary' | 'markDeviceSnapshot' | 'saveSnapshot'
> & {
  getHead(domain: 'list', userId: string): Promise<SnapshotRecord<ListData>>
}

interface MutationContext {
  head: SnapshotRecord<ListData>
  user: UserSummary
}

interface MutationPlan {
  action: ListAction
  affectedPlaylistCount?: number
  affectedSongCount?: number
  resultPlaylistId?: string
}

interface ResolvedPlaylist {
  apiId: string
  wireId: string
  type: 'default' | 'love' | 'user'
  songs: MusicInfo[]
  userList?: UserListInfoFull
}

export interface PlaylistMutationResult {
  snapshotId: string
  snapshotCreatedAt: string
}

export interface PlaylistUpsertResult extends PlaylistMutationResult {
  playlist: PlaylistSummary
}

export interface PlaylistSongMutationResult extends PlaylistMutationResult {
  affectedSongCount: number
}

export class PlaylistManagementService {
  constructor(
    private readonly repository: PlaylistManagementRepository,
    private readonly hub: Pick<ConnectionHub, 'forUser' | 'runExclusive'>,
  ) {}

  async create(input: {
    userId: string
    actor: string
    name: string
    expectedSnapshotId: string
    logger?: SyncLogger
  }): Promise<PlaylistUpsertResult> {
    const wireId = randomUUID()
    const result = await this.mutate({
      ...input,
      auditAction: 'playlist.create',
      build: ({ head }) => {
        assertCanCreatePlaylist(head.data)
        return {
          action: {
            action: 'list_create',
            data: {
              position: -1,
              listInfos: [
                {
                  id: wireId,
                  name: input.name,
                  locationUpdateTime: null,
                },
              ],
            },
          },
          resultPlaylistId: userPlaylistApiId(wireId),
        }
      },
    })
    return withPlaylist(result.snapshot, userPlaylistApiId(wireId))
  }

  async rename(input: {
    userId: string
    actor: string
    playlistId: string
    name: string
    expectedSnapshotId: string
    logger?: SyncLogger
  }): Promise<PlaylistUpsertResult> {
    const result = await this.mutate({
      ...input,
      auditAction: 'playlist.rename',
      build: ({ head }) => {
        const playlist = resolveWritableUserPlaylist(
          head.data,
          input.playlistId,
        )
        return {
          action: {
            action: 'list_update',
            data: [
              {
                ...toUserListInfo(playlist.userList),
                name: input.name,
              },
            ],
          },
          resultPlaylistId: playlist.apiId,
        }
      },
    })
    if (!result.resultPlaylistId)
      throw new AppError(500, 'INTERNAL_ERROR', 'Playlist result is missing')
    return withPlaylist(result.snapshot, result.resultPlaylistId)
  }

  async delete(input: {
    userId: string
    actor: string
    playlistId: string
    expectedSnapshotId: string
    logger?: SyncLogger
  }): Promise<PlaylistMutationResult> {
    const result = await this.mutate({
      ...input,
      auditAction: 'playlist.delete',
      build: ({ head }) => {
        const playlist = resolveWritableUserPlaylist(
          head.data,
          input.playlistId,
        )
        return {
          action: { action: 'list_remove', data: [playlist.wireId] },
        }
      },
    })
    return mutationResponse(result.snapshot)
  }

  async removeSongs(input: {
    userId: string
    actor: string
    playlistId: string
    songIds: Array<string | number>
    expectedSnapshotId: string
    logger?: SyncLogger
  }): Promise<PlaylistSongMutationResult> {
    const result = await this.mutate({
      ...input,
      auditAction: 'playlist.songs.remove',
      build: ({ head }) => {
        const playlist = resolvePlaylist(head.data, input.playlistId)
        assertWireAddressablePlaylist(playlist)
        requireSongs(playlist, input.songIds)
        return {
          action: {
            action: 'list_music_remove',
            data: { listId: playlist.wireId, ids: input.songIds },
          },
          affectedSongCount: input.songIds.length,
        }
      },
    })
    return songMutationResponse(result.snapshot, result.affectedSongCount)
  }

  async moveSongs(input: {
    userId: string
    actor: string
    playlistId: string
    targetPlaylistId: string
    songIds: Array<string | number>
    expectedSnapshotId: string
    logger?: SyncLogger
  }): Promise<PlaylistSongMutationResult> {
    const result = await this.mutate({
      ...input,
      auditAction: 'playlist.songs.move',
      build: ({ head, user }) => {
        const source = resolvePlaylist(head.data, input.playlistId)
        const target = resolvePlaylist(head.data, input.targetPlaylistId)
        assertWireAddressablePlaylist(source)
        assertWireAddressablePlaylist(target)
        requireDifferentPlaylists(source, target)
        const songs = requireSongs(source, input.songIds)
        return {
          action: {
            action: 'list_music_move',
            data: {
              fromId: source.wireId,
              toId: target.wireId,
              musicInfos: songs,
              addMusicLocationType: user.addMusicLocationType,
            },
          },
          affectedPlaylistCount: 2,
          affectedSongCount: songs.length,
        }
      },
    })
    return songMutationResponse(result.snapshot, result.affectedSongCount)
  }

  async copySongs(input: {
    userId: string
    actor: string
    playlistId: string
    targetPlaylistId: string
    songIds: Array<string | number>
    expectedSnapshotId: string
    logger?: SyncLogger
  }): Promise<PlaylistSongMutationResult> {
    const result = await this.mutate({
      ...input,
      auditAction: 'playlist.songs.copy',
      build: ({ head, user }) => {
        const source = resolvePlaylist(head.data, input.playlistId)
        const target = resolvePlaylist(head.data, input.targetPlaylistId)
        assertWireAddressablePlaylist(source)
        assertWireAddressablePlaylist(target)
        requireDifferentPlaylists(source, target)
        const songs = requireSongs(source, input.songIds)
        assertCanCopySongs(head.data, target, songs)
        return {
          action: {
            action: 'list_music_add',
            data: {
              id: target.wireId,
              musicInfos: songs,
              addMusicLocationType: user.addMusicLocationType,
            },
          },
          affectedSongCount: songs.length,
        }
      },
    })
    return songMutationResponse(result.snapshot, result.affectedSongCount)
  }

  private async mutate(input: {
    userId: string
    actor: string
    expectedSnapshotId: string
    auditAction: string
    logger?: SyncLogger
    build: (context: MutationContext) => MutationPlan
  }): Promise<{
    snapshot: SnapshotRecord<ListData>
    affectedSongCount: number
    resultPlaylistId?: string
  }> {
    return this.hub.runExclusive(input.userId, async () => {
      const user = await this.repository.getUserSummary(input.userId)
      if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found')
      const head = await this.repository.getHead('list', input.userId)
      if (head.id !== input.expectedSnapshotId)
        throw new SnapshotConflictError()
      assertUnambiguousUserPlaylistIds(head.data)
      const plan = input.build({ head, user })
      const affectedPlaylistCount = plan.affectedPlaylistCount ?? 1
      const affectedSongCount = plan.affectedSongCount ?? 0
      const next = parseListData(applyListAction(head.data, plan.action))
      const snapshot = await this.repository.saveSnapshot({
        userId: input.userId,
        domain: 'list',
        data: next,
        expectedSnapshotId: head.id,
        audit: {
          actor: input.actor,
          action: input.auditAction,
          targetType: 'sync_user',
          targetId: input.userId,
          metadata: {
            domain: 'list',
            affectedPlaylistCount,
            affectedSongCount,
          },
        },
      })
      await broadcastListAction({
        repository: this.repository,
        hub: this.hub,
        userId: input.userId,
        action: plan.action,
        snapshot,
        ...(input.logger ? { logger: input.logger } : {}),
      })
      return {
        snapshot,
        affectedSongCount,
        ...(plan.resultPlaylistId
          ? { resultPlaylistId: plan.resultPlaylistId }
          : {}),
      }
    })
  }
}

function mutationResponse(
  snapshot: SnapshotRecord<ListData>,
): PlaylistMutationResult {
  return {
    snapshotId: snapshot.id,
    snapshotCreatedAt: snapshot.createdAt.toISOString(),
  }
}

function songMutationResponse(
  snapshot: SnapshotRecord<ListData>,
  affectedSongCount: number,
): PlaylistSongMutationResult {
  return { ...mutationResponse(snapshot), affectedSongCount }
}

function withPlaylist(
  snapshot: SnapshotRecord<ListData>,
  playlistId: string,
): PlaylistUpsertResult {
  const playlist = playlistSummaryResponse(snapshot).data.find(
    (item) => item.id === playlistId,
  )
  if (!playlist)
    throw new AppError(500, 'INTERNAL_ERROR', 'Saved playlist was not found')
  return { ...mutationResponse(snapshot), playlist }
}

function resolveWritableUserPlaylist(
  data: ListData,
  playlistId: string,
): ResolvedPlaylist & { userList: UserListInfoFull } {
  if (playlistId === 'default' || playlistId === 'love')
    throw new AppError(
      409,
      'PLAYLIST_IMMUTABLE',
      'Built-in playlists cannot be renamed or deleted',
    )
  const playlist = resolvePlaylist(data, playlistId)
  if (!playlist.userList)
    throw new AppError(
      409,
      'PLAYLIST_IMMUTABLE',
      'Built-in playlists cannot be renamed or deleted',
    )
  return { ...playlist, userList: playlist.userList }
}

function resolvePlaylist(data: ListData, playlistId: string): ResolvedPlaylist {
  if (playlistId === 'default')
    return {
      apiId: 'default',
      wireId: 'default',
      type: 'default',
      songs: data.defaultList,
    }
  if (playlistId === 'love')
    return {
      apiId: 'love',
      wireId: 'love',
      type: 'love',
      songs: data.loveList,
    }
  if (!playlistId.startsWith('user:'))
    throw new AppError(404, 'PLAYLIST_NOT_FOUND', 'Playlist was not found')
  const wireId = playlistId.slice('user:'.length)
  const matches = data.userList.filter((playlist) => playlist.id === wireId)
  if (matches.length > 1)
    throw new AppError(
      409,
      'PLAYLIST_ID_AMBIGUOUS',
      'Playlist identifier is ambiguous',
    )
  const userList = matches[0]
  if (!userList)
    throw new AppError(404, 'PLAYLIST_NOT_FOUND', 'Playlist was not found')
  return {
    apiId: userPlaylistApiId(userList.id),
    wireId: userList.id,
    type: 'user',
    songs: userList.list,
    userList,
  }
}

function requireSongs(
  playlist: ResolvedPlaylist,
  songIds: Array<string | number>,
): MusicInfo[] {
  return songIds.map((songId) => {
    const matches = playlist.songs.filter((song) => song.id === songId)
    if (matches.length > 1)
      throw new AppError(
        409,
        'SONG_ID_AMBIGUOUS',
        'Song identifier is ambiguous',
      )
    const song = matches[0]
    if (!song) throw new AppError(404, 'SONG_NOT_FOUND', 'Song was not found')
    return song
  })
}

function assertWireAddressablePlaylist(playlist: ResolvedPlaylist): void {
  if (
    playlist.type === 'user' &&
    (playlist.wireId === 'default' || playlist.wireId === 'love')
  )
    throw new AppError(
      409,
      'PLAYLIST_ID_AMBIGUOUS',
      'Playlist identifier is ambiguous on the LX wire protocol',
    )
}

function requireDifferentPlaylists(
  source: ResolvedPlaylist,
  target: ResolvedPlaylist,
): void {
  if (source.apiId === target.apiId)
    throw new AppError(
      409,
      'PLAYLIST_TARGET_INVALID',
      'Source and target playlists must differ',
    )
}

function assertCanCreatePlaylist(data: ListData): void {
  if (data.userList.length >= syncLimits.maxUserLists)
    throw new AppError(
      409,
      'PLAYLIST_CAPACITY_EXCEEDED',
      'Playlist capacity limit would be exceeded',
    )
}

function assertCanCopySongs(
  data: ListData,
  target: ResolvedPlaylist,
  songs: MusicInfo[],
): void {
  const targetIds = new Set(target.songs.map((song) => song.id))
  let additionalSongCount = 0
  for (const song of songs) {
    if (targetIds.has(song.id)) continue
    targetIds.add(song.id)
    additionalSongCount += 1
  }
  const currentSongCount =
    data.defaultList.length +
    data.loveList.length +
    data.userList.reduce((total, playlist) => total + playlist.list.length, 0)
  if (currentSongCount + additionalSongCount > syncLimits.maxTracks)
    throw new AppError(
      409,
      'PLAYLIST_CAPACITY_EXCEEDED',
      'Playlist capacity limit would be exceeded',
    )
}
