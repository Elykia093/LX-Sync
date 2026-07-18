import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  decodeWireMessage,
  decryptAtRest,
  deriveConnectionKey,
  encodeWireMessage,
  encryptAtRest,
  randomSessionId,
} from './crypto.js'

describe('cryptographic boundaries', () => {
  it('encrypts stored secrets with authenticated random nonces', () => {
    const key = randomBytes(32).toString('base64')
    const first = encryptAtRest('secret', key)
    const second = encryptAtRest('secret', key)
    expect(first).not.toBe(second)
    expect(decryptAtRest(first, key)).toBe('secret')
    const [version, iv, tag, encrypted] = first.split('.')
    if (!version || !iv || !tag || !encrypted)
      throw new Error('Expected a versioned encrypted value')
    const tamperedTag = `${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`
    expect(() =>
      decryptAtRest([version, iv, tamperedTag, encrypted].join('.'), key),
    ).toThrow()
  })

  it('round-trips compressed wire messages', async () => {
    const message = JSON.stringify({ value: 'x'.repeat(4_096) })
    const encoded = await encodeWireMessage(message)
    expect(encoded.startsWith('cg_')).toBe(true)
    await expect(decodeWireMessage(encoded)).resolves.toBe(message)
  })

  it('rejects compressed messages that expand past 8 MiB', async () => {
    const encoded = await encodeWireMessage('x'.repeat(8 * 1024 * 1024 + 1))
    await expect(decodeWireMessage(encoded)).rejects.toThrow()
  })

  it('derives protocol-sized keys and high-entropy session IDs', () => {
    expect(
      Buffer.from(deriveConnectionKey('connection-code'), 'base64'),
    ).toHaveLength(16)
    expect(randomSessionId()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})
