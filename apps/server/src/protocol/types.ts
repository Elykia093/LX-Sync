export type JsonPrimitive = string | number | boolean | null
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue }

export type MusicInfo = { id: string | number } & Record<
  string,
  JsonValue | undefined
>

export interface UserListInfo {
  id: string
  name: string
  source?: 'kw' | 'kg' | 'tx' | 'wy' | 'mg'
  sourceListId?: string
  locationUpdateTime: number | null
}

export interface UserListInfoFull extends UserListInfo {
  list: MusicInfo[]
}

export interface ListData {
  defaultList: MusicInfo[]
  loveList: MusicInfo[]
  userList: UserListInfoFull[]
}

export type AddMusicLocationType = 'top' | 'bottom'

export type ListAction =
  | { action: 'list_data_overwrite'; data: ListData }
  | {
      action: 'list_create'
      data: { position: number; listInfos: UserListInfo[] }
    }
  | { action: 'list_remove'; data: string[] }
  | { action: 'list_update'; data: UserListInfo[] }
  | {
      action: 'list_update_position'
      data: { ids: string[]; position: number }
    }
  | {
      action: 'list_music_add'
      data: {
        id: string
        musicInfos: MusicInfo[]
        addMusicLocationType: AddMusicLocationType
      }
    }
  | {
      action: 'list_music_move'
      data: {
        fromId: string
        toId: string
        musicInfos: MusicInfo[]
        addMusicLocationType: AddMusicLocationType
      }
    }
  | {
      action: 'list_music_remove'
      data: { listId: string; ids: Array<string | number> }
    }
  | {
      action: 'list_music_update'
      data: Array<{ id: string; musicInfo: MusicInfo }>
    }
  | {
      action: 'list_music_update_position'
      data: { listId: string; position: number; ids: Array<string | number> }
    }
  | {
      action: 'list_music_overwrite'
      data: { listId: string; musicInfos: MusicInfo[] }
    }
  | { action: 'list_music_clear'; data: string[] }

export type DislikeRules = string

export type DislikeAction =
  | { action: 'dislike_data_overwrite'; data: DislikeRules }
  | { action: 'dislike_music_add'; data: Array<Record<string, JsonValue>> }
  | { action: 'dislike_music_clear' }

export type SyncMode =
  | 'merge_local_remote'
  | 'merge_remote_local'
  | 'overwrite_local_remote'
  | 'overwrite_remote_local'
  | 'overwrite_local_remote_full'
  | 'overwrite_remote_local_full'
  | 'cancel'

export interface FeatureConfig {
  skipSnapshot: boolean
}

export interface EnabledFeatures {
  list?: false | FeatureConfig
  dislike?: false | FeatureConfig
}

export interface DeviceKeyInfo {
  clientId: string
  key: string
  deviceName: string
  isMobile: boolean
  lastConnectDate?: number
}
