import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely'
import { FileMigrationProvider, Migrator } from 'kysely/migration'
import { Pool } from 'pg'
import type { Database } from './schema.js'

export function createDatabase(connectionString: string): Kysely<Database> {
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  })
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  })
}

interface MigrationOptions {
  readonly migrationTableSchema?: string
}

export async function migrateToLatest(
  db: Kysely<Database>,
  options: MigrationOptions = {},
): Promise<void> {
  const migrationFolder = fileURLToPath(
    new URL('./migrations', import.meta.url),
  )
  const migrator = new Migrator({
    db,
    ...(options.migrationTableSchema
      ? { migrationTableSchema: options.migrationTableSchema }
      : {}),
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder,
      import: (modulePath) => import(pathToFileURL(modulePath).href),
    }),
  })
  const { error, results } = await migrator.migrateToLatest()
  for (const result of results ?? []) {
    if (result.status === 'Error')
      throw new Error(`Migration ${result.migrationName} failed`)
  }
  if (error) throw error
}
