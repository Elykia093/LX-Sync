import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  publicEncrypt,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)
const maxWireMessageBytes = 8 * 1024 * 1024

export function md5(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function randomSessionId(): string {
  return randomBytes(32).toString('base64url')
}

export function deriveConnectionKey(connectionCode: string): string {
  return Buffer.from(md5(connectionCode).slice(0, 16)).toString('base64')
}

export function encryptProtocolMessage(
  value: string | Buffer,
  base64Key: string,
): string {
  const cipher = createCipheriv(
    'aes-128-ecb',
    Buffer.from(base64Key, 'base64'),
    null,
  )
  return Buffer.concat([cipher.update(value), cipher.final()]).toString(
    'base64',
  )
}

export function decryptProtocolMessage(
  value: string,
  base64Key: string,
): string {
  const decipher = createDecipheriv(
    'aes-128-ecb',
    Buffer.from(base64Key, 'base64'),
    null,
  )
  return Buffer.concat([
    decipher.update(Buffer.from(value, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

export function encryptForPublicKey(value: Buffer, publicKey: string): string {
  return publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING },
    value,
  ).toString('base64')
}

export function encryptAtRest(value: string, base64MasterKey: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(base64MasterKey, 'base64'),
    iv,
  )
  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.')
}

export function decryptAtRest(value: string, base64MasterKey: string): string {
  const [version, iv, tag, encrypted] = value.split('.')
  if (version !== 'v1' || !iv || !tag || encrypted == null)
    throw new Error('Unsupported encrypted value')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(base64MasterKey, 'base64'),
    Buffer.from(iv, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

export function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  )
}

export async function encodeWireMessage(message: string): Promise<string> {
  if (message.length <= 1024) return message
  return `cg_${(await gzipAsync(message)).toString('base64')}`
}

export async function decodeWireMessage(message: string): Promise<string> {
  if (!message.startsWith('cg_')) return message
  return (
    await gunzipAsync(Buffer.from(message.slice(3), 'base64'), {
      maxOutputLength: maxWireMessageBytes,
    })
  ).toString('utf8')
}
