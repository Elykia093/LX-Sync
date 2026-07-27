import type { Repository, SnapshotRecord } from '../db/repository.js'
import type { ListAction } from '../protocol/index.js'
import {
  deviceLogReference,
  type SyncLogger,
  syncErrorLogContext,
  userLogReference,
} from './logging.js'
import type { ConnectionHub } from './types.js'

export type ListBroadcastRepository = Pick<Repository, 'markDeviceSnapshot'>

export async function broadcastListAction(input: {
  repository: ListBroadcastRepository
  hub: Pick<ConnectionHub, 'forUser'>
  userId: string
  action: ListAction
  snapshot: SnapshotRecord
  sourceDeviceId?: string
  logger?: SyncLogger
}): Promise<void> {
  const tasks = input.hub
    .forUser(input.userId)
    .filter(
      (connection) =>
        connection.active &&
        connection.moduleReady.list &&
        connection.device.clientId !== input.sourceDeviceId,
    )
    .map(async (connection) => {
      try {
        await connection.remoteList.onListSyncAction(input.action)
        await input.repository.markDeviceSnapshot(
          connection.device.clientId,
          'list',
          input.snapshot.id,
        )
      } catch (error) {
        input.logger?.warn(
          {
            event: 'sync.broadcast.failed',
            domain: 'list',
            userRef: userLogReference(input.userId),
            targetDeviceRef: deviceLogReference(connection.device.clientId),
            ...syncErrorLogContext(error),
          },
          'LX synchronization broadcast failed',
        )
        connection.close()
      }
    })
  await Promise.all(tasks)
}
