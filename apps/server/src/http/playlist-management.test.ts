import { describe, expect, it } from 'vitest'
import {
  type AuditEventInput,
  SnapshotConflictError,
  type SnapshotRecord,
  type UserSummary,
} from '../db/repository.js'
import type { AppError } from '../errors.js'
import type {
  DislikeRules,
  ListAction,
  ListData,
  SyncDomain,
} from '../protocol/index.js'
import { syncLimits } from '../sync/snapshot.js'
import type { ConnectionHub, SyncConnection } from '../sync/types.js'
import { PlaylistManagementService } from './playlist-management.js'

const createdAt = new Date('2026-07-23T04:00:00.000Z')

function snapshot(id: string, data: ListData): SnapshotRecord<ListData> {
  return {
    id,
    hash: id,
    data,
    createdAt,
    itemCount: 0,
    byteSize: 0,
  }
}

class MemoryRepository {
  head: SnapshotRecord<ListData>
  saveCalls = 0
  marks: Array<{ deviceId: string; snapshotId: string }> = []
  audits: AuditEventInput[] = []

  readonly user: UserSummary = {
    id: 'user-id',
    name: 'User',
    enabled: true,
    maxSnapshots: 10,
    addMusicLocationType: 'bottom',
    deviceCount: 0,
    createdAt,
  }

  constructor(data: ListData) {
    this.head = snapshot('00000000-0000-4000-8000-000000000001', data)
  }

  async getUserSummary(userId: string): Promise<UserSummary | null> {
    return userId === this.user.id ? this.user : null
  }

  async getHead(
    _domain: 'list',
    _userId: string,
  ): Promise<SnapshotRecord<ListData>> {
    return this.head
  }

  async saveSnapshot(input: {
    userId: string
    domain: 'list'
    data: ListData
    expectedSnapshotId?: string
    audit?: AuditEventInput
  }): Promise<SnapshotRecord<ListData>>
  async saveSnapshot(input: {
    userId: string
    domain: 'dislike'
    data: DislikeRules
    expectedSnapshotId?: string
    audit?: AuditEventInput
  }): Promise<SnapshotRecord<DislikeRules>>
  async saveSnapshot(input: {
    userId: string
    domain: SyncDomain
    data: ListData | DislikeRules
    expectedSnapshotId?: string
    audit?: AuditEventInput
  }): Promise<SnapshotRecord> {
    if (input.domain !== 'list' || typeof input.data === 'string')
      throw new Error('Unexpected dislike write')
    if (input.expectedSnapshotId !== this.head.id)
      throw new SnapshotConflictError()
    this.saveCalls += 1
    if (input.audit) this.audits.push(input.audit)
    this.head = snapshot(
      `00000000-0000-4000-8000-${String(this.saveCalls + 1).padStart(12, '0')}`,
      input.data,
    )
    return this.head
  }

  async markDeviceSnapshot(
    deviceId: string,
    _domain: SyncDomain,
    snapshotId: string,
  ): Promise<void> {
    this.marks.push({ deviceId, snapshotId })
  }
}

function connection(input: {
  actions: ListAction[]
  close?: () => void
}): SyncConnection {
  return {
    connectionId: 'connection-id',
    pathMode: 'root',
    active: true,
    device: {
      clientId: 'ready-device',
      userId: 'user-id',
      userName: 'User',
      key: 'key',
      deviceName: 'Ready device',
      isMobile: false,
    },
    user: {
      id: 'user-id',
      name: 'User',
      authKey: 'key',
      enabled: true,
      maxSnapshots: 10,
      addMusicLocationType: 'bottom',
    },
    feature: { list: { skipSnapshot: false } },
    moduleReady: { list: true, dislike: false },
    remote: {
      getEnabledFeatures: async () => ({}),
      finished: async () => {},
    },
    remoteList: {
      onListSyncAction: async (action) => {
        input.actions.push(action as ListAction)
      },
      list_sync_get_md5: async () => '',
      list_sync_get_sync_mode: async () => 'merge_local_remote',
      list_sync_get_list_data: async () => ({}),
      list_sync_set_list_data: async () => {},
      list_sync_finished: async () => {},
    },
    remoteDislike: {
      onDislikeSyncAction: async () => {},
      dislike_sync_get_md5: async () => '',
      dislike_sync_get_sync_mode: async () => 'merge_local_remote',
      dislike_sync_get_list_data: async () => '',
      dislike_sync_set_list_data: async () => {},
      dislike_sync_finished: async () => {},
    },
    close: input.close ?? (() => {}),
  }
}

function hub(connections: SyncConnection[]): ConnectionHub {
  return {
    forUser: () => connections,
    runExclusive: (_userId, task) => task(),
  }
}

const baseData = (): ListData => ({
  defaultList: [
    {
      id: 2,
      name: 'Numeric song',
      source: 'wy',
      privateField: { preserved: true },
    },
  ],
  loveList: [],
  userList: [
    {
      id: 'target',
      name: 'Target',
      source: 'wy',
      sourceListId: 'remote-list',
      locationUpdateTime: 123,
      list: [],
    },
  ],
})

describe('PlaylistManagementService', () => {
  it('moves numeric song IDs with full metadata, audits atomically, and broadcasts before advancing baselines', async () => {
    const actions: ListAction[] = []
    const repository = new MemoryRepository(baseData())
    const service = new PlaylistManagementService(
      repository,
      hub([connection({ actions })]),
    )

    const result = await service.moveSongs({
      userId: 'user-id',
      actor: 'admin',
      playlistId: 'default',
      targetPlaylistId: 'user:target',
      songIds: [2],
      expectedSnapshotId: repository.head.id,
    })

    expect(result.affectedSongCount).toBe(1)
    expect(repository.head.data.defaultList).toEqual([])
    expect(repository.head.data.userList[0]?.list).toEqual([
      expect.objectContaining({
        id: 2,
        privateField: { preserved: true },
      }),
    ])
    expect(actions).toEqual([
      expect.objectContaining({
        action: 'list_music_move',
        data: expect.objectContaining({
          musicInfos: [expect.objectContaining({ id: 2 })],
        }),
      }),
    ])
    expect(repository.marks).toEqual([
      { deviceId: 'ready-device', snapshotId: result.snapshotId },
    ])
    expect(repository.audits).toEqual([
      {
        actor: 'admin',
        action: 'playlist.songs.move',
        targetType: 'sync_user',
        targetId: 'user-id',
        metadata: {
          domain: 'list',
          affectedPlaylistCount: 2,
          affectedSongCount: 1,
        },
      },
    ])
    expect(JSON.stringify(repository.audits)).not.toContain('Numeric song')
    expect(JSON.stringify(repository.audits)).not.toContain('remote-list')
  })

  it('does not coerce string and numeric song identifiers', async () => {
    const repository = new MemoryRepository(baseData())
    const service = new PlaylistManagementService(repository, hub([]))

    await expect(
      service.removeSongs({
        userId: 'user-id',
        actor: 'admin',
        playlistId: 'default',
        songIds: ['2'],
        expectedSnapshotId: repository.head.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'SONG_NOT_FOUND' })
    expect(repository.saveCalls).toBe(0)
  })

  it('rejects stale heads without retrying or broadcasting', async () => {
    const actions: ListAction[] = []
    const repository = new MemoryRepository(baseData())
    const service = new PlaylistManagementService(
      repository,
      hub([connection({ actions })]),
    )

    await expect(
      service.create({
        userId: 'user-id',
        actor: 'admin',
        name: 'New list',
        expectedSnapshotId: '00000000-0000-4000-8000-999999999999',
      }),
    ).rejects.toBeInstanceOf(SnapshotConflictError)
    expect(repository.saveCalls).toBe(0)
    expect(actions).toEqual([])
  })

  it('preserves unknown playlist metadata while renaming', async () => {
    const repository = new MemoryRepository(baseData())
    const service = new PlaylistManagementService(repository, hub([]))

    const result = await service.rename({
      userId: 'user-id',
      actor: 'admin',
      playlistId: 'user:target',
      name: 'Renamed',
      expectedSnapshotId: repository.head.id,
    })

    expect(result.playlist).toMatchObject({
      id: 'user:target',
      name: 'Renamed',
      type: 'user',
    })
    expect(repository.head.data.userList[0]).toMatchObject({
      id: 'target',
      name: 'Renamed',
      source: 'wy',
      sourceListId: 'remote-list',
      locationUpdateTime: 123,
    })
  })

  it('rejects immutable and ambiguous playlist targets', async () => {
    const repository = new MemoryRepository(baseData())
    const service = new PlaylistManagementService(repository, hub([]))

    await expect(
      service.delete({
        userId: 'user-id',
        actor: 'admin',
        playlistId: 'love',
        expectedSnapshotId: repository.head.id,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAYLIST_IMMUTABLE',
    } satisfies Partial<AppError>)

    const [duplicatePlaylist] = repository.head.data.userList
    if (!duplicatePlaylist) throw new Error('Expected a user playlist fixture')
    repository.head.data.userList.push({
      ...duplicatePlaylist,
      list: [],
    })
    await expect(
      service.copySongs({
        userId: 'user-id',
        actor: 'admin',
        playlistId: 'default',
        targetPlaylistId: 'user:target',
        songIds: [2],
        expectedSnapshotId: repository.head.id,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAYLIST_ID_AMBIGUOUS',
    })
    expect(repository.saveCalls).toBe(0)
  })

  it('rejects reserved user playlist IDs before emitting ambiguous music actions', async () => {
    const data = baseData()
    data.userList.push(
      {
        id: 'default',
        name: 'Reserved default',
        locationUpdateTime: null,
        list: [{ id: 'reserved-song' }],
      },
      {
        id: 'love',
        name: 'Reserved love',
        locationUpdateTime: null,
        list: [],
      },
    )
    const repository = new MemoryRepository(data)
    const service = new PlaylistManagementService(repository, hub([]))

    await expect(
      service.removeSongs({
        userId: 'user-id',
        actor: 'admin',
        playlistId: 'user:default',
        songIds: ['reserved-song'],
        expectedSnapshotId: repository.head.id,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAYLIST_ID_AMBIGUOUS',
    })
    await expect(
      service.moveSongs({
        userId: 'user-id',
        actor: 'admin',
        playlistId: 'default',
        targetPlaylistId: 'user:love',
        songIds: [2],
        expectedSnapshotId: repository.head.id,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAYLIST_ID_AMBIGUOUS',
    })
    await expect(
      service.copySongs({
        userId: 'user-id',
        actor: 'admin',
        playlistId: 'user:default',
        targetPlaylistId: 'user:target',
        songIds: ['reserved-song'],
        expectedSnapshotId: repository.head.id,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAYLIST_ID_AMBIGUOUS',
    })
    expect(repository.saveCalls).toBe(0)
  })

  it('rejects writes that would exceed playlist snapshot capacity', async () => {
    const fullPlaylistData = baseData()
    fullPlaylistData.userList = Array.from(
      { length: syncLimits.maxUserLists },
      (_, index) => ({
        id: `playlist-${index}`,
        name: `Playlist ${index}`,
        locationUpdateTime: null,
        list: [],
      }),
    )
    const fullPlaylistRepository = new MemoryRepository(fullPlaylistData)
    const fullPlaylistService = new PlaylistManagementService(
      fullPlaylistRepository,
      hub([]),
    )

    await expect(
      fullPlaylistService.create({
        userId: 'user-id',
        actor: 'admin',
        name: 'One too many',
        expectedSnapshotId: fullPlaylistRepository.head.id,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAYLIST_CAPACITY_EXCEEDED',
    })
    expect(fullPlaylistRepository.saveCalls).toBe(0)

    const fullTrackData = baseData()
    fullTrackData.defaultList = Array.from(
      { length: syncLimits.maxTracks },
      (_, index) => ({ id: `song-${index}` }),
    )
    const fullTrackRepository = new MemoryRepository(fullTrackData)
    const fullTrackService = new PlaylistManagementService(
      fullTrackRepository,
      hub([]),
    )

    await expect(
      fullTrackService.copySongs({
        userId: 'user-id',
        actor: 'admin',
        playlistId: 'default',
        targetPlaylistId: 'user:target',
        songIds: ['song-0'],
        expectedSnapshotId: fullTrackRepository.head.id,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAYLIST_CAPACITY_EXCEEDED',
    })
    expect(fullTrackRepository.saveCalls).toBe(0)
  })
})
