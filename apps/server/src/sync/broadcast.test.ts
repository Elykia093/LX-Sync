import { describe, expect, it } from 'vitest'
import type { SnapshotRecord } from '../db/repository.js'
import type { ListAction, ListData } from '../protocol/index.js'
import { broadcastListAction } from './broadcast.js'
import type { SyncConnection } from './types.js'

const snapshot: SnapshotRecord<ListData> = {
  id: '00000000-0000-4000-8000-000000000001',
  hash: 'hash',
  data: { defaultList: [], loveList: [], userList: [] },
  createdAt: new Date('2026-07-23T04:00:00.000Z'),
  itemCount: 0,
  byteSize: 0,
}

const action: ListAction = {
  action: 'list_music_clear',
  data: ['default'],
}

function connection(input: {
  clientId: string
  ready?: boolean
  active?: boolean
  send: () => Promise<void>
  close: () => void
}): SyncConnection {
  return {
    connectionId: input.clientId,
    pathMode: 'root',
    active: input.active ?? true,
    device: {
      clientId: input.clientId,
      userId: 'user-id',
      userName: 'User',
      key: 'key',
      deviceName: input.clientId,
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
    feature: {},
    moduleReady: { list: input.ready ?? true, dislike: false },
    remote: {
      getEnabledFeatures: async () => ({}),
      finished: async () => {},
    },
    remoteList: {
      onListSyncAction: input.send,
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
    close: input.close,
  }
}

describe('broadcastListAction', () => {
  it('advances only confirmed ready targets and closes failed connections', async () => {
    const sent: string[] = []
    const closed: string[] = []
    const marked: string[] = []
    const source = connection({
      clientId: 'source',
      send: async () => {
        sent.push('source')
      },
      close: () => closed.push('source'),
    })
    const ready = connection({
      clientId: 'ready',
      send: async () => {
        sent.push('ready')
      },
      close: () => closed.push('ready'),
    })
    const failed = connection({
      clientId: 'failed',
      send: async () => {
        throw new Error('delivery failed')
      },
      close: () => closed.push('failed'),
    })
    const notReady = connection({
      clientId: 'not-ready',
      ready: false,
      send: async () => {
        sent.push('not-ready')
      },
      close: () => closed.push('not-ready'),
    })

    await broadcastListAction({
      repository: {
        markDeviceSnapshot: async (deviceId) => {
          marked.push(deviceId)
        },
      },
      hub: { forUser: () => [source, ready, failed, notReady] },
      userId: 'user-id',
      action,
      snapshot,
      sourceDeviceId: 'source',
    })

    expect(sent).toEqual(['ready'])
    expect(marked).toEqual(['ready'])
    expect(closed).toEqual(['failed'])
  })
})
