import { describe, expect, it } from 'vitest'
import {
  applyListAction,
  normalizeDislikeRules,
  parseListData,
  serializeSnapshot,
  syncLimits,
} from './snapshot.js'
import {
  parseDislikeAction,
  parseFeatures,
  parseListAction,
} from './validation.js'

describe('snapshot actions', () => {
  it('applies validated list actions without duplicating music', () => {
    const current = {
      defaultList: [{ id: 'old', name: 'Old' }],
      loveList: [],
      userList: [],
    }
    const action = parseListAction({
      action: 'list_music_add',
      data: {
        id: 'default',
        musicInfos: [
          { id: 'new', name: 'New' },
          { id: 'old', name: 'Duplicate' },
        ],
        addMusicLocationType: 'top',
      },
    })

    expect(
      applyListAction(current, action).defaultList.map((item) => item.id),
    ).toEqual(['new', 'old'])
    expect(current.defaultList.map((item) => item.id)).toEqual(['old'])
  })

  it('keeps protocol MD5 separate from SHA-256 content identity', () => {
    const serialized = serializeSnapshot('dislike', 'artist@title\n')
    expect(serialized.hash).toHaveLength(32)
    expect(serialized.contentHash).toHaveLength(64)
    expect(serialized.hash).not.toBe(serialized.contentHash)
  })

  it('normalizes dislike rules and rejects non-JSON action values', () => {
    expect(
      normalizeDislikeRules(' Song @ Singer \nsong@singer\nOnlyName'),
    ).toBe('song@singer\nonlyname')
    expect(() =>
      parseDislikeAction({
        action: 'dislike_music_add',
        data: [{ name: undefined }],
      }),
    ).toThrow('Invalid dislike action')
  })

  it('preserves absent feature fields under exact optional semantics', () => {
    expect(parseFeatures({ list: { skipSnapshot: true } })).toEqual({
      list: { skipSnapshot: true },
    })
  })

  it('rejects snapshots above playlist and total track limits', () => {
    const userList = Array.from(
      { length: syncLimits.maxUserLists + 1 },
      (_, index) => ({
        id: `list-${index}`,
        name: `List ${index}`,
        locationUpdateTime: null,
        list: [],
      }),
    )
    expect(() =>
      parseListData({ defaultList: [], loveList: [], userList }),
    ).toThrow('Invalid user list')

    const defaultList = Array.from(
      { length: syncLimits.maxTracks + 1 },
      (_, index) => ({ id: index }),
    )
    expect(() =>
      parseListData({ defaultList, loveList: [], userList: [] }),
    ).toThrow('Invalid default list')
  })

  it('normalizes legacy playlist metadata in snapshots', () => {
    expect(
      parseListData({
        defaultList: [],
        loveList: [],
        userList: [
          {
            id: 'legacy-list',
            name: 'Legacy list',
            source: 'wy',
            sourceListId: 123456,
            list: [],
          },
        ],
      }).userList,
    ).toEqual([
      {
        id: 'legacy-list',
        name: 'Legacy list',
        source: 'wy',
        sourceListId: '123456',
        locationUpdateTime: null,
        list: [],
      },
    ])
  })

  it('normalizes nullable desktop playlist metadata in snapshots', () => {
    expect(
      parseListData({
        defaultList: [],
        loveList: [],
        userList: [
          {
            id: 'desktop-list',
            name: 'Desktop list',
            source: null,
            sourceListId: null,
            locationUpdateTime: null,
            metadata: { preserved: true },
            list: [],
          },
        ],
      }).userList,
    ).toEqual([
      {
        id: 'desktop-list',
        name: 'Desktop list',
        locationUpdateTime: null,
        metadata: { preserved: true },
        list: [],
      },
    ])
  })

  it('normalizes legacy playlist metadata in incremental actions', () => {
    expect(
      parseListAction({
        action: 'list_create',
        data: {
          position: 0,
          listInfos: [
            {
              id: 'created-list',
              name: 'Created list',
              sourceListId: 42,
            },
          ],
        },
      }),
    ).toEqual({
      action: 'list_create',
      data: {
        position: 0,
        listInfos: [
          {
            id: 'created-list',
            name: 'Created list',
            sourceListId: '42',
            locationUpdateTime: null,
          },
        ],
      },
    })

    expect(
      parseListAction({
        action: 'list_update',
        data: [
          {
            id: 'updated-list',
            name: 'Updated list',
            sourceListId: 84,
          },
        ],
      }),
    ).toEqual({
      action: 'list_update',
      data: [
        {
          id: 'updated-list',
          name: 'Updated list',
          sourceListId: '84',
          locationUpdateTime: null,
        },
      ],
    })
  })

  it('normalizes nullable desktop metadata in incremental actions', () => {
    expect(
      parseListAction({
        action: 'list_create',
        data: {
          position: 0,
          listInfos: [
            {
              id: 'created-list',
              name: 'Created list',
              source: null,
              sourceListId: null,
              locationUpdateTime: null,
            },
          ],
        },
      }),
    ).toEqual({
      action: 'list_create',
      data: {
        position: 0,
        listInfos: [
          {
            id: 'created-list',
            name: 'Created list',
            locationUpdateTime: null,
          },
        ],
      },
    })

    expect(
      parseListAction({
        action: 'list_update',
        data: [
          {
            id: 'updated-list',
            name: 'Updated list',
            source: null,
            sourceListId: null,
            locationUpdateTime: null,
          },
        ],
      }),
    ).toEqual({
      action: 'list_update',
      data: [
        {
          id: 'updated-list',
          name: 'Updated list',
          locationUpdateTime: null,
        },
      ],
    })
  })

  it('rejects invalid legacy playlist metadata values', () => {
    expect(() =>
      parseListData({
        defaultList: [],
        loveList: [],
        userList: [
          {
            id: 'invalid-list',
            name: 'Invalid list',
            sourceListId: Number.POSITIVE_INFINITY,
            list: [],
          },
        ],
      }),
    ).toThrow('Invalid list data')

    expect(() =>
      parseListAction({
        action: 'list_update',
        data: [
          {
            id: 'invalid-list',
            name: 'Invalid list',
            locationUpdateTime: 'yesterday',
          },
        ],
      }),
    ).toThrow('Invalid list action')
  })

  it('rejects JSON metadata deeper than the protocol limit', () => {
    let metadata: unknown = 'value'
    for (let depth = 0; depth <= syncLimits.maxJsonDepth; depth += 1)
      metadata = { nested: metadata }

    expect(() =>
      parseListAction({
        action: 'list_music_add',
        data: {
          id: 'default',
          musicInfos: [{ id: 'song', metadata }],
          addMusicLocationType: 'bottom',
        },
      }),
    ).toThrow('Invalid list action')
  })
})
