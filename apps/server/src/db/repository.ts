import { randomBytes, randomUUID } from 'node:crypto'
import { type Kysely, sql, type Transaction, type Updateable } from 'kysely'
import type {
  AddMusicLocationType,
  DislikeRules,
  ListData,
  SyncDomain,
} from '../protocol/index.js'
import { decryptAtRest, encryptAtRest } from '../security/crypto.js'
import {
  emptyListData,
  parseSnapshot,
  type SerializedSnapshot,
  serializeSnapshot,
} from '../sync/snapshot.js'
import type { Database, SyncUsersTable } from './schema.js'

type DatabaseExecutor = Kysely<Database> | Transaction<Database>

export interface AuditEventInput {
  actor: string
  action: string
  targetType: string
  targetId?: string
  metadata?: Record<string, unknown>
}

export interface SyncUserRecord {
  id: string
  name: string
  authKey: string
  enabled: boolean
  maxSnapshots: number
  addMusicLocationType: AddMusicLocationType
}

export interface DeviceRecord {
  clientId: string
  userId: string
  userName: string
  key: string
  deviceName: string
  isMobile: boolean
}

export interface SnapshotRecord<
  T extends ListData | DislikeRules = ListData | DislikeRules,
> {
  id: string
  hash: string
  data: T
  createdAt: Date
  itemCount: number
  byteSize: number
}

export interface UserSummary {
  id: string
  name: string
  enabled: boolean
  maxSnapshots: number
  addMusicLocationType: AddMusicLocationType
  deviceCount: number
  createdAt: Date
}

export class SnapshotConflictError extends Error {
  constructor() {
    super('Snapshot head changed')
    this.name = 'SnapshotConflictError'
  }
}

export class Repository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly masterKey: string,
  ) {}

  async checkDatabase(): Promise<void> {
    await sql`select 1`.execute(this.db)
  }

  async ensureServiceMetadata(): Promise<string> {
    const existing = await this.db
      .selectFrom('serviceMetadata')
      .select('serverId')
      .where('id', '=', 1)
      .executeTakeFirst()
    if (existing) return existing.serverId
    const serverId = randomBytes(16).toString('base64')
    await this.db
      .insertInto('serviceMetadata')
      .values({ id: 1, serverId })
      .onConflict((conflict) => conflict.column('id').doNothing())
      .execute()
    const saved = await this.db
      .selectFrom('serviceMetadata')
      .select('serverId')
      .where('id', '=', 1)
      .executeTakeFirstOrThrow()
    return saved.serverId
  }

  async createUser(
    input: {
      name: string
      authKey: string
      maxSnapshots: number
      addMusicLocationType: AddMusicLocationType
    },
    audit?: Omit<AuditEventInput, 'targetId'>,
  ): Promise<{
    id: string
    name: string
  }> {
    return this.db.transaction().execute(async (transaction) => {
      const id = randomUUID()
      const name = input.name.trim()
      await transaction
        .insertInto('syncUsers')
        .values({
          id,
          name,
          authKeyEncrypted: encryptAtRest(input.authKey, this.masterKey),
          enabled: true,
          maxSnapshots: input.maxSnapshots,
          addMusicLocationType: input.addMusicLocationType,
        })
        .executeTakeFirstOrThrow()

      await this.createInitialHead(
        transaction,
        id,
        'list',
        serializeSnapshot('list', emptyListData()),
      )
      await this.createInitialHead(
        transaction,
        id,
        'dislike',
        serializeSnapshot('dislike', ''),
      )
      if (audit) await this.insertAudit(transaction, { ...audit, targetId: id })
      return { id, name }
    })
  }

  private async createInitialHead(
    transaction: Transaction<Database>,
    userId: string,
    domain: SyncDomain,
    snapshot: SerializedSnapshot,
  ): Promise<void> {
    const snapshotId = randomUUID()
    await transaction
      .insertInto('syncSnapshots')
      .values({
        id: snapshotId,
        userId,
        domain,
        hash: snapshot.hash,
        contentHash: snapshot.contentHash,
        payload: snapshot.payload,
        itemCount: snapshot.itemCount,
        byteSize: snapshot.byteSize,
        sourceDeviceId: null,
      })
      .executeTakeFirstOrThrow()
    await transaction
      .insertInto('syncHeads')
      .values({ userId, domain, snapshotId, version: 1 })
      .executeTakeFirstOrThrow()
  }

  private userSummaryQuery() {
    return this.db
      .selectFrom('syncUsers')
      .select([
        'id',
        'name',
        'enabled',
        'maxSnapshots',
        'addMusicLocationType',
        'createdAt',
      ])
      .select((builder) =>
        builder
          .selectFrom('devices')
          .select((inner) => inner.fn.count<number>('clientId').as('count'))
          .whereRef('devices.userId', '=', 'syncUsers.id')
          .where('devices.revokedAt', 'is', null)
          .as('deviceCount'),
      )
  }

  async listUsers(): Promise<UserSummary[]> {
    return this.userSummaryQuery()
      .orderBy('createdAt', 'asc')
      .execute()
      .then((rows) =>
        rows.map((row) => ({
          id: row.id,
          name: row.name,
          enabled: row.enabled,
          maxSnapshots: row.maxSnapshots,
          addMusicLocationType: row.addMusicLocationType,
          deviceCount: Number(row.deviceCount ?? 0),
          createdAt: row.createdAt,
        })),
      )
  }

  async getUserSummary(userId: string): Promise<UserSummary | null> {
    const row = await this.userSummaryQuery()
      .where('id', '=', userId)
      .executeTakeFirst()
    return row
      ? {
          id: row.id,
          name: row.name,
          enabled: row.enabled,
          maxSnapshots: row.maxSnapshots,
          addMusicLocationType: row.addMusicLocationType,
          deviceCount: Number(row.deviceCount ?? 0),
          createdAt: row.createdAt,
        }
      : null
  }

  async getUser(userId: string): Promise<SyncUserRecord | null> {
    const row = await this.db
      .selectFrom('syncUsers')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst()
    return row ? this.mapUser(row) : null
  }

  async getEnabledUsersForAuthentication(): Promise<SyncUserRecord[]> {
    const rows = await this.db
      .selectFrom('syncUsers')
      .selectAll()
      .where('enabled', '=', true)
      .execute()
    return rows.map((row) => this.mapUser(row))
  }

  private mapUser(row: {
    id: string
    name: string
    authKeyEncrypted: string
    enabled: boolean
    maxSnapshots: number
    addMusicLocationType: AddMusicLocationType
  }): SyncUserRecord {
    return {
      id: row.id,
      name: row.name,
      authKey: decryptAtRest(row.authKeyEncrypted, this.masterKey),
      enabled: row.enabled,
      maxSnapshots: row.maxSnapshots,
      addMusicLocationType: row.addMusicLocationType,
    }
  }

  async updateUser(
    userId: string,
    patch: {
      enabled?: boolean
      maxSnapshots?: number
      addMusicLocationType?: AddMusicLocationType
      authKey?: string
    },
    audit?: AuditEventInput,
  ): Promise<boolean> {
    const values: Updateable<SyncUsersTable> = { updatedAt: new Date() }
    if (patch.enabled !== undefined) values.enabled = patch.enabled
    if (patch.maxSnapshots !== undefined)
      values.maxSnapshots = patch.maxSnapshots
    if (patch.addMusicLocationType !== undefined)
      values.addMusicLocationType = patch.addMusicLocationType
    if (patch.authKey !== undefined)
      values.authKeyEncrypted = encryptAtRest(patch.authKey, this.masterKey)
    return this.db.transaction().execute(async (transaction) => {
      const result = await transaction
        .updateTable('syncUsers')
        .set(values)
        .where('id', '=', userId)
        .executeTakeFirst()
      if (result.numUpdatedRows !== 1n) return false
      if (audit) await this.insertAudit(transaction, audit)
      return true
    })
  }

  async registerDevice(input: {
    userId: string
    clientId: string
    key: string
    deviceName: string
    isMobile: boolean
  }): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom('syncUsers')
        .select('id')
        .where('id', '=', input.userId)
        .forUpdate()
        .executeTakeFirstOrThrow()
      const count = await transaction
        .selectFrom('devices')
        .select((builder) => builder.fn.count<number>('clientId').as('count'))
        .where('userId', '=', input.userId)
        .where('revokedAt', 'is', null)
        .executeTakeFirstOrThrow()
      if (Number(count.count) >= 100) throw new Error('Device limit reached')
      await transaction
        .insertInto('devices')
        .values({
          clientId: input.clientId,
          userId: input.userId,
          keyEncrypted: encryptAtRest(input.key, this.masterKey),
          deviceName: input.deviceName,
          isMobile: input.isMobile,
          lastConnectAt: null,
          revokedAt: null,
        })
        .executeTakeFirstOrThrow()
    })
  }

  async getDevice(clientId: string): Promise<DeviceRecord | null> {
    const row = await this.db
      .selectFrom('devices')
      .innerJoin('syncUsers', 'syncUsers.id', 'devices.userId')
      .select([
        'devices.clientId',
        'devices.userId',
        'devices.keyEncrypted',
        'devices.deviceName',
        'devices.isMobile',
        'syncUsers.name as userName',
      ])
      .where('devices.clientId', '=', clientId)
      .where('devices.revokedAt', 'is', null)
      .where('syncUsers.enabled', '=', true)
      .executeTakeFirst()
    if (!row) return null
    return {
      clientId: row.clientId,
      userId: row.userId,
      userName: row.userName,
      key: decryptAtRest(row.keyEncrypted, this.masterKey),
      deviceName: row.deviceName,
      isMobile: row.isMobile,
    }
  }

  async touchDevice(clientId: string, deviceName?: string): Promise<boolean> {
    const result = await this.db
      .updateTable('devices')
      .set({
        ...(deviceName === undefined ? {} : { deviceName }),
        lastConnectAt: new Date(),
        updatedAt: new Date(),
      })
      .where('clientId', '=', clientId)
      .where('revokedAt', 'is', null)
      .executeTakeFirst()
    return result.numUpdatedRows === 1n
  }

  async listDevices(userId: string) {
    return this.db
      .selectFrom('devices')
      .select([
        'clientId',
        'deviceName',
        'isMobile',
        'lastConnectAt',
        'revokedAt',
        'createdAt',
      ])
      .where('userId', '=', userId)
      .orderBy('lastConnectAt', 'desc')
      .execute()
  }

  async revokeDevice(
    userId: string,
    clientId: string,
    audit?: AuditEventInput,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (transaction) => {
      const result = await transaction
        .updateTable('devices')
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where('clientId', '=', clientId)
        .where('userId', '=', userId)
        .where('revokedAt', 'is', null)
        .executeTakeFirst()
      if (result.numUpdatedRows !== 1n) return false
      if (audit) await this.insertAudit(transaction, audit)
      return true
    })
  }

  async getHead(
    domain: 'list',
    userId: string,
  ): Promise<SnapshotRecord<ListData>>
  async getHead(
    domain: 'dislike',
    userId: string,
  ): Promise<SnapshotRecord<DislikeRules>>
  async getHead(domain: SyncDomain, userId: string): Promise<SnapshotRecord> {
    const row = await this.db
      .selectFrom('syncHeads')
      .innerJoin('syncSnapshots', 'syncSnapshots.id', 'syncHeads.snapshotId')
      .select([
        'syncSnapshots.id',
        'syncSnapshots.hash',
        'syncSnapshots.payload',
        'syncSnapshots.createdAt',
        'syncSnapshots.itemCount',
        'syncSnapshots.byteSize',
      ])
      .where('syncHeads.userId', '=', userId)
      .where('syncHeads.domain', '=', domain)
      .executeTakeFirstOrThrow()
    return this.mapSnapshot(domain, row)
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
    domain: SyncDomain,
    userId: string,
    deviceId: string,
  ): Promise<SnapshotRecord | null> {
    const row = await this.db
      .selectFrom('deviceSyncState')
      .innerJoin('devices', 'devices.clientId', 'deviceSyncState.deviceId')
      .innerJoin(
        'syncSnapshots',
        'syncSnapshots.id',
        'deviceSyncState.snapshotId',
      )
      .select([
        'syncSnapshots.id',
        'syncSnapshots.hash',
        'syncSnapshots.payload',
        'syncSnapshots.createdAt',
        'syncSnapshots.itemCount',
        'syncSnapshots.byteSize',
      ])
      .where('deviceSyncState.deviceId', '=', deviceId)
      .where('deviceSyncState.domain', '=', domain)
      .where('devices.userId', '=', userId)
      .executeTakeFirst()
    return row ? this.mapSnapshot(domain, row) : null
  }

  private mapSnapshot(
    domain: SyncDomain,
    row: {
      id: string
      hash: string
      payload: string
      createdAt: Date
      itemCount: number
      byteSize: number
    },
  ): SnapshotRecord {
    return {
      id: row.id,
      hash: row.hash,
      data:
        domain === 'list'
          ? parseSnapshot('list', row.payload)
          : parseSnapshot('dislike', row.payload),
      createdAt: row.createdAt,
      itemCount: row.itemCount,
      byteSize: row.byteSize,
    }
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
    let snapshot: SerializedSnapshot
    if (input.domain === 'list') {
      if (typeof input.data === 'string')
        throw new Error('List snapshot must be an object')
      snapshot = serializeSnapshot('list', input.data)
    } else {
      if (typeof input.data !== 'string')
        throw new Error('Dislike snapshot must be a string')
      snapshot = serializeSnapshot('dislike', input.data)
    }
    return this.db.transaction().execute(async (transaction) => {
      const head = await transaction
        .selectFrom('syncHeads')
        .select(['snapshotId', 'version'])
        .where('userId', '=', input.userId)
        .where('domain', '=', input.domain)
        .forUpdate()
        .executeTakeFirstOrThrow()
      if (
        input.expectedSnapshotId &&
        head.snapshotId !== input.expectedSnapshotId
      )
        throw new SnapshotConflictError()

      await transaction
        .insertInto('syncSnapshots')
        .values({
          id: randomUUID(),
          userId: input.userId,
          domain: input.domain,
          hash: snapshot.hash,
          contentHash: snapshot.contentHash,
          payload: snapshot.payload,
          itemCount: snapshot.itemCount,
          byteSize: snapshot.byteSize,
          sourceDeviceId: input.sourceDeviceId ?? null,
        })
        .onConflict((conflict) =>
          conflict.columns(['userId', 'domain', 'contentHash']).doNothing(),
        )
        .execute()

      const stored = await transaction
        .selectFrom('syncSnapshots')
        .selectAll()
        .where('userId', '=', input.userId)
        .where('domain', '=', input.domain)
        .where('contentHash', '=', snapshot.contentHash)
        .executeTakeFirstOrThrow()

      const updated = await transaction
        .updateTable('syncHeads')
        .set({
          snapshotId: stored.id,
          version: sql`version + 1`,
          updatedAt: new Date(),
        })
        .where('userId', '=', input.userId)
        .where('domain', '=', input.domain)
        .executeTakeFirst()
      if (updated.numUpdatedRows !== 1n)
        throw new Error('Snapshot head update failed')

      if (input.sourceDeviceId)
        await this.upsertDeviceState(
          transaction,
          input.sourceDeviceId,
          input.domain,
          stored.id,
        )
      const user = await transaction
        .selectFrom('syncUsers')
        .select('maxSnapshots')
        .where('id', '=', input.userId)
        .executeTakeFirstOrThrow()
      await this.pruneSnapshots(
        transaction,
        input.userId,
        input.domain,
        user.maxSnapshots,
      )
      return this.mapSnapshot(input.domain, stored)
    })
  }

  private async upsertDeviceState(
    executor: DatabaseExecutor,
    deviceId: string,
    domain: SyncDomain,
    snapshotId: string,
  ): Promise<void> {
    await executor
      .insertInto('deviceSyncState')
      .values({ deviceId, domain, snapshotId })
      .onConflict((conflict) =>
        conflict
          .columns(['deviceId', 'domain'])
          .doUpdateSet({ snapshotId, lastSyncAt: new Date() }),
      )
      .execute()
  }

  async markDeviceSnapshot(
    deviceId: string,
    domain: SyncDomain,
    snapshotId: string,
  ): Promise<void> {
    await this.upsertDeviceState(this.db, deviceId, domain, snapshotId)
  }

  private async pruneSnapshots(
    executor: DatabaseExecutor,
    userId: string,
    domain: SyncDomain,
    maxSnapshots: number,
  ): Promise<void> {
    await sql`
      with ranked as (
        select id, row_number() over (order by created_at desc, id desc) as position
        from sync_snapshots
        where user_id = ${userId} and domain = ${domain}
      )
      delete from sync_snapshots snapshot
      using ranked
      where snapshot.id = ranked.id
        and ranked.position > ${maxSnapshots}
        and not exists (select 1 from sync_heads head where head.snapshot_id = snapshot.id)
        and not exists (select 1 from device_sync_state state where state.snapshot_id = snapshot.id)
    `.execute(executor)
  }

  async listSnapshots(userId: string, domain: SyncDomain, limit = 50) {
    return this.db
      .selectFrom('syncSnapshots')
      .select([
        'id',
        'hash',
        'itemCount',
        'byteSize',
        'sourceDeviceId',
        'createdAt',
      ])
      .where('userId', '=', userId)
      .where('domain', '=', domain)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(Math.min(Math.max(limit, 1), 100))
      .execute()
  }

  async restoreSnapshot(
    userId: string,
    domain: SyncDomain,
    snapshotId: string,
    audit?: AuditEventInput,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (transaction) => {
      const snapshot = await transaction
        .selectFrom('syncSnapshots')
        .select('id')
        .where('id', '=', snapshotId)
        .where('userId', '=', userId)
        .where('domain', '=', domain)
        .executeTakeFirst()
      if (!snapshot) return false
      const result = await transaction
        .updateTable('syncHeads')
        .set({ snapshotId, version: sql`version + 1`, updatedAt: new Date() })
        .where('userId', '=', userId)
        .where('domain', '=', domain)
        .executeTakeFirst()
      if (result.numUpdatedRows !== 1n) return false
      if (audit) await this.insertAudit(transaction, audit)
      return true
    })
  }

  async createSession(
    input: {
      sessionHash: string
      username: string
      expiresAt: Date
      remoteAddress: string | null
    },
    audit?: AuditEventInput,
  ): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      await transaction
        .insertInto('adminSessions')
        .values(input)
        .executeTakeFirstOrThrow()
      if (audit) await this.insertAudit(transaction, audit)
    })
  }

  async getSession(sessionHash: string) {
    return this.db
      .selectFrom('adminSessions')
      .selectAll()
      .where('sessionHash', '=', sessionHash)
      .where('expiresAt', '>', new Date())
      .executeTakeFirst()
  }

  async touchSession(sessionHash: string): Promise<void> {
    await this.db
      .updateTable('adminSessions')
      .set({ lastSeenAt: new Date() })
      .where('sessionHash', '=', sessionHash)
      .execute()
  }

  async deleteSession(
    sessionHash: string,
    audit?: AuditEventInput,
  ): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      await transaction
        .deleteFrom('adminSessions')
        .where('sessionHash', '=', sessionHash)
        .execute()
      if (audit) await this.insertAudit(transaction, audit)
    })
  }

  async deleteExpiredSessions(): Promise<void> {
    await this.db
      .deleteFrom('adminSessions')
      .where('expiresAt', '<=', new Date())
      .execute()
  }

  private async insertAudit(
    executor: DatabaseExecutor,
    input: AuditEventInput,
  ): Promise<void> {
    await executor
      .insertInto('auditEvents')
      .values({
        actor: input.actor,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        metadata: input.metadata ?? {},
      })
      .execute()
  }

  async listAudit(limit = 100) {
    return this.db
      .selectFrom('auditEvents')
      .selectAll()
      .orderBy('createdAt', 'desc')
      .limit(Math.min(Math.max(limit, 1), 200))
      .execute()
  }
}
