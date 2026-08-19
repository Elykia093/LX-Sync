import { describe, expect, it } from 'vitest'
import {
  type AuditEventInput,
  type PlaylistQualityUpdate,
  SnapshotConflictError,
  type SnapshotRecord,
  type UserSummary,
} from '../db/repository.js'
import type { AppError } from '../errors.js'
import type { PlaylistQuality } from '../playlist-quality.js'
import type {
  DislikeRules,
  ListAction,
  ListData,
  SyncDomain,
} from '../protocol/index.js'
import { syncLimits } from '../sync/snapshot.js'
import type { ConnectionHub, SyncConnection } from '../sync/types.js'
import {
  isValidManagedSongId,
  PlaylistManagementService,
} from './playlist-management.js'

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
  qualities = new Map<string, PlaylistQuality>()

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
    playlistQualityUpdate?: PlaylistQualityUpdate
  }): Promise<SnapshotRecord<ListData>>
  async saveSnapshot(input: {
    userId: string
    domain: 'dislike'
    data: DislikeRules
    expectedSnapshotId?: string
    audit?: AuditEventInput
    playlistQualityUpdate?: PlaylistQualityUpdate
  }): Promise<SnapshotRecord<DislikeRules>>
  async saveSnapshot(input: {
    userId: string
    domain: SyncDomain
    data: ListData | DislikeRules
    expectedSnapshotId?: string
    audit?: AuditEventInput
    playlistQualityUpdate?: PlaylistQualityUpdate
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
    if (input.playlistQualityUpdate) {
      const { playlistId, quality } = input.playlistQualityUpdate
      if (quality === null) this.qualities.delete(playlistId)
      else this.qualities.set(playlistId, quality)
    }
    return this.head
  }

  async getPlaylistQualities(
    _userId: string,
  ): Promise<Map<string, PlaylistQuality>> {
    return new Map(this.qualities)
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
  it('accepts platform ID types and rejects every reserved pseudo prefix', () => {
    expect(isValidManagedSongId('0032')).toBe(true)
    expect(isValidManagedSongId('MUSIC_123-abc')).toBe(true)
    expect(isValidManagedSongId(32)).toBe(true)
    for (const pseudoId of [
      'unknown',
      'unknown_track',
      'local',
      'local-track',
      'temp',
      'temp_123',
      'undefined',
      'undefined-track',
      'null',
      'null_track',
      '---',
    ])
      expect(isValidManagedSongId(pseudoId)).toBe(false)
    expect(isValidManagedSongId(0)).toBe(false)
    expect(isValidManagedSongId(1.5)).toBe(false)
  })

  it('adds a controlled platform song, preserves its ID type, audits, and broadcasts', async () => {
    const actions: ListAction[] = []
    const repository = new MemoryRepository(baseData())
    const service = new PlaylistManagementService(
      repository,
      hub([connection({ actions })]),
    )

    const result = await service.addSong({
      userId: 'user-id',
      actor: 'admin',
      playlistId: 'user:target',
      song: {
        id: '0032',
        source: 'tx',
        name: 'Added song',
        singer: 'Added singer',
        albumName: 'Added album',
        interval: '03:21',
      },
      expectedSnapshotId: repository.head.id,
    })

    expect(result.affectedSongCount).toBe(1)
    expect(repository.head.data.userList[0]?.list).toEqual([
      {
        id: '0032',
        name: 'Added song',
        singer: 'Added singer',
        source: 'tx',
        interval: '03:21',
        songmid: '0032',
        albumName: 'Added album',
        types: [],
        _types: {},
        typeUrl: {},
        meta: {
          songId: '0032',
          albumName: 'Added album',
          qualitys: [],
          _qualitys: {},
        },
      },
    ])
    expect(actions).toEqual([
      expect.objectContaining({
        action: 'list_music_add',
        data: expect.objectContaining({
          id: 'target',
          musicInfos: [expect.objectContaining({ id: '0032', source: 'tx' })],
        }),
      }),
    ])
    expect(repository.marks).toEqual([
      { deviceId: 'ready-device', snapshotId: result.snapshotId },
    ])
    expect(repository.audits).toEqual([
      {
        actor: 'admin',
        action: 'playlist.songs.add',
        targetType: 'sync_user',
        targetId: 'user-id',
        metadata: {
          domain: 'list',
          affectedPlaylistCount: 1,
          affectedSongCount: 1,
        },
      },
    ])
    expect(JSON.stringify(repository.audits)).not.toContain('Added song')
    expect(JSON.stringify(repository.audits)).not.toContain('0032')
  })

  it('keeps numeric platform IDs distinct from string IDs when adding songs', async () => {
    const data = baseData()
    data.userList[0]?.list.push({ id: '2', source: 'wy' })
    const repository = new MemoryRepository(data)
    const service = new PlaylistManagementService(repository, hub([]))

    await service.addSong({
      userId: 'user-id',
      actor: 'admin',
      playlistId: 'user:target',
      song: {
        id: 2,
        source: 'wy',
        name: 'Numeric platform ID',
        singer: 'Singer',
        albumName: '',
        interval: null,
      },
      expectedSnapshotId: repository.head.id,
    })

    expect(
      repository.head.data.userList[0]?.list.map((song) => song.id),
    ).toEqual(['2', 2])
    expect(repository.head.data.userList[0]?.list[1]?.meta).toMatchObject({
      songId: 2,
    })
  })

  it('rejects invalid, duplicate, built-in, and capacity-exceeding additions', async () => {
    const repository = new MemoryRepository(baseData())
    const service = new PlaylistManagementService(repository, hub([]))

    await expect(
      service.addSong({
        userId: 'user-id',
        actor: 'admin',
        playlistId: 'user:target',
        song: {
          id: 'local-track',
          source: 'wy',
          name: 'Invalid',
          singer: 'Singer',
          albumName: '',
          interval: null,
        },
        expectedSnapshotId: repository.head.id,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_FAILED' })

    await expect(
      service.addSong({
        userId: 'user-id',
        actor: 'admin',
        playlistId: 'user:target',
        song: {
          id: '---',
          source: 'wy',
          name: 'Invalid',
          singer: 'Singer',
          albumName: '',
          interval: null,
        },
        expectedSnapshotId: repository.head.id,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_FAILED' })

    await expect(
      service.addSong({
        userId: 'user-id',
        actor: 'admin',
        playlistId: 'default',
        song: {
          id: 'valid-id',
          source: 'wy',
          name: 'Invalid target',
          singer: 'Singer',
          albumName: '',
          interval: null,
        },
        expectedSnapshotId: repository.head.id,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PLAYLIST_IMMUTABLE' })

    repository.head.data.userList[0]?.list.push({
      id: 'duplicate',
      source: 'wy',
    })
    await expect(
      service.addSong({
        userId: 'user-id',
        actor: 'admin',
        playlistId: 'user:target',
        song: {
          id: 'duplicate',
          source: 'wy',
          name: 'Duplicate',
          singer: 'Singer',
          albumName: '',
          interval: null,
        },
        expectedSnapshotId: repository.head.id,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SONG_ALREADY_EXISTS' })

    const fullData = baseData()
    fullData.defaultList = Array.from(
      { length: syncLimits.maxTracks },
      (_, index) => ({ id: `song-${index}` }),
    )
    const fullRepository = new MemoryRepository(fullData)
    const fullService = new PlaylistManagementService(fullRepository, hub([]))
    await expect(
      fullService.addSong({
        userId: 'user-id',
        actor: 'admin',
        playlistId: 'user:target',
        song: {
          id: 'valid-id',
          source: 'wy',
          name: 'Over capacity',
          singer: 'Singer',
          albumName: '',
          interval: null,
        },
        expectedSnapshotId: fullRepository.head.id,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAYLIST_CAPACITY_EXCEEDED',
    })
    expect(repository.saveCalls).toBe(0)
    expect(fullRepository.saveCalls).toBe(0)
  })

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

  it('stores a playlist quality without changing the existing list source', async () => {
    const actions: ListAction[] = []
    const repository = new MemoryRepository(baseData())
    const service = new PlaylistManagementService(
      repository,
      hub([connection({ actions })]),
    )

    const result = await service.rename({
      userId: 'user-id',
      actor: 'admin',
      playlistId: 'user:target',
      name: 'Target',
      quality: 'hires',
      expectedSnapshotId: repository.head.id,
    })

    expect(result.playlist).toMatchObject({
      id: 'user:target',
      quality: 'hires',
    })
    expect(repository.head.data.userList[0]).toMatchObject({
      name: 'Target',
      source: 'wy',
      sourceListId: 'remote-list',
    })
    expect(actions).toEqual([
      {
        action: 'list_update',
        data: [expect.objectContaining({ id: 'target', source: 'wy' })],
      },
    ])
    expect(repository.qualities).toEqual(new Map([['target', 'hires']]))
    expect(repository.audits).toEqual([
      expect.objectContaining({ action: 'playlist.update' }),
    ])

    await service.delete({
      userId: 'user-id',
      actor: 'admin',
      playlistId: 'user:target',
      expectedSnapshotId: repository.head.id,
    })
    expect(repository.qualities).toEqual(new Map())
    expect(repository.head.data.userList).toEqual([])
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
