import { Buffer } from 'node:buffer'
import type {
  AddMusicLocationType,
  DislikeAction,
  DislikeRules,
  JsonValue,
  ListAction,
  ListData,
  MusicInfo,
  SyncDomain,
  UserListInfo,
  UserListInfoFull,
} from '../protocol/index.js'
import { md5, sha256 } from '../security/crypto.js'

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export const syncLimits = {
  maxJsonDepth: 16,
  maxJsonNodes: 200_000,
  maxIdentifierLength: 1_024,
  maxObjectProperties: 256,
  maxStringLength: 512 * 1_024,
  maxTracks: 10_000,
  maxUserLists: 100,
} as const

export const isBoundedString = (value: unknown): value is string => {
  return typeof value === 'string' && value.length <= syncLimits.maxStringLength
}

export const isBoundedJsonValue = (value: unknown): value is JsonValue => {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || ++nodes > syncLimits.maxJsonNodes) return false
    if (current.value === null || typeof current.value === 'boolean') continue
    if (typeof current.value === 'string') {
      if (!isBoundedString(current.value)) return false
      continue
    }
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) return false
      continue
    }
    if (typeof current.value !== 'object') return false
    if (current.depth >= syncLimits.maxJsonDepth) return false
    if (Array.isArray(current.value)) {
      if (current.value.length > syncLimits.maxJsonNodes) return false
      for (const item of current.value)
        pending.push({ value: item, depth: current.depth + 1 })
    } else if (isRecord(current.value)) {
      const entries = Object.entries(current.value)
      if (entries.length > syncLimits.maxObjectProperties) return false
      for (const [key, item] of entries) {
        if (!isBoundedString(key)) return false
        pending.push({ value: item, depth: current.depth + 1 })
      }
    } else {
      return false
    }
  }
  return true
}

export const isBoundedJsonObject = (
  value: unknown,
): value is Record<string, JsonValue> => {
  return isRecord(value) && isBoundedJsonValue(value)
}

const isMusicInfo = (value: unknown): value is MusicInfo => {
  return (
    isRecord(value) &&
    ((isBoundedString(value.id) &&
      value.id.length > 0 &&
      value.id.length <= syncLimits.maxIdentifierLength) ||
      (typeof value.id === 'number' && Number.isFinite(value.id))) &&
    Object.keys(value).length <= syncLimits.maxObjectProperties &&
    Object.values(value).every(
      (item) => item === undefined || isBoundedJsonValue(item),
    )
  )
}

export const parseUserListInfo = (value: unknown): UserListInfo | null => {
  if (
    !isRecord(value) ||
    !isBoundedJsonObject(value) ||
    !isBoundedString(value.id) ||
    value.id.length === 0 ||
    value.id.length > syncLimits.maxIdentifierLength ||
    !isBoundedString(value.name) ||
    value.name.length > syncLimits.maxIdentifierLength ||
    (value.locationUpdateTime !== undefined &&
      value.locationUpdateTime !== null &&
      (typeof value.locationUpdateTime !== 'number' ||
        !Number.isFinite(value.locationUpdateTime))) ||
    (value.source !== undefined &&
      value.source !== 'kw' &&
      value.source !== 'kg' &&
      value.source !== 'tx' &&
      value.source !== 'wy' &&
      value.source !== 'mg') ||
    (value.sourceListId !== undefined &&
      !(
        (isBoundedString(value.sourceListId) &&
          value.sourceListId.length <= syncLimits.maxIdentifierLength) ||
        (typeof value.sourceListId === 'number' &&
          Number.isFinite(value.sourceListId))
      ))
  )
    return null

  return {
    ...value,
    locationUpdateTime: value.locationUpdateTime ?? null,
    ...(typeof value.sourceListId === 'number'
      ? { sourceListId: String(value.sourceListId) }
      : {}),
  } as UserListInfo
}

const parseUserListInfoFull = (value: unknown): UserListInfoFull | null => {
  const info = parseUserListInfo(value)
  if (
    !info ||
    !isRecord(value) ||
    !Array.isArray(value.list) ||
    value.list.length > syncLimits.maxTracks ||
    !value.list.every(isMusicInfo)
  )
    return null
  return { ...info, list: value.list }
}

export function parseListData(value: unknown): ListData {
  if (!isRecord(value)) throw new Error('Invalid list data')
  if (!isBoundedJsonObject(value)) throw new Error('Invalid list data')
  const defaultList: unknown = value.defaultList ?? []
  const loveList: unknown = value.loveList ?? []
  const userList: unknown = value.userList ?? []
  if (
    !Array.isArray(defaultList) ||
    defaultList.length > syncLimits.maxTracks ||
    !defaultList.every(isMusicInfo)
  )
    throw new Error('Invalid default list')
  if (
    !Array.isArray(loveList) ||
    loveList.length > syncLimits.maxTracks ||
    !loveList.every(isMusicInfo)
  )
    throw new Error('Invalid love list')
  if (!Array.isArray(userList) || userList.length > syncLimits.maxUserLists)
    throw new Error('Invalid user list')
  const normalizedUserList: UserListInfoFull[] = []
  for (const item of userList) {
    const list = parseUserListInfoFull(item)
    if (!list) throw new Error('Invalid user list')
    normalizedUserList.push(list)
  }
  const trackCount = normalizedUserList.reduce(
    (total, list) => total + list.list.length,
    defaultList.length + loveList.length,
  )
  if (trackCount > syncLimits.maxTracks)
    throw new Error('List data exceeds the track limit')
  return { defaultList, loveList, userList: normalizedUserList }
}

export function parseSnapshot(domain: 'list', payload: string): ListData
export function parseSnapshot(domain: 'dislike', payload: string): DislikeRules
export function parseSnapshot(
  domain: SyncDomain,
  payload: string,
): ListData | DislikeRules {
  if (domain === 'dislike') return payload
  return parseListData(JSON.parse(payload) as unknown)
}

export interface SerializedSnapshot {
  payload: string
  hash: string
  contentHash: string
  itemCount: number
  byteSize: number
}

export function serializeSnapshot(
  domain: 'list',
  data: ListData,
): SerializedSnapshot
export function serializeSnapshot(
  domain: 'dislike',
  data: DislikeRules,
): SerializedSnapshot
export function serializeSnapshot(
  domain: SyncDomain,
  data: ListData | DislikeRules,
): SerializedSnapshot {
  if (domain === 'list') {
    if (typeof data === 'string')
      throw new Error('List snapshot must be an object')
    const payload = JSON.stringify(data)
    return {
      payload,
      hash: md5(payload),
      contentHash: sha256(payload),
      itemCount:
        data.defaultList.length +
        data.loveList.length +
        data.userList.reduce((total, list) => total + list.list.length, 0),
      byteSize: Buffer.byteLength(payload),
    }
  }
  if (typeof data !== 'string')
    throw new Error('Dislike snapshot must be a string')
  return {
    payload: data,
    hash: md5(data.trim()),
    contentHash: sha256(data),
    itemCount: normalizeDislikeRules(data).split('\n').filter(Boolean).length,
    byteSize: Buffer.byteLength(data),
  }
}

const musicList = (data: ListData, listId: string): MusicInfo[] | null => {
  if (listId === 'default') return data.defaultList
  if (listId === 'love') return data.loveList
  return data.userList.find((list) => list.id === listId)?.list ?? null
}

const addUniqueMusic = (
  target: MusicInfo[],
  incoming: MusicInfo[],
  location: AddMusicLocationType,
): MusicInfo[] => {
  const ids = new Set(target.map((item) => item.id))
  const unique = incoming.filter((item) => {
    if (ids.has(item.id)) return false
    ids.add(item.id)
    return true
  })
  return location === 'top' ? [...unique, ...target] : [...target, ...unique]
}

const moveItems = <T>(
  items: T[],
  position: number,
  ids: string[],
  getId: (item: T) => string,
): T[] => {
  const wanted = new Set(ids)
  const selectedById = new Map(
    items
      .filter((item) => wanted.has(getId(item)))
      .map((item) => [getId(item), item]),
  )
  const selected = ids.flatMap((id) => {
    const item = selectedById.get(id)
    return item ? [item] : []
  })
  const remaining = items.filter((item) => !wanted.has(getId(item)))
  remaining.splice(
    Math.min(Math.max(position, 0), remaining.length),
    0,
    ...selected,
  )
  return remaining
}

export function applyListAction(
  current: ListData,
  action: ListAction,
): ListData {
  const next = structuredClone(current)
  switch (action.action) {
    case 'list_data_overwrite':
      return structuredClone(action.data)
    case 'list_create':
      for (const info of action.data.listInfos) {
        if (next.userList.some((list) => list.id === info.id)) continue
        const list: UserListInfoFull = { ...info, list: [] }
        const position = action.data.position
        if (position < 0 || position >= next.userList.length)
          next.userList.push(list)
        else next.userList.splice(position, 0, list)
      }
      return next
    case 'list_remove': {
      const ids = new Set(action.data)
      next.userList = next.userList.filter((list) => !ids.has(list.id))
      return next
    }
    case 'list_update': {
      const changes = new Map(action.data.map((item) => [item.id, item]))
      next.userList = next.userList.map((list) => {
        const info = changes.get(list.id)
        return info ? { ...list, ...info, list: list.list } : list
      })
      return next
    }
    case 'list_update_position':
      next.userList = moveItems(
        next.userList,
        action.data.position,
        action.data.ids,
        (list) => list.id,
      )
      for (const list of next.userList) {
        if (action.data.ids.includes(list.id))
          list.locationUpdateTime = Date.now()
      }
      return next
    case 'list_music_overwrite': {
      const target = musicList(next, action.data.listId)
      if (target) target.splice(0, target.length, ...action.data.musicInfos)
      return next
    }
    case 'list_music_add': {
      const target = musicList(next, action.data.id)
      if (target)
        target.splice(
          0,
          target.length,
          ...addUniqueMusic(
            target,
            action.data.musicInfos,
            action.data.addMusicLocationType,
          ),
        )
      return next
    }
    case 'list_music_move': {
      const source = musicList(next, action.data.fromId)
      const target = musicList(next, action.data.toId)
      const ids = new Set(action.data.musicInfos.map((item) => item.id))
      if (source)
        source.splice(
          0,
          source.length,
          ...source.filter((item) => !ids.has(item.id)),
        )
      if (target)
        target.splice(
          0,
          target.length,
          ...addUniqueMusic(
            target,
            action.data.musicInfos,
            action.data.addMusicLocationType,
          ),
        )
      return next
    }
    case 'list_music_remove': {
      const target = musicList(next, action.data.listId)
      const ids = new Set(action.data.ids)
      if (target)
        target.splice(
          0,
          target.length,
          ...target.filter((item) => !ids.has(item.id)),
        )
      return next
    }
    case 'list_music_update':
      for (const update of action.data) {
        const target = musicList(next, update.id)
        const index =
          target?.findIndex((item) => item.id === update.musicInfo.id) ?? -1
        if (!target || index < 0) continue
        const original = target[index]
        if (!original) continue
        const replacement = { ...original }
        for (const key of [
          'name',
          'singer',
          'source',
          'interval',
          'meta',
        ] as const) {
          if (update.musicInfo[key] !== undefined)
            replacement[key] = update.musicInfo[key]
        }
        target.splice(index, 1, replacement)
      }
      return next
    case 'list_music_update_position': {
      const target = musicList(next, action.data.listId)
      if (!target) return next
      const ids = action.data.ids.map(String)
      const moved = moveItems(target, action.data.position, ids, (item) =>
        String(item.id),
      )
      target.splice(0, target.length, ...moved)
      return next
    }
    case 'list_music_clear':
      for (const listId of action.data) {
        const target = musicList(next, listId)
        if (target) target.splice(0, target.length)
      }
      return next
  }
}

export function normalizeDislikeRules(rules: string): string {
  const normalized = new Set<string>()
  for (const rawRule of rules.split('\n')) {
    if (!rawRule) continue
    const separator = rawRule.indexOf('@')
    const rawName = separator < 0 ? rawRule : rawRule.slice(0, separator)
    const rawSinger = separator < 0 ? '' : rawRule.slice(separator + 1)
    const name = rawName.replaceAll('@', '#').toLocaleLowerCase().trim()
    const singer = rawSinger.replaceAll('@', '#').toLocaleLowerCase().trim()
    if (name && singer) normalized.add(`${name}@${singer}`)
    else if (name) normalized.add(name)
    else if (singer) normalized.add(`@${singer}`)
  }
  return [...normalized].join('\n')
}

export function applyDislikeAction(
  current: DislikeRules,
  action: DislikeAction,
): DislikeRules {
  switch (action.action) {
    case 'dislike_data_overwrite':
      return normalizeDislikeRules(action.data)
    case 'dislike_music_add': {
      const additions = action.data.map(
        (item) => `${String(item.name ?? '')}@${String(item.singer ?? '')}`,
      )
      return normalizeDislikeRules(`${current}\n${additions.join('\n')}`)
    }
    case 'dislike_music_clear':
      return ''
  }
}

export const emptyListData = (): ListData => ({
  defaultList: [],
  loveList: [],
  userList: [],
})

export function toUserListInfo(value: UserListInfoFull): UserListInfo {
  const { list: _list, ...info } = value
  return info
}
