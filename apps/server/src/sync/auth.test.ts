import { generateKeyPairSync } from 'node:crypto'
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
      getUser: async () => null,
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

  it('loads only the user selected by a scoped path', async () => {
    const authKey = deriveConnectionKey('connection-code')
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const publicKeyBody = Buffer.from(
      publicKey.export({ format: 'der', type: 'spki' }),
    ).toString('base64')
    const listUsers = vi.fn(async () => [])
    const registeredUsers: string[] = []
    const repository: AuthRepository = {
      getDevice: async () => null,
      getUser: async (userId) =>
        userId === 'user-b'
          ? {
              id: 'user-b',
              name: 'User B',
              authKey,
              enabled: true,
              maxSnapshots: 10,
              addMusicLocationType: 'bottom',
            }
          : null,
      touchDevice: async () => false,
      getEnabledUsersForAuthentication: listUsers,
      registerDevice: async (input) => {
        registeredUsers.push(input.userId)
      },
    }
    const service = new LxAuthService(repository, 'LX Sync')
    const encryptedMessage = encryptProtocolMessage(
      [LX_SYNC.authMessagePrefix, publicKeyBody, 'Scoped Device'].join('\n'),
      authKey,
    )

    await expect(
      service.authenticateHttp({
        ip: 'scoped-client',
        encryptedMessage,
        userId: 'user-b',
      }),
    ).resolves.toMatchObject({ statusCode: 200 })
    expect(listUsers).not.toHaveBeenCalled()
    expect(registeredUsers).toEqual(['user-b'])
  })

  it('rejects a registered device on another user path', async () => {
    const key = Buffer.alloc(16, 7).toString('base64')
    let touches = 0
    const repository: AuthRepository = {
      getDevice: async () => ({
        clientId: 'device-a',
        userId: 'user-a',
        userName: 'User A',
        key,
        deviceName: 'Device A',
        isMobile: false,
      }),
      getUser: async () => null,
      touchDevice: async () => {
        touches += 1
        return true
      },
      getEnabledUsersForAuthentication: async () => [],
      registerDevice: async () => {},
    }
    const service = new LxAuthService(repository, 'LX Sync')
    const encryptedMessage = encryptProtocolMessage(
      `${LX_SYNC.authMessagePrefix}Device A`,
      key,
    )
    const token = encryptProtocolMessage(LX_SYNC.connectMessage, key)

    await expect(
      service.authenticateHttp({
        ip: 'http-client',
        encryptedMessage,
        clientId: 'device-a',
        userId: 'user-b',
      }),
    ).resolves.toMatchObject({ statusCode: 401 })
    await expect(
      service.authenticateUpgrade({
        ip: 'ws-client',
        clientId: 'device-a',
        token,
        userId: 'user-b',
      }),
    ).resolves.toBeNull()
    await expect(
      service.authenticateUpgrade({
        ip: 'root-client',
        clientId: 'device-a',
        token,
      }),
    ).resolves.toMatchObject({ userId: 'user-a' })
    expect(touches).toBe(1)
  })
})
