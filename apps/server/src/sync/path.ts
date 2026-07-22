const userIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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
  if (pathname === '/' || pathname === '') return { kind: 'root' }
  if (!syncBasePath) return null

  const normalized =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname
  const prefix = `${syncBasePath}/`
  if (!normalized.startsWith(prefix)) return null
  const userId = normalized.slice(prefix.length)
  return userIdPattern.test(userId)
    ? { kind: 'scoped', userId: userId.toLowerCase() }
    : null
}
