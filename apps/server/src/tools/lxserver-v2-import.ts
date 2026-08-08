import { createHash, randomUUID } from 'node:crypto'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { type Kysely, sql, type Transaction } from 'kysely'
import { z } from 'zod'
import { loadConfig } from '../config.js'
import { createDatabase, migrateToLatest } from '../db/connection.js'
import type { Database } from '../db/schema.js'
import type { AddMusicLocationType, SyncDomain } from '../protocol/index.js'
import { deriveConnectionKey, encryptAtRest, md5 } from '../security/crypto.js'
import {
  emptyListData,
  parseListData,
  type SerializedSnapshot,
  serializeSnapshot,
} from '../sync/snapshot.js'

const snapshotKeyPattern = /^[a-f0-9]{32}$/i
const fileNamePattern = /[\\/:*?#"<>|]/g
const maxSourceFileBytes = 8 * 1024 * 1024
const allowedTargetTables = new Set([
  'admin_sessions',
  'audit_events',
  'device_sync_state',
  'devices',
  'kysely_migration',
  'kysely_migration_lock',
  'service_metadata',
  'sync_heads',
  'sync_snapshots',
  'sync_users',
])
const targetBusinessTables = new Set([
  'admin_sessions',
  'audit_events',
  'device_sync_state',
  'devices',
  'service_metadata',
  'sync_heads',
  'sync_snapshots',
  'sync_users',
])

const base64Key16 = z.string().refine((value) => {
  const decoded = Buffer.from(value, 'base64')
  return decoded.length === 16 && decoded.toString('base64') === value
})
const sourceUserSchema = z
  .object({
    name: z.string().min(1).max(64),
    password: z.string().min(1).max(4_096),
    maxSnapshotNum: z.number().int().min(1).max(1_000).optional(),
    'list.addMusicLocationType': z.enum(['top', 'bottom']).optional(),
  })
  .strict()
const sourceUsersSchema = z.array(sourceUserSchema).max(1_000)
const serverInfoSchema = z
  .object({ serverId: base64Key16, version: z.literal(2) })
  .strict()
const deviceSchema = z
  .object({
    clientId: base64Key16,
    key: base64Key16,
    deviceName: z.string().min(1).max(128),
    isMobile: z.boolean(),
    lastConnectDate: z.number().finite().nonnegative().optional(),
  })
  .strict()
const devicesInfoSchema = z
  .object({
    userName: z.string().min(1).max(64),
    clients: z.record(z.string(), deviceSchema),
  })
  .strict()
const snapshotReferenceSchema = z
  .object({
    snapshotKey: z.union([z.literal(''), z.string().regex(snapshotKeyPattern)]),
    lastSyncDate: z.number().finite().nonnegative(),
  })
  .strict()
const snapshotInfoSchema = z
  .object({
    latest: z.string().regex(snapshotKeyPattern).nullable(),
    time: z.number().finite().nonnegative(),
    list: z.array(z.string().regex(snapshotKeyPattern)).max(1_000),
    clients: z.record(z.string(), snapshotReferenceSchema),
  })
  .strict()

interface SourceDevice {
  readonly clientId: string
  readonly key: string
  readonly deviceName: string
  readonly isMobile: boolean
  readonly lastConnectAt: Date | null
}

interface SourceSnapshot {
  readonly sourceKey: string
  readonly domain: SyncDomain
  readonly serialized: SerializedSnapshot
  readonly createdAt: Date
  readonly fromSourceFile: boolean
}

interface SourceBaseline {
  readonly clientId: string
  readonly domain: SyncDomain
  readonly sourceSnapshotKey: string
  readonly lastSyncAt: Date
}

interface SourceUserPlan {
  readonly authKey: string
  readonly name: string
  readonly devices: readonly SourceDevice[]
  readonly snapshots: readonly SourceSnapshot[]
  readonly heads: Readonly<Record<SyncDomain, string>>
  readonly baselines: readonly SourceBaseline[]
  readonly maxSnapshots: number
  readonly addMusicLocationType: AddMusicLocationType
}

export interface LxserverV2ImportSummary {
  readonly sourceVersion: 2
  readonly users: number
  readonly devices: number
  readonly sourceSnapshots: number
  readonly storedSnapshots: number
  readonly baselines: number
  readonly listHeadItems: number
  readonly dislikeHeadItems: number
  readonly orphanUserDirectories: number
}

export interface LxserverV2ImportPlan {
  readonly serverId: string
  readonly users: readonly SourceUserPlan[]
  readonly summary: LxserverV2ImportSummary
}

export interface BuildImportPlanOptions {
  readonly maxSnapshots: number
  readonly addMusicLocationType: AddMusicLocationType
}

export class ImportValidationError extends Error {
  constructor(message = 'Invalid lxserver v2 import source') {
    super(message)
    this.name = 'ImportValidationError'
  }
}

export class TargetDatabaseNotEmptyError extends Error {
  constructor() {
    super('Target LX-Sync database is not empty')
    this.name = 'TargetDatabaseNotEmptyError'
  }
}

export class TargetSchemaNotDedicatedError extends Error {
  constructor() {
    super('Target database schema contains unrelated tables')
    this.name = 'TargetSchemaNotDedicatedError'
  }
}

export async function buildLxserverV2ImportPlan(
  sourceDirectory: string,
  options: BuildImportPlanOptions,
): Promise<LxserverV2ImportPlan> {
  assertImportOptions(options)
  const sourceRoot = await requireDirectory(sourceDirectory)
  const serverInfo = await readJson(
    path.join(sourceRoot, 'serverInfo.json'),
    serverInfoSchema,
  )
  const sourceUsers = await readJson(
    path.join(sourceRoot, 'users.json'),
    sourceUsersSchema,
  )
  assertUniqueSourceUsers(sourceUsers)

  const usersRoot = path.join(sourceRoot, 'users')
  await requireDirectory(usersRoot)
  const userDirectories = await readdir(usersRoot, { withFileTypes: true })
  const expectedDirectories = new Set(
    sourceUsers.map((user) => sourceUserDirectoryName(user.name)),
  )
  const orphanUserDirectories = userDirectories.filter(
    (entry) => entry.isDirectory() && !expectedDirectories.has(entry.name),
  ).length
  const globalClientIds = new Set<string>()
  const users: SourceUserPlan[] = []

  for (const sourceUser of sourceUsers) {
    const userDirectory = path.join(
      usersRoot,
      sourceUserDirectoryName(sourceUser.name),
    )
    const hasUserDirectory = await isDirectory(userDirectory)
    const devices = hasUserDirectory
      ? await readSourceDevices(userDirectory, sourceUser.name)
      : []
    for (const device of devices) {
      if (globalClientIds.has(device.clientId))
        throw new ImportValidationError()
      globalClientIds.add(device.clientId)
    }

    const list = hasUserDirectory
      ? await readSourceDomain(userDirectory, 'list', devices)
      : emptySourceDomain('list')
    const dislike = hasUserDirectory
      ? await readSourceDomain(userDirectory, 'dislike', devices)
      : emptySourceDomain('dislike')
    const snapshots = [...list.snapshots, ...dislike.snapshots]
    const maxSourceSnapshots = Math.max(
      list.snapshots.length,
      dislike.snapshots.length,
    )
    if (maxSourceSnapshots > 1_000) throw new ImportValidationError()
    users.push({
      name: sourceUser.name,
      authKey: deriveConnectionKey(sourceUser.password),
      devices,
      snapshots,
      heads: { list: list.head, dislike: dislike.head },
      baselines: [...list.baselines, ...dislike.baselines],
      maxSnapshots: Math.max(
        sourceUser.maxSnapshotNum ?? options.maxSnapshots,
        maxSourceSnapshots,
      ),
      addMusicLocationType:
        sourceUser['list.addMusicLocationType'] ?? options.addMusicLocationType,
    })
  }

  return {
    serverId: serverInfo.serverId,
    users,
    summary: importSummary(users, orphanUserDirectories),
  }
}

export async function assertTargetSchemaDedicated(
  db: DatabaseExecutor,
): Promise<void> {
  const tables = await targetSchemaTables(db)
  if (tables.some((table) => !allowedTargetTables.has(table)))
    throw new TargetSchemaNotDedicatedError()
}

export async function assertTargetReadyForImport(
  db: Kysely<Database>,
): Promise<void> {
  const tables = await targetSchemaTables(db)
  if (tables.some((table) => !allowedTargetTables.has(table)))
    throw new TargetSchemaNotDedicatedError()
  const existingBusinessTables = tables.filter((table) =>
    targetBusinessTables.has(table),
  )
  if (existingBusinessTables.length === 0) return
  if (existingBusinessTables.length !== targetBusinessTables.size)
    throw new TargetSchemaNotDedicatedError()
  await assertTargetDatabaseEmpty(db)
}

async function targetSchemaTables(db: DatabaseExecutor): Promise<string[]> {
  const tables = await sql<{ tableName: string }>`
    select table_name as "tableName"
    from information_schema.tables
    where table_schema = current_schema()
      and table_type = 'BASE TABLE'
  `.execute(db)
  return tables.rows.map((row) => row.tableName)
}

export async function applyLxserverV2ImportPlan(
  db: Kysely<Database>,
  plan: LxserverV2ImportPlan,
  masterKey: string,
): Promise<LxserverV2ImportSummary> {
  return db.transaction().execute(async (transaction) => {
    await assertTargetSchemaDedicated(transaction)
    await assertTargetDatabaseEmpty(transaction)
    const importedAt = new Date()
    await transaction
      .insertInto('serviceMetadata')
      .values({ id: 1, serverId: plan.serverId, createdAt: importedAt })
      .executeTakeFirstOrThrow()

    for (const user of plan.users)
      await importUser(transaction, user, masterKey, importedAt)

    await verifyImportedCounts(transaction, plan.summary)
    return plan.summary
  })
}

async function importUser(
  transaction: Transaction<Database>,
  user: SourceUserPlan,
  masterKey: string,
  importedAt: Date,
): Promise<void> {
  const userId = randomUUID()
  const oldestSnapshot = user.snapshots.reduce<Date>(
    (oldest, snapshot) =>
      snapshot.createdAt < oldest ? snapshot.createdAt : oldest,
    importedAt,
  )
  await transaction
    .insertInto('syncUsers')
    .values({
      id: userId,
      name: user.name,
      authKeyEncrypted: encryptAtRest(user.authKey, masterKey),
      enabled: true,
      maxSnapshots: user.maxSnapshots,
      addMusicLocationType: user.addMusicLocationType,
      createdAt: oldestSnapshot,
      updatedAt: importedAt,
    })
    .executeTakeFirstOrThrow()

  const sourceSnapshotIds = new Map<string, string>()
  const storedContentIds = new Map<string, string>()
  for (const snapshot of user.snapshots) {
    const contentKey = `${snapshot.domain}:${snapshot.serialized.contentHash}`
    let snapshotId = storedContentIds.get(contentKey)
    if (!snapshotId) {
      snapshotId = randomUUID()
      storedContentIds.set(contentKey, snapshotId)
      await transaction
        .insertInto('syncSnapshots')
        .values({
          id: snapshotId,
          userId,
          domain: snapshot.domain,
          hash: snapshot.serialized.hash,
          contentHash: snapshot.serialized.contentHash,
          payload: snapshot.serialized.payload,
          itemCount: snapshot.serialized.itemCount,
          byteSize: snapshot.serialized.byteSize,
          sourceDeviceId: null,
          createdAt: snapshot.createdAt,
        })
        .executeTakeFirstOrThrow()
    }
    sourceSnapshotIds.set(
      snapshotMapKey(snapshot.domain, snapshot.sourceKey),
      snapshotId,
    )
  }

  for (const domain of ['list', 'dislike'] as const) {
    const snapshotId = sourceSnapshotIds.get(
      snapshotMapKey(domain, user.heads[domain]),
    )
    if (!snapshotId) throw new ImportValidationError()
    await transaction
      .insertInto('syncHeads')
      .values({
        userId,
        domain,
        snapshotId,
        version: Math.max(
          1,
          user.snapshots.filter((snapshot) => snapshot.domain === domain)
            .length,
        ),
        updatedAt: importedAt,
      })
      .executeTakeFirstOrThrow()
  }

  for (const device of user.devices) {
    const createdAt = device.lastConnectAt ?? importedAt
    await transaction
      .insertInto('devices')
      .values({
        clientId: device.clientId,
        userId,
        keyEncrypted: encryptAtRest(device.key, masterKey),
        deviceName: device.deviceName,
        isMobile: device.isMobile,
        lastConnectAt: device.lastConnectAt,
        revokedAt: null,
        createdAt,
        updatedAt: importedAt,
      })
      .executeTakeFirstOrThrow()
  }

  for (const baseline of user.baselines) {
    const snapshotId = sourceSnapshotIds.get(
      snapshotMapKey(baseline.domain, baseline.sourceSnapshotKey),
    )
    if (!snapshotId) throw new ImportValidationError()
    await transaction
      .insertInto('deviceSyncState')
      .values({
        deviceId: baseline.clientId,
        domain: baseline.domain,
        snapshotId,
        lastSyncAt: baseline.lastSyncAt,
      })
      .executeTakeFirstOrThrow()
  }

  await transaction
    .insertInto('auditEvents')
    .values({
      actor: 'migration:lxserver-v2',
      action: 'migration.lxserver-v2.import',
      targetType: 'sync_user',
      targetId: userId,
      metadata: {
        sourceFormat: 'lxserver-v2',
        deviceCount: user.devices.length,
        snapshotCount: user.snapshots.length,
        baselineCount: user.baselines.length,
      },
      createdAt: importedAt,
    })
    .executeTakeFirstOrThrow()
}

async function assertTargetDatabaseEmpty(
  executor: DatabaseExecutor,
): Promise<void> {
  const [
    metadata,
    users,
    devices,
    snapshots,
    heads,
    baselines,
    sessions,
    audit,
  ] = await Promise.all([
    countRows(executor, 'serviceMetadata'),
    countRows(executor, 'syncUsers'),
    countRows(executor, 'devices'),
    countRows(executor, 'syncSnapshots'),
    countRows(executor, 'syncHeads'),
    countRows(executor, 'deviceSyncState'),
    countRows(executor, 'adminSessions'),
    countRows(executor, 'auditEvents'),
  ])
  if (
    [
      metadata,
      users,
      devices,
      snapshots,
      heads,
      baselines,
      sessions,
      audit,
    ].some((count) => count !== 0)
  )
    throw new TargetDatabaseNotEmptyError()
}

async function verifyImportedCounts(
  transaction: Transaction<Database>,
  summary: LxserverV2ImportSummary,
): Promise<void> {
  const [metadata, users, devices, snapshots, heads, baselines, audit] =
    await Promise.all([
      countRows(transaction, 'serviceMetadata'),
      countRows(transaction, 'syncUsers'),
      countRows(transaction, 'devices'),
      countRows(transaction, 'syncSnapshots'),
      countRows(transaction, 'syncHeads'),
      countRows(transaction, 'deviceSyncState'),
      countRows(transaction, 'auditEvents'),
    ])
  if (
    metadata !== 1 ||
    users !== summary.users ||
    devices !== summary.devices ||
    snapshots !== summary.storedSnapshots ||
    heads !== summary.users * 2 ||
    baselines !== summary.baselines ||
    audit !== summary.users
  )
    throw new Error('Imported row count verification failed')
}

type CountableTable =
  | 'serviceMetadata'
  | 'syncUsers'
  | 'devices'
  | 'syncSnapshots'
  | 'syncHeads'
  | 'deviceSyncState'
  | 'adminSessions'
  | 'auditEvents'

type DatabaseExecutor = Kysely<Database> | Transaction<Database>

async function countRows(
  executor: DatabaseExecutor,
  table: CountableTable,
): Promise<number> {
  const result = await executor
    .selectFrom(table)
    .select((builder) => builder.fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow()
  return Number(result.count)
}

async function readSourceDevices(
  userDirectory: string,
  expectedUserName: string,
): Promise<SourceDevice[]> {
  const devicesPath = path.join(userDirectory, 'devices.json')
  if (!(await pathExists(devicesPath))) return []
  await requireRegularFile(devicesPath)
  const info = await readJson(devicesPath, devicesInfoSchema)
  if (info.userName !== expectedUserName) throw new ImportValidationError()
  const devices: SourceDevice[] = []
  for (const [clientId, device] of Object.entries(info.clients)) {
    if (clientId !== device.clientId) throw new ImportValidationError()
    devices.push({
      clientId: device.clientId,
      key: device.key,
      deviceName: device.deviceName,
      isMobile: device.isMobile,
      lastConnectAt: dateFromMilliseconds(device.lastConnectDate ?? 0, true),
    })
  }
  if (devices.length > 100) throw new ImportValidationError()
  return devices
}

interface SourceDomainPlan {
  readonly snapshots: readonly SourceSnapshot[]
  readonly head: string
  readonly baselines: readonly SourceBaseline[]
}

async function readSourceDomain(
  userDirectory: string,
  domain: SyncDomain,
  devices: readonly SourceDevice[],
): Promise<SourceDomainPlan> {
  const domainDirectory = path.join(userDirectory, domain)
  if (!(await isDirectory(domainDirectory))) return emptySourceDomain(domain)
  const infoPath = path.join(domainDirectory, 'snapshotInfo.json')
  const snapshotDirectory = path.join(domainDirectory, 'snapshot')
  if (!(await pathExists(infoPath))) {
    if (!(await pathExists(snapshotDirectory))) return emptySourceDomain(domain)
    await requireDirectory(snapshotDirectory)
    const entries = await readdir(snapshotDirectory)
    if (entries.some((entry) => entry.startsWith('snapshot_')))
      throw new ImportValidationError()
    return emptySourceDomain(domain)
  }
  await requireDirectory(snapshotDirectory)
  const info = await readJson(infoPath, snapshotInfoSchema)
  const entries = await readdir(snapshotDirectory, { withFileTypes: true })
  const snapshots: SourceSnapshot[] = []
  for (const entry of entries) {
    if (!entry.name.startsWith('snapshot_')) continue
    if (!entry.isFile()) throw new ImportValidationError()
    const sourceKey = entry.name.slice('snapshot_'.length)
    if (!snapshotKeyPattern.test(sourceKey)) throw new ImportValidationError()
    const snapshotPath = path.join(snapshotDirectory, entry.name)
    await requireRegularFile(snapshotPath)
    const payload = await readFile(snapshotPath, 'utf8')
    const sourceHash = md5(domain === 'dislike' ? payload.trim() : payload)
    if (sourceHash.toLowerCase() !== sourceKey.toLowerCase())
      throw new ImportValidationError()
    const serialized = serializeSourceSnapshot(domain, payload)
    const metadata = await stat(snapshotPath)
    snapshots.push({
      sourceKey,
      domain,
      serialized,
      createdAt: metadata.mtime,
      fromSourceFile: true,
    })
  }
  snapshots.sort(
    (left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.sourceKey.localeCompare(right.sourceKey),
  )
  if (!info.latest || snapshots.length === 0) throw new ImportValidationError()
  const availableSnapshots = new Set(
    snapshots.map((snapshot) => snapshot.sourceKey),
  )
  const referencedSnapshots = [
    info.latest,
    ...info.list,
    ...Object.values(info.clients)
      .map((client) => client.snapshotKey)
      .filter(Boolean),
  ]
  if (referencedSnapshots.some((key) => !availableSnapshots.has(key)))
    throw new ImportValidationError()
  if (new Set(info.list).size !== info.list.length)
    throw new ImportValidationError()

  const deviceIds = new Set(devices.map((device) => device.clientId))
  const baselines: SourceBaseline[] = []
  for (const [clientId, client] of Object.entries(info.clients)) {
    if (!client.snapshotKey) continue
    if (!deviceIds.has(clientId)) throw new ImportValidationError()
    baselines.push({
      clientId,
      domain,
      sourceSnapshotKey: client.snapshotKey,
      lastSyncAt: dateFromMilliseconds(client.lastSyncDate),
    })
  }
  return { snapshots, head: info.latest, baselines }
}

function emptySourceDomain(domain: SyncDomain): SourceDomainPlan {
  const sourceKey = `empty-${domain}`
  const serialized =
    domain === 'list'
      ? serializeSnapshot('list', emptyListData())
      : serializeSnapshot('dislike', '')
  return {
    snapshots: [
      {
        sourceKey,
        domain,
        serialized,
        createdAt: new Date(),
        fromSourceFile: false,
      },
    ],
    head: sourceKey,
    baselines: [],
  }
}

function serializeSourceSnapshot(
  domain: SyncDomain,
  payload: string,
): SerializedSnapshot {
  try {
    if (domain === 'dislike') return serializeSnapshot('dislike', payload)
    const data = parseListData(JSON.parse(payload) as unknown)
    return serializeSnapshot('list', data)
  } catch {
    throw new ImportValidationError()
  }
}

function importSummary(
  users: readonly SourceUserPlan[],
  orphanUserDirectories: number,
): LxserverV2ImportSummary {
  let sourceSnapshots = 0
  let storedSnapshots = 0
  let listHeadItems = 0
  let dislikeHeadItems = 0
  for (const user of users) {
    sourceSnapshots += user.snapshots.filter(
      (snapshot) => snapshot.fromSourceFile,
    ).length
    storedSnapshots += new Set(
      user.snapshots.map(
        (snapshot) => `${snapshot.domain}:${snapshot.serialized.contentHash}`,
      ),
    ).size
    for (const domain of ['list', 'dislike'] as const) {
      const head = user.snapshots.find(
        (snapshot) =>
          snapshot.domain === domain &&
          snapshot.sourceKey === user.heads[domain],
      )
      if (!head) throw new ImportValidationError()
      if (domain === 'list') listHeadItems += head.serialized.itemCount
      else dislikeHeadItems += head.serialized.itemCount
    }
  }
  return {
    sourceVersion: 2,
    users: users.length,
    devices: users.reduce((total, user) => total + user.devices.length, 0),
    sourceSnapshots,
    storedSnapshots,
    baselines: users.reduce((total, user) => total + user.baselines.length, 0),
    listHeadItems,
    dislikeHeadItems,
    orphanUserDirectories,
  }
}

function assertUniqueSourceUsers(
  users: ReadonlyArray<z.infer<typeof sourceUserSchema>>,
): void {
  const names = new Set<string>()
  const directories = new Set<string>()
  const authKeys = new Set<string>()
  for (const user of users) {
    const normalized = user.name.trim().toLocaleLowerCase()
    const directory = sourceUserDirectoryName(user.name)
    const authKey = deriveConnectionKey(user.password)
    if (
      normalized !== user.name.toLocaleLowerCase() ||
      names.has(normalized) ||
      directories.has(directory) ||
      authKeys.has(authKey)
    )
      throw new ImportValidationError()
    names.add(normalized)
    directories.add(directory)
    authKeys.add(authKey)
  }
}

function sourceUserDirectoryName(userName: string): string {
  const filtered = userName.replace(fileNamePattern, '')
  const suffix = createHash('md5').update(userName).digest('hex').slice(0, 6)
  return `${filtered}_${suffix}`
}

function snapshotMapKey(domain: SyncDomain, sourceKey: string): string {
  return `${domain}:${sourceKey}`
}

function dateFromMilliseconds(value: number, nullable?: false): Date
function dateFromMilliseconds(value: number, nullable: true): Date | null
function dateFromMilliseconds(value: number, nullable = false): Date | null {
  if (nullable && value === 0) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new ImportValidationError()
  return date
}

async function readJson<T>(filePath: string, schema: z.ZodType<T>): Promise<T> {
  try {
    await requireRegularFile(filePath)
    return schema.parse(JSON.parse(await readFile(filePath, 'utf8')) as unknown)
  } catch (error) {
    if (error instanceof ImportValidationError) throw error
    throw new ImportValidationError()
  }
}

async function requireDirectory(directory: string): Promise<string> {
  try {
    const resolved = await realpath(path.resolve(directory))
    const metadata = await lstat(resolved)
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new ImportValidationError()
    return resolved
  } catch (error) {
    if (error instanceof ImportValidationError) throw error
    throw new ImportValidationError()
  }
}

async function requireRegularFile(filePath: string): Promise<void> {
  try {
    const metadata = await lstat(filePath)
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > maxSourceFileBytes
    )
      throw new ImportValidationError()
  } catch (error) {
    if (error instanceof ImportValidationError) throw error
    throw new ImportValidationError()
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new ImportValidationError()
  }
}

async function isDirectory(directory: string): Promise<boolean> {
  if (!(await pathExists(directory))) return false
  const metadata = await lstat(directory)
  if (metadata.isSymbolicLink()) throw new ImportValidationError()
  return metadata.isDirectory()
}

function assertImportOptions(options: BuildImportPlanOptions): void {
  if (
    !Number.isSafeInteger(options.maxSnapshots) ||
    options.maxSnapshots < 1 ||
    options.maxSnapshots > 1_000 ||
    !['top', 'bottom'].includes(options.addMusicLocationType)
  )
    throw new ImportValidationError('Invalid import options')
}

function databaseName(connectionString: string): string {
  try {
    const name = decodeURIComponent(new URL(connectionString).pathname.slice(1))
    if (!name || name.includes('/')) throw new Error()
    return name
  } catch {
    throw new ImportValidationError('Invalid target database URL')
  }
}

function printHelp(): void {
  console.log(
    [
      'Usage:',
      '  node dist/tools/lxserver-v2-import.js --source <backup-data-dir>',
      '  node dist/tools/lxserver-v2-import.js --source <backup-data-dir> --apply --expected-database <name>',
      '',
      'Apply also requires ALLOW_LXSERVER_V2_IMPORT=1 and an empty dedicated target database.',
    ].join('\n'),
  )
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    strict: true,
    options: {
      source: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'expected-database': { type: 'string' },
      'max-snapshots': { type: 'string', default: '10' },
      'add-music-location-type': { type: 'string', default: 'bottom' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    printHelp()
    return
  }
  if (!values.source)
    throw new ImportValidationError('Missing source directory')
  const maxSnapshots = Number(values['max-snapshots'])
  const addMusicLocationType = values['add-music-location-type']
  if (addMusicLocationType !== 'top' && addMusicLocationType !== 'bottom')
    throw new ImportValidationError('Invalid import options')
  const plan = await buildLxserverV2ImportPlan(values.source, {
    maxSnapshots,
    addMusicLocationType,
  })
  if (!values.apply) {
    console.log(JSON.stringify({ mode: 'dry-run', ...plan.summary }))
    return
  }
  if (process.env.ALLOW_LXSERVER_V2_IMPORT !== '1')
    throw new ImportValidationError('Import apply gate is not enabled')
  if (!values['expected-database'])
    throw new ImportValidationError('Missing expected target database name')
  const config = loadConfig()
  if (databaseName(config.DATABASE_URL) !== values['expected-database'])
    throw new ImportValidationError('Target database name does not match')
  const db = createDatabase(config.DATABASE_URL)
  try {
    await assertTargetReadyForImport(db)
    await migrateToLatest(db)
    const summary = await applyLxserverV2ImportPlan(db, plan, config.MASTER_KEY)
    console.log(JSON.stringify({ mode: 'applied', ...summary }))
  } finally {
    await db.destroy()
  }
}

const mainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (mainModule)
  main().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : 'UnknownError'
    console.error(`LX-Sync import failed: ${name}`)
    process.exitCode = 1
  })
