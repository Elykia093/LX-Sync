import { describe, expect, it } from 'vitest'
import { ConnectionRegistry, resolveUpgradeIp } from './gateway.js'
import { resolveSyncPath } from './path.js'
import type { SyncConnection } from './types.js'

function connectionFor(
  userId: string,
  clientId: string,
  close: () => void,
): SyncConnection {
  return {
    connectionId: `connection-${clientId}`,
    pathMode: 'root',
    active: true,
    device: {
      clientId,
      userId,
      userName: userId,
      key: 'key',
      deviceName: clientId,
      isMobile: false,
    },
    user: {
      id: userId,
      name: userId,
      authKey: 'key',
      enabled: true,
      maxSnapshots: 10,
      addMusicLocationType: 'bottom',
    },
    feature: {},
    moduleReady: { list: false, dislike: false },
    remote: {
      getEnabledFeatures: async () => ({}),
      finished: async () => {},
    },
    remoteList: {
      onListSyncAction: async () => {},
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
    close,
  }
}

describe('LX gateway proxy boundary', () => {
  it('ignores forwarded headers unless a trusted proxy is configured', () => {
    expect(
      resolveUpgradeIp({
        forwarded: '198.51.100.10',
        remoteAddress: '127.0.0.1',
        trustProxy: false,
      }),
    ).toBe('127.0.0.1')
  })

  it('uses the address appended by the nearest trusted proxy', () => {
    expect(
      resolveUpgradeIp({
        forwarded: '203.0.113.7, 198.51.100.10',
        remoteAddress: '127.0.0.1',
        trustProxy: true,
      }),
    ).toBe('198.51.100.10')
  })
})

describe('LX gateway path boundary', () => {
  it('accepts legacy and mobile WebSocket paths within the configured scope', () => {
    const userId = '00000000-0000-4000-8000-000000000001'
    expect(resolveSyncPath('/', '/base')).toEqual({ kind: 'root' })
    expect(resolveSyncPath('/socket', '/base')).toEqual({ kind: 'root' })
    expect(resolveSyncPath(`/base/${userId}`, '/base')).toEqual({
      kind: 'scoped',
      userId,
    })
    expect(resolveSyncPath(`/base/${userId}/socket`, '/base')).toEqual({
      kind: 'scoped',
      userId,
    })
    expect(resolveSyncPath('/unexpected', '/base')).toBeNull()
    expect(resolveSyncPath(`/base/${userId}/unexpected`, '/base')).toBeNull()
  })
})

describe('ConnectionRegistry', () => {
  it('serializes tasks for the same user', async () => {
    const registry = new ConnectionRegistry()
    const firstStarted = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const events: string[] = []
    const first = registry.runExclusive('user', async () => {
      events.push('first:start')
      firstStarted.resolve()
      await releaseFirst.promise
      events.push('first:end')
    })
    const second = registry.runExclusive('user', async () => {
      events.push('second')
    })

    await firstStarted.promise
    expect(events).toEqual(['first:start'])
    releaseFirst.resolve()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second'])
  })

  it('deactivates only the owned device and waits for in-flight writes', async () => {
    const registry = new ConnectionRegistry()
    let firstClosed = false
    let secondClosed = false
    const first = connectionFor('user-a', 'shared', () => {
      firstClosed = true
    })
    const second = connectionFor('user-b', 'shared', () => {
      secondClosed = true
    })
    registry.add(first)
    registry.add(second)
    const taskStarted = Promise.withResolvers<void>()
    const releaseTask = Promise.withResolvers<void>()
    const task = registry.runExclusive('user-a', async () => {
      taskStarted.resolve()
      await releaseTask.promise
    })
    await taskStarted.promise

    let closeFinished = false
    const close = registry.closeDevice('user-a', 'shared').then(() => {
      closeFinished = true
    })
    await Promise.resolve()
    expect(first.active).toBe(false)
    expect(firstClosed).toBe(true)
    expect(second.active).toBe(true)
    expect(secondClosed).toBe(false)
    expect(closeFinished).toBe(false)

    releaseTask.resolve()
    await Promise.all([task, close])
    expect(closeFinished).toBe(true)
  })
})
