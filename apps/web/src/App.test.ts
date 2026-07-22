import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import {
  applyLoggedOutState,
  queryKeys,
  sessionLoginError,
  syncAddress,
} from './App.js'
import {
  ApiError,
  parseServerStatus,
  parseSyncUser,
  type Session,
  shouldExpireSession,
} from './api.js'

describe('applyLoggedOutState', () => {
  it('removes protected cache data and exposes an explicit logged-out state', () => {
    const queryClient = new QueryClient()
    const session: Session = {
      username: 'admin',
      expiresAt: '2026-07-18T00:00:00.000Z',
    }
    queryClient.setQueryData(queryKeys.session, session)
    queryClient.setQueryData(queryKeys.users, { data: [{ id: 'private' }] })

    applyLoggedOutState(queryClient)

    expect(queryClient.getQueryData(queryKeys.session)).toBeNull()
    expect(queryClient.getQueryData(queryKeys.users)).toBeUndefined()
  })

  it('uses the login surface for unauthenticated or unavailable sessions', () => {
    const unauthorized = new ApiError(401, 'AUTH_INVALID', 'Unauthorized')
    const badGateway = new ApiError(502, 'HTTP_ERROR', 'Bad Gateway')
    const unavailable = new ApiError(503, 'HTTP_ERROR', 'Unavailable')

    expect(sessionLoginError(unauthorized)).toBe(unauthorized)
    expect(sessionLoginError(badGateway)).toBe(badGateway)
    expect(sessionLoginError(unavailable)).toBe(unavailable)
    expect(
      sessionLoginError(new ApiError(500, 'INTERNAL_ERROR', 'Failed')),
    ).toBeNull()
    expect(sessionLoginError(new Error('Network failed'))).toBeNull()
  })

  it('expires cached sessions only for protected unauthorized requests', () => {
    const unauthorized = new ApiError(401, 'AUTH_INVALID', 'Unauthorized')
    const forbidden = new ApiError(403, 'ORIGIN_INVALID', 'Forbidden')

    expect(shouldExpireSession('/status', unauthorized)).toBe(true)
    expect(shouldExpireSession('/auth/session', unauthorized)).toBe(true)
    expect(shouldExpireSession('/auth/login', unauthorized)).toBe(false)
    expect(shouldExpireSession('/status', forbidden)).toBe(false)
  })
})

describe('syncAddress', () => {
  it('uses a scoped path when present and preserves the root fallback', () => {
    expect(
      syncAddress(
        'https://sync.example.test',
        '/base/00000000-0000-4000-8000-000000000001',
      ),
    ).toBe(
      'https://sync.example.test/base/00000000-0000-4000-8000-000000000001',
    )
    expect(syncAddress('https://sync.example.test', null)).toBe(
      'https://sync.example.test',
    )
  })

  it('treats scoped path fields omitted by an older server as disabled', () => {
    expect(
      parseServerStatus({
        serverId: 'server',
        serverName: 'LX Sync',
        startedAt: '2026-07-18T00:00:00.000Z',
        onlineDevices: 0,
      }).syncBasePath,
    ).toBeNull()
    expect(
      parseSyncUser({
        id: '00000000-0000-4000-8000-000000000001',
        name: 'User',
        enabled: true,
        maxSnapshots: 10,
        addMusicLocationType: 'bottom',
        deviceCount: 0,
        createdAt: '2026-07-18T00:00:00.000Z',
      }).syncPath,
    ).toBeNull()
  })
})
