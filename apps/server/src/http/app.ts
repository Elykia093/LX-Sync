import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { ZodError, z } from 'zod'
import type { AppConfig } from '../config.js'
import type { Repository } from '../db/repository.js'
import { AppError } from '../errors.js'
import { LX_SYNC } from '../protocol/index.js'
import {
  deriveConnectionKey,
  randomSessionId,
  secureEqual,
  sha256,
} from '../security/crypto.js'
import type { LxAuthService } from '../sync/auth.js'
import { AttemptLimiter } from '../sync/auth.js'
import type { ConnectionRegistry } from '../sync/gateway.js'
import { syncPathForUser } from '../sync/path.js'

export const sessionCookieName = 'lx_sync_session'

interface SessionContext {
  sessionHash: string
  username: string
  expiresAt: Date
}

export interface AppDependencies {
  config: AppConfig
  repository: Pick<
    Repository,
    | 'checkDatabase'
    | 'createSession'
    | 'getSession'
    | 'touchSession'
    | 'deleteSession'
    | 'listUsers'
    | 'createUser'
    | 'getUserSummary'
    | 'updateUser'
    | 'listDevices'
    | 'revokeDevice'
    | 'listSnapshots'
    | 'restoreSnapshot'
    | 'listAudit'
  >
  auth: Pick<LxAuthService, 'authenticateHttp'>
  registry: Pick<ConnectionRegistry, 'count' | 'closeUser' | 'closeDevice'>
  serverId: string
  startedAt: Date
  loggerStream?: { write(message: string): void }
}

const loginSchema = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(256),
  })
  .strict()

const createUserSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    connectionCode: z.string().min(8).max(256),
    maxSnapshots: z.number().int().min(1).max(1000).optional(),
    addMusicLocationType: z.enum(['top', 'bottom']).optional(),
  })
  .strict()

const updateUserSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxSnapshots: z.number().int().min(1).max(1000).optional(),
    addMusicLocationType: z.enum(['top', 'bottom']).optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    'at least one writable field is required',
  )

const credentialSchema = z
  .object({ connectionCode: z.string().min(8).max(256) })
  .strict()
const userParamsSchema = z.object({ userId: z.string().uuid() }).strict()
const syncUserParamsSchema = z
  .object({
    userId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict()
const deviceParamsSchema = userParamsSchema
  .extend({ clientId: z.string().min(1).max(256) })
  .strict()
const snapshotParamsSchema = userParamsSchema
  .extend({
    domain: z.enum(['list', 'dislike']),
    snapshotId: z.string().uuid(),
  })
  .strict()
const snapshotListParamsSchema = userParamsSchema
  .extend({ domain: z.enum(['list', 'dislike']) })
  .strict()
const snapshotQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict()
const auditQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(100) })
  .strict()

export async function buildApp(dependencies: AppDependencies) {
  const { config, repository } = dependencies
  const sessions = new WeakMap<FastifyRequest, SessionContext>()
  const loginLimiter = new AttemptLimiter()
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    connectionTimeout: 10_000,
    requestTimeout: 30_000,
    trustProxy: config.TRUST_PROXY ? 1 : false,
    logger:
      config.NODE_ENV === 'test' || config.LOG_LEVEL === 'silent'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: {
              paths: [
                'req.url',
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers.set-cookie',
              ],
              censor: '[Redacted]',
            },
            ...(dependencies.loggerStream
              ? { stream: dependencies.loggerStream }
              : {}),
          },
  })

  await app.register(cookie)

  app.addHook('onRequest', async (request) => {
    if (
      !request.url.startsWith('/api/v1') ||
      ['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    )
      return
    const expectedOrigin =
      config.PUBLIC_ORIGIN ?? `${request.protocol}://${request.host}`
    if (request.headers.origin !== expectedOrigin)
      throw new AppError(403, 'ORIGIN_INVALID', 'Request origin is not allowed')
  })

  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('X-Frame-Options', 'DENY')
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'",
    )
    if (config.NODE_ENV === 'production')
      reply.header(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains',
      )
    if (request.url.startsWith('/api/v1'))
      reply.header('Cache-Control', 'no-store')
  })

  app.setErrorHandler((error, request, reply) => {
    if (hasErrorCode(error, 'FST_ERR_CTP_INVALID_JSON_BODY')) {
      sendProblem(
        reply,
        request,
        400,
        'INVALID_JSON',
        'Bad Request',
        'Request body is not valid JSON',
      )
      return
    }
    if (error instanceof ZodError) {
      sendProblem(
        reply,
        request,
        400,
        'VALIDATION_FAILED',
        'Invalid request',
        'Request validation failed',
      )
      return
    }
    if (error instanceof AppError) {
      sendProblem(
        reply,
        request,
        error.statusCode,
        error.code,
        problemTitle(error.statusCode),
        error.message,
      )
      return
    }
    if (hasErrorCode(error, '23505')) {
      sendProblem(
        reply,
        request,
        409,
        'RESOURCE_CONFLICT',
        'Conflict',
        'The resource conflicts with existing data',
      )
      return
    }
    request.log.error({ err: error }, 'Unhandled request error')
    sendProblem(
      reply,
      request,
      500,
      'INTERNAL_ERROR',
      'Internal Server Error',
      'The server could not process the request',
    )
  })

  app.get('/health/live', async () => ({ status: 'ok' }))
  app.get('/health/ready', async (_request, reply) => {
    try {
      await repository.checkDatabase()
      return { status: 'ready' }
    } catch {
      return reply.status(503).send({ status: 'unavailable' })
    }
  })

  const sendHello = (_request: FastifyRequest, reply: FastifyReply) =>
    reply.type('text/plain').send(LX_SYNC.helloMessage)
  const sendServerId = (_request: FastifyRequest, reply: FastifyReply) =>
    reply.type('text/plain').send(`${LX_SYNC.idPrefix}${dependencies.serverId}`)
  const authenticateProtocol = async (
    request: FastifyRequest,
    reply: FastifyReply,
    userId?: string,
  ) => {
    const result = await dependencies.auth.authenticateHttp({
      ip: request.ip,
      ...(typeof request.headers.m === 'string'
        ? { encryptedMessage: request.headers.m }
        : {}),
      ...(typeof request.headers.i === 'string'
        ? { clientId: request.headers.i }
        : {}),
      ...(userId ? { userId } : {}),
    })
    return reply
      .header('Cache-Control', 'no-store')
      .status(result.statusCode)
      .type('text/plain')
      .send(result.body)
  }

  app.get('/hello', sendHello)
  app.get('/id', sendServerId)
  app.get('/ah', (request, reply) => authenticateProtocol(request, reply))

  if (config.SYNC_BASE_PATH) {
    const scopedProtocolPath = `${config.SYNC_BASE_PATH}/:userId`
    app.get(`${scopedProtocolPath}/hello`, async (request, reply) => {
      syncUserParamsSchema.parse(request.params)
      return sendHello(request, reply)
    })
    app.get(`${scopedProtocolPath}/id`, async (request, reply) => {
      syncUserParamsSchema.parse(request.params)
      return sendServerId(request, reply)
    })
    app.get(`${scopedProtocolPath}/ah`, async (request, reply) => {
      const { userId } = syncUserParamsSchema.parse(request.params)
      return authenticateProtocol(request, reply, userId)
    })
  }

  await app.register(
    async (api) => {
      api.post('/auth/login', async (request, reply) => {
        if (!loginLimiter.isAllowed(request.ip)) {
          reply.header('Retry-After', '300')
          throw new AppError(
            429,
            'AUTH_RATE_LIMITED',
            'Too many authentication attempts',
          )
        }
        const body = loginSchema.parse(request.body)
        if (
          !secureEqual(body.username, config.ADMIN_USERNAME) ||
          !secureEqual(body.password, config.ADMIN_PASSWORD)
        ) {
          loginLimiter.recordFailure(request.ip)
          throw new AppError(401, 'AUTH_INVALID', 'Authentication failed')
        }
        loginLimiter.clear(request.ip)
        const sessionId = randomSessionId()
        const sessionHash = sha256(sessionId)
        const expiresAt = new Date(
          Date.now() + config.SESSION_TTL_HOURS * 60 * 60 * 1000,
        )
        await repository.createSession(
          {
            sessionHash,
            username: config.ADMIN_USERNAME,
            expiresAt,
            remoteAddress: request.ip,
          },
          {
            actor: config.ADMIN_USERNAME,
            action: 'session.login',
            targetType: 'session',
          },
        )
        reply.setCookie(
          sessionCookieName,
          sessionId,
          cookieOptions(config, config.SESSION_TTL_HOURS * 60 * 60),
        )
        return { username: config.ADMIN_USERNAME, expiresAt }
      })

      await api.register(async (protectedApi) => {
        protectedApi.addHook('preHandler', async (request) => {
          const rawSession = request.cookies[sessionCookieName]
          if (!rawSession || !/^[A-Za-z0-9_-]{43}$/.test(rawSession))
            throw new AppError(401, 'AUTH_INVALID', 'Authentication failed')
          const sessionHash = sha256(rawSession)
          const session = await repository.getSession(sessionHash)
          if (!session)
            throw new AppError(401, 'AUTH_INVALID', 'Authentication failed')
          sessions.set(request, {
            sessionHash,
            username: session.username,
            expiresAt: session.expiresAt,
          })
          if (Date.now() - session.lastSeenAt.getTime() >= 5 * 60_000)
            await repository.touchSession(sessionHash)
        })

        protectedApi.post('/auth/logout', async (request, reply) => {
          const session = sessionFor(sessions, request)
          await repository.deleteSession(session.sessionHash, {
            actor: session.username,
            action: 'session.logout',
            targetType: 'session',
          })
          reply.clearCookie(sessionCookieName, cookieOptions(config))
          return reply.status(204).send()
        })

        protectedApi.get('/auth/session', async (request) => {
          const session = sessionFor(sessions, request)
          return { username: session.username, expiresAt: session.expiresAt }
        })

        protectedApi.get('/status', async () => ({
          serverId: dependencies.serverId,
          serverName: config.SERVER_NAME,
          startedAt: dependencies.startedAt,
          onlineDevices: dependencies.registry.count(),
          syncBasePath: config.SYNC_BASE_PATH ?? null,
        }))

        protectedApi.get('/users', async () => ({
          data: (await repository.listUsers()).map((user) =>
            withSyncPath(user, config),
          ),
        }))

        protectedApi.post('/users', async (request, reply) => {
          const session = sessionFor(sessions, request)
          const body = createUserSchema.parse(request.body)
          const created = await repository.createUser(
            {
              name: body.name,
              authKey: deriveConnectionKey(body.connectionCode),
              maxSnapshots: body.maxSnapshots ?? config.MAX_SNAPSHOTS,
              addMusicLocationType: body.addMusicLocationType ?? 'bottom',
            },
            {
              actor: session.username,
              action: 'user.create',
              targetType: 'sync_user',
            },
          )
          const user = await repository.getUserSummary(created.id)
          if (!user)
            throw new AppError(
              500,
              'INTERNAL_ERROR',
              'Created user could not be read',
            )
          reply.header('Location', `/api/v1/users/${created.id}`)
          return reply.status(201).send(withSyncPath(user, config))
        })

        protectedApi.patch('/users/:userId', async (request) => {
          const session = sessionFor(sessions, request)
          const { userId } = userParamsSchema.parse(request.params)
          const parsedPatch = updateUserSchema.parse(request.body)
          const patch = {
            ...(parsedPatch.enabled === undefined
              ? {}
              : { enabled: parsedPatch.enabled }),
            ...(parsedPatch.maxSnapshots === undefined
              ? {}
              : { maxSnapshots: parsedPatch.maxSnapshots }),
            ...(parsedPatch.addMusicLocationType === undefined
              ? {}
              : { addMusicLocationType: parsedPatch.addMusicLocationType }),
          }
          if (parsedPatch.enabled === false)
            await dependencies.registry.closeUser(userId)
          if (
            !(await repository.updateUser(userId, patch, {
              actor: session.username,
              action: 'user.update',
              targetType: 'sync_user',
              targetId: userId,
              metadata: { fields: Object.keys(patch) },
            }))
          )
            throw new AppError(404, 'USER_NOT_FOUND', 'User was not found')
          const user = await repository.getUserSummary(userId)
          if (!user)
            throw new AppError(404, 'USER_NOT_FOUND', 'User was not found')
          return withSyncPath(user, config)
        })

        protectedApi.put(
          '/users/:userId/connection-credential',
          async (request, reply) => {
            const session = sessionFor(sessions, request)
            const { userId } = userParamsSchema.parse(request.params)
            const body = credentialSchema.parse(request.body)
            await dependencies.registry.closeUser(userId)
            if (
              !(await repository.updateUser(
                userId,
                { authKey: deriveConnectionKey(body.connectionCode) },
                {
                  actor: session.username,
                  action: 'user.credential.rotate',
                  targetType: 'sync_user',
                  targetId: userId,
                },
              ))
            ) {
              throw new AppError(404, 'USER_NOT_FOUND', 'User was not found')
            }
            return reply.status(204).send()
          },
        )

        protectedApi.get('/users/:userId/devices', async (request) => {
          const { userId } = userParamsSchema.parse(request.params)
          await requireUser(repository, userId)
          return { data: await repository.listDevices(userId) }
        })

        protectedApi.delete(
          '/users/:userId/devices/:clientId',
          async (request, reply) => {
            const session = sessionFor(sessions, request)
            const { userId, clientId } = deviceParamsSchema.parse(
              request.params,
            )
            await requireUser(repository, userId)
            await dependencies.registry.closeDevice(userId, clientId)
            await repository.revokeDevice(userId, clientId, {
              actor: session.username,
              action: 'device.revoke',
              targetType: 'device',
              targetId: clientId,
              metadata: { userId },
            })
            return reply.status(204).send()
          },
        )

        protectedApi.get(
          '/users/:userId/sync-domains/:domain/snapshots',
          async (request) => {
            const { userId, domain } = snapshotListParamsSchema.parse(
              request.params,
            )
            const { limit } = snapshotQuerySchema.parse(request.query)
            await requireUser(repository, userId)
            return {
              data: await repository.listSnapshots(userId, domain, limit),
            }
          },
        )

        protectedApi.post(
          '/users/:userId/sync-domains/:domain/snapshots/:snapshotId/restorations',
          async (request, reply) => {
            const session = sessionFor(sessions, request)
            const { userId, domain, snapshotId } = snapshotParamsSchema.parse(
              request.params,
            )
            await requireUser(repository, userId)
            await dependencies.registry.closeUser(userId)
            if (
              !(await repository.restoreSnapshot(userId, domain, snapshotId, {
                actor: session.username,
                action: 'snapshot.restore',
                targetType: 'snapshot',
                targetId: snapshotId,
                metadata: { userId, domain },
              }))
            ) {
              throw new AppError(
                404,
                'SNAPSHOT_NOT_FOUND',
                'Snapshot was not found',
              )
            }
            reply.header(
              'Location',
              `/api/v1/users/${userId}/sync-domains/${domain}/snapshots/${snapshotId}`,
            )
            return reply.status(201).send({ snapshotId })
          },
        )

        protectedApi.get('/audit-events', async (request) => {
          const { limit } = auditQuerySchema.parse(request.query)
          return { data: await repository.listAudit(limit) }
        })
      })
    },
    { prefix: '/api/v1' },
  )

  const webRoot = config.WEB_DIST_PATH
    ? path.resolve(config.WEB_DIST_PATH)
    : fileURLToPath(new URL('../../../web/dist', import.meta.url))
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot })
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/health/')) {
      sendProblem(
        reply,
        request,
        404,
        'ROUTE_NOT_FOUND',
        'Not Found',
        'Route was not found',
      )
      return
    }
    if (
      request.method === 'GET' &&
      existsSync(path.join(webRoot, 'index.html'))
    ) {
      return reply.type('text/html').sendFile('index.html')
    }
    return reply.status(404).type('text/plain').send('Not Found')
  })

  return app
}

function sessionFor(
  sessions: WeakMap<FastifyRequest, SessionContext>,
  request: FastifyRequest,
): SessionContext {
  const session = sessions.get(request)
  if (!session) throw new AppError(401, 'AUTH_INVALID', 'Authentication failed')
  return session
}

function withSyncPath<T extends { id: string }>(user: T, config: AppConfig) {
  return {
    ...user,
    syncPath: syncPathForUser(config.SYNC_BASE_PATH, user.id),
  }
}

async function requireUser(
  repository: AppDependencies['repository'],
  userId: string,
): Promise<void> {
  if (!(await repository.getUserSummary(userId)))
    throw new AppError(404, 'USER_NOT_FOUND', 'User was not found')
}

function cookieOptions(config: AppConfig, maxAge?: number) {
  return {
    path: '/api/v1',
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    ...(maxAge === undefined ? {} : { maxAge }),
  }
}

function sendProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  title: string,
  detail: string,
): void {
  void reply.status(status).type('application/problem+json').send({
    type: 'about:blank',
    title,
    status,
    code,
    detail,
    requestId: request.id,
  })
}

function problemTitle(status: number): string {
  if (status === 400) return 'Bad Request'
  if (status === 401) return 'Unauthorized'
  if (status === 403) return 'Forbidden'
  if (status === 404) return 'Not Found'
  if (status === 409) return 'Conflict'
  if (status === 429) return 'Too Many Requests'
  return status >= 500 ? 'Internal Server Error' : 'Request Failed'
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  )
}
