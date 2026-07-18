import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { FastifyBaseLogger } from 'fastify'
import { createMsg2call } from 'message2call'
import { WebSocket, WebSocketServer } from 'ws'
import type { DeviceRecord, Repository } from '../db/repository.js'
import { LX_SYNC } from '../protocol/index.js'
import { decodeWireMessage, encodeWireMessage } from '../security/crypto.js'
import type { LxAuthService } from './auth.js'
import { SyncEngine } from './engine.js'
import type {
  ClientDislikeRemote,
  ClientListRemote,
  ClientRemote,
  ConnectionHub,
  SyncConnection,
} from './types.js'
import {
  parseDislikeAction,
  parseListAction,
  parseMessage2CallMessage,
} from './validation.js'

const maxPayloadBytes = 8 * 1024 * 1024
const maxBufferedBytes = 8 * 1024 * 1024
const shutdownGraceMs = 5_000

export class ConnectionRegistry implements ConnectionHub {
  private readonly connections = new Map<string, Set<SyncConnection>>()
  private readonly userTasks = new Map<string, Promise<void>>()

  add(connection: SyncConnection): void {
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
}): LxGateway {
  const registry = input.registry
  const engine = new SyncEngine(input.repository, registry)
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: maxPayloadBytes,
  })
  const alive = new WeakMap<WebSocket, boolean>()
  const socketConnections = new WeakMap<WebSocket, SyncConnection>()
  const pendingDevices = new WeakMap<IncomingMessage, DeviceRecord>()

  webSockets.on('connection', (socket, request) => {
    const device = pendingDevices.get(request)
    pendingDevices.delete(request)
    void startConnection(socket, device).catch((error: unknown) => {
      input.logger.warn({ err: error }, 'LX WebSocket initialization failed')
      socket.close(LX_SYNC.closeCode.failed)
    })
  })

  async function startConnection(
    socket: WebSocket,
    deviceValue: unknown,
  ): Promise<void> {
    if (!isAuthenticatedDevice(deviceValue)) {
      socket.close(LX_SYNC.closeCode.failed)
      return
    }
    const device = deviceValue
    const user = await input.repository.getUser(device.userId)
    if (!user) {
      socket.close(LX_SYNC.closeCode.failed)
      return
    }

    await registry.closeDevice(device.userId, device.clientId)
    alive.set(socket, true)
    socket.on('pong', () => alive.set(socket, true))

    let disconnected = false
    let connection: SyncConnection
    let outbound = Promise.resolve()
    const msg2call = createMsg2call<ClientRemote>({
      funcsObj: {
        onFeatureChanged: (feature: unknown) =>
          engine.featureChanged(connection, feature),
        onListSyncAction: (action: unknown) =>
          engine.applyList(connection, parseListAction(action)),
        onDislikeSyncAction: (action: unknown) =>
          engine.applyDislike(connection, parseDislikeAction(action)),
      },
      timeout: 120_000,
      sendMessage(message) {
        if (disconnected) throw new Error('Disconnected')
        outbound = outbound
          .then(async () => {
            const payload = await encodeWireMessage(JSON.stringify(message))
            if (socket.bufferedAmount > maxBufferedBytes)
              throw new Error('LX WebSocket outbound buffer limit exceeded')
            if (socket.readyState === WebSocket.OPEN) socket.send(payload)
          })
          .catch((error: unknown) => {
            input.logger.warn(
              { err: error, clientId: device.clientId },
              'LX WebSocket send failed',
            )
            socket.close(LX_SYNC.closeCode.failed)
          })
      },
      onError(error, path, groupName) {
        input.logger.warn(
          { err: error, path, groupName, clientId: device.clientId },
          'LX RPC call failed',
        )
      },
    })

    connection = {
      active: true,
      device,
      user,
      feature: {},
      moduleReady: { list: false, dislike: false },
      remote: msg2call.remote,
      remoteList: msg2call.createQueueRemote<ClientListRemote>('list'),
      remoteDislike: msg2call.createQueueRemote<ClientDislikeRemote>('dislike'),
      close: () => socket.close(LX_SYNC.closeCode.normal),
    }
    socketConnections.set(socket, connection)
    registry.add(connection)

    let inbound = Promise.resolve()
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(LX_SYNC.closeCode.failed)
        return
      }
      inbound = inbound
        .then(async () => {
          const decoded = await decodeWireMessage(data.toString())
          const message = parseMessage2CallMessage(
            JSON.parse(decoded) as unknown,
          )
          msg2call.message(message)
        })
        .catch((error: unknown) => {
          input.logger.warn(
            { err: error, clientId: device.clientId },
            'Invalid LX WebSocket message',
          )
          socket.close(LX_SYNC.closeCode.failed)
        })
    })

    socket.once('close', () => {
      disconnected = true
      msg2call.destroy()
      registry.remove(connection)
    })

    try {
      await engine.initialize(connection)
    } catch (error) {
      input.logger.warn(
        { err: error, clientId: device.clientId },
        'LX initial synchronization failed',
      )
      socket.close(LX_SYNC.closeCode.failed)
    }
  }

  const upgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    void (async () => {
      const url = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? 'localhost'}`,
      )
      const device = await input.auth.authenticateUpgrade({
        ip: resolveUpgradeIp({
          forwarded: request.headers['x-forwarded-for'],
          remoteAddress: request.socket.remoteAddress,
          trustProxy: input.trustProxy,
        }),
        clientId: url.searchParams.get('i'),
        token: url.searchParams.get('t'),
      })
      if (!device) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      pendingDevices.set(request, device)
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSockets.emit('connection', webSocket, request)
      })
    })().catch((error: unknown) => {
      input.logger.warn({ err: error }, 'LX WebSocket upgrade failed')
      socket.destroy()
    })
  }
  input.server.on('upgrade', upgrade)

  const heartbeat = setInterval(() => {
    for (const socket of webSockets.clients) {
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
      for (const socket of webSockets.clients)
        socket.close(LX_SYNC.closeCode.normal)
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

function isAuthenticatedDevice(value: unknown): value is DeviceRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'clientId' in value &&
    'userId' in value
  )
}
