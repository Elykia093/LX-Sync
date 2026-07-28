import { z } from 'zod'

const timestampSchema = z.iso.datetime()
const sessionSchema = z.object({
  username: z.string(),
  expiresAt: timestampSchema,
})
const statusSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  startedAt: timestampSchema,
  onlineDevices: z.number(),
  syncBasePath: z.string().nullable().default(null),
})
const userSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  enabled: z.boolean(),
  maxSnapshots: z.number(),
  addMusicLocationType: z.enum(['top', 'bottom']),
  deviceCount: z.number(),
  createdAt: timestampSchema,
  syncPath: z.string().nullable().default(null),
})
const deviceSchema = z.object({
  clientId: z.string(),
  deviceName: z.string(),
  isMobile: z.boolean(),
  lastConnectAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
})
const snapshotSchema = z.object({
  id: z.string().uuid(),
  hash: z.string(),
  itemCount: z.number(),
  byteSize: z.number(),
  sourceDeviceId: z.string().nullable(),
  createdAt: timestampSchema,
})
const playlistSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['default', 'love', 'user']),
  songCount: z.number().int().min(0),
})
const playlistSongSchema = z.object({
  id: z.union([z.string(), z.number()]),
  position: z.number().int().min(1),
  name: z.string().nullable(),
  singer: z.string().nullable(),
  albumName: z.string().nullable(),
  source: z.string().nullable(),
  interval: z.string().nullable(),
})
const playlistListSchema = z.object({
  snapshotId: z.string().uuid(),
  snapshotCreatedAt: timestampSchema,
  data: z.array(playlistSummarySchema),
})
const playlistDetailSchema = z.object({
  snapshotId: z.string().uuid(),
  snapshotCreatedAt: timestampSchema,
  playlist: playlistSummarySchema,
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).max(100),
  total: z.number().int().min(0),
  data: z.array(playlistSongSchema),
})
const playlistMutationSchema = z.object({
  snapshotId: z.string().uuid(),
  snapshotCreatedAt: timestampSchema,
})
const playlistUpsertSchema = playlistMutationSchema.extend({
  playlist: playlistSummarySchema,
})
const playlistSongMutationSchema = playlistMutationSchema.extend({
  affectedSongCount: z.number().int().min(0),
})
const managedSongSourceSchema = z.enum(['kw', 'kg', 'tx', 'wy', 'mg'])
const auditEventSchema = z.object({
  id: z.string(),
  actor: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: timestampSchema,
})
const problemSchema = z.object({
  status: z.number(),
  code: z.string(),
  detail: z.string(),
  requestId: z.string().optional(),
})

export type Session = z.infer<typeof sessionSchema>
export type ServerStatus = z.infer<typeof statusSchema>
export type SyncUser = z.infer<typeof userSchema>
export type Device = z.infer<typeof deviceSchema>
export type Snapshot = z.infer<typeof snapshotSchema>
export type PlaylistSummary = z.infer<typeof playlistSummarySchema>
export type PlaylistSong = z.infer<typeof playlistSongSchema>
export type PlaylistList = z.infer<typeof playlistListSchema>
export type PlaylistDetail = z.infer<typeof playlistDetailSchema>
export type AuditEvent = z.infer<typeof auditEventSchema>
export type ManagedSongSource = z.infer<typeof managedSongSourceSchema>

export interface AddPlaylistSongInput {
  id: string | number
  source: ManagedSongSource
  name: string
  singer: string
  albumName?: string
  interval?: string | null
  expectedSnapshotId: string
}

export interface PlaylistSongQuery {
  snapshotId: string
  q: string
  source?: ManagedSongSource | ''
  singer?: string
  albumName?: string
  offset: number
  limit: number
}

export const parseServerStatus = (value: unknown): ServerStatus =>
  statusSchema.parse(value)
export const parseSyncUser = (value: unknown): SyncUser =>
  userSchema.parse(value)
export const parsePlaylistDetail = (value: unknown): PlaylistDetail =>
  playlistDetailSchema.parse(value)

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export const sessionExpiredEventName = 'lx-sync:session-expired'

export function shouldExpireSession(path: string, error: ApiError): boolean {
  return path !== '/auth/login' && error.status === 401
}

function notifySessionExpired(path: string, error: ApiError): void {
  if (typeof window === 'undefined' || !shouldExpireSession(path, error)) return
  window.dispatchEvent(new Event(sessionExpiredEventName))
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      ...(init?.body === undefined
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const error = await responseError(response)
    notifySessionExpired(path, error)
    throw error
  }
  return schema.parse(await response.json())
}

async function requestVoid(path: string, init: RequestInit): Promise<void> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      ...(init.body === undefined
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
  if (!response.ok) {
    const error = await responseError(response)
    notifySessionExpired(path, error)
    throw error
  }
}

async function responseError(response: Response): Promise<ApiError> {
  const raw: unknown = await response.json().catch(() => null)
  const problem = problemSchema.safeParse(raw)
  return problem.success
    ? new ApiError(
        response.status,
        problem.data.code,
        problem.data.detail,
        problem.data.requestId,
      )
    : new ApiError(
        response.status,
        'HTTP_ERROR',
        `请求失败（HTTP ${response.status}）`,
      )
}

const json = (value: unknown) => JSON.stringify(value)
const encoded = (value: string) => encodeURIComponent(value)

export function snapshotExportPath(
  userId: string,
  domain: 'list' | 'dislike',
  snapshotId: string,
): string {
  return `/api/v1/users/${encoded(userId)}/sync-domains/${domain}/snapshots/${encoded(snapshotId)}/export`
}

export function playlistDetailPath(
  userId: string,
  playlistId: string,
  query: PlaylistSongQuery,
): string {
  const search = new URLSearchParams()
  search.set('snapshotId', query.snapshotId)
  if (query.q !== '') search.set('q', query.q)
  if (query.source) search.set('source', query.source)
  if (query.singer) search.set('singer', query.singer)
  if (query.albumName) search.set('albumName', query.albumName)
  search.set('offset', String(query.offset))
  search.set('limit', String(query.limit))
  return `/users/${encoded(userId)}/playlists/${encoded(playlistId)}?${search.toString()}`
}

export const api = {
  session: () => request('/auth/session', sessionSchema),
  login: (input: { username: string; password: string }) =>
    request('/auth/login', sessionSchema, {
      method: 'POST',
      body: json(input),
    }),
  logout: () => requestVoid('/auth/logout', { method: 'POST' }),
  status: () => request('/status', statusSchema),
  users: () => request('/users', z.object({ data: z.array(userSchema) })),
  createUser: (input: {
    name: string
    connectionCode: string
    maxSnapshots?: number
    addMusicLocationType: 'top' | 'bottom'
  }) => request('/users', userSchema, { method: 'POST', body: json(input) }),
  updateUser: (
    userId: string,
    input: {
      enabled: boolean
      maxSnapshots: number
      addMusicLocationType: 'top' | 'bottom'
    },
  ) =>
    request(`/users/${encoded(userId)}`, userSchema, {
      method: 'PATCH',
      body: json(input),
    }),
  rotateCredential: (userId: string, connectionCode: string) =>
    requestVoid(`/users/${encoded(userId)}/connection-credential`, {
      method: 'PUT',
      body: json({ connectionCode }),
    }),
  devices: (userId: string) =>
    request(
      `/users/${encoded(userId)}/devices`,
      z.object({ data: z.array(deviceSchema) }),
    ),
  revokeDevice: (userId: string, clientId: string) =>
    requestVoid(`/users/${encoded(userId)}/devices/${encoded(clientId)}`, {
      method: 'DELETE',
    }),
  playlists: (userId: string) =>
    request(`/users/${encoded(userId)}/playlists`, playlistListSchema),
  playlistSongs: (
    userId: string,
    playlistId: string,
    query: PlaylistSongQuery,
  ) =>
    request(
      playlistDetailPath(userId, playlistId, query),
      playlistDetailSchema,
    ),
  createPlaylist: (
    userId: string,
    input: { name: string; expectedSnapshotId: string },
  ) =>
    request(`/users/${encoded(userId)}/playlists`, playlistUpsertSchema, {
      method: 'POST',
      body: json(input),
    }),
  renamePlaylist: (
    userId: string,
    playlistId: string,
    input: { name: string; expectedSnapshotId: string },
  ) =>
    request(
      `/users/${encoded(userId)}/playlists/${encoded(playlistId)}`,
      playlistUpsertSchema,
      { method: 'PATCH', body: json(input) },
    ),
  deletePlaylist: (
    userId: string,
    playlistId: string,
    expectedSnapshotId: string,
  ) =>
    request(
      `/users/${encoded(userId)}/playlists/${encoded(playlistId)}`,
      playlistMutationSchema,
      { method: 'DELETE', body: json({ expectedSnapshotId }) },
    ),
  addPlaylistSong: (
    userId: string,
    playlistId: string,
    input: AddPlaylistSongInput,
  ) =>
    request(
      `/users/${encoded(userId)}/playlists/${encoded(playlistId)}/songs`,
      playlistSongMutationSchema,
      { method: 'POST', body: json(input) },
    ),
  removePlaylistSongs: (
    userId: string,
    playlistId: string,
    input: {
      songIds: Array<string | number>
      expectedSnapshotId: string
    },
  ) =>
    request(
      `/users/${encoded(userId)}/playlists/${encoded(playlistId)}/songs`,
      playlistSongMutationSchema,
      { method: 'DELETE', body: json(input) },
    ),
  movePlaylistSongs: (
    userId: string,
    playlistId: string,
    input: {
      targetPlaylistId: string
      songIds: Array<string | number>
      expectedSnapshotId: string
    },
  ) =>
    request(
      `/users/${encoded(userId)}/playlists/${encoded(playlistId)}/song-moves`,
      playlistSongMutationSchema,
      { method: 'POST', body: json(input) },
    ),
  copyPlaylistSongs: (
    userId: string,
    playlistId: string,
    input: {
      targetPlaylistId: string
      songIds: Array<string | number>
      expectedSnapshotId: string
    },
  ) =>
    request(
      `/users/${encoded(userId)}/playlists/${encoded(playlistId)}/song-copies`,
      playlistSongMutationSchema,
      { method: 'POST', body: json(input) },
    ),
  snapshots: (userId: string, domain: 'list' | 'dislike') =>
    request(
      `/users/${encoded(userId)}/sync-domains/${domain}/snapshots`,
      z.object({ data: z.array(snapshotSchema) }),
    ),
  snapshotExportPath,
  restoreSnapshot: (
    userId: string,
    domain: 'list' | 'dislike',
    snapshotId: string,
  ) =>
    request(
      `/users/${encoded(userId)}/sync-domains/${domain}/snapshots/${encoded(snapshotId)}/restorations`,
      z.object({ snapshotId: z.string().uuid() }),
      { method: 'POST' },
    ),
  auditEvents: () =>
    request('/audit-events', z.object({ data: z.array(auditEventSchema) })),
}
