import { describe, expect, it } from 'vitest'
import {
  deviceLogReference,
  snapshotLogReference,
  syncErrorLogContext,
  syncLogContext,
  userLogReference,
} from './logging.js'
import type { SyncConnection } from './types.js'

describe('synchronization log redaction', () => {
  it('uses a fixed-length device reference instead of the raw identifier', () => {
    const clientId = 'sensitive-device-identifier'
    const reference = deviceLogReference(clientId)

    expect(reference).toMatch(/^[a-f0-9]{12}$/)
    expect(reference).not.toContain(clientId)
  })

  it('redacts user, device, and snapshot identifiers in structured bindings', () => {
    const connection = {
      connectionId: 'connection-1',
      pathMode: 'scoped',
      user: { id: 'sensitive-user-id' },
      device: { clientId: 'sensitive-device-id' },
    } as SyncConnection
    const context = syncLogContext(connection)
    const snapshotRef = snapshotLogReference('sensitive-snapshot-id')

    expect(context).toEqual({
      connectionId: 'connection-1',
      pathMode: 'scoped',
      userRef: userLogReference('sensitive-user-id'),
      deviceRef: deviceLogReference('sensitive-device-id'),
    })
    expect(snapshotRef).toMatch(/^[a-f0-9]{12}$/)
    const serialized = JSON.stringify({ ...context, snapshotRef })
    expect(serialized).not.toContain('sensitive-user-id')
    expect(serialized).not.toContain('sensitive-device-id')
    expect(serialized).not.toContain('sensitive-snapshot-id')
  })

  it('does not serialize client-controlled error details', () => {
    const error = Object.assign(new Error('secret payload'), {
      input: '/?i=device&t=secret-token',
    })

    expect(syncErrorLogContext(error)).toEqual({ errorType: 'Error' })
    expect(JSON.stringify(syncErrorLogContext(error))).not.toContain('secret')
  })
})
