const userIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const socketPath = '/socket'

export type SyncPathScope =
  | { kind: 'root' }
  | { kind: 'scoped'; userId: string }

export function syncPathForUser(
  syncBasePath: string | undefined,
  userId: string,
): string | null {
  return syncBasePath ? `${syncBasePath}/${userId}` : null
}

export function resolveSyncPath(
  pathname: string,
  syncBasePath: string | undefined,
): SyncPathScope | null {
  const normalized =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname

  if (normalized === '' || normalized === '/' || normalized === socketPath)
    return { kind: 'root' }
  if (!syncBasePath) return null

  const scopedPath = normalized.endsWith(socketPath)
    ? normalized.slice(0, -socketPath.length)
    : normalized
  const prefix = `${syncBasePath}/`
  if (!scopedPath.startsWith(prefix)) return null
  const userId = scopedPath.slice(prefix.length)
  return userIdPattern.test(userId)
    ? { kind: 'scoped', userId: userId.toLowerCase() }
    : null
}
