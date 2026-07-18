import { afterEach, describe, expect, it, vi } from 'vitest'
import { LX_SYNC } from '../protocol/index.js'
import {
  deriveConnectionKey,
  encryptProtocolMessage,
} from '../security/crypto.js'
import { AttemptLimiter, type AuthRepository, LxAuthService } from './auth.js'

afterEach(() => vi.useRealTimers())

describe('AttemptLimiter', () => {
  it('blocks at the configured limit and resets after the window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const limiter = new AttemptLimiter(2, 1_000)

    limiter.recordFailure('client')
    expect(limiter.isAllowed('client')).toBe(true)
    limiter.recordFailure('client')
    expect(limiter.isAllowed('client')).toBe(false)

    vi.setSystemTime(1_000)
    expect(limiter.isAllowed('client')).toBe(true)
  })

  it('bounds tracked keys under high-cardinality input', () => {
    const limiter = new AttemptLimiter(1, 60_000, 2)
    limiter.recordFailure('first')
    limiter.recordFailure('second')
    limiter.recordFailure('third')

    expect(limiter.isAllowed('first')).toBe(true)
    expect(limiter.isAllowed('second')).toBe(false)
    expect(limiter.isAllowed('third')).toBe(false)
  })
})

describe('LX device registration', () => {
  it('validates the RSA public key before reserving a device slot', async () => {
    const authKey = deriveConnectionKey('connection-code')
    let registrationCount = 0
    const repository: AuthRepository = {
      getDevice: async () => null,
      touchDevice: async () => false,
      getEnabledUsersForAuthentication: async () => [
        {
          id: 'user-id',
          name: 'User',
          authKey,
          enabled: true,
          maxSnapshots: 10,
          addMusicLocationType: 'bottom',
        },
      ],
      registerDevice: async () => {
        registrationCount += 1
      },
    }
    const service = new LxAuthService(repository, 'LX Sync')
    const encryptedMessage = encryptProtocolMessage(
      `${LX_SYNC.authMessagePrefix}\nQUJD\nDevice`,
      authKey,
    )

    await expect(
      service.authenticateHttp({ ip: 'client', encryptedMessage }),
    ).resolves.toEqual({
      statusCode: 401,
      body: LX_SYNC.authFailedMessage,
    })
    expect(registrationCount).toBe(0)
  })
})
