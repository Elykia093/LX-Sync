import type {
  DislikeAction,
  EnabledFeatures,
  ListAction,
  MusicInfo,
  UserListInfo,
} from '../protocol/index.js'
import {
  isBoundedJsonObject,
  isBoundedString,
  parseListData,
  parseUserListInfo,
  syncLimits,
} from './snapshot.js'

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const isStringArray = (value: unknown): value is string[] => {
  return (
    Array.isArray(value) &&
    value.length <= syncLimits.maxTracks &&
    value.every(
      (item) =>
        isBoundedString(item) && item.length <= syncLimits.maxIdentifierLength,
    )
  )
}

const isIdArray = (value: unknown): value is Array<string | number> => {
  return (
    Array.isArray(value) &&
    value.length <= syncLimits.maxTracks &&
    value.every(
      (item) =>
        (isBoundedString(item) &&
          item.length <= syncLimits.maxIdentifierLength) ||
        (typeof item === 'number' && Number.isFinite(item)),
    )
  )
}

const isMusicInfo = (value: unknown): value is MusicInfo => {
  return (
    isRecord(value) &&
    ((isBoundedString(value.id) &&
      value.id.length > 0 &&
      value.id.length <= syncLimits.maxIdentifierLength) ||
      (typeof value.id === 'number' && Number.isFinite(value.id))) &&
    isBoundedJsonObject(value)
  )
}

const isMusicArray = (value: unknown): value is MusicInfo[] => {
  return (
    Array.isArray(value) &&
    value.length <= syncLimits.maxTracks &&
    value.every(isMusicInfo)
  )
}

const parseUserListInfos = (value: unknown): UserListInfo[] | null => {
  if (!Array.isArray(value) || value.length > syncLimits.maxUserLists)
    return null
  const infos: UserListInfo[] = []
  for (const item of value) {
    const info = parseUserListInfo(item)
    if (!info) return null
    infos.push(info)
  }
  return infos
}

const isLocation = (value: unknown): value is 'top' | 'bottom' =>
  value === 'top' || value === 'bottom'
const isPosition = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 0

export function parseFeatures(value: unknown): EnabledFeatures {
  if (!isRecord(value)) throw new Error('Invalid feature set')
  const parseFeature = (feature: unknown) => {
    if (feature === undefined || feature === false) return feature
    if (!isRecord(feature) || typeof feature.skipSnapshot !== 'boolean')
      throw new Error('Invalid feature configuration')
    return { skipSnapshot: feature.skipSnapshot }
  }
  const list = parseFeature(value.list)
  const dislike = parseFeature(value.dislike)
  return {
    ...(list === undefined ? {} : { list }),
    ...(dislike === undefined ? {} : { dislike }),
  }
}

export function parseListAction(value: unknown): ListAction {
  if (!isRecord(value) || typeof value.action !== 'string')
    throw new Error('Invalid list action')
  const data = value.data
  switch (value.action) {
    case 'list_data_overwrite':
      return { action: value.action, data: parseListData(data) }
    case 'list_create': {
      if (!isRecord(data) || !isPosition(data.position)) break
      const listInfos = parseUserListInfos(data.listInfos)
      if (!listInfos) break
      return {
        action: value.action,
        data: { position: data.position, listInfos },
      }
    }
    case 'list_remove':
      if (isStringArray(data)) return { action: value.action, data }
      break
    case 'list_update': {
      const listInfos = parseUserListInfos(data)
      if (listInfos) return { action: value.action, data: listInfos }
      break
    }
    case 'list_update_position':
      if (
        isRecord(data) &&
        isPosition(data.position) &&
        isStringArray(data.ids)
      )
        return {
          action: value.action,
          data: { position: data.position, ids: data.ids },
        }
      break
    case 'list_music_add':
      if (
        isRecord(data) &&
        isBoundedString(data.id) &&
        data.id.length <= syncLimits.maxIdentifierLength &&
        isMusicArray(data.musicInfos) &&
        isLocation(data.addMusicLocationType)
      ) {
        return {
          action: value.action,
          data: {
            id: data.id,
            musicInfos: data.musicInfos,
            addMusicLocationType: data.addMusicLocationType,
          },
        }
      }
      break
    case 'list_music_move':
      if (
        isRecord(data) &&
        isBoundedString(data.fromId) &&
        data.fromId.length <= syncLimits.maxIdentifierLength &&
        isBoundedString(data.toId) &&
        data.toId.length <= syncLimits.maxIdentifierLength &&
        isMusicArray(data.musicInfos) &&
        isLocation(data.addMusicLocationType)
      ) {
        return {
          action: value.action,
          data: {
            fromId: data.fromId,
            toId: data.toId,
            musicInfos: data.musicInfos,
            addMusicLocationType: data.addMusicLocationType,
          },
        }
      }
      break
    case 'list_music_remove':
      if (
        isRecord(data) &&
        isBoundedString(data.listId) &&
        data.listId.length <= syncLimits.maxIdentifierLength &&
        isIdArray(data.ids)
      )
        return {
          action: value.action,
          data: { listId: data.listId, ids: data.ids },
        }
      break
    case 'list_music_update':
      if (
        Array.isArray(data) &&
        data.length <= syncLimits.maxTracks &&
        data.every(
          (item) =>
            isRecord(item) &&
            isBoundedString(item.id) &&
            item.id.length <= syncLimits.maxIdentifierLength &&
            isMusicInfo(item.musicInfo),
        )
      ) {
        return { action: value.action, data }
      }
      break
    case 'list_music_update_position':
      if (
        isRecord(data) &&
        isBoundedString(data.listId) &&
        data.listId.length <= syncLimits.maxIdentifierLength &&
        isPosition(data.position) &&
        isIdArray(data.ids)
      ) {
        return {
          action: value.action,
          data: { listId: data.listId, position: data.position, ids: data.ids },
        }
      }
      break
    case 'list_music_overwrite':
      if (
        isRecord(data) &&
        isBoundedString(data.listId) &&
        data.listId.length <= syncLimits.maxIdentifierLength &&
        isMusicArray(data.musicInfos)
      )
        return {
          action: value.action,
          data: { listId: data.listId, musicInfos: data.musicInfos },
        }
      break
    case 'list_music_clear':
      if (isStringArray(data)) return { action: value.action, data }
      break
  }
  throw new Error('Invalid list action')
}

export function parseDislikeAction(value: unknown): DislikeAction {
  if (!isRecord(value) || typeof value.action !== 'string')
    throw new Error('Invalid dislike action')
  switch (value.action) {
    case 'dislike_data_overwrite':
      if (isBoundedString(value.data))
        return { action: value.action, data: value.data }
      break
    case 'dislike_music_add':
      if (
        Array.isArray(value.data) &&
        value.data.length <= syncLimits.maxTracks &&
        value.data.every(isBoundedJsonObject)
      )
        return { action: value.action, data: value.data }
      break
    case 'dislike_music_clear':
      return { action: value.action }
  }
  throw new Error('Invalid dislike action')
}

const allowedCalls = new Set([
  'onFeatureChanged',
  'onListSyncAction',
  'onDislikeSyncAction',
])

export interface Message2CallMessage {
  name: string
  path?: string[]
  error?: string | null
  data?: unknown
}

export function parseMessage2CallMessage(value: unknown): Message2CallMessage {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    value.name.length > 256
  )
    throw new Error('Invalid RPC message')
  const message: Message2CallMessage = { name: value.name }
  if (value.path !== undefined) {
    if (
      !Array.isArray(value.path) ||
      value.path.length !== 1 ||
      !value.path.every(
        (item) => typeof item === 'string' && allowedCalls.has(item),
      )
    ) {
      throw new Error('Invalid RPC path')
    }
    message.path = value.path
  }
  if (value.error !== undefined) {
    if (value.error !== null && !isBoundedString(value.error))
      throw new Error('Invalid RPC error')
    message.error = value.error
  }
  if (value.data !== undefined) message.data = value.data
  return message
}
