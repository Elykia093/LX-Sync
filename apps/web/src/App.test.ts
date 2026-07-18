import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { applyLoggedOutState, queryKeys, sessionLoginError } from './App.js'
import { ApiError, type Session, shouldExpireSession } from './api.js'

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
