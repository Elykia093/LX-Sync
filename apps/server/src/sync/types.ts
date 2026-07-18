import type { DeviceRecord, SyncUserRecord } from '../db/repository.js'
import type { EnabledFeatures, SyncDomain } from '../protocol/index.js'

export interface ClientRemote {
  getEnabledFeatures: (
    serverType: 'server',
    supportedFeatures: Record<SyncDomain, number>,
  ) => Promise<unknown>
  finished: () => Promise<void>
}

export interface ClientListRemote {
  onListSyncAction: (action: unknown) => Promise<void>
  list_sync_get_md5: () => Promise<unknown>
  list_sync_get_sync_mode: () => Promise<unknown>
  list_sync_get_list_data: () => Promise<unknown>
  list_sync_set_list_data: (data: unknown) => Promise<void>
  list_sync_finished: () => Promise<void>
}

export interface ClientDislikeRemote {
  onDislikeSyncAction: (action: unknown) => Promise<void>
  dislike_sync_get_md5: () => Promise<unknown>
  dislike_sync_get_sync_mode: () => Promise<unknown>
  dislike_sync_get_list_data: () => Promise<unknown>
  dislike_sync_set_list_data: (data: unknown) => Promise<void>
  dislike_sync_finished: () => Promise<void>
}

export interface SyncConnection {
  active: boolean
  device: DeviceRecord
  user: SyncUserRecord
  feature: EnabledFeatures
  moduleReady: Record<SyncDomain, boolean>
  remote: ClientRemote
  remoteList: ClientListRemote
  remoteDislike: ClientDislikeRemote
  close: () => void
}

export interface ConnectionHub {
  forUser: (userId: string) => SyncConnection[]
  runExclusive: <T>(userId: string, task: () => Promise<T>) => Promise<T>
}
