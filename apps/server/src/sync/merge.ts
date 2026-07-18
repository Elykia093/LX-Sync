import type {
  AddMusicLocationType,
  DislikeRules,
  ListData,
  MusicInfo,
  SyncMode,
  UserListInfoFull,
} from '../protocol/index.js'
import { normalizeDislikeRules } from './snapshot.js'

const mergeMusic = (
  source: MusicInfo[],
  target: MusicInfo[],
  location: AddMusicLocationType,
): MusicInfo[] => {
  const sequence =
    location === 'top' ? [...target, ...source] : [...source, ...target]
  const values = new Map<string | number, MusicInfo>()
  if (location === 'top') {
    for (let index = sequence.length - 1; index >= 0; index -= 1) {
      const item = sequence[index]
      if (item && !values.has(item.id)) values.set(item.id, item)
    }
    return [...values.values()].reverse()
  }
  for (const item of sequence)
    if (!values.has(item.id)) values.set(item.id, item)
  return [...values.values()]
}

const mergeMusicFromSnapshot = (
  local: MusicInfo[],
  remote: MusicInfo[],
  snapshot: MusicInfo[],
  location: AddMusicLocationType,
): MusicInfo[] => {
  const localIds = new Set(local.map((item) => item.id))
  const remoteIds = new Set(remote.map((item) => item.id))
  const removed = new Set(
    snapshot
      .filter((item) => !localIds.has(item.id) || !remoteIds.has(item.id))
      .map((item) => item.id),
  )
  return mergeMusic(local, remote, location).filter(
    (item) => !removed.has(item.id),
  )
}

const listMap = (data: ListData) =>
  new Map(data.userList.map((list) => [list.id, list]))

export function hasListContent(data: ListData): boolean {
  return (
    data.defaultList.length > 0 ||
    data.loveList.length > 0 ||
    data.userList.length > 0
  )
}

export function mergeInitialLists(
  source: ListData,
  target: ListData,
  location: AddMusicLocationType,
  includeTargetOnly: boolean,
): ListData {
  const sourceMap = listMap(source)
  const userList = source.userList.map((list) => structuredClone(list))
  for (const [position, targetList] of target.userList.entries()) {
    const sourceList = sourceMap.get(targetList.id)
    if (sourceList) {
      const current = userList.find((list) => list.id === targetList.id)
      if (current)
        current.list = mergeMusic(sourceList.list, targetList.list, location)
      continue
    }
    if (!includeTargetOnly) continue
    const insertion = structuredClone(targetList)
    if ((targetList.locationUpdateTime ?? 0) > 0)
      userList.splice(Math.min(position, userList.length), 0, insertion)
    else userList.push(insertion)
  }
  return {
    defaultList: includeTargetOnly
      ? mergeMusic(source.defaultList, target.defaultList, location)
      : structuredClone(source.defaultList),
    loveList: includeTargetOnly
      ? mergeMusic(source.loveList, target.loveList, location)
      : structuredClone(source.loveList),
    userList,
  }
}

const selectChanged = <T>(snapshot: T, local: T, remote: T): T =>
  Object.is(snapshot, local) ? remote : local

export function mergeListsFromSnapshot(
  local: ListData,
  remote: ListData,
  snapshot: ListData,
  location: AddMusicLocationType,
): ListData {
  const localMap = listMap(local)
  const remoteMap = listMap(remote)
  const snapshotMap = listMap(snapshot)
  const removed = new Set(
    snapshot.userList
      .filter((list) => !localMap.has(list.id) || !remoteMap.has(list.id))
      .map((list) => list.id),
  )

  const mergedById = new Map<string, UserListInfoFull>()
  for (const localList of local.userList) {
    if (removed.has(localList.id)) continue
    const remoteList = remoteMap.get(localList.id)
    if (!remoteList) {
      mergedById.set(localList.id, structuredClone(localList))
      continue
    }
    const previous = snapshotMap.get(localList.id)
    const source = previous
      ? selectChanged(previous.source, localList.source, remoteList.source)
      : localList.source
    const sourceListId = previous
      ? selectChanged(
          previous.sourceListId,
          localList.sourceListId,
          remoteList.sourceListId,
        )
      : localList.sourceListId
    mergedById.set(localList.id, {
      ...structuredClone(localList),
      name: previous
        ? selectChanged(previous.name, localList.name, remoteList.name)
        : localList.name,
      ...(source === undefined ? {} : { source }),
      ...(sourceListId === undefined ? {} : { sourceListId }),
      list: mergeMusicFromSnapshot(
        localList.list,
        remoteList.list,
        previous?.list ?? [],
        location,
      ),
    })
  }
  for (const remoteList of remote.userList) {
    if (!removed.has(remoteList.id) && !mergedById.has(remoteList.id))
      mergedById.set(remoteList.id, structuredClone(remoteList))
  }

  const orderSource = [...local.userList, ...remote.userList].sort(
    (left, right) =>
      (right.locationUpdateTime ?? 0) - (left.locationUpdateTime ?? 0),
  )
  const orderedIds = new Set<string>()
  const userList: UserListInfoFull[] = []
  for (const item of orderSource) {
    const merged = mergedById.get(item.id)
    if (merged && !orderedIds.has(item.id)) {
      orderedIds.add(item.id)
      userList.push(merged)
    }
  }

  return {
    defaultList: mergeMusicFromSnapshot(
      local.defaultList,
      remote.defaultList,
      snapshot.defaultList,
      location,
    ),
    loveList: mergeMusicFromSnapshot(
      local.loveList,
      remote.loveList,
      snapshot.loveList,
      location,
    ),
    userList,
  }
}

const transformedModes: Record<SyncMode, SyncMode> = {
  merge_local_remote: 'merge_remote_local',
  merge_remote_local: 'merge_local_remote',
  overwrite_local_remote: 'overwrite_remote_local',
  overwrite_remote_local: 'overwrite_local_remote',
  overwrite_local_remote_full: 'overwrite_remote_local_full',
  overwrite_remote_local_full: 'overwrite_local_remote_full',
  cancel: 'cancel',
}

export function transformClientMode(value: unknown): SyncMode {
  if (typeof value !== 'string' || !(value in transformedModes)) return 'cancel'
  return transformedModes[value as SyncMode]
}

export function resolveInitialList(
  mode: SyncMode,
  local: ListData,
  remote: ListData,
  location: AddMusicLocationType,
): ListData {
  switch (mode) {
    case 'merge_local_remote':
      return mergeInitialLists(local, remote, location, true)
    case 'merge_remote_local':
      return mergeInitialLists(remote, local, location, true)
    case 'overwrite_local_remote':
      return mergeInitialLists(local, remote, location, true)
    case 'overwrite_remote_local':
      return mergeInitialLists(remote, local, location, true)
    case 'overwrite_local_remote_full':
      return structuredClone(local)
    case 'overwrite_remote_local_full':
      return structuredClone(remote)
    case 'cancel':
      throw new Error('Sync cancelled')
  }
}

export function resolveInitialDislike(
  mode: SyncMode,
  local: DislikeRules,
  remote: DislikeRules,
): DislikeRules {
  switch (mode) {
    case 'merge_local_remote':
      return normalizeDislikeRules(`${local}\n${remote}`)
    case 'merge_remote_local':
      return normalizeDislikeRules(`${remote}\n${local}`)
    case 'overwrite_local_remote':
    case 'overwrite_local_remote_full':
      return local
    case 'overwrite_remote_local':
    case 'overwrite_remote_local_full':
      return remote
    case 'cancel':
      throw new Error('Sync cancelled')
  }
}

export function mergeDislikeFromSnapshot(
  local: string,
  remote: string,
  snapshot: string,
): string {
  const localRules = new Set(
    normalizeDislikeRules(local).split('\n').filter(Boolean),
  )
  const remoteRules = new Set(
    normalizeDislikeRules(remote).split('\n').filter(Boolean),
  )
  const removed = new Set(
    normalizeDislikeRules(snapshot)
      .split('\n')
      .filter((rule) => !localRules.has(rule) || !remoteRules.has(rule)),
  )
  return [
    ...new Set(
      [...localRules, ...remoteRules].filter((rule) => !removed.has(rule)),
    ),
  ].join('\n')
}
