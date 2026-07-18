import { describe, expect, it } from 'vitest'
import { resolveSyncPath, syncPathForUser } from './path.js'

const userId = '00000000-0000-4000-8000-000000000001'

describe('synchronization paths', () => {
  it('keeps the root WebSocket path available with or without scoping', () => {
    expect(resolveSyncPath('/', undefined)).toEqual({ kind: 'root' })
    expect(resolveSyncPath('/', '/base')).toEqual({ kind: 'root' })
  })

  it('recognizes only valid scoped user paths', () => {
    expect(resolveSyncPath(`/base/${userId}`, '/base')).toEqual({
      kind: 'scoped',
      userId,
    })
    expect(resolveSyncPath(`/base/${userId.toUpperCase()}`, '/base')).toEqual({
      kind: 'scoped',
      userId,
    })
    expect(resolveSyncPath(`/base/${userId}/`, '/base')).toEqual({
      kind: 'scoped',
      userId,
    })
    expect(resolveSyncPath('/base/not-a-user', '/base')).toBeNull()
    expect(resolveSyncPath(`/other/${userId}`, '/base')).toBeNull()
    expect(resolveSyncPath(`/base/${userId}`, undefined)).toBeNull()
  })

  it('returns a per-user path only when the feature is enabled', () => {
    expect(syncPathForUser('/base', userId)).toBe(`/base/${userId}`)
    expect(syncPathForUser(undefined, userId)).toBeNull()
  })
})
