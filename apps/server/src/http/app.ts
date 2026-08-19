import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { ZodError, z } from 'zod'
import type { AppConfig } from '../config.js'
import {
  type Repository,
  SnapshotConflictError,
  type SnapshotRecord,
} from '../db/repository.js'
import { AppError } from '../errors.js'
import { playlistQualities } from '../playlist-quality.js'
import { type ListData, LX_SYNC } from '../protocol/index.js'
import {
  deriveConnectionKey,
  randomSessionId,
  secureEqual,
  sha256,
} from '../security/crypto.js'
import type { LxAuthService } from '../sync/auth.js'
import { AttemptLimiter } from '../sync/auth.js'
import type { ConnectionRegistry } from '../sync/gateway.js'
import type { SyncLogger } from '../sync/logging.js'
import { syncPathForUser } from '../sync/path.js'
import {
  isValidManagedSongId,
  PlaylistManagementService,
} from './playlist-management.js'
import { playlistDetailResponse, playlistSummaryResponse } from './playlists.js'

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
    | 'getPlaylistQualities'
    | 'updateUser'
    | 'listDevices'
    | 'revokeDevice'
    | 'listSnapshots'
    | 'getSnapshot'
    | 'markDeviceSnapshot'
    | 'saveSnapshot'
    | 'restoreSnapshot'
    | 'listAudit'
  > & {
    getHead(domain: 'list', userId: string): Promise<SnapshotRecord<ListData>>
  }
  auth: Pick<LxAuthService, 'authenticateHttp'>
  registry: Pick<
    ConnectionRegistry,
    'count' | 'closeUser' | 'closeDevice' | 'forUser' | 'runExclusive'
  >
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
    connectionCode: z.string().min(1),
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
  .object({ connectionCode: z.string().min(1) })
  .strict()
const canonicalUserIdSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const userParamsSchema = z.object({ userId: canonicalUserIdSchema }).strict()
const syncUserParamsSchema = z
  .object({ userId: canonicalUserIdSchema })
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
const playlistParamsSchema = userParamsSchema
  .extend({ playlistId: z.string().min(1).max(2048) })
  .strict()
const playlistQuerySchema = z
  .object({
    snapshotId: z.string().uuid(),
    q: z.string().max(256).default(''),
    source: z.enum(['kw', 'kg', 'tx', 'wy', 'mg']).optional(),
    singer: z.string().trim().max(256).default(''),
    albumName: z.string().trim().max(256).default(''),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
const playlistNameMutationSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    expectedSnapshotId: z.string().uuid(),
  })
  .strict()
const playlistUpdateMutationSchema = playlistNameMutationSchema
  .extend({ quality: z.enum(playlistQualities).nullable().optional() })
  .strict()
const playlistSnapshotMutationSchema = z
  .object({ expectedSnapshotId: z.string().uuid() })
  .strict()
const playlistSongIdSchema = z.union([
  z.string().min(1).max(1024),
  z.number().finite(),
])
const playlistSongIdsSchema = z
  .array(playlistSongIdSchema)
  .min(1)
  .max(10_000)
  .superRefine((songIds, context) => {
    const seen = new Set<string>()
    for (const songId of songIds) {
      const key = `${typeof songId}:${String(songId)}`
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          message: 'songIds must contain unique values',
        })
        return
      }
      seen.add(key)
    }
  })
const playlistSongsMutationSchema = z
  .object({
    songIds: playlistSongIdsSchema,
    expectedSnapshotId: z.string().uuid(),
  })
  .strict()
const playlistSongTransferSchema = playlistSongsMutationSchema
  .extend({ targetPlaylistId: z.string().min(1).max(2048) })
  .strict()
const managedPlaylistSongSchema = z
  .object({
    id: z.union([
      z
        .string()
        .min(1)
        .max(1024)
        .refine(isValidManagedSongId, 'Invalid platform song ID'),
      z
        .number()
        .int()
        .safe()
        .positive()
        .refine(isValidManagedSongId, 'Invalid platform song ID'),
    ]),
    source: z.enum(['kw', 'kg', 'tx', 'wy', 'mg']),
    name: z.string().trim().min(1).max(256),
    singer: z.string().trim().min(1).max(256),
    albumName: z.string().trim().max(256).default(''),
    interval: z
      .string()
      .regex(/^\d{1,3}:[0-5]\d$/)
      .nullable()
      .default(null),
    expectedSnapshotId: z.string().uuid(),
  })
  .strict()
const auditQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(100) })
  .strict()

export async function buildApp(dependencies: AppDependencies) {
  const { config, repository } = dependencies
  const playlistManagement = new PlaylistManagementService(
    repository,
    dependencies.registry,
  )
  const sessions = new WeakMap<FastifyRequest, SessionContext>()
  const loginLimiter = new AttemptLimiter()
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    connectionTimeout: 10_000,
    requestTimeout: 30_000,
    routerOptions: { maxParamLength: 2048 },
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
      "default-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'",
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
    if (
      hasErrorCode(error, 'FST_ERR_CTP_INVALID_JSON_BODY') ||
      hasErrorCode(error, 'FST_ERR_CTP_EMPTY_JSON_BODY')
    ) {
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
    if (hasErrorCode(error, 'FST_ERR_CTP_BODY_TOO_LARGE')) {
      sendProblem(
        reply,
        request,
        413,
        'PAYLOAD_TOO_LARGE',
        'Payload Too Large',
        'Request body exceeds the allowed size',
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
    if (error instanceof SnapshotConflictError) {
      sendProblem(
        reply,
        request,
        409,
        'SNAPSHOT_CONFLICT',
        'Conflict',
        'Snapshot head changed; refresh and retry',
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

        protectedApi.get('/users/:userId/playlists', async (request) => {
          const { userId } = userParamsSchema.parse(request.params)
          await requireUser(repository, userId)
          const [head, qualities] = await Promise.all([
            repository.getHead('list', userId),
            repository.getPlaylistQualities(userId),
          ])
          return playlistSummaryResponse(head, qualities)
        })

        protectedApi.get(
          '/users/:userId/playlists/:playlistId',
          async (request) => {
            const { userId, playlistId } = playlistParamsSchema.parse(
              request.params,
            )
            const query = playlistQuerySchema.parse(request.query)
            await requireUser(repository, userId)
            const [snapshot, qualities] = await Promise.all([
              repository.getSnapshot(userId, 'list', query.snapshotId),
              repository.getPlaylistQualities(userId),
            ])
            if (!snapshot)
              throw new AppError(
                404,
                'SNAPSHOT_NOT_FOUND',
                'Snapshot was not found',
              )
            const response = playlistDetailResponse(
              snapshot,
              playlistId,
              query,
              qualities,
            )
            if (!response)
              throw new AppError(
                404,
                'PLAYLIST_NOT_FOUND',
                'Playlist was not found',
              )
            return response
          },
        )

        protectedApi.post(
          '/users/:userId/playlists',
          async (request, reply) => {
            const session = sessionFor(sessions, request)
            const { userId } = userParamsSchema.parse(request.params)
            const body = playlistNameMutationSchema.parse(request.body)
            const result = await playlistManagement.create({
              userId,
              actor: session.username,
              name: body.name,
              expectedSnapshotId: body.expectedSnapshotId,
              logger: requestSyncLogger(request),
            })
            reply.header(
              'Location',
              `/api/v1/users/${userId}/playlists/${encodeURIComponent(result.playlist.id)}`,
            )
            return reply.status(201).send(result)
          },
        )

        protectedApi.patch(
          '/users/:userId/playlists/:playlistId',
          async (request) => {
            const session = sessionFor(sessions, request)
            const { userId, playlistId } = playlistParamsSchema.parse(
              request.params,
            )
            const body = playlistUpdateMutationSchema.parse(request.body)
            return playlistManagement.rename({
              userId,
              actor: session.username,
              playlistId,
              name: body.name,
              ...(body.quality === undefined ? {} : { quality: body.quality }),
              expectedSnapshotId: body.expectedSnapshotId,
              logger: requestSyncLogger(request),
            })
          },
        )

        protectedApi.delete(
          '/users/:userId/playlists/:playlistId',
          async (request) => {
            const session = sessionFor(sessions, request)
            const { userId, playlistId } = playlistParamsSchema.parse(
              request.params,
            )
            const body = playlistSnapshotMutationSchema.parse(request.body)
            return playlistManagement.delete({
              userId,
              actor: session.username,
              playlistId,
              expectedSnapshotId: body.expectedSnapshotId,
              logger: requestSyncLogger(request),
            })
          },
        )

        protectedApi.post(
          '/users/:userId/playlists/:playlistId/songs',
          async (request, reply) => {
            const session = sessionFor(sessions, request)
            const { userId, playlistId } = playlistParamsSchema.parse(
              request.params,
            )
            const body = managedPlaylistSongSchema.parse(request.body)
            const result = await playlistManagement.addSong({
              userId,
              actor: session.username,
              playlistId,
              song: {
                id: body.id,
                source: body.source,
                name: body.name,
                singer: body.singer,
                albumName: body.albumName,
                interval: body.interval,
              },
              expectedSnapshotId: body.expectedSnapshotId,
              logger: requestSyncLogger(request),
            })
            reply.header(
              'Location',
              `/api/v1/users/${userId}/playlists/${encodeURIComponent(playlistId)}?snapshotId=${result.snapshotId}`,
            )
            return reply.status(201).send(result)
          },
        )

        protectedApi.delete(
          '/users/:userId/playlists/:playlistId/songs',
          async (request) => {
            const session = sessionFor(sessions, request)
            const { userId, playlistId } = playlistParamsSchema.parse(
              request.params,
            )
            const body = playlistSongsMutationSchema.parse(request.body)
            return playlistManagement.removeSongs({
              userId,
              actor: session.username,
              playlistId,
              songIds: body.songIds,
              expectedSnapshotId: body.expectedSnapshotId,
              logger: requestSyncLogger(request),
            })
          },
        )

        protectedApi.post(
          '/users/:userId/playlists/:playlistId/song-moves',
          async (request) => {
            const session = sessionFor(sessions, request)
            const { userId, playlistId } = playlistParamsSchema.parse(
              request.params,
            )
            const body = playlistSongTransferSchema.parse(request.body)
            return playlistManagement.moveSongs({
              userId,
              actor: session.username,
              playlistId,
              targetPlaylistId: body.targetPlaylistId,
              songIds: body.songIds,
              expectedSnapshotId: body.expectedSnapshotId,
              logger: requestSyncLogger(request),
            })
          },
        )

        protectedApi.post(
          '/users/:userId/playlists/:playlistId/song-copies',
          async (request) => {
            const session = sessionFor(sessions, request)
            const { userId, playlistId } = playlistParamsSchema.parse(
              request.params,
            )
            const body = playlistSongTransferSchema.parse(request.body)
            return playlistManagement.copySongs({
              userId,
              actor: session.username,
              playlistId,
              targetPlaylistId: body.targetPlaylistId,
              songIds: body.songIds,
              expectedSnapshotId: body.expectedSnapshotId,
              logger: requestSyncLogger(request),
            })
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

        protectedApi.get(
          '/users/:userId/sync-domains/:domain/snapshots/:snapshotId/export',
          async (request, reply) => {
            const { userId, domain, snapshotId } = snapshotParamsSchema.parse(
              request.params,
            )
            await requireUser(repository, userId)
            const snapshot = await repository.getSnapshot(
              userId,
              domain,
              snapshotId,
            )
            if (!snapshot)
              throw new AppError(
                404,
                'SNAPSHOT_NOT_FOUND',
                'Snapshot was not found',
              )
            reply
              .type('application/json; charset=utf-8')
              .header(
                'Content-Disposition',
                `attachment; filename="lx-sync-${domain}-${snapshot.id}.json"`,
              )
            return {
              format: 'lx-sync.snapshot',
              version: 1,
              userId,
              domain,
              snapshot: {
                id: snapshot.id,
                hash: snapshot.hash,
                itemCount: snapshot.itemCount,
                byteSize: snapshot.byteSize,
                createdAt: snapshot.createdAt,
                data: snapshot.data,
              },
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
            const restored = await dependencies.registry.runExclusive(
              userId,
              () =>
                repository.restoreSnapshot(userId, domain, snapshotId, {
                  actor: session.username,
                  action: 'snapshot.restore',
                  targetType: 'snapshot',
                  targetId: snapshotId,
                  metadata: { userId, domain },
                }),
            )
            if (!restored) {
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

function requestSyncLogger(request: FastifyRequest): SyncLogger {
  return {
    debug: (bindings, message) => request.log.debug(bindings, message),
    info: (bindings, message) => request.log.info(bindings, message),
    warn: (bindings, message) => request.log.warn(bindings, message),
  }
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
  if (status === 413) return 'Payload Too Large'
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
