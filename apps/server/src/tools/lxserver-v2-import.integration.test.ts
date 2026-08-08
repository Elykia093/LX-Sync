import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase, migrateToLatest } from '../db/connection.js'
import { Repository } from '../db/repository.js'
import type { ListData } from '../protocol/index.js'
import { deriveConnectionKey, md5 } from '../security/crypto.js'
import {
  applyLxserverV2ImportPlan,
  assertTargetReadyForImport,
  assertTargetSchemaDedicated,
  buildLxserverV2ImportPlan,
  TargetDatabaseNotEmptyError,
  TargetSchemaNotDedicatedError,
} from './lxserver-v2-import.js'

const testDatabaseUrl = guardedTestDatabaseUrl(process.env)
const integration = testDatabaseUrl ? describe : describe.skip

integration('lxserver v2 PostgreSQL import', () => {
  const schemaName = `lx_sync_test_import_${randomBytes(8).toString('hex')}`
  const masterKey = randomBytes(32).toString('base64')
  let sourceDirectory = ''
  let fixture: Awaited<ReturnType<typeof createSourceFixture>>
  let database: ReturnType<typeof createDatabase>

  beforeAll(async () => {
    if (!testDatabaseUrl) return
    sourceDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'lx-sync-import-integration-'),
    )
    fixture = await createSourceFixture(sourceDirectory)
    const administrator = createDatabase(testDatabaseUrl)
    try {
      await sql.raw(`create schema "${schemaName}"`).execute(administrator)
    } finally {
      await administrator.destroy()
    }
    database = createDatabase(databaseUrlForSchema(testDatabaseUrl, schemaName))
    await assertTargetSchemaDedicated(database)
    await migrateToLatest(database, { migrationTableSchema: schemaName })
  })

  afterAll(async () => {
    if (!testDatabaseUrl) return
    if (database) await database.destroy()
    const administrator = createDatabase(testDatabaseUrl)
    try {
      await sql
        .raw(`drop schema if exists "${schemaName}" cascade`)
        .execute(administrator)
    } finally {
      await administrator.destroy()
    }
    if (sourceDirectory)
      await rm(sourceDirectory, { recursive: true, force: true })
  })

  it('rejects unrelated target tables at the transactional apply boundary', async () => {
    const plan = await buildLxserverV2ImportPlan(sourceDirectory, {
      maxSnapshots: 10,
      addMusicLocationType: 'bottom',
    })
    await sql
      .raw('create table "unrelated_import_state" (id integer primary key)')
      .execute(database)
    try {
      await expect(
        applyLxserverV2ImportPlan(database, plan, masterKey),
      ).rejects.toBeInstanceOf(TargetSchemaNotDedicatedError)
    } finally {
      await sql.raw('drop table "unrelated_import_state"').execute(database)
    }
  })

  it('atomically preserves identity, credentials, snapshots, and baselines', async () => {
    const plan = await buildLxserverV2ImportPlan(sourceDirectory, {
      maxSnapshots: 10,
      addMusicLocationType: 'bottom',
    })
    await expect(
      applyLxserverV2ImportPlan(database, plan, masterKey),
    ).resolves.toEqual(plan.summary)

    const repository = new Repository(database, masterKey)
    await expect(repository.ensureServiceMetadata()).resolves.toBe(
      fixture.serverId,
    )
    const users = await repository.getEnabledUsersForAuthentication()
    expect(users).toHaveLength(1)
    const user = users[0]
    expect(user).toMatchObject({
      name: fixture.userName,
      authKey: deriveConnectionKey(fixture.connectionCode),
      maxSnapshots: 12,
      addMusicLocationType: 'top',
    })
    if (!user) throw new Error('Imported user is missing')

    await expect(repository.getDevice(fixture.clientId)).resolves.toMatchObject(
      {
        userId: user.id,
        key: fixture.deviceKey,
        deviceName: 'Source device',
        isMobile: true,
      },
    )
    const listHead = await repository.getHead('list', user.id)
    const dislikeHead = await repository.getHead('dislike', user.id)
    expect(listHead.data).toEqual(fixture.listData)
    expect(dislikeHead.data).toBe(fixture.dislikePayload)
    await expect(
      repository.getDeviceSnapshot('list', user.id, fixture.clientId),
    ).resolves.toMatchObject({ id: listHead.id })
    await expect(
      repository.getDeviceSnapshot('dislike', user.id, fixture.clientId),
    ).resolves.toMatchObject({ id: dislikeHead.id })

    const audit = await repository.listAudit(10)
    expect(audit).toEqual([
      expect.objectContaining({
        actor: 'migration:lxserver-v2',
        action: 'migration.lxserver-v2.import',
        targetType: 'sync_user',
        targetId: user.id,
        metadata: {
          sourceFormat: 'lxserver-v2',
          deviceCount: 1,
          snapshotCount: 2,
          baselineCount: 2,
        },
      }),
    ])
    const auditJson = JSON.stringify(audit)
    for (const secret of [
      fixture.connectionCode,
      fixture.deviceKey,
      fixture.songName,
    ])
      expect(auditJson).not.toContain(secret)

    await expect(
      applyLxserverV2ImportPlan(database, plan, masterKey),
    ).rejects.toBeInstanceOf(TargetDatabaseNotEmptyError)
    await expect(assertTargetReadyForImport(database)).rejects.toBeInstanceOf(
      TargetDatabaseNotEmptyError,
    )
  })
})

async function createSourceFixture(source: string) {
  const userName = 'integration-source-user'
  const connectionCode = 'integration-source-code'
  const serverId = Buffer.alloc(16, 10).toString('base64')
  const clientId = Buffer.alloc(16, 11).toString('base64')
  const deviceKey = Buffer.alloc(16, 12).toString('base64')
  const songName = 'Imported private song'
  const listData: ListData = {
    defaultList: [
      { id: 'imported-song', name: songName, singer: 'Private singer' },
    ],
    loveList: [],
    userList: [],
  }
  const dislikePayload = 'blocked@singer'
  const listPayload = JSON.stringify(listData)
  const listKey = md5(listPayload)
  const dislikeKey = md5(dislikePayload.trim())
  const userDirectory = path.join(
    source,
    'users',
    sourceUserDirectoryName(userName),
  )
  const listSnapshotDirectory = path.join(userDirectory, 'list', 'snapshot')
  const dislikeSnapshotDirectory = path.join(
    userDirectory,
    'dislike',
    'snapshot',
  )
  await mkdir(listSnapshotDirectory, { recursive: true })
  await mkdir(dislikeSnapshotDirectory, { recursive: true })
  await writeFile(
    path.join(source, 'serverInfo.json'),
    JSON.stringify({ serverId, version: 2 }),
  )
  await writeFile(
    path.join(source, 'users.json'),
    JSON.stringify([
      {
        name: userName,
        password: connectionCode,
        maxSnapshotNum: 12,
        'list.addMusicLocationType': 'top',
      },
    ]),
  )
  await writeFile(
    path.join(userDirectory, 'devices.json'),
    JSON.stringify({
      userName,
      clients: {
        [clientId]: {
          clientId,
          key: deviceKey,
          deviceName: 'Source device',
          isMobile: true,
          lastConnectDate: Date.parse('2026-07-20T10:00:00.000Z'),
        },
      },
    }),
  )
  await writeFile(
    path.join(listSnapshotDirectory, `snapshot_${listKey}`),
    listPayload,
  )
  await writeFile(
    path.join(userDirectory, 'list', 'snapshotInfo.json'),
    snapshotInfo(clientId, listKey),
  )
  await writeFile(
    path.join(dislikeSnapshotDirectory, `snapshot_${dislikeKey}`),
    dislikePayload,
  )
  await writeFile(
    path.join(userDirectory, 'dislike', 'snapshotInfo.json'),
    snapshotInfo(clientId, dislikeKey),
  )
  return {
    userName,
    connectionCode,
    serverId,
    clientId,
    deviceKey,
    songName,
    listData,
    dislikePayload,
  }
}

function snapshotInfo(clientId: string, snapshotKey: string): string {
  const timestamp = Date.parse('2026-07-20T10:00:00.000Z')
  return JSON.stringify({
    latest: snapshotKey,
    time: timestamp,
    list: [],
    clients: {
      [clientId]: { snapshotKey, lastSyncDate: timestamp },
    },
  })
}

function sourceUserDirectoryName(userName: string): string {
  const filtered = userName.replace(/[\\/:*?#"<>|]/g, '')
  const suffix = createHash('md5').update(userName).digest('hex').slice(0, 6)
  return `${filtered}_${suffix}`
}

function guardedTestDatabaseUrl(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const value = environment.TEST_DATABASE_URL
  if (!value) return undefined
  if (environment.ALLOW_TEST_DATABASE_WRITE !== '1')
    throw new Error(
      'ALLOW_TEST_DATABASE_WRITE=1 is required for PostgreSQL integration tests',
    )
  const databaseName = new URL(value).pathname.slice(1)
  if (!/(^|[-_])test([-_]|$)/i.test(databaseName))
    throw new Error(
      'TEST_DATABASE_URL must target a clearly named test database',
    )
  return value
}

function databaseUrlForSchema(
  connectionString: string,
  schema: string,
): string {
  const url = new URL(connectionString)
  const current = url.searchParams.get('options')
  url.searchParams.set(
    'options',
    [current, `-csearch_path=${schema}`].filter(Boolean).join(' '),
  )
  return url.toString()
}
