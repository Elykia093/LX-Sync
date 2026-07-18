import type { ColumnType, Generated } from 'kysely'
import type { AddMusicLocationType, SyncDomain } from '../protocol/index.js'

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>

export interface ServiceMetadataTable {
  id: number
  serverId: string
  createdAt: Timestamp
}

export interface SyncUsersTable {
  id: string
  name: string
  authKeyEncrypted: string
  enabled: boolean
  maxSnapshots: number
  addMusicLocationType: AddMusicLocationType
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface DevicesTable {
  clientId: string
  userId: string
  keyEncrypted: string
  deviceName: string
  isMobile: boolean
  lastConnectAt: NullableTimestamp
  revokedAt: NullableTimestamp
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface SyncSnapshotsTable {
  id: string
  userId: string
  domain: SyncDomain
  hash: string
  contentHash: string
  payload: string
  itemCount: number
  byteSize: number
  sourceDeviceId: string | null
  createdAt: Timestamp
}

export interface SyncHeadsTable {
  userId: string
  domain: SyncDomain
  snapshotId: string
  version: number
  updatedAt: Timestamp
}

export interface DeviceSyncStateTable {
  deviceId: string
  domain: SyncDomain
  snapshotId: string
  lastSyncAt: Timestamp
}

export interface AdminSessionsTable {
  sessionHash: string
  username: string
  expiresAt: Timestamp
  lastSeenAt: Timestamp
  createdAt: Timestamp
  remoteAddress: string | null
}

export interface AuditEventsTable {
  id: Generated<string>
  actor: string
  action: string
  targetType: string
  targetId: string | null
  metadata: Record<string, unknown>
  createdAt: Timestamp
}

export interface Database {
  serviceMetadata: ServiceMetadataTable
  syncUsers: SyncUsersTable
  devices: DevicesTable
  syncSnapshots: SyncSnapshotsTable
  syncHeads: SyncHeadsTable
  deviceSyncState: DeviceSyncStateTable
  adminSessions: AdminSessionsTable
  auditEvents: AuditEventsTable
}
