import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FastifyBaseLogger } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import type {
  DeviceRecord,
  Repository,
  SnapshotRecord,
  SyncUserRecord,
} from '../db/repository.js'
import { type ListData, LX_SYNC } from '../protocol/index.js'
import { decodeWireMessage, encodeWireMessage } from '../security/crypto.js'
import type { LxAuthService } from './auth.js'
import { ConnectionRegistry, createLxGateway } from './gateway.js'

const maxPayloadBytes = 8 * 1024 * 1024
const fixtures: Array<{ close: () => Promise<void> }> = []

interface RpcFrame {
  name: string
  path?: string[]
  error?: string | null
  data?: unknown
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
  vi.restoreAllMocks()
})

async function createFixture(
  input: {
    getUser?: () => Promise<SyncUserRecord | null>
    getEnabledFeatures?: () => Promise<unknown>
  } = {},
) {
  const user: SyncUserRecord = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Lifecycle test',
    authKey: 'test-key',
    enabled: true,
    maxSnapshots: 10,
    addMusicLocationType: 'bottom',
  }
  const device: DeviceRecord = {
    clientId: 'lifecycle-device',
    userId: user.id,
    userName: user.name,
    key: 'test-key',
    deviceName: 'Lifecycle test device',
    isMobile: false,
  }
  const snapshot: SnapshotRecord<ListData> = {
    id: '00000000-0000-4000-8000-000000000002',
    hash: 'lifecycle-head-hash',
    data: { defaultList: [], loveList: [], userList: [] },
    createdAt: new Date('2026-09-08T00:00:00.000Z'),
    itemCount: 0,
    byteSize: 0,
  }
  const markDeviceSnapshot = vi.fn(async () => {})
  const saveSnapshot = vi.fn(async () => snapshot)
  const repository = {
    getUser: input.getUser ?? (async () => user),
    getHead: async () => snapshot,
    getDeviceSnapshot: async () => null,
    saveSnapshot,
    markDeviceSnapshot,
  } as unknown as Repository
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }
  const server = createServer()
  const registry = new ConnectionRegistry()
  const serverSockets: WebSocket[] = []
  const serverClosed = new WeakMap<WebSocket, Promise<number>>()
  const handleUpgrade = WebSocketServer.prototype.handleUpgrade
  vi.spyOn(WebSocketServer.prototype, 'handleUpgrade').mockImplementation(
    function (this: WebSocketServer, request, socket, head, callback) {
      handleUpgrade.call(this, request, socket, head, (webSocket, incoming) => {
        serverSockets.push(webSocket)
        serverClosed.set(
          webSocket,
          new Promise<number>((resolve) => webSocket.once('close', resolve)),
        )
        callback(webSocket, incoming)
      })
    },
  )
  const gateway = createLxGateway({
    server,
    repository,
    auth: {
      authenticateUpgrade: async () => device,
    } as unknown as LxAuthService,
    registry,
    logger: logger as unknown as FastifyBaseLogger,
    trustProxy: false,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const clients: WebSocket[] = []
  const cleanup: Array<() => void> = []

  const fixture = {
    user,
    registry,
    logger,
    markDeviceSnapshot,
    saveSnapshot,
    serverSockets,
    serverClosed,
    cleanup,
    async connect() {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/`)
      clients.push(socket)
      const initialized = Promise.withResolvers<void>()
      const closed = new Promise<number>((resolve) =>
        socket.once('close', resolve),
      )
      const errors: unknown[] = []
      const frames: string[] = []
      const responses: RpcFrame[] = []
      let inbound = Promise.resolve()
      socket.on('error', (error) => errors.push(error))
      socket.on('message', (data) => {
        const wire = data.toString()
        frames.push(wire)
        inbound = inbound
          .then(async () => {
            const message = JSON.parse(
              await decodeWireMessage(wire),
            ) as RpcFrame
            if (!message.path) {
              responses.push(message)
              return
            }
            const method = message.path[0]
            let result: unknown
            if (method === 'getEnabledFeatures') {
              result = input.getEnabledFeatures
                ? await input.getEnabledFeatures()
                : { list: { skipSnapshot: false } }
            } else if (method === 'list_sync_get_md5') {
              result = snapshot.hash
            }
            if (socket.readyState !== WebSocket.OPEN) return
            socket.send(
              await encodeWireMessage(
                JSON.stringify({
                  name: message.name,
                  error: null,
                  data: result,
                }),
              ),
            )
            if (method === 'finished') initialized.resolve()
          })
          .catch((error: unknown) => {
            errors.push(error)
          })
      })
      await once(socket, 'open')
      return {
        socket,
        initialized: initialized.promise,
        closed,
        frames,
        responses,
        errors,
        async ready() {
          await initialized.promise
          await registry.runExclusive(user.id, async () => {})
        },
        async close() {
          socket.close()
          return closed
        },
      }
    },
    async close() {
      for (const release of cleanup) release()
      for (const socket of clients) {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
      }
      for (const socket of serverSockets) {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
        // Release any RPCs attached after an already observed close in the red baseline.
        else socket.emit('close', LX_SYNC.closeCode.normal, Buffer.alloc(0))
      }
      await gateway.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
  fixtures.push(fixture)
  return fixture
}

describe('LX gateway connection lifecycle', () => {
  it('handles oversized WebSocket frames without an unhandled transport error', async () => {
    const fixture = await createFixture()
    const client = await fixture.connect()
    await client.ready()
    const serverSocket = fixture.serverSockets[0]
    if (!serverSocket) throw new Error('Expected a server WebSocket')
    const applicationErrorListeners = serverSocket.listenerCount('error')
    // Observe the actual ws error while keeping the red baseline from crashing Vitest.
    const error = once(serverSocket, 'error')
    client.socket.send('x'.repeat(maxPayloadBytes + 1))
    const [transportError] = await error
    expect(transportError).toMatchObject({
      code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',
    })
    expect(await client.closed).toBe(1009)
    expect(applicationErrorListeners).toBeGreaterThan(0)
    expect(fixture.registry.count()).toBe(0)

    const replacement = await fixture.connect()
    await replacement.ready()
    expect(fixture.registry.count()).toBe(1)
  })

  it('deactivates both sync domains when the peer disconnects', async () => {
    const fixture = await createFixture()
    const client = await fixture.connect()
    await client.ready()
    const connection = fixture.registry.forUser(fixture.user.id)[0]
    const serverSocket = fixture.serverSockets[0]
    if (!connection || !serverSocket) throw new Error('Expected a connection')
    expect(connection.moduleReady.list).toBe(true)

    await client.close()
    await fixture.serverClosed.get(serverSocket)
    expect(fixture.registry.count()).toBe(0)
    expect(connection.active).toBe(false)
    expect(connection.moduleReady).toEqual({ list: false, dislike: false })

    const lateCalls = await Promise.allSettled([
      connection.remote.finished(),
      connection.remoteList.list_sync_get_md5(),
      connection.remoteList.list_sync_get_md5(),
    ])
    expect(lateCalls).toHaveLength(3)
    for (const call of lateCalls) {
      expect(call.status).toBe('rejected')
      if (call.status === 'rejected')
        expect(call.reason).toMatchObject({ message: 'destroy' })
    }
  })

  it('does not register a socket that closes while its user lookup is pending', async () => {
    const lookupStarted = Promise.withResolvers<void>()
    const lookup = Promise.withResolvers<SyncUserRecord | null>()
    const fixture = await createFixture({
      getUser: async () => {
        lookupStarted.resolve()
        return lookup.promise
      },
    })
    fixture.cleanup.push(() => lookup.resolve(null))
    const client = await fixture.connect()
    await lookupStarted.promise
    const serverSocket = fixture.serverSockets[0]
    if (!serverSocket) throw new Error('Expected a server WebSocket')
    await client.close()
    await fixture.serverClosed.get(serverSocket)

    lookup.resolve(fixture.user)
    // All resumed startup work uses settled promises; drain through one event-loop turn.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(fixture.registry.count()).toBe(0)
    expect(
      fixture.logger.info.mock.calls.some(
        ([context]) => context.event === 'sync.connection.opened',
      ),
    ).toBe(false)
  })

  it('does not register a replacement that closes while the old device drains', async () => {
    const fixture = await createFixture()
    const first = await fixture.connect()
    await first.ready()
    const taskStarted = Promise.withResolvers<void>()
    const releaseTask = Promise.withResolvers<void>()
    fixture.cleanup.push(() => releaseTask.resolve())
    const task = fixture.registry.runExclusive(fixture.user.id, async () => {
      taskStarted.resolve()
      await releaseTask.promise
    })
    await taskStarted.promise
    const replacement = await fixture.connect()
    const serverSocket = fixture.serverSockets[1]
    if (!serverSocket) throw new Error('Expected a replacement WebSocket')
    await first.closed
    await replacement.close()
    await fixture.serverClosed.get(serverSocket)

    releaseTask.resolve()
    await task
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(fixture.registry.count()).toBe(0)
  })

  it('keeps only one active connection when the same device connects concurrently', async () => {
    const bothLookupsStarted = Promise.withResolvers<void>()
    const lookup = Promise.withResolvers<SyncUserRecord | null>()
    let lookups = 0
    const fixture = await createFixture({
      getUser: async () => {
        lookups += 1
        if (lookups === 2) bothLookupsStarted.resolve()
        return lookup.promise
      },
    })
    fixture.cleanup.push(() => lookup.resolve(null))
    const first = await fixture.connect()
    const second = await fixture.connect()
    await bothLookupsStarted.promise
    lookup.resolve(fixture.user)
    await Promise.race([first.initialized, second.initialized])

    await vi.waitFor(() => expect(fixture.registry.count()).toBe(1), {
      interval: 5,
      timeout: 1_000,
    })
    expect(await Promise.race([first.closed, second.closed])).toBe(
      LX_SYNC.closeCode.normal,
    )
  })

  it('rejects oversized decoded outbound messages before they reach the client', async () => {
    const fixture = await createFixture()
    const client = await fixture.connect()
    await client.ready()
    const connection = fixture.registry.forUser(fixture.user.id)[0]
    if (!connection) throw new Error('Expected a connection')
    const previousFrames = client.frames.length
    const previousBaselines = fixture.markDeviceSnapshot.mock.calls.length
    const nextFrame = once(client.socket, 'message').then(() => 'message')
    const closed = client.closed.then(() => 'closed')
    const call = connection.remoteList.list_sync_set_list_data({
      name: 'x'.repeat(maxPayloadBytes),
    })
    void call.catch(() => {})

    expect(await Promise.race([nextFrame, closed])).toBe('closed')
    expect(await client.closed).toBe(LX_SYNC.closeCode.failed)
    expect(client.frames).toHaveLength(previousFrames)
    expect(fixture.markDeviceSnapshot).toHaveBeenCalledTimes(previousBaselines)
  })

  it('bounds unfinished RPC calls even when each inbound frame has already decoded', async () => {
    const featuresRequested = Promise.withResolvers<void>()
    const features = Promise.withResolvers<unknown>()
    const fixture = await createFixture({
      getEnabledFeatures: async () => {
        featuresRequested.resolve()
        return features.promise
      },
    })
    fixture.cleanup.push(() => features.resolve({}))
    const runExclusive = vi.spyOn(fixture.registry, 'runExclusive')
    const client = await fixture.connect()
    await featuresRequested.promise
    const initializationTasks = runExclusive.mock.calls.length

    try {
      for (let index = 0; index < 32; index += 1) {
        client.socket.send(
          JSON.stringify({
            name: `pending-feature-${index}`,
            path: ['onFeatureChanged'],
            data: [{}],
          }),
        )
        await vi.waitFor(
          () => {
            expect(runExclusive).toHaveBeenCalledTimes(
              initializationTasks + index + 1,
            )
          },
          { interval: 1, timeout: 1_000 },
        )
      }
      client.socket.send(
        JSON.stringify({
          name: 'pending-feature-overflow',
          path: ['onFeatureChanged'],
          data: [{}],
        }),
      )

      await vi.waitFor(
        () => expect(client.socket.readyState).toBe(WebSocket.CLOSED),
        { interval: 5, timeout: 1_000 },
      )
      expect(await client.closed).toBe(LX_SYNC.closeCode.failed)
      expect(fixture.markDeviceSnapshot).not.toHaveBeenCalled()
    } finally {
      features.resolve({})
      // Drain the unbounded red baseline while its socket can still acknowledge RPCs.
      if (client.socket.readyState === WebSocket.OPEN)
        await fixture.registry.runExclusive(fixture.user.id, async () => {})
    }
  })

  it('accepts initialization replies when the unfinished call budget is full', async () => {
    const featuresRequested = Promise.withResolvers<void>()
    const features = Promise.withResolvers<unknown>()
    const fixture = await createFixture({
      getEnabledFeatures: async () => {
        featuresRequested.resolve()
        return features.promise
      },
    })
    fixture.cleanup.push(() => features.resolve({}))
    const runExclusive = vi.spyOn(fixture.registry, 'runExclusive')
    const client = await fixture.connect()
    await featuresRequested.promise
    const initializationTasks = runExclusive.mock.calls.length

    for (let index = 0; index < 32; index += 1) {
      client.socket.send(
        JSON.stringify({
          name: `full-budget-${index}`,
          path: ['onFeatureChanged'],
          data: [{}],
        }),
      )
      await vi.waitFor(
        () =>
          expect(runExclusive).toHaveBeenCalledTimes(
            initializationTasks + index + 1,
          ),
        { interval: 1, timeout: 1_000 },
      )
    }

    features.resolve({})
    await client.ready()
    await vi.waitFor(() => expect(client.responses).toHaveLength(32), {
      interval: 1,
      timeout: 1_000,
    })
    expect(client.responses.every((response) => response.error === null)).toBe(
      true,
    )
    expect(client.socket.readyState).toBe(WebSocket.OPEN)
    expect(fixture.registry.count()).toBe(1)
  })

  it('reuses the task and decoded byte budgets after normal RPC completion', async () => {
    const fixture = await createFixture()
    const client = await fixture.connect()
    await client.ready()
    const padding = 'x'.repeat(512 * 1024)

    // Cumulative traffic exceeds both 32 requests and 16 MiB while each call completes.
    for (let index = 0; index < 40; index += 1) {
      const name = `completed-call-${index}`
      client.socket.send(
        await encodeWireMessage(
          JSON.stringify({
            name,
            path: ['onFeatureChanged'],
            data: [{ padding }],
          }),
        ),
      )
      await vi.waitFor(
        () =>
          expect(client.responses[index]).toMatchObject({ name, error: null }),
        { interval: 1, timeout: 1_000 },
      )
    }

    expect(client.responses).toHaveLength(40)
    expect(client.socket.readyState).toBe(WebSocket.OPEN)
    expect(fixture.registry.count()).toBe(1)
  })

  it('rejects a duplicate unfinished call ID without dispatching it twice', async () => {
    const fixture = await createFixture()
    const client = await fixture.connect()
    await client.ready()
    const taskStarted = Promise.withResolvers<void>()
    const releaseTask = Promise.withResolvers<void>()
    fixture.cleanup.push(() => releaseTask.resolve())
    const task = fixture.registry.runExclusive(fixture.user.id, async () => {
      taskStarted.resolve()
      await releaseTask.promise
    })
    await taskStarted.promise
    const runExclusive = vi.spyOn(fixture.registry, 'runExclusive')
    const frame = JSON.stringify({
      name: 'duplicate-pending-call',
      path: ['onFeatureChanged'],
      data: [{}],
    })
    client.socket.send(frame)
    await vi.waitFor(() => expect(runExclusive).toHaveBeenCalledTimes(1), {
      interval: 1,
      timeout: 1_000,
    })

    client.socket.send(frame)
    expect(await client.closed).toBe(LX_SYNC.closeCode.failed)
    expect(runExclusive).toHaveBeenCalledTimes(1)
    releaseTask.resolve()
    await task
    await fixture.registry.runExclusive(fixture.user.id, async () => {})
    expect(fixture.registry.count()).toBe(0)
    expect(fixture.saveSnapshot).not.toHaveBeenCalled()
  })

  it('stops dispatching queued frames after a decoded message exceeds the size limit', async () => {
    const fixture = await createFixture()
    const client = await fixture.connect()
    await client.ready()
    const runExclusive = vi.spyOn(fixture.registry, 'runExclusive')
    const oversized = await encodeWireMessage(
      JSON.stringify({
        name: 'oversized-decoded-call',
        path: ['onFeatureChanged'],
        data: [{ padding: 'x'.repeat(maxPayloadBytes) }],
      }),
    )
    expect(Buffer.byteLength(oversized)).toBeLessThan(maxPayloadBytes)

    client.socket.send(oversized)
    client.socket.send(
      JSON.stringify({
        name: 'must-not-dispatch-after-oversize',
        path: ['onFeatureChanged'],
        data: [{}],
      }),
    )

    expect(await client.closed).toBe(LX_SYNC.closeCode.failed)
    expect(runExclusive).not.toHaveBeenCalled()
    expect(fixture.registry.count()).toBe(0)
    expect(fixture.saveSnapshot).not.toHaveBeenCalled()
  })

  it('does not start an old queued write after its socket disconnects', async () => {
    const fixture = await createFixture()
    const client = await fixture.connect()
    await client.ready()
    const serverSocket = fixture.serverSockets[0]
    if (!serverSocket) throw new Error('Expected a server WebSocket')
    const taskStarted = Promise.withResolvers<void>()
    const releaseTask = Promise.withResolvers<void>()
    fixture.cleanup.push(() => releaseTask.resolve())
    const task = fixture.registry.runExclusive(fixture.user.id, async () => {
      taskStarted.resolve()
      await releaseTask.promise
    })
    await taskStarted.promise
    const runExclusive = vi.spyOn(fixture.registry, 'runExclusive')
    const previousBaselines = fixture.markDeviceSnapshot.mock.calls.length
    client.socket.send(
      JSON.stringify({
        name: 'queued-list-write',
        path: ['onListSyncAction'],
        data: [{ action: 'list_music_clear', data: ['default'] }],
      }),
    )
    await vi.waitFor(() => expect(runExclusive).toHaveBeenCalledTimes(1), {
      interval: 1,
      timeout: 1_000,
    })

    await client.close()
    await fixture.serverClosed.get(serverSocket)
    releaseTask.resolve()
    await task
    await fixture.registry.runExclusive(fixture.user.id, async () => {})

    expect(fixture.saveSnapshot).not.toHaveBeenCalled()
    expect(fixture.markDeviceSnapshot).toHaveBeenCalledTimes(previousBaselines)
    expect(fixture.registry.count()).toBe(0)
  })
})
