import { describe, expect, it } from 'vitest'
import { playlistOffsetForPage } from './PlaylistPagination.js'

describe('playlistOffsetForPage', () => {
  it('accepts valid pages including a partial last page', () => {
    expect(playlistOffsetForPage('1', 63, 25)).toBe(0)
    expect(playlistOffsetForPage(' 2 ', 63, 25)).toBe(25)
    expect(playlistOffsetForPage('3', 63, 25)).toBe(50)
    expect(playlistOffsetForPage('1', 0, 25)).toBe(0)
  })

  it.each([
    '',
    ' ',
    '0',
    '-1',
    '4',
    '1.5',
    '2e0',
    '0x2',
    '+2',
    'Infinity',
    'NaN',
    '9007199254740992',
  ])('rejects invalid or out-of-range page input %j', (value) => {
    expect(playlistOffsetForPage(value, 63, 25)).toBeNull()
  })

  it('revalidates the page against a smaller filtered or deleted result', () => {
    expect(playlistOffsetForPage('3', 26, 25)).toBeNull()
    expect(playlistOffsetForPage('2', 25, 25)).toBeNull()
    expect(playlistOffsetForPage('2', 0, 25)).toBeNull()
  })
})
