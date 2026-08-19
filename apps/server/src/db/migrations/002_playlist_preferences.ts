import { type Kysely, sql } from 'kysely'
import type { Database } from '../schema.js'

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('playlistPreferences')
    .addColumn('userId', 'uuid', (column) =>
      column.notNull().references('syncUsers.id').onDelete('cascade'),
    )
    .addColumn('playlistId', 'text', (column) => column.notNull())
    .addColumn('quality', 'text', (column) => column.notNull())
    .addColumn('updatedAt', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint('playlist_preferences_primary', [
      'userId',
      'playlistId',
    ])
    .addCheckConstraint(
      'playlist_preferences_quality',
      sql`quality in ('128k', '320k', 'flac', 'hires', 'atmos', 'atmos_plus', 'master')`,
    )
    .execute()
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('playlistPreferences').ifExists().execute()
}
