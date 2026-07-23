import { describe, expect, it } from 'vitest'
import { SnapshotConflictError, type SnapshotRecord } from '../db/repository.js'
import type { DislikeRules, ListData, SyncDomain } from '../protocol/index.js'
import { SyncEngine, type SyncRepository } from './engine.js'
import type { SyncLogger } from './logging.js'
import type { ConnectionHub, SyncConnection } from './types.js'

const emptyList = (): ListData => ({
  defaultList: [],
  loveList: [],
  userList: [],
})

const listSnapshot = (
  id: string,
  data: ListData = emptyList(),
): SnapshotRecord<ListData> => ({
  id,
  hash: id,
  data,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  itemCount: 0,
  byteSize: 0,
})

class ListRepository implements SyncRepository {
  getHeadCalls = 0
  saveAttempts = 0
  markedSnapshots: string[] = []
  savedData?: ListData

  constructor(
    private readonly conflictFirst: boolean,
    private readonly events: string[],
    private readonly saveError?: Error,
  ) {}

  async getHead(
    domain: 'list',
    userId: string,
  ): Promise<SnapshotRecord<ListData>>
  async getHead(
    domain: 'dislike',
    userId: string,
  ): Promise<SnapshotRecord<DislikeRules>>
  async getHead(domain: SyncDomain, _userId: string): Promise<SnapshotRecord> {
    if (domain === 'dislike') throw new Error('Unexpected dislike read')
    this.getHeadCalls += 1
    return listSnapshot(`head-${this.getHeadCalls}`)
  }

  async getDeviceSnapshot(
    domain: 'list',
    userId: string,
    deviceId: string,
  ): Promise<SnapshotRecord<ListData> | null>
  async getDeviceSnapshot(
    domain: 'dislike',
    userId: string,
    deviceId: string,
  ): Promise<SnapshotRecord<DislikeRules> | null>
  async getDeviceSnapshot(
    _domain: SyncDomain,
    _userId: string,
    _deviceId: string,
  ): Promise<SnapshotRecord | null> {
    return null
  }

  async saveSnapshot(input: {
    userId: string
    domain: 'list'
    data: ListData
    sourceDeviceId?: string
    expectedSnapshotId?: string
  }): Promise<SnapshotRecord<ListData>>
  async saveSnapshot(input: {
    userId: string
    domain: 'dislike'
    data: DislikeRules
    sourceDeviceId?: string
    expectedSnapshotId?: string
  }): Promise<SnapshotRecord<DislikeRules>>
  async saveSnapshot(input: {
    userId: string
    domain: SyncDomain
    data: ListData | DislikeRules
    sourceDeviceId?: string
    expectedSnapshotId?: string
  }): Promise<SnapshotRecord> {
    if (input.domain === 'dislike' || typeof input.data === 'string')
      throw new Error('Unexpected dislike write')
    if (this.saveError) throw this.saveError
    this.saveAttempts += 1
    if (this.conflictFirst && this.saveAttempts === 1)
      throw new SnapshotConflictError()
    this.savedData = input.data
    return listSnapshot('saved', input.data)
  }

  async markDeviceSnapshot(
    _clientId: string,
    _domain: SyncDomain,
    snapshotId: string,
  ): Promise<void> {
    this.markedSnapshots.push(snapshotId)
    this.events.push('mark')
  }
}

function listConnection(input: {
  events: string[]
  listData?: unknown
  setListData?: () => Promise<void>
}): SyncConnection {
  return {
    connectionId: 'connection-1',
    pathMode: 'root',
    active: true,
    device: {
      clientId: 'client',
      userId: 'user',
      userName: 'User',
      key: 'key',
      deviceName: 'Device',
      isMobile: false,
    },
    user: {
      id: 'user',
      name: 'User',
      authKey: 'key',
      enabled: true,
      maxSnapshots: 10,
      addMusicLocationType: 'bottom',
    },
    feature: {},
    moduleReady: { list: false, dislike: false },
    remote: {
      getEnabledFeatures: async () => ({
        list: { skipSnapshot: false },
      }),
      finished: async () => {
        input.events.push('connection-finished')
      },
    },
    remoteList: {
      onListSyncAction: async () => {},
      list_sync_get_md5: async () => 'remote-hash',
      list_sync_get_sync_mode: async () => 'merge_local_remote',
      list_sync_get_list_data: async () =>
        input.listData ?? {
          defaultList: [{ id: 'song' }],
          loveList: [],
          userList: [],
        },
      list_sync_set_list_data: async () => {
        input.events.push('set')
        await input.setListData?.()
      },
      list_sync_finished: async () => {
        input.events.push('list-finished')
      },
    },
    remoteDislike: {
      onDislikeSyncAction: async () => {},
      dislike_sync_get_md5: async () => '',
      dislike_sync_get_sync_mode: async () => 'merge_local_remote',
      dislike_sync_get_list_data: async () => '',
      dislike_sync_set_list_data: async () => {},
      dislike_sync_finished: async () => {},
    },
    close: () => {},
  }
}

const directHub: ConnectionHub = {
  forUser: () => [],
  runExclusive: (_userId, task) => task(),
}

describe('SyncEngine initial synchronization', () => {
  it('normalizes legacy playlist metadata before saving initial data', async () => {
    const repository = new ListRepository(false, [])
    const connection = listConnection({
      events: [],
      listData: {
        defaultList: [],
        loveList: [],
        userList: [
          {
            id: 'legacy-list',
            name: 'Legacy list',
            sourceListId: 123456,
            list: [],
          },
        ],
      },
    })
    const engine = new SyncEngine(repository, directHub)

    await engine.initialize(connection)

    expect(repository.savedData?.userList).toEqual([
      {
        id: 'legacy-list',
        name: 'Legacy list',
        sourceListId: '123456',
        locationUpdateTime: null,
        list: [],
      },
    ])
    expect(repository.markedSnapshots).toEqual(['saved'])
    expect(connection.moduleReady.list).toBe(true)
  })

  it('accepts nullable desktop playlist metadata during initial sync', async () => {
    const repository = new ListRepository(false, [])
    const connection = listConnection({
      events: [],
      listData: {
        defaultList: [],
        loveList: [],
        userList: [
          {
            id: 'desktop-list',
            name: 'Desktop list',
            source: null,
            sourceListId: null,
            locationUpdateTime: null,
            list: [],
          },
        ],
      },
    })
    const engine = new SyncEngine(repository, directHub)

    await engine.initialize(connection)

    expect(repository.savedData?.userList).toEqual([
      {
        id: 'desktop-list',
        name: 'Desktop list',
        locationUpdateTime: null,
        list: [],
      },
    ])
    expect(repository.markedSnapshots).toEqual(['saved'])
    expect(connection.moduleReady.list).toBe(true)
  })

  it('recomputes after a CAS conflict and advances the baseline last', async () => {
    const events: string[] = []
    const logs: Array<{ bindings: Record<string, unknown>; message: string }> =
      []
    const logger: SyncLogger = {
      debug: (bindings, message) => logs.push({ bindings, message }),
      info: (bindings, message) => logs.push({ bindings, message }),
      warn: (bindings, message) => logs.push({ bindings, message }),
    }
    const repository = new ListRepository(true, events)
    const connection = listConnection({ events })
    const engine = new SyncEngine(repository, directHub, logger)

    await engine.initialize(connection)

    expect(repository.saveAttempts).toBe(2)
    expect(repository.getHeadCalls).toBe(2)
    expect(repository.markedSnapshots).toEqual(['saved'])
    expect(events).toEqual([
      'set',
      'list-finished',
      'mark',
      'connection-finished',
    ])
    expect(connection.moduleReady.list).toBe(true)
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bindings: expect.objectContaining({
            event: 'sync.cas.retry',
            connectionId: 'connection-1',
            userRef: expect.stringMatching(/^[a-f0-9]{12}$/),
            deviceRef: expect.stringMatching(/^[a-f0-9]{12}$/),
            domain: 'list',
            attempt: 1,
          }),
          message: 'LX snapshot conflict; retrying synchronization',
        }),
      ]),
    )
    expect(logs.map((entry) => entry.bindings.event)).toEqual(
      expect.arrayContaining([
        'sync.initialize.started',
        'sync.cas.retry',
        'sync.domain.completed',
        'sync.initialize.completed',
      ]),
    )
    expect(JSON.stringify(logs)).not.toContain('"userId":"user"')
    expect(JSON.stringify(logs)).not.toContain('"deviceRef":"client"')
  })

  it('does not advance the device baseline when client delivery fails', async () => {
    const events: string[] = []
    const repository = new ListRepository(false, events)
    const connection = listConnection({
      events,
      setListData: async () => {
        throw new Error('delivery failed')
      },
    })
    const engine = new SyncEngine(repository, directHub)

    await expect(engine.initialize(connection)).rejects.toThrow(
      'delivery failed',
    )
    expect(repository.markedSnapshots).toEqual([])
    expect(connection.moduleReady.list).toBe(false)
  })

  it('logs terminal action failures without error details', async () => {
    const logs: Array<{ bindings: Record<string, unknown>; message: string }> =
      []
    const logger: SyncLogger = {
      debug: (bindings, message) => logs.push({ bindings, message }),
      info: (bindings, message) => logs.push({ bindings, message }),
      warn: (bindings, message) => logs.push({ bindings, message }),
    }
    const repository = new ListRepository(
      false,
      [],
      new Error('sensitive database query'),
    )
    const connection = listConnection({ events: [] })
    connection.moduleReady.list = true
    const engine = new SyncEngine(repository, directHub, logger)

    await expect(
      engine.applyList(connection, {
        action: 'list_music_add',
        data: {
          id: 'default',
          musicInfos: [{ id: 'track' }],
          addMusicLocationType: 'bottom',
        },
      }),
    ).rejects.toThrow('sensitive database query')

    expect(logs).toContainEqual({
      bindings: expect.objectContaining({
        event: 'sync.action.failed',
        domain: 'list',
        errorType: 'Error',
      }),
      message: 'LX list synchronization action failed',
    })
    expect(JSON.stringify(logs)).not.toContain('sensitive database query')
  })

  it('logs action validation failures before touching the repository', async () => {
    const logs: Array<{ bindings: Record<string, unknown>; message: string }> =
      []
    const logger: SyncLogger = {
      debug: (bindings, message) => logs.push({ bindings, message }),
      info: (bindings, message) => logs.push({ bindings, message }),
      warn: (bindings, message) => logs.push({ bindings, message }),
    }
    const repository = new ListRepository(false, [])
    const connection = listConnection({ events: [] })
    connection.moduleReady.list = true
    const engine = new SyncEngine(repository, directHub, logger)

    await expect(
      engine.applyList(connection, {
        action: 'invalid_action',
        data: { secret: 'client-controlled-payload' },
      }),
    ).rejects.toThrow()

    expect(repository.getHeadCalls).toBe(0)
    expect(logs).toContainEqual({
      bindings: expect.objectContaining({
        event: 'sync.action.failed',
        domain: 'list',
        errorType: 'Error',
      }),
      message: 'LX list synchronization action failed',
    })
    expect(JSON.stringify(logs)).not.toContain('client-controlled-payload')
  })

  it('logs feature validation failures without client-controlled details', async () => {
    const logs: Array<{ bindings: Record<string, unknown>; message: string }> =
      []
    const logger: SyncLogger = {
      debug: (bindings, message) => logs.push({ bindings, message }),
      info: (bindings, message) => logs.push({ bindings, message }),
      warn: (bindings, message) => logs.push({ bindings, message }),
    }
    const repository = new ListRepository(false, [])
    const connection = listConnection({ events: [] })
    const engine = new SyncEngine(repository, directHub, logger)

    await expect(
      engine.featureChanged(connection, {
        list: { skipSnapshot: 'client-controlled-payload' },
      }),
    ).rejects.toThrow()

    expect(repository.getHeadCalls).toBe(0)
    expect(logs).toContainEqual({
      bindings: expect.objectContaining({
        event: 'sync.features.failed',
        errorType: 'Error',
        userRef: expect.stringMatching(/^[a-f0-9]{12}$/),
        deviceRef: expect.stringMatching(/^[a-f0-9]{12}$/),
      }),
      message: 'LX synchronization feature change failed',
    })
    expect(JSON.stringify(logs)).not.toContain('client-controlled-payload')
  })
})
