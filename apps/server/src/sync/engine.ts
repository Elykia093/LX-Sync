import {
  type Repository,
  SnapshotConflictError,
  type SnapshotRecord,
} from '../db/repository.js'
import {
  type DislikeAction,
  type ListAction,
  type ListData,
  LX_SYNC,
  type SyncDomain,
} from '../protocol/index.js'
import {
  hasListContent,
  mergeDislikeFromSnapshot,
  mergeListsFromSnapshot,
  resolveInitialDislike,
  resolveInitialList,
  transformClientMode,
} from './merge.js'
import {
  applyDislikeAction,
  applyListAction,
  parseListData,
} from './snapshot.js'
import type { ConnectionHub, SyncConnection } from './types.js'
import { parseFeatures } from './validation.js'

export type SyncRepository = Pick<
  Repository,
  'getHead' | 'getDeviceSnapshot' | 'saveSnapshot' | 'markDeviceSnapshot'
>

export class SyncEngine {
  constructor(
    private readonly repository: SyncRepository,
    private readonly hub: ConnectionHub,
  ) {}

  async initialize(connection: SyncConnection): Promise<void> {
    return this.hub.runExclusive(connection.user.id, async () => {
      this.requireActive(connection)
      await this.initializeExclusive(connection)
    })
  }

  private async initializeExclusive(connection: SyncConnection): Promise<void> {
    const feature = parseFeatures(
      await connection.remote.getEnabledFeatures(
        'server',
        LX_SYNC.featureVersion,
      ),
    )
    connection.feature = feature
    if (feature.list) await this.syncList(connection)
    if (feature.dislike) await this.syncDislike(connection)
    await connection.remote.finished()
  }

  async featureChanged(
    connection: SyncConnection,
    rawFeature: unknown,
  ): Promise<void> {
    return this.hub.runExclusive(connection.user.id, async () => {
      this.requireActive(connection)
      await this.featureChangedExclusive(connection, rawFeature)
    })
  }

  private async featureChangedExclusive(
    connection: SyncConnection,
    rawFeature: unknown,
  ): Promise<void> {
    const feature = parseFeatures(rawFeature)
    for (const domain of ['list', 'dislike'] as const) {
      if (feature[domain] === undefined) continue
      connection.feature[domain] = feature[domain]
      connection.moduleReady[domain] = false
      if (feature[domain]) {
        if (domain === 'list') await this.syncList(connection)
        else await this.syncDislike(connection)
      }
    }
  }

  private async syncList(connection: SyncConnection): Promise<void> {
    const remoteHash = await connection.remoteList.list_sync_get_md5()
    let remote: ListData | undefined
    let initialMode: ReturnType<typeof transformClientMode> | undefined
    for (let attempt = 0; attempt < 3; attempt += 1) {
      this.requireActive(connection)
      const head = await this.repository.getHead('list', connection.user.id)
      if (typeof remoteHash === 'string' && remoteHash === head.hash) {
        await connection.remoteList.list_sync_finished()
        await this.repository.markDeviceSnapshot(
          connection.device.clientId,
          'list',
          head.id,
        )
        connection.moduleReady.list = true
        return
      }

      remote ??= parseListData(
        await connection.remoteList.list_sync_get_list_data(),
      )
      const previous =
        connection.feature.list && !connection.feature.list.skipSnapshot
          ? await this.repository.getDeviceSnapshot(
              'list',
              connection.user.id,
              connection.device.clientId,
            )
          : null
      let merged: ListData
      if (previous)
        merged = mergeListsFromSnapshot(
          head.data,
          remote,
          previous.data,
          connection.user.addMusicLocationType,
        )
      else if (!hasListContent(head.data)) merged = remote
      else if (!hasListContent(remote)) merged = head.data
      else {
        initialMode ??= transformClientMode(
          await connection.remoteList.list_sync_get_sync_mode(),
        )
        merged = resolveInitialList(
          initialMode,
          head.data,
          remote,
          connection.user.addMusicLocationType,
        )
      }

      try {
        const saved = await this.repository.saveSnapshot({
          userId: connection.user.id,
          domain: 'list',
          data: merged,
          expectedSnapshotId: head.id,
        })
        if (remoteHash !== saved.hash)
          await connection.remoteList.list_sync_set_list_data(merged)
        await this.broadcastList(
          connection,
          { action: 'list_data_overwrite', data: merged },
          saved,
        )
        await connection.remoteList.list_sync_finished()
        await this.repository.markDeviceSnapshot(
          connection.device.clientId,
          'list',
          saved.id,
        )
        connection.moduleReady.list = true
        return
      } catch (error) {
        if (!(error instanceof SnapshotConflictError) || attempt === 2)
          throw error
      }
    }
  }

  private async syncDislike(connection: SyncConnection): Promise<void> {
    const remoteHash = await connection.remoteDislike.dislike_sync_get_md5()
    let remote: string | undefined
    let initialMode: ReturnType<typeof transformClientMode> | undefined
    for (let attempt = 0; attempt < 3; attempt += 1) {
      this.requireActive(connection)
      const head = await this.repository.getHead('dislike', connection.user.id)
      if (typeof remoteHash === 'string' && remoteHash === head.hash) {
        await connection.remoteDislike.dislike_sync_finished()
        await this.repository.markDeviceSnapshot(
          connection.device.clientId,
          'dislike',
          head.id,
        )
        connection.moduleReady.dislike = true
        return
      }
      if (remote === undefined) {
        const rawRemote =
          await connection.remoteDislike.dislike_sync_get_list_data()
        if (typeof rawRemote !== 'string')
          throw new Error('Invalid dislike data')
        remote = rawRemote
      }
      const previous =
        connection.feature.dislike && !connection.feature.dislike.skipSnapshot
          ? await this.repository.getDeviceSnapshot(
              'dislike',
              connection.user.id,
              connection.device.clientId,
            )
          : null
      let merged: string
      if (previous)
        merged = mergeDislikeFromSnapshot(head.data, remote, previous.data)
      else if (!head.data) merged = remote
      else if (!remote) merged = head.data
      else {
        initialMode ??= transformClientMode(
          await connection.remoteDislike.dislike_sync_get_sync_mode(),
        )
        merged = resolveInitialDislike(initialMode, head.data, remote)
      }

      try {
        const saved = await this.repository.saveSnapshot({
          userId: connection.user.id,
          domain: 'dislike',
          data: merged,
          expectedSnapshotId: head.id,
        })
        if (remoteHash !== saved.hash)
          await connection.remoteDislike.dislike_sync_set_list_data(merged)
        await this.broadcastDislike(
          connection,
          { action: 'dislike_data_overwrite', data: merged },
          saved,
        )
        await connection.remoteDislike.dislike_sync_finished()
        await this.repository.markDeviceSnapshot(
          connection.device.clientId,
          'dislike',
          saved.id,
        )
        connection.moduleReady.dislike = true
        return
      } catch (error) {
        if (!(error instanceof SnapshotConflictError) || attempt === 2)
          throw error
      }
    }
  }

  async applyList(
    connection: SyncConnection,
    action: ListAction,
  ): Promise<void> {
    return this.hub.runExclusive(connection.user.id, async () => {
      this.requireActive(connection)
      await this.applyListExclusive(connection, action)
    })
  }

  private async applyListExclusive(
    connection: SyncConnection,
    action: ListAction,
  ): Promise<void> {
    if (!connection.moduleReady.list)
      throw new Error('List module is not ready')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const head = await this.repository.getHead('list', connection.user.id)
      try {
        const saved = await this.repository.saveSnapshot({
          userId: connection.user.id,
          domain: 'list',
          data: applyListAction(head.data, action),
          sourceDeviceId: connection.device.clientId,
          expectedSnapshotId: head.id,
        })
        await this.broadcastList(connection, action, saved)
        return
      } catch (error) {
        if (!(error instanceof SnapshotConflictError) || attempt === 2)
          throw error
      }
    }
  }

  async applyDislike(
    connection: SyncConnection,
    action: DislikeAction,
  ): Promise<void> {
    return this.hub.runExclusive(connection.user.id, async () => {
      this.requireActive(connection)
      await this.applyDislikeExclusive(connection, action)
    })
  }

  private async applyDislikeExclusive(
    connection: SyncConnection,
    action: DislikeAction,
  ): Promise<void> {
    if (!connection.moduleReady.dislike)
      throw new Error('Dislike module is not ready')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const head = await this.repository.getHead('dislike', connection.user.id)
      try {
        const saved = await this.repository.saveSnapshot({
          userId: connection.user.id,
          domain: 'dislike',
          data: applyDislikeAction(head.data, action),
          sourceDeviceId: connection.device.clientId,
          expectedSnapshotId: head.id,
        })
        await this.broadcastDislike(connection, action, saved)
        return
      } catch (error) {
        if (!(error instanceof SnapshotConflictError) || attempt === 2)
          throw error
      }
    }
  }

  private async broadcastList(
    connection: SyncConnection,
    action: ListAction,
    snapshot: SnapshotRecord,
  ): Promise<void> {
    await this.broadcast(connection, 'list', snapshot, async (client) =>
      client.remoteList.onListSyncAction(action),
    )
  }

  private async broadcastDislike(
    connection: SyncConnection,
    action: DislikeAction,
    snapshot: SnapshotRecord,
  ): Promise<void> {
    await this.broadcast(connection, 'dislike', snapshot, async (client) =>
      client.remoteDislike.onDislikeSyncAction(action),
    )
  }

  private async broadcast(
    source: SyncConnection,
    domain: SyncDomain,
    snapshot: SnapshotRecord,
    send: (connection: SyncConnection) => Promise<void>,
  ): Promise<void> {
    const tasks = this.hub
      .forUser(source.user.id)
      .filter(
        (client) =>
          client.device.clientId !== source.device.clientId &&
          client.moduleReady[domain],
      )
      .map(async (client) => {
        try {
          await send(client)
          await this.repository.markDeviceSnapshot(
            client.device.clientId,
            domain,
            snapshot.id,
          )
        } catch {
          client.close()
        }
      })
    await Promise.all(tasks)
  }

  private requireActive(connection: SyncConnection): void {
    if (!connection.active) throw new Error('Connection is inactive')
  }
}
