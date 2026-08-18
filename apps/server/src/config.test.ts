import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const requiredEnvironment = {
  DATABASE_URL: 'postgresql://test.invalid/test',
  MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  ADMIN_PASSWORD: 'correct-horse-battery',
}

describe('SYNC_BASE_PATH configuration', () => {
  it('treats an empty value as disabled and normalizes valid paths', () => {
    expect(
      loadConfig({ ...requiredEnvironment, SYNC_BASE_PATH: '' }).SYNC_BASE_PATH,
    ).toBeUndefined()
    expect(
      loadConfig({ ...requiredEnvironment, SYNC_BASE_PATH: ' /base ' })
        .SYNC_BASE_PATH,
    ).toBe('/base')
  })

  it.each([
    '/base/',
    'base',
    '/api',
    '/health/private',
    '/users',
    '/audit/private',
    '/assets',
    '/base/../escape',
  ])('rejects unsafe path %s', (syncBasePath) => {
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        SYNC_BASE_PATH: syncBasePath,
      }),
    ).toThrow()
  })
})

describe('ADMIN_PASSWORD configuration', () => {
  it('accepts a non-empty password shorter than 12 characters', () => {
    expect(
      loadConfig({ ...requiredEnvironment, ADMIN_PASSWORD: 'x' })
        .ADMIN_PASSWORD,
    ).toBe('x')
  })

  it.each(['', 'x'.repeat(257)])(
    'rejects an invalid password length',
    (password) => {
      expect(() =>
        loadConfig({ ...requiredEnvironment, ADMIN_PASSWORD: password }),
      ).toThrow()
    },
  )
})
