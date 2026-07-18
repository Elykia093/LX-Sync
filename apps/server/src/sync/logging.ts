import { sha256 } from '../security/crypto.js'
import type { SyncConnection } from './types.js'

export interface SyncLogger {
  debug: (bindings: Record<string, unknown>, message: string) => void
  info: (bindings: Record<string, unknown>, message: string) => void
  warn: (bindings: Record<string, unknown>, message: string) => void
}

export function deviceLogReference(clientId: string): string {
  return opaqueLogReference(clientId)
}

export function userLogReference(userId: string): string {
  return opaqueLogReference(userId)
}

export function snapshotLogReference(snapshotId: string): string {
  return opaqueLogReference(snapshotId)
}

export function syncErrorLogContext(error: unknown) {
  return {
    errorType: error instanceof Error ? error.name : 'UnknownError',
  }
}

export function syncLogContext(connection: SyncConnection) {
  return {
    connectionId: connection.connectionId,
    pathMode: connection.pathMode,
    userRef: userLogReference(connection.user.id),
    deviceRef: deviceLogReference(connection.device.clientId),
  }
}

function opaqueLogReference(value: string): string {
  return sha256(value).slice(0, 12)
}
