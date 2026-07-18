import { type Kysely, sql } from 'kysely'
import type { Database } from '../schema.js'

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('serviceMetadata')
    .addColumn('id', 'smallint', (column) => column.primaryKey())
    .addColumn('serverId', 'text', (column) => column.notNull().unique())
    .addColumn('createdAt', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint('service_metadata_singleton', sql`id = 1`)
    .execute()

  await db.schema
    .createTable('syncUsers')
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('name', 'text', (column) => column.notNull())
    .addColumn('authKeyEncrypted', 'text', (column) => column.notNull())
    .addColumn('enabled', 'boolean', (column) =>
      column.notNull().defaultTo(true),
    )
    .addColumn('maxSnapshots', 'integer', (column) =>
      column.notNull().defaultTo(10),
    )
    .addColumn('addMusicLocationType', 'text', (column) =>
      column.notNull().defaultTo('bottom'),
    )
    .addColumn('createdAt', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updatedAt', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      'sync_users_name_not_blank',
      sql`length(btrim(name)) > 0`,
    )
    .addCheckConstraint(
      'sync_users_snapshot_limit',
      sql`max_snapshots between 1 and 1000`,
    )
    .addCheckConstraint(
      'sync_users_music_location',
      sql`add_music_location_type in ('top', 'bottom')`,
    )
    .execute()
  await db.schema
    .createIndex('sync_users_name_ci_unique')
    .unique()
    .on('syncUsers')
    .expression(sql`lower(name)`)
    .execute()

  await db.schema
    .createTable('devices')
    .addColumn('clientId', 'text', (column) => column.primaryKey())
    .addColumn('userId', 'uuid', (column) =>
      column.notNull().references('syncUsers.id').onDelete('cascade'),
    )
    .addColumn('keyEncrypted', 'text', (column) => column.notNull())
    .addColumn('deviceName', 'text', (column) => column.notNull())
    .addColumn('isMobile', 'boolean', (column) => column.notNull())
    .addColumn('lastConnectAt', 'timestamptz')
    .addColumn('revokedAt', 'timestamptz')
    .addColumn('createdAt', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updatedAt', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      'devices_name_not_blank',
      sql`length(btrim(device_name)) > 0`,
    )
    .execute()
  await db.schema
    .createIndex('devices_user_last_connect')
    .on('devices')
    .columns(['userId', 'lastConnectAt'])
    .execute()

  await db.schema
    .createTable('syncSnapshots')
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('userId', 'uuid', (column) =>
      column.notNull().references('syncUsers.id').onDelete('cascade'),
    )
    .addColumn('domain', 'text', (column) => column.notNull())
    .addColumn('hash', 'char(32)', (column) => column.notNull())
    .addColumn('contentHash', 'char(64)', (column) => column.notNull())
    .addColumn('payload', 'text', (column) => column.notNull())
    .addColumn('itemCount', 'integer', (column) => column.notNull())
    .addColumn('byteSize', 'integer', (column) => column.notNull())
    .addColumn('sourceDeviceId', 'text')
    .addColumn('createdAt', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint('sync_snapshots_user_domain_content', [
      'userId',
      'domain',
      'contentHash',
    ])
    .addCheckConstraint(
      'sync_snapshots_domain',
      sql`domain in ('list', 'dislike')`,
    )
    .addCheckConstraint(
      'sync_snapshots_sizes',
      sql`item_count >= 0 and byte_size >= 0`,
    )
    .execute()
  await db.schema
    .createIndex('sync_snapshots_history')
    .on('syncSnapshots')
    .columns(['userId', 'domain', 'createdAt'])
    .execute()

  await db.schema
    .createTable('syncHeads')
    .addColumn('userId', 'uuid', (column) =>
      column.notNull().references('syncUsers.id').onDelete('cascade'),
    )
    .addColumn('domain', 'text', (column) => column.notNull())
    .addColumn('snapshotId', 'uuid', (column) =>
      column.notNull().references('syncSnapshots.id').onDelete('restrict'),
    )
    .addColumn('version', 'integer', (column) => column.notNull().defaultTo(1))
    .addColumn('updatedAt', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint('sync_heads_primary', ['userId', 'domain'])
    .addCheckConstraint('sync_heads_domain', sql`domain in ('list', 'dislike')`)
    .addCheckConstraint('sync_heads_version', sql`version > 0`)
    .execute()

  await db.schema
    .createTable('deviceSyncState')
    .addColumn('deviceId', 'text', (column) =>
      column.notNull().references('devices.clientId').onDelete('cascade'),
    )
    .addColumn('domain', 'text', (column) => column.notNull())
    .addColumn('snapshotId', 'uuid', (column) =>
      column.notNull().references('syncSnapshots.id').onDelete('restrict'),
    )
    .addColumn('lastSyncAt', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint('device_sync_state_primary', [
      'deviceId',
      'domain',
    ])
    .addCheckConstraint(
      'device_sync_state_domain',
      sql`domain in ('list', 'dislike')`,
    )
    .execute()

  await db.schema
    .createTable('adminSessions')
    .addColumn('sessionHash', 'char(64)', (column) => column.primaryKey())
    .addColumn('username', 'text', (column) => column.notNull())
    .addColumn('expiresAt', 'timestamptz', (column) => column.notNull())
    .addColumn('lastSeenAt', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn('createdAt', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn('remoteAddress', 'text')
    .execute()
  await db.schema
    .createIndex('admin_sessions_expiry')
    .on('adminSessions')
    .column('expiresAt')
    .execute()

  await db.schema
    .createTable('auditEvents')
    .addColumn('id', 'bigserial', (column) => column.primaryKey())
    .addColumn('actor', 'text', (column) => column.notNull())
    .addColumn('action', 'text', (column) => column.notNull())
    .addColumn('targetType', 'text', (column) => column.notNull())
    .addColumn('targetId', 'text')
    .addColumn('metadata', 'jsonb', (column) =>
      column.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn('createdAt', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute()
  await db.schema
    .createIndex('audit_events_created')
    .on('auditEvents')
    .column('createdAt')
    .execute()
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('auditEvents').ifExists().execute()
  await db.schema.dropTable('adminSessions').ifExists().execute()
  await db.schema.dropTable('deviceSyncState').ifExists().execute()
  await db.schema.dropTable('syncHeads').ifExists().execute()
  await db.schema.dropTable('syncSnapshots').ifExists().execute()
  await db.schema.dropTable('devices').ifExists().execute()
  await db.schema.dropTable('syncUsers').ifExists().execute()
  await db.schema.dropTable('serviceMetadata').ifExists().execute()
}
