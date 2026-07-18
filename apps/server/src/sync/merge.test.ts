import { describe, expect, it } from 'vitest'
import {
  mergeDislikeFromSnapshot,
  mergeListsFromSnapshot,
  resolveInitialList,
  transformClientMode,
} from './merge.js'

describe('three-way synchronization merge', () => {
  it('propagates deletions made on either side from the shared snapshot', () => {
    const snapshot = {
      defaultList: [{ id: 'keep' }, { id: 'removed' }],
      loveList: [],
      userList: [],
    }
    const local = { ...snapshot, defaultList: [{ id: 'keep' }] }
    const remote = {
      ...snapshot,
      defaultList: [{ id: 'keep' }, { id: 'removed' }, { id: 'remote-new' }],
    }

    expect(
      mergeListsFromSnapshot(local, remote, snapshot, 'bottom').defaultList.map(
        (item) => item.id,
      ),
    ).toEqual(['keep', 'remote-new'])
  })

  it('keeps optional playlist metadata absent instead of writing undefined', () => {
    const list = {
      id: 'playlist',
      name: 'List',
      locationUpdateTime: null,
      list: [],
    }
    const merged = mergeListsFromSnapshot(
      { defaultList: [], loveList: [], userList: [list] },
      {
        defaultList: [],
        loveList: [],
        userList: [{ ...list, name: 'Remote' }],
      },
      { defaultList: [], loveList: [], userList: [list] },
      'bottom',
    )
    expect(merged.userList[0]).toEqual({
      id: 'playlist',
      name: 'Remote',
      locationUpdateTime: null,
      list: [],
    })
    expect(Object.hasOwn(merged.userList[0] ?? {}, 'source')).toBe(false)
  })

  it('transforms client perspective and resolves initial precedence', () => {
    const local = { defaultList: [{ id: 'local' }], loveList: [], userList: [] }
    const remote = {
      defaultList: [{ id: 'remote' }],
      loveList: [],
      userList: [],
    }
    expect(transformClientMode('overwrite_local_remote_full')).toBe(
      'overwrite_remote_local_full',
    )
    expect(
      resolveInitialList(
        'overwrite_local_remote_full',
        local,
        remote,
        'bottom',
      ),
    ).toEqual(local)
  })

  it('does not resurrect dislike rules removed on one side', () => {
    expect(mergeDislikeFromSnapshot('a@b', 'a@b\nc@d', 'a@b\nc@d')).toBe('a@b')
  })
})
