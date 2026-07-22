import { randomBytes } from 'node:crypto'
import type { DeviceRecord, Repository } from '../db/repository.js'
import { LX_SYNC } from '../protocol/index.js'
import {
  decryptProtocolMessage,
  encryptForPublicKey,
  encryptProtocolMessage,
} from '../security/crypto.js'

export type AuthRepository = Pick<
  Repository,
  | 'getDevice'
  | 'getUser'
  | 'touchDevice'
  | 'getEnabledUsersForAuthentication'
  | 'registerDevice'
>

interface AttemptState {
  count: number
  resetAt: number
}

export class AttemptLimiter {
  private readonly states = new Map<string, AttemptState>()

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 5 * 60_000,
    private readonly maxKeys = 10_000,
  ) {}

  isAllowed(key: string): boolean {
    const now = Date.now()
    const state = this.states.get(key)
    if (!state || state.resetAt <= now) return true
    return state.count < this.limit
  }

  recordFailure(key: string): void {
    const now = Date.now()
    const state = this.states.get(key)
    if (!state || state.resetAt <= now) {
      this.removeExpired(now)
      if (!this.states.has(key) && this.states.size >= this.maxKeys)
        this.removeEarliestExpiry()
      this.states.set(key, { count: 1, resetAt: now + this.windowMs })
    } else state.count += 1
  }

  clear(key: string): void {
    this.states.delete(key)
  }

  private removeExpired(now: number): void {
    for (const [key, state] of this.states) {
      if (state.resetAt <= now) this.states.delete(key)
    }
  }

  private removeEarliestExpiry(): void {
    let earliestKey: string | undefined
    let earliestReset = Number.POSITIVE_INFINITY
    for (const [key, state] of this.states) {
      if (state.resetAt < earliestReset) {
        earliestKey = key
        earliestReset = state.resetAt
      }
    }
    if (earliestKey !== undefined) this.states.delete(earliestKey)
  }
}

export interface ProtocolAuthResult {
  statusCode: 200 | 401 | 403
  body: string
}

export class LxAuthService {
  private readonly limiter = new AttemptLimiter()

  constructor(
    private readonly repository: AuthRepository,
    private readonly serverName: string,
  ) {}

  async authenticateHttp(input: {
    ip: string
    encryptedMessage?: string
    clientId?: string
    userId?: string
  }): Promise<ProtocolAuthResult> {
    if (!this.limiter.isAllowed(input.ip))
      return { statusCode: 403, body: LX_SYNC.blockedIpMessage }
    if (!input.encryptedMessage || input.encryptedMessage.length > 16_384)
      return this.failed(input.ip)

    if (input.clientId) {
      const device = await this.repository.getDevice(input.clientId)
      if (!device || (input.userId && device.userId !== input.userId))
        return this.failed(input.ip)
      try {
        const text = decryptProtocolMessage(input.encryptedMessage, device.key)
        if (!text.startsWith(LX_SYNC.authMessagePrefix))
          return this.failed(input.ip)
        const deviceName =
          text.slice(LX_SYNC.authMessagePrefix.length).trim().slice(0, 128) ||
          'Unknown'
        await this.repository.touchDevice(device.clientId, deviceName)
        this.limiter.clear(input.ip)
        return {
          statusCode: 200,
          body: encryptProtocolMessage(LX_SYNC.helloMessage, device.key),
        }
      } catch {
        return this.failed(input.ip)
      }
    }

    const users = input.userId
      ? await this.repository
          .getUser(input.userId)
          .then((user) => (user?.enabled ? [user] : []))
      : await this.repository.getEnabledUsersForAuthentication()
    for (const user of users) {
      let text: string
      try {
        text = decryptProtocolMessage(input.encryptedMessage, user.authKey)
      } catch {
        continue
      }
      if (!text.startsWith(LX_SYNC.authMessagePrefix)) continue
      const lines = text.split('\n')
      const publicKeyBody = lines[1]
      if (
        !publicKeyBody ||
        publicKeyBody.length > 2_048 ||
        !/^[A-Za-z0-9+/=]+$/.test(publicKeyBody)
      )
        return this.failed(input.ip)
      const deviceName =
        (lines[2] ?? 'Unknown').trim().slice(0, 128) || 'Unknown'
      const isMobile = lines[3] === 'lx_music_mobile'
      const clientId = randomBytes(16).toString('base64')
      const key = randomBytes(16).toString('base64')
      try {
        const publicKey = `-----BEGIN PUBLIC KEY-----\n${publicKeyBody}\n-----END PUBLIC KEY-----`
        const body = encryptForPublicKey(
          Buffer.from(
            JSON.stringify({ clientId, key, serverName: this.serverName }),
          ),
          publicKey,
        )
        await this.repository.registerDevice({
          userId: user.id,
          clientId,
          key,
          deviceName,
          isMobile,
        })
        this.limiter.clear(input.ip)
        return { statusCode: 200, body }
      } catch {
        return this.failed(input.ip)
      }
    }
    return this.failed(input.ip)
  }

  async authenticateUpgrade(input: {
    ip: string
    clientId: string | null
    token: string | null
    userId?: string
  }): Promise<DeviceRecord | null> {
    if (
      !this.limiter.isAllowed(input.ip) ||
      !input.clientId ||
      !input.token ||
      input.token.length > 16_384
    )
      return null
    const device = await this.repository.getDevice(input.clientId)
    if (!device || (input.userId && device.userId !== input.userId)) return null
    try {
      if (
        decryptProtocolMessage(input.token, device.key) !==
        LX_SYNC.connectMessage
      )
        throw new Error('Invalid token')
      this.limiter.clear(input.ip)
      await this.repository.touchDevice(device.clientId)
      return device
    } catch {
      this.limiter.recordFailure(input.ip)
      return null
    }
  }

  private failed(ip: string): ProtocolAuthResult {
    this.limiter.recordFailure(ip)
    return { statusCode: 401, body: LX_SYNC.authFailedMessage }
  }
}
