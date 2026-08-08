import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ListData } from '../protocol/index.js'
import { md5 } from '../security/crypto.js'
import {
  buildLxserverV2ImportPlan,
  ImportValidationError,
} from './lxserver-v2-import.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('lxserver v2 import planning', () => {
  it('validates source hashes and returns only aggregate dry-run evidence', async () => {
    const fixture = await createSourceFixture()
    await mkdir(path.join(fixture.source, 'users', 'orphan-directory'))

    const plan = await buildLxserverV2ImportPlan(fixture.source, {
      maxSnapshots: 10,
      addMusicLocationType: 'bottom',
    })

    expect(plan.summary).toEqual({
      sourceVersion: 2,
      users: 1,
      devices: 1,
      sourceSnapshots: 2,
      storedSnapshots: 2,
      baselines: 2,
      listHeadItems: 2,
      dislikeHeadItems: 1,
      orphanUserDirectories: 1,
    })
    expect(plan.users[0]?.maxSnapshots).toBe(12)
    expect(plan.users[0]?.addMusicLocationType).toBe('top')
    const publicEvidence = JSON.stringify(plan.summary)
    for (const secret of [
      fixture.userName,
      fixture.connectionCode,
      fixture.clientId,
      fixture.deviceKey,
      fixture.serverId,
      fixture.songName,
    ])
      expect(publicEvidence).not.toContain(secret)
  })

  it('rejects a snapshot whose content no longer matches its source key', async () => {
    const fixture = await createSourceFixture()
    const original = JSON.parse(
      await readFile(fixture.listSnapshotPath, 'utf8'),
    ) as ListData
    original.defaultList.push({ id: 'tampered' })
    await writeFile(fixture.listSnapshotPath, JSON.stringify(original))

    await expect(
      buildLxserverV2ImportPlan(fixture.source, {
        maxSnapshots: 10,
        addMusicLocationType: 'bottom',
      }),
    ).rejects.toBeInstanceOf(ImportValidationError)
  })

  it('rejects source files larger than the LX-Sync wire boundary', async () => {
    const fixture = await createSourceFixture()
    const usersPath = path.join(fixture.source, 'users.json')
    const users = await readFile(usersPath, 'utf8')
    await writeFile(usersPath, `${users}${' '.repeat(8 * 1024 * 1024)}`)

    await expect(
      buildLxserverV2ImportPlan(fixture.source, {
        maxSnapshots: 10,
        addMusicLocationType: 'bottom',
      }),
    ).rejects.toBeInstanceOf(ImportValidationError)
  })

  it('accepts an initialized source domain that has never created a snapshot', async () => {
    const fixture = await createSourceFixture()
    await rm(fixture.dislikeInfoPath)
    await rm(fixture.dislikeSnapshotPath)

    const plan = await buildLxserverV2ImportPlan(fixture.source, {
      maxSnapshots: 10,
      addMusicLocationType: 'bottom',
    })

    expect(plan.summary).toMatchObject({
      sourceSnapshots: 1,
      storedSnapshots: 2,
      baselines: 1,
      dislikeHeadItems: 0,
    })
  })

  it('rejects case-insensitive duplicate configured users', async () => {
    const fixture = await createSourceFixture()
    await writeFile(
      path.join(fixture.source, 'users.json'),
      JSON.stringify([
        { name: fixture.userName, password: fixture.connectionCode },
        { name: fixture.userName.toUpperCase(), password: 'second-code' },
      ]),
    )

    await expect(
      buildLxserverV2ImportPlan(fixture.source, {
        maxSnapshots: 10,
        addMusicLocationType: 'bottom',
      }),
    ).rejects.toBeInstanceOf(ImportValidationError)
  })

  it('rejects duplicate connection credentials that root authentication cannot disambiguate', async () => {
    const fixture = await createSourceFixture()
    await writeFile(
      path.join(fixture.source, 'users.json'),
      JSON.stringify([
        { name: fixture.userName, password: fixture.connectionCode },
        { name: 'second-user', password: fixture.connectionCode },
      ]),
    )

    await expect(
      buildLxserverV2ImportPlan(fixture.source, {
        maxSnapshots: 10,
        addMusicLocationType: 'bottom',
      }),
    ).rejects.toBeInstanceOf(ImportValidationError)
  })
})

async function createSourceFixture() {
  const source = await mkdtemp(path.join(os.tmpdir(), 'lx-sync-import-'))
  temporaryDirectories.push(source)
  const userName = 'source-user'
  const connectionCode = 'source-connection-code'
  const serverId = Buffer.alloc(16, 7).toString('base64')
  const clientId = Buffer.alloc(16, 8).toString('base64')
  const deviceKey = Buffer.alloc(16, 9).toString('base64')
  const songName = 'Private source song'
  const listData: ListData = {
    defaultList: [
      { id: 'song-1', name: songName, singer: 'Private singer', source: 'wy' },
    ],
    loveList: [],
    userList: [
      {
        id: 'source-list',
        name: 'Source list',
        locationUpdateTime: null,
        list: [{ id: 2, name: 'Second song', source: 'tx' }],
      },
    ],
  }
  const listPayload = JSON.stringify(listData)
  const dislikePayload = 'blocked@singer'
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
  const listSnapshotPath = path.join(
    listSnapshotDirectory,
    `snapshot_${listKey}`,
  )
  await writeFile(listSnapshotPath, listPayload)
  await writeFile(
    path.join(userDirectory, 'list', 'snapshotInfo.json'),
    JSON.stringify({
      latest: listKey,
      time: Date.parse('2026-07-20T10:00:00.000Z'),
      list: [],
      clients: {
        [clientId]: {
          snapshotKey: listKey,
          lastSyncDate: Date.parse('2026-07-20T10:00:00.000Z'),
        },
      },
    }),
  )
  const dislikeSnapshotPath = path.join(
    dislikeSnapshotDirectory,
    `snapshot_${dislikeKey}`,
  )
  const dislikeInfoPath = path.join(
    userDirectory,
    'dislike',
    'snapshotInfo.json',
  )
  await writeFile(dislikeSnapshotPath, dislikePayload)
  await writeFile(
    dislikeInfoPath,
    JSON.stringify({
      latest: dislikeKey,
      time: Date.parse('2026-07-20T10:00:00.000Z'),
      list: [],
      clients: {
        [clientId]: {
          snapshotKey: dislikeKey,
          lastSyncDate: Date.parse('2026-07-20T10:00:00.000Z'),
        },
      },
    }),
  )
  return {
    source,
    userName,
    connectionCode,
    serverId,
    clientId,
    deviceKey,
    songName,
    listSnapshotPath,
    dislikeSnapshotPath,
    dislikeInfoPath,
  }
}

function sourceUserDirectoryName(userName: string): string {
  const filtered = userName.replace(/[\\/:*?#"<>|]/g, '')
  const suffix = createHash('md5').update(userName).digest('hex').slice(0, 6)
  return `${filtered}_${suffix}`
}
