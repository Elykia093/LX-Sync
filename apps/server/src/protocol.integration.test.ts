import {
  constants,
  createCipheriv,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
} from 'node:crypto'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import { sql } from 'kysely'
import { createMsg2call } from 'message2call'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { AppConfig } from './config.js'
import { createDatabase, migrateToLatest } from './db/connection.js'
import { Repository, SnapshotConflictError } from './db/repository.js'
import { buildApp } from './http/app.js'
import type {
  DislikeAction,
  ListAction,
  ListData,
  MusicInfo,
} from './protocol/index.js'
import { LxAuthService } from './sync/auth.js'
import {
  ConnectionRegistry,
  createLxGateway,
  type LxGateway,
} from './sync/gateway.js'

// Fixed test-side baseline from LX v4 and reference commit d47aca4284a7c4d9ef755df1f44fb0b0a5b2af36.
// Keep this client independent from production protocol/security helpers so drift fails the E2E.
const upstreamLxV4 = {
  helloMessage: 'Hello~::^-^::~v4~',
  idPrefix: 'OjppZDo6',
  authMessagePrefix: 'lx-music auth::',
  connectMessage: 'lx-music connect',
  featureVersion: { list: 1, dislike: 1 },
} as const
const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

const testDatabaseUrl = resolveTestDatabaseUrl(process.env)
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip

describe('PostgreSQL integration safety gate', () => {
  it('requires an explicit write opt-in and a clearly named test database', () => {
    expect(
      resolveTestDatabaseUrl({
        TEST_DATABASE_URL: 'postgresql://localhost/lx_sync_test',
        ALLOW_TEST_DATABASE_WRITE: '1',
      }),
    ).toBe('postgresql://localhost/lx_sync_test')
    expect(() =>
      resolveTestDatabaseUrl({
        TEST_DATABASE_URL: 'postgresql://localhost/lx_sync_test',
      }),
    ).toThrow('ALLOW_TEST_DATABASE_WRITE=1')
    expect(() =>
      resolveTestDatabaseUrl({
        TEST_DATABASE_URL: 'postgresql://localhost/lx_sync',
        ALLOW_TEST_DATABASE_WRITE: '1',
      }),
    ).toThrow('test database')
  })
})

interface ServerRemote {
  onListSyncAction: (action: ListAction) => Promise<void>
  onDislikeSyncAction: (action: DislikeAction) => Promise<void>
}

interface RegisteredDevice {
  clientId: string
  key: string
  serverName: string
}

interface ClientState {
  list: ListData
  dislike: string
  receivedListActions: ListAction[]
  receivedDislikeActions: DislikeAction[]
}

interface ProtocolClient {
  device: RegisteredDevice
  initialized: Promise<void>
  remote: ServerRemote
  state: ClientState
  wireFrames: {
    sentCompressed: boolean
    receivedCompressed: boolean
  }
  close: () => Promise<void>
}

describeWithDatabase.sequential('LX v4 protocol with PostgreSQL', () => {
  if (!testDatabaseUrl) return

  const schemaName = `lx_sync_test_${randomBytes(8).toString('hex')}`
  const decoySchemaName = `${schemaName}_decoy`
  const masterKey = randomBytes(32).toString('base64')
  const connectionCode = 'integration-connection-code'
  const publicOrigin = 'http://127.0.0.1'
  const clients: ProtocolClient[] = []
  let database: ReturnType<typeof createDatabase>
  let repository: Repository
  let app: Awaited<ReturnType<typeof buildApp>>
  let gateway: LxGateway
  let origin: string
  let userId: string

  beforeAll(async () => {
    const administrator = createDatabase(testDatabaseUrl)
    try {
      await sql.raw(`create schema "${schemaName}"`).execute(administrator)
      await sql.raw(`create schema "${decoySchemaName}"`).execute(administrator)
      await sql
        .raw(
          `create table "${decoySchemaName}"."kysely_migration" (name varchar(255) primary key, timestamp varchar(255) not null)`,
        )
        .execute(administrator)
      await sql
        .raw(
          `create table "${decoySchemaName}"."kysely_migration_lock" (id varchar(255) primary key, is_locked integer not null default 0)`,
        )
        .execute(administrator)
    } finally {
      await administrator.destroy()
    }

    const isolatedUrl = databaseUrlForSchema(testDatabaseUrl, schemaName)
    database = createDatabase(isolatedUrl)
    await migrateToLatest(database, { migrationTableSchema: schemaName })
    repository = new Repository(database, masterKey)
    const serverId = await repository.ensureServiceMetadata()
    const user = await repository.createUser({
      name: 'integration-user',
      authKey: fixtureDeriveConnectionKey(connectionCode),
      maxSnapshots: 10,
      addMusicLocationType: 'bottom',
    })
    userId = user.id

    const config = {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 0,
      SERVER_NAME: 'LX Sync Integration',
      DATABASE_URL: isolatedUrl,
      MASTER_KEY: masterKey,
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'integration-admin-password',
      SESSION_TTL_HOURS: 24,
      MAX_SNAPSHOTS: 10,
      TRUST_PROXY: false,
      PUBLIC_ORIGIN: publicOrigin,
      SYNC_BASE_PATH: '/base',
      LOG_LEVEL: 'silent',
    } satisfies AppConfig
    const auth = new LxAuthService(repository, config.SERVER_NAME)
    const registry = new ConnectionRegistry()
    app = await buildApp({
      config,
      repository,
      auth,
      registry,
      serverId,
      startedAt: new Date(),
    })
    gateway = createLxGateway({
      server: app.server,
      repository,
      auth,
      registry,
      logger: app.log,
      trustProxy: false,
      syncBasePath: config.SYNC_BASE_PATH,
    })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (!address || typeof address === 'string')
      throw new Error('Integration server did not bind a TCP port')
    origin = `http://127.0.0.1:${address.port}`
  }, 30_000)

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()))
    if (gateway) await gateway.close()
    if (app) await app.close()
    if (database) await database.destroy()

    const administrator = createDatabase(testDatabaseUrl)
    try {
      await sql
        .raw(`drop schema if exists "${schemaName}" cascade`)
        .execute(administrator)
      await sql
        .raw(`drop schema if exists "${decoySchemaName}" cascade`)
        .execute(administrator)
    } finally {
      await administrator.destroy()
    }
  }, 30_000)

  it('registers devices, synchronizes both domains, and broadcasts actions', async () => {
    const scopedOrigin = `${origin}/base/${userId}`
    await expect(
      fetch(`${origin}/hello`).then((response) => response.text()),
    ).resolves.toBe(upstreamLxV4.helloMessage)
    await expect(
      fetch(`${origin}/id`).then((response) => response.text()),
    ).resolves.toMatch(new RegExp(`^${upstreamLxV4.idPrefix}.+`))
    await expect(
      fetch(`${scopedOrigin}/hello`).then((response) => response.text()),
    ).resolves.toBe(upstreamLxV4.helloMessage)
    await expect(
      fetch(`${scopedOrigin}/id`).then((response) => response.text()),
    ).resolves.toMatch(new RegExp(`^${upstreamLxV4.idPrefix}.+`))

    const first = await connectClient({
      origin,
      connectionCode,
      deviceName: 'Integration Desktop',
      list: {
        defaultList: [
          { id: 'track-1', name: 'First', note: 'x'.repeat(4_096) },
        ],
        loveList: [],
        userList: [],
      },
      dislike: 'blocked@singer',
    })
    clients.push(first)
    await first.initialized
    expect(first.wireFrames.sentCompressed).toBe(true)

    const repeatedAuthentication = await reauthenticateDevice(
      scopedOrigin,
      first.device,
    )
    expect(repeatedAuthentication.status).toBe(200)
    const uppercaseAuthentication = await reauthenticateDevice(
      `${origin}/base/${userId.toUpperCase()}`,
      first.device,
    )
    expect(uppercaseAuthentication.status).toBe(200)
    const wrongUserAuthentication = await reauthenticateDevice(
      `${origin}/base/00000000-0000-4000-8000-000000000099`,
      first.device,
    )
    expect(wrongUserAuthentication.status).toBe(401)

    const firstListHead = await repository.getHead('list', userId)
    const firstDislikeHead = await repository.getHead('dislike', userId)
    expect(firstListHead.data).toEqual(first.state.list)
    expect(firstDislikeHead.data).toBe(first.state.dislike)

    const second = await connectClient({
      origin: `${origin}/base/${userId.toUpperCase()}`,
      connectionCode,
      deviceName: 'Integration Mobile',
      isMobile: true,
      list: emptyListData(),
      dislike: '',
    })
    clients.push(second)
    await second.initialized
    expect(second.wireFrames.receivedCompressed).toBe(true)
    expect(second.state.list).toEqual(first.state.list)
    expect(second.state.dislike).toBe(first.state.dislike)

    const addedTrack: MusicInfo = { id: 'track-2', name: 'Second' }
    const action: ListAction = {
      action: 'list_music_add',
      data: {
        id: 'default',
        musicInfos: [addedTrack],
        addMusicLocationType: 'bottom',
      },
    }
    first.state.list.defaultList.push(addedTrack)
    await first.remote.onListSyncAction(action)

    expect(second.state.receivedListActions).toContainEqual(action)
    expect(second.state.list.defaultList).toEqual(first.state.list.defaultList)
    const finalHead = await repository.getHead('list', userId)
    expect(finalHead.data).toEqual(first.state.list)

    const firstBaseline = await repository.getDeviceSnapshot(
      'list',
      userId,
      first.device.clientId,
    )
    const secondBaseline = await repository.getDeviceSnapshot(
      'list',
      userId,
      second.device.clientId,
    )
    expect(firstBaseline?.id).toBe(finalHead.id)
    expect(secondBaseline?.id).toBe(finalHead.id)

    const dislikeAction: DislikeAction = {
      action: 'dislike_music_add',
      data: [{ name: 'Second Block', singer: 'Another Singer' }],
    }
    applyDislikeAction(first.state, dislikeAction)
    await first.remote.onDislikeSyncAction(dislikeAction)

    expect(second.state.receivedDislikeActions).toContainEqual(dislikeAction)
    expect(second.state.dislike).toBe(first.state.dislike)
    const finalDislikeHead = await repository.getHead('dislike', userId)
    expect(finalDislikeHead.data).toBe(first.state.dislike)
    const firstDislikeBaseline = await repository.getDeviceSnapshot(
      'dislike',
      userId,
      first.device.clientId,
    )
    const secondDislikeBaseline = await repository.getDeviceSnapshot(
      'dislike',
      userId,
      second.device.clientId,
    )
    expect(firstDislikeBaseline?.id).toBe(finalDislikeHead.id)
    expect(secondDislikeBaseline?.id).toBe(finalDislikeHead.id)
  }, 30_000)

  it('allows exactly one cross-connection CAS update for the same head', async () => {
    const user = await repository.createUser({
      name: 'cas-user',
      authKey: fixtureDeriveConnectionKey('cas-connection-code'),
      maxSnapshots: 10,
      addMusicLocationType: 'bottom',
    })
    const initialHead = await repository.getHead('list', user.id)
    const competingDatabase = createDatabase(
      databaseUrlForSchema(testDatabaseUrl, schemaName),
    )
    const competingRepository = new Repository(competingDatabase, masterKey)

    try {
      const results = await Promise.allSettled([
        repository.saveSnapshot({
          userId: user.id,
          domain: 'list',
          data: listWithTrack('cas-a'),
          expectedSnapshotId: initialHead.id,
        }),
        competingRepository.saveSnapshot({
          userId: user.id,
          domain: 'list',
          data: listWithTrack('cas-b'),
          expectedSnapshotId: initialHead.id,
        }),
      ])
      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      )
      const rejected = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )

      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.reason).toBeInstanceOf(SnapshotConflictError)
      const head = await repository.getHead('list', user.id)
      expect(head.id).toBe(fulfilled[0]?.value.id)
      const headRow = await database
        .selectFrom('syncHeads')
        .select('version')
        .where('userId', '=', user.id)
        .where('domain', '=', 'list')
        .executeTakeFirstOrThrow()
      expect(headRow.version).toBe(2)
      const snapshots = await database
        .selectFrom('syncSnapshots')
        .select('id')
        .where('userId', '=', user.id)
        .where('domain', '=', 'list')
        .execute()
      expect(snapshots).toHaveLength(2)
    } finally {
      await competingDatabase.destroy()
    }
  }, 30_000)

  it('persists managed song additions with audit and online delivery', async () => {
    const currentListHead = await repository.getHead('list', userId)
    const currentDislikeHead = await repository.getHead('dislike', userId)
    const client = await connectClient({
      origin,
      connectionCode,
      deviceName: 'Managed Playlist Integration',
      list: currentListHead.data,
      dislike: currentDislikeHead.data,
    })
    clients.push(client)
    await client.initialized
    client.state.receivedListActions.length = 0

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: publicOrigin },
      payload: {
        username: 'admin',
        password: 'integration-admin-password',
      },
    })
    expect(login.statusCode).toBe(200)
    const setCookie = login.headers['set-cookie']
    if (typeof setCookie !== 'string')
      throw new Error('Integration login did not return a session cookie')
    const headers = {
      origin: publicOrigin,
      cookie: setCookie.split(';')[0] ?? '',
    }
    const managedUserId = userId.toUpperCase()

    const beforeCreate = await repository.getHead('list', userId)
    const createPlaylist = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${managedUserId}/playlists`,
      headers,
      payload: {
        name: 'Managed additions',
        expectedSnapshotId: beforeCreate.id,
      },
    })
    expect(createPlaylist.statusCode).toBe(201)
    const createdBody = createPlaylist.json<{
      snapshotId: string
      playlist: { id: string }
    }>()

    const addSong = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${managedUserId}/playlists/${encodeURIComponent(createdBody.playlist.id)}/songs`,
      headers,
      payload: {
        id: 186016,
        source: 'wy',
        name: 'Integration song',
        singer: 'Integration singer',
        albumName: 'Integration album',
        interval: '03:45',
        expectedSnapshotId: createdBody.snapshotId,
      },
    })
    expect(addSong.statusCode).toBe(201)
    const addBody = addSong.json<{
      snapshotId: string
      affectedSongCount: number
    }>()
    expect(addBody.affectedSongCount).toBe(1)

    const persistedHead = await repository.getHead('list', userId)
    expect(persistedHead.id).toBe(addBody.snapshotId)
    expect(
      persistedHead.data.userList.find(
        (playlist) => `user:${playlist.id}` === createdBody.playlist.id,
      )?.list,
    ).toEqual([
      expect.objectContaining({
        id: 186016,
        source: 'wy',
        meta: expect.objectContaining({ songId: 186016 }),
      }),
    ])
    expect(client.state.receivedListActions).toEqual([
      expect.objectContaining({ action: 'list_create' }),
      expect.objectContaining({
        action: 'list_music_add',
        data: expect.objectContaining({
          musicInfos: [expect.objectContaining({ id: 186016 })],
        }),
      }),
    ])
    const deliveredBaseline = await repository.getDeviceSnapshot(
      'list',
      userId,
      client.device.clientId,
    )
    expect(deliveredBaseline?.id).toBe(persistedHead.id)

    const audits = await repository.listAudit(200)
    const additionAudit = audits.find(
      (event) => event.action === 'playlist.songs.add',
    )
    expect(additionAudit?.metadata).toEqual({
      domain: 'list',
      affectedPlaylistCount: 1,
      affectedSongCount: 1,
    })
    expect(JSON.stringify(additionAudit)).not.toContain('Integration song')
    expect(JSON.stringify(additionAudit)).not.toContain('186016')
  }, 30_000)

  it('rolls back snapshot, head, and baseline when a transactional step fails', async () => {
    const user = await repository.createUser({
      name: 'rollback-user',
      authKey: fixtureDeriveConnectionKey('rollback-connection-code'),
      maxSnapshots: 10,
      addMusicLocationType: 'bottom',
    })
    const initialHead = await repository.getHead('list', user.id)

    await expect(
      repository.saveSnapshot({
        userId: user.id,
        domain: 'list',
        data: listWithTrack('must-roll-back'),
        sourceDeviceId: 'missing-device',
        expectedSnapshotId: initialHead.id,
      }),
    ).rejects.toThrow()

    const head = await repository.getHead('list', user.id)
    expect(head.id).toBe(initialHead.id)
    const snapshots = await database
      .selectFrom('syncSnapshots')
      .select('id')
      .where('userId', '=', user.id)
      .where('domain', '=', 'list')
      .execute()
    expect(snapshots).toEqual([{ id: initialHead.id }])
    const baselines = await database
      .selectFrom('deviceSyncState')
      .select('snapshotId')
      .where('deviceId', '=', 'missing-device')
      .execute()
    expect(baselines).toEqual([])
  }, 30_000)

  it('rolls back the snapshot and head when audit insertion fails', async () => {
    const user = await repository.createUser({
      name: 'audit-rollback-user',
      authKey: fixtureDeriveConnectionKey('audit-rollback-code'),
      maxSnapshots: 10,
      addMusicLocationType: 'bottom',
    })
    const initialHead = await repository.getHead('list', user.id)

    await expect(
      repository.saveSnapshot({
        userId: user.id,
        domain: 'list',
        data: listWithTrack('must-roll-back-with-audit'),
        expectedSnapshotId: initialHead.id,
        audit: {
          actor: 'integration-test',
          action: 'playlist.create',
          targetType: 'sync_user',
          targetId: user.id,
          metadata: { unsupportedJsonValue: 1n },
        },
      }),
    ).rejects.toThrow()

    const head = await repository.getHead('list', user.id)
    expect(head.id).toBe(initialHead.id)
    const snapshots = await database
      .selectFrom('syncSnapshots')
      .select('id')
      .where('userId', '=', user.id)
      .where('domain', '=', 'list')
      .execute()
    expect(snapshots).toEqual([{ id: initialHead.id }])
    const audits = await database
      .selectFrom('auditEvents')
      .select('id')
      .where('targetId', '=', user.id)
      .where('action', '=', 'playlist.create')
      .execute()
    expect(audits).toEqual([])
  }, 30_000)
})

function resolveTestDatabaseUrl(environment: {
  readonly TEST_DATABASE_URL?: string
  readonly ALLOW_TEST_DATABASE_WRITE?: string
}): string | undefined {
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

async function registerDevice(input: {
  origin: string
  connectionCode: string
  deviceName: string
  isMobile: boolean
}): Promise<RegisteredDevice> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  })
  const publicKeyBody = Buffer.from(
    publicKey.export({ format: 'der', type: 'spki' }),
  ).toString('base64')
  const authMessage = [
    upstreamLxV4.authMessagePrefix,
    publicKeyBody,
    input.deviceName,
    input.isMobile ? 'lx_music_mobile' : 'lx_music_desktop',
  ].join('\n')
  const response = await fetch(`${input.origin}/ah`, {
    headers: {
      m: fixtureEncryptProtocolMessage(
        authMessage,
        fixtureDeriveConnectionKey(input.connectionCode),
      ),
    },
  })
  expect(response.status).toBe(200)
  const decrypted = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(await response.text(), 'base64'),
  ).toString('utf8')
  return JSON.parse(decrypted) as RegisteredDevice
}

async function connectClient(input: {
  origin: string
  connectionCode: string
  deviceName: string
  isMobile?: boolean
  list: ListData
  dislike: string
}): Promise<ProtocolClient> {
  const device = await registerDevice({
    origin: input.origin,
    connectionCode: input.connectionCode,
    deviceName: input.deviceName,
    isMobile: input.isMobile ?? false,
  })
  const state: ClientState = {
    list: structuredClone(input.list),
    dislike: input.dislike,
    receivedListActions: [],
    receivedDislikeActions: [],
  }
  const wireFrames = {
    sentCompressed: false,
    receivedCompressed: false,
  }
  let initialize: () => void = () => {}
  const initialized = new Promise<void>((resolve) => {
    initialize = resolve
  })
  let socket: WebSocket
  let outbound = Promise.resolve()
  const message2call = createMsg2call<ServerRemote>({
    funcsObj: {
      getEnabledFeatures: (serverType: unknown, featureVersion: unknown) => {
        expect(serverType).toBe('server')
        expect(featureVersion).toEqual(upstreamLxV4.featureVersion)
        return {
          list: { skipSnapshot: false },
          dislike: { skipSnapshot: false },
        }
      },
      finished: () => initialize(),
      list_sync_get_md5: () => fixtureMd5(JSON.stringify(state.list)),
      list_sync_get_sync_mode: () => 'merge_local_remote',
      list_sync_get_list_data: () => structuredClone(state.list),
      list_sync_set_list_data: (data: ListData) => {
        state.list = structuredClone(data)
      },
      list_sync_finished: () => {},
      dislike_sync_get_md5: () => fixtureMd5(state.dislike.trim()),
      dislike_sync_get_sync_mode: () => 'merge_local_remote',
      dislike_sync_get_list_data: () => state.dislike,
      dislike_sync_set_list_data: (data: string) => {
        state.dislike = data
      },
      dislike_sync_finished: () => {},
      onListSyncAction: (action: ListAction) => {
        state.receivedListActions.push(structuredClone(action))
        applyListAction(state.list, action)
      },
      onDislikeSyncAction: (action: DislikeAction) => {
        state.receivedDislikeActions.push(structuredClone(action))
        applyDislikeAction(state, action)
      },
    },
    timeout: 5_000,
    sendMessage(message) {
      outbound = outbound.then(async () => {
        const payload = await fixtureEncodeWireMessage(JSON.stringify(message))
        if (payload.startsWith('cg_')) wireFrames.sentCompressed = true
        socket.send(payload)
      })
    },
  })

  const websocketOrigin = input.origin.replace(/^http/, 'ws')
  const websocketPath = input.isMobile ? '/socket' : '/'
  const token = encodeURIComponent(
    fixtureEncryptProtocolMessage(upstreamLxV4.connectMessage, device.key),
  )
  socket = new WebSocket(
    `${websocketOrigin}${websocketPath}?i=${encodeURIComponent(device.clientId)}&t=${token}`,
  )
  socket.on('message', (data, isBinary) => {
    if (isBinary) return
    const payload = data.toString()
    if (payload === 'ping') return
    if (payload.startsWith('cg_')) wireFrames.receivedCompressed = true
    void fixtureDecodeWireMessage(payload).then((decoded) => {
      message2call.message(JSON.parse(decoded) as unknown)
    })
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })

  return {
    device,
    initialized,
    remote: message2call.remote,
    state,
    wireFrames,
    close: async () => {
      message2call.destroy()
      if (
        socket.readyState === WebSocket.CLOSED ||
        socket.readyState === WebSocket.CLOSING
      )
        return
      await new Promise<void>((resolve) => {
        socket.once('close', resolve)
        socket.close()
      })
    },
  }
}

function reauthenticateDevice(
  origin: string,
  device: RegisteredDevice,
): Promise<Response> {
  return fetch(`${origin}/ah`, {
    headers: {
      i: device.clientId,
      m: fixtureEncryptProtocolMessage(
        upstreamLxV4.authMessagePrefix,
        device.key,
      ),
    },
  })
}

function applyListAction(state: ListData, action: ListAction): void {
  if (action.action !== 'list_music_add') return
  const target =
    action.data.id === 'default'
      ? state.defaultList
      : action.data.id === 'love'
        ? state.loveList
        : state.userList.find((list) => list.id === action.data.id)?.list
  if (!target) return
  const existing = new Set(target.map((track) => track.id))
  const incoming = action.data.musicInfos.filter(
    (track) => !existing.has(track.id),
  )
  if (action.data.addMusicLocationType === 'top') target.unshift(...incoming)
  else target.push(...incoming)
}

function applyDislikeAction(state: ClientState, action: DislikeAction): void {
  if (action.action === 'dislike_data_overwrite') state.dislike = action.data
  if (action.action === 'dislike_music_clear') state.dislike = ''
  if (action.action === 'dislike_music_add') {
    const additions = action.data.map(
      (item) => `${String(item.name ?? '')}@${String(item.singer ?? '')}`,
    )
    state.dislike = fixtureNormalizeDislikeRules(
      `${state.dislike}\n${additions.join('\n')}`,
    )
  }
}

function emptyListData(): ListData {
  return { defaultList: [], loveList: [], userList: [] }
}

function listWithTrack(id: string): ListData {
  return {
    defaultList: [{ id, name: id }],
    loveList: [],
    userList: [],
  }
}

function fixtureMd5(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

function fixtureDeriveConnectionKey(connectionCode: string): string {
  return Buffer.from(fixtureMd5(connectionCode).slice(0, 16)).toString('base64')
}

function fixtureEncryptProtocolMessage(
  value: string | Buffer,
  base64Key: string,
): string {
  const cipher = createCipheriv(
    'aes-128-ecb',
    Buffer.from(base64Key, 'base64'),
    null,
  )
  return Buffer.concat([cipher.update(value), cipher.final()]).toString(
    'base64',
  )
}

async function fixtureEncodeWireMessage(message: string): Promise<string> {
  if (message.length <= 1_024) return message
  return `cg_${(await gzipAsync(message)).toString('base64')}`
}

async function fixtureDecodeWireMessage(message: string): Promise<string> {
  if (!message.startsWith('cg_')) return message
  return (await gunzipAsync(Buffer.from(message.slice(3), 'base64'))).toString(
    'utf8',
  )
}

function fixtureNormalizeDislikeRules(rules: string): string {
  const normalized = new Set<string>()
  for (const rawRule of rules.split('\n')) {
    if (!rawRule) continue
    const separator = rawRule.indexOf('@')
    const rawName = separator < 0 ? rawRule : rawRule.slice(0, separator)
    const rawSinger = separator < 0 ? '' : rawRule.slice(separator + 1)
    const name = rawName.replaceAll('@', '#').toLocaleLowerCase().trim()
    const singer = rawSinger.replaceAll('@', '#').toLocaleLowerCase().trim()
    if (name && singer) normalized.add(`${name}@${singer}`)
    else if (name) normalized.add(name)
    else if (singer) normalized.add(`@${singer}`)
  }
  return [...normalized].join('\n')
}
