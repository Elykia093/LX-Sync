import { randomUUID } from 'node:crypto'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { FastifyBaseLogger } from 'fastify'
import { createMsg2call } from 'message2call'
import { type RawData, WebSocket, WebSocketServer } from 'ws'
import type { DeviceRecord, Repository } from '../db/repository.js'
import { LX_SYNC } from '../protocol/index.js'
import { decodeWireMessage, encodeWireMessage } from '../security/crypto.js'
import type { LxAuthService } from './auth.js'
import { SyncEngine } from './engine.js'
import {
  deviceLogReference,
  syncErrorLogContext,
  syncLogContext,
  userLogReference,
} from './logging.js'
import { resolveSyncPath } from './path.js'
import { QueueOverflowError, SerialQueue } from './queue.js'
import type {
  ClientDislikeRemote,
  ClientListRemote,
  ClientRemote,
  ConnectionHub,
  SyncConnection,
} from './types.js'
import { parseMessage2CallMessage } from './validation.js'

const maxPayloadBytes = 8 * 1024 * 1024
const maxBufferedBytes = 8 * 1024 * 1024
const maxInboundQueuedMessages = 32
const maxInboundQueuedBytes = 16 * 1024 * 1024
const maxOutboundQueuedMessages = 256
const maxOutboundQueuedBytes = 16 * 1024 * 1024
const shutdownGraceMs = 5_000

export class ConnectionRegistry implements ConnectionHub {
  private readonly connections = new Map<string, Set<SyncConnection>>()
  private readonly userTasks = new Map<string, Promise<void>>()

  add(connection: SyncConnection): void {
    // Recheck synchronously after asynchronous device replacement has drained.
    for (const existing of this.forUser(connection.user.id)) {
      if (
        existing !== connection &&
        existing.device.clientId === connection.device.clientId
      )
        this.deactivate(existing)
    }
    const current =
      this.connections.get(connection.user.id) ?? new Set<SyncConnection>()
    current.add(connection)
    this.connections.set(connection.user.id, current)
  }

  remove(connection: SyncConnection): void {
    const current = this.connections.get(connection.user.id)
    current?.delete(connection)
    if (current?.size === 0) this.connections.delete(connection.user.id)
  }

  forUser(userId: string): SyncConnection[] {
    return [...(this.connections.get(userId) ?? [])]
  }

  count(): number {
    let total = 0
    for (const connections of this.connections.values())
      total += connections.size
    return total
  }

  async closeDevice(userId: string, clientId: string): Promise<void> {
    const users = new Set<string>()
    for (const connection of this.forUser(userId)) {
      if (connection.device.clientId !== clientId) continue
      users.add(connection.user.id)
      this.deactivate(connection)
    }
    await Promise.all([...users].map((userId) => this.waitForUser(userId)))
  }

  async closeUser(userId: string): Promise<void> {
    for (const connection of this.forUser(userId)) this.deactivate(connection)
    await this.waitForUser(userId)
  }

  runExclusive<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.userTasks.get(userId) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(task)
    const tracked = result.then(
      () => {},
      () => {},
    )
    this.userTasks.set(userId, tracked)
    void tracked.finally(() => {
      if (this.userTasks.get(userId) === tracked) this.userTasks.delete(userId)
    })
    return result
  }

  private deactivate(connection: SyncConnection): void {
    connection.active = false
    connection.moduleReady.list = false
    connection.moduleReady.dislike = false
    this.remove(connection)
    connection.close()
  }

  private async waitForUser(userId: string): Promise<void> {
    await this.userTasks.get(userId)
  }
}

export interface LxGateway {
  registry: ConnectionRegistry
  close: () => Promise<void>
}

export function createLxGateway(input: {
  server: HttpServer
  repository: Repository
  auth: LxAuthService
  registry: ConnectionRegistry
  logger: FastifyBaseLogger
  trustProxy: boolean
  syncBasePath?: string
}): LxGateway {
  const registry = input.registry
  const engine = new SyncEngine(input.repository, registry, input.logger)
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: maxPayloadBytes,
  })
  const alive = new WeakMap<WebSocket, boolean>()
  const socketConnections = new WeakMap<WebSocket, SyncConnection>()
  const pendingDevices = new WeakMap<IncomingMessage, DeviceRecord>()
  const pendingPathModes = new WeakMap<IncomingMessage, 'root' | 'scoped'>()

  webSockets.on('connection', (socket, request) => {
    const device = pendingDevices.get(request)
    const pathMode = pendingPathModes.get(request) ?? 'root'
    pendingDevices.delete(request)
    pendingPathModes.delete(request)
    void startConnection(socket, device, pathMode).catch((error: unknown) => {
      input.logger.warn(
        { event: 'sync.connection.failed', ...syncErrorLogContext(error) },
        'LX WebSocket initialization failed',
      )
      socket.close(LX_SYNC.closeCode.failed)
    })
  })

  async function startConnection(
    socket: WebSocket,
    deviceValue: unknown,
    pathMode: 'root' | 'scoped',
  ): Promise<void> {
    const connectedAt = Date.now()
    const connectionId = randomUUID()
    let disconnected = false
    let connection: SyncConnection | undefined
    let destroyRpc: (() => void) | undefined
    const logContext = {
      connectionId,
      pathMode,
      ...(isAuthenticatedDevice(deviceValue)
        ? {
            userRef: userLogReference(deviceValue.userId),
            deviceRef: deviceLogReference(deviceValue.clientId),
          }
        : {}),
    }
    const inbound = new SerialQueue({
      maxTasks: maxInboundQueuedMessages,
      maxBytes: maxInboundQueuedBytes,
    })
    const outbound = new SerialQueue({
      maxTasks: maxOutboundQueuedMessages,
      maxBytes: maxOutboundQueuedBytes,
    })
    const pendingCalls = new Map<string, number>()
    let pendingCallBytes = 0
    const isOpen = () => !disconnected && socket.readyState === WebSocket.OPEN
    const deactivate = () => {
      if (disconnected) return
      disconnected = true
      inbound.close()
      outbound.close()
      pendingCalls.clear()
      pendingCallBytes = 0
      if (connection) {
        connection.active = false
        connection.moduleReady.list = false
        connection.moduleReady.dislike = false
        registry.remove(connection)
      }
      destroyRpc?.()
    }
    const closeConnection = (code: number) => {
      deactivate()
      socket.close(code)
    }

    // Register before the first await: the peer can fail or leave during lookup.
    socket.on('error', (error: unknown) => {
      input.logger.warn(
        {
          ...logContext,
          event: 'sync.connection.error',
          ...syncErrorLogContext(error),
        },
        'LX WebSocket transport failed',
      )
      closeConnection(LX_SYNC.closeCode.failed)
    })
    socket.once('close', (code) => {
      deactivate()
      input.logger.info(
        {
          ...logContext,
          event: 'sync.connection.closed',
          code,
          durationMs: Date.now() - connectedAt,
        },
        'LX device disconnected',
      )
    })

    if (!isAuthenticatedDevice(deviceValue)) {
      closeConnection(LX_SYNC.closeCode.failed)
      return
    }
    const device = deviceValue
    const user = await input.repository.getUser(device.userId)
    if (!isOpen()) return
    if (!user?.enabled) {
      closeConnection(LX_SYNC.closeCode.failed)
      return
    }

    await registry.closeDevice(device.userId, device.clientId)
    if (!isOpen()) return
    alive.set(socket, true)
    socket.on('pong', () => alive.set(socket, true))

    const msg2call = createMsg2call<ClientRemote>({
      funcsObj: {
        onFeatureChanged: (feature: unknown) =>
          engine.featureChanged(activeConnection, feature),
        onListSyncAction: (action: unknown) =>
          engine.applyList(activeConnection, action),
        onDislikeSyncAction: (action: unknown) =>
          engine.applyDislike(activeConnection, action),
      },
      timeout: 120_000,
      sendMessage(message) {
        if (!message.path && typeof message.name === 'string') {
          const cost = pendingCalls.get(message.name)
          if (cost !== undefined) {
            pendingCalls.delete(message.name)
            pendingCallBytes -= cost
          }
        }
        if (!isOpen()) {
          // Reject outbound calls without throwing from message2call's detached
          // response handler, including calls created after disconnection.
          deactivate()
          destroyRpc?.()
          return
        }
        try {
          const serialized = JSON.stringify(message)
          const bytes = Buffer.byteLength(serialized)
          if (bytes > maxPayloadBytes)
            throw new RangeError('LX WebSocket message limit exceeded')
          outbound.push(async () => {
            if (!isOpen()) return
            try {
              const payload = await encodeWireMessage(serialized)
              if (!isOpen()) return
              const wireBytes = Buffer.byteLength(payload)
              if (wireBytes > maxPayloadBytes)
                throw new RangeError('LX WebSocket message limit exceeded')
              if (socket.bufferedAmount + wireBytes > maxBufferedBytes)
                throw new Error('LX WebSocket outbound buffer limit exceeded')
              await new Promise<void>((resolve, reject) => {
                socket.send(payload, (error) => {
                  if (error) reject(error)
                  else resolve()
                })
              })
            } catch (error: unknown) {
              input.logger.warn(
                {
                  ...logContext,
                  event: 'sync.message.send_failed',
                  ...syncErrorLogContext(error),
                },
                'LX WebSocket send failed',
              )
              closeConnection(LX_SYNC.closeCode.failed)
            }
          }, bytes)
        } catch (error: unknown) {
          input.logger.warn(
            {
              ...logContext,
              event:
                error instanceof QueueOverflowError
                  ? 'sync.outbound.overflow'
                  : 'sync.message.send_failed',
              ...syncErrorLogContext(error),
            },
            'LX WebSocket send rejected',
          )
          closeConnection(LX_SYNC.closeCode.failed)
        }
      },
      onError(error) {
        input.logger.warn(
          {
            ...logContext,
            event: 'sync.rpc.failed',
            ...syncErrorLogContext(error),
          },
          'LX RPC call failed',
        )
      },
    })
    destroyRpc = msg2call.destroy

    const activeConnection: SyncConnection = {
      connectionId,
      pathMode,
      active: true,
      device,
      user,
      feature: {},
      moduleReady: { list: false, dislike: false },
      remote: msg2call.remote,
      remoteList: msg2call.createQueueRemote<ClientListRemote>('list'),
      remoteDislike: msg2call.createQueueRemote<ClientDislikeRemote>('dislike'),
      close: () => closeConnection(LX_SYNC.closeCode.normal),
    }
    connection = activeConnection
    socketConnections.set(socket, activeConnection)
    registry.add(activeConnection)
    input.logger.info(
      {
        ...syncLogContext(activeConnection),
        event: 'sync.connection.opened',
        isMobile: device.isMobile,
      },
      'LX device connected',
    )

    socket.on('message', (data, isBinary) => {
      if (!isOpen()) return
      if (isBinary) {
        closeConnection(LX_SYNC.closeCode.failed)
        return
      }
      try {
        inbound.push(async () => {
          if (!isOpen()) return
          try {
            const decoded = await decodeWireMessage(data.toString())
            if (!isOpen()) return
            const bytes = Buffer.byteLength(decoded)
            if (bytes > maxPayloadBytes)
              throw new RangeError('LX WebSocket message limit exceeded')
            const message = parseMessage2CallMessage(
              JSON.parse(decoded) as unknown,
            )
            // Parsing can finish while the RPC still waits for the user's write
            // queue. Charge it until its response, without blocking RPC replies.
            if (message.path && message.name) {
              if (pendingCalls.has(message.name))
                throw new Error('Duplicate pending LX RPC call')
              if (pendingCalls.size >= maxInboundQueuedMessages)
                throw new QueueOverflowError('tasks', maxInboundQueuedMessages)
              if (pendingCallBytes + bytes > maxInboundQueuedBytes)
                throw new QueueOverflowError('bytes', maxInboundQueuedBytes)
              pendingCalls.set(message.name, bytes)
              pendingCallBytes += bytes
            }
            msg2call.message(message)
          } catch (error: unknown) {
            input.logger.warn(
              {
                ...logContext,
                event:
                  error instanceof QueueOverflowError
                    ? 'sync.inbound.overflow'
                    : 'sync.message.rejected',
                ...syncErrorLogContext(error),
              },
              'Invalid LX WebSocket message',
            )
            closeConnection(LX_SYNC.closeCode.failed)
          }
        }, rawDataByteLength(data))
      } catch (error: unknown) {
        input.logger.warn(
          {
            ...logContext,
            event: 'sync.inbound.overflow',
            ...syncErrorLogContext(error),
          },
          'LX WebSocket inbound queue limit exceeded',
        )
        closeConnection(LX_SYNC.closeCode.failed)
      }
    })

    try {
      await engine.initialize(activeConnection)
    } catch (error) {
      if (disconnected) return
      input.logger.warn(
        {
          ...logContext,
          event: 'sync.initialize.failed',
          ...syncErrorLogContext(error),
        },
        'LX initial synchronization failed',
      )
      closeConnection(LX_SYNC.closeCode.failed)
    }
  }

  const upgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    void (async () => {
      const url = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? 'localhost'}`,
      )
      const scope = resolveSyncPath(url.pathname, input.syncBasePath)
      if (!scope) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const device = await input.auth.authenticateUpgrade({
        ip: resolveUpgradeIp({
          forwarded: request.headers['x-forwarded-for'],
          remoteAddress: request.socket.remoteAddress,
          trustProxy: input.trustProxy,
        }),
        clientId: url.searchParams.get('i'),
        token: url.searchParams.get('t'),
        ...(scope.kind === 'scoped' ? { userId: scope.userId } : {}),
      })
      if (!device) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      pendingDevices.set(request, device)
      pendingPathModes.set(request, scope.kind)
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSockets.emit('connection', webSocket, request)
      })
    })().catch((error: unknown) => {
      input.logger.warn(
        { event: 'sync.upgrade.failed', ...syncErrorLogContext(error) },
        'LX WebSocket upgrade failed',
      )
      socket.destroy()
    })
  }
  input.server.on('upgrade', upgrade)

  const heartbeat = setInterval(() => {
    for (const socket of webSockets.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue
      if (alive.get(socket) === false) {
        socket.terminate()
        continue
      }
      alive.set(socket, false)
      socket.ping()
      const connection = socketConnections.get(socket)
      if (connection?.device.isMobile) socket.send('ping')
    }
  }, 30_000)
  heartbeat.unref()

  let closing: Promise<void> | undefined
  const close = () => {
    if (closing) return closing
    closing = (async () => {
      clearInterval(heartbeat)
      input.server.off('upgrade', upgrade)
      for (const socket of webSockets.clients) {
        const connection = socketConnections.get(socket)
        if (connection) connection.close()
        else socket.close(LX_SYNC.closeCode.normal)
      }
      await new Promise<void>((resolve, reject) => {
        const forceClose = setTimeout(() => {
          for (const socket of webSockets.clients) socket.terminate()
        }, shutdownGraceMs)
        forceClose.unref()
        webSockets.close((error) => {
          clearTimeout(forceClose)
          if (error) reject(error)
          else resolve()
        })
      })
    })()
    return closing
  }

  return {
    registry,
    close,
  }
}

export function resolveUpgradeIp(input: {
  forwarded: string | string[] | undefined
  remoteAddress: string | undefined
  trustProxy: boolean
}): string {
  if (input.trustProxy) {
    const forwarded = Array.isArray(input.forwarded)
      ? input.forwarded.at(-1)
      : input.forwarded
    const nearestClient = forwarded?.split(',').at(-1)?.trim()
    if (nearestClient) return nearestClient
  }
  return input.remoteAddress ?? 'unknown'
}

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data))
    return data.reduce((total, chunk) => total + chunk.byteLength, 0)
  return data.byteLength
}

function isAuthenticatedDevice(value: unknown): value is DeviceRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'clientId' in value &&
    'userId' in value
  )
}
