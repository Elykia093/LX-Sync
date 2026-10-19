import type { Page, Request, Route } from '@playwright/test'
import { expect, test } from '@playwright/test'

const userId = '00000000-0000-4000-8000-000000000001'
const createdAt = '2026-07-23T08:00:00.000Z'
const longSongId = 'long-song-identifier-'.repeat(24)

type SongId = string | number

interface MockSong {
  id: SongId
  name: string
  singer: string | null
  albumName: string | null
  source: string | null
  interval: string | null
}

interface MockPlaylist {
  id: string
  name: string
  type: 'default' | 'love' | 'user'
  quality: string | null
  songs: MockSong[]
}

interface MutationRecord {
  action: 'create' | 'rename' | 'delete' | 'add' | 'remove' | 'move' | 'copy'
  body: Record<string, unknown>
}

interface MockState {
  snapshotIndex: number
  snapshotId: string
  playlists: MockPlaylist[]
  snapshots: Map<string, MockPlaylist[]>
  failNextRename: boolean
  failNextCopy: boolean
  failNextAdd: boolean
  playlistReads: number
  renameRequests: number
  addRequests: number
  copyPreviews: Array<{ playlistId: string; body: Record<string, unknown> }>
  failNextPreview: number | null
  omitCopyCounts: boolean
  mutations: MutationRecord[]
  unhandled: string[]
}

test('分页支持首末页、跳页校验、加载禁用和删除后收缩', async ({
  page,
}, testInfo) => {
  const state = await installMockApi(page)
  const source = state.playlists[0]
  if (!source) throw new Error('Source playlist is missing')
  source.songs = Array.from({ length: 63 }, (_, index) => ({
    ...song(`page-${index + 1}`, `分页歌曲 ${index + 1}`),
    singer: index < 30 ? '筛选歌手' : '其他歌手',
  }))
  state.snapshots.set(state.snapshotId, clonePlaylists(state.playlists))
  const requested = Promise.withResolvers<void>()
  const response = Promise.withResolvers<void>()
  let holdLastPage = true
  await page.route(
    `**/api/v1/users/${userId}/playlists/default?**`,
    async (route) => {
      if (
        holdLastPage &&
        new URL(route.request().url()).searchParams.get('offset') === '50'
      ) {
        holdLastPage = false
        requested.resolve()
        await response.promise
      }
      await route.fallback()
    },
  )
  await page.goto(`/users/${userId}`)
  const pagination = page.getByRole('navigation', { name: '歌曲分页' })
  await expect(pagination).toContainText('第 1 / 3 页')
  await expect(
    pagination.getByRole('button', { name: '首页', exact: true }),
  ).toBeDisabled()
  await pagination.getByRole('button', { name: '末页', exact: true }).click()
  await requested.promise
  for (const name of ['首页', '上一页', '下一页', '末页', '跳转']) {
    await expect(
      pagination.getByRole('button', { name, exact: true }),
    ).toBeDisabled()
  }
  await expect(pagination.getByLabel('跳转页码')).toBeDisabled()
  response.resolve()
  await expect(page.getByText('分页歌曲 51', { exact: true })).toBeVisible()
  await expect(pagination).toContainText('第 3 / 3 页')
  await expect(
    pagination.getByRole('button', { name: '末页', exact: true }),
  ).toBeDisabled()
  await pagination.getByLabel('跳转页码').fill('2')
  await pagination.getByRole('button', { name: '跳转', exact: true }).click()
  await expect(page.getByText('分页歌曲 26', { exact: true })).toBeVisible()
  for (const invalidPage of ['', '0', '4', '1.5', '2e0']) {
    await pagination.getByLabel('跳转页码').fill(invalidPage)
    await pagination.getByRole('button', { name: '跳转', exact: true }).click()
    await expect(pagination.getByRole('alert')).toHaveText(
      '请输入 1–3 之间的整数页码。',
    )
    await expect(pagination).toContainText('第 2 / 3 页')
  }
  await pagination.getByRole('button', { name: '首页', exact: true }).click()
  await expect(pagination).toContainText('第 1 / 3 页')
  await expect(pagination.getByRole('alert')).toHaveCount(0)

  await page.setViewportSize({ width: 320, height: 568 })
  await pagination.scrollIntoViewIfNeeded()
  await expect(
    pagination.getByRole('button', { name: '末页', exact: true }),
  ).toBeVisible()
  const bounds = await pagination.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return {
      left: box.left,
      right: box.right,
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }
  })
  expect(bounds.left).toBeGreaterThanOrEqual(0)
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewport)
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.viewport)
  await page.screenshot({
    path: testInfo.outputPath('playlist-pagination-320.png'),
    animations: 'disabled',
  })

  await pagination.getByLabel('跳转页码').fill('88')
  await page.getByPlaceholder('筛选歌手').fill('筛选歌手')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(pagination).toContainText('第 1 / 2 页')
  await expect(pagination.getByLabel('跳转页码')).toHaveValue('1')
  await pagination.getByRole('button', { name: '末页', exact: true }).click()
  await expect(page.getByText('分页歌曲 26', { exact: true })).toBeVisible()
  for (let index = 26; index <= 30; index++) {
    await page.getByLabel(`选择 分页歌曲 ${index}`, { exact: true }).check()
  }
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '移除', exact: true }).click()
  await expect(pagination).toContainText('第 1 / 1 页 · 共 25 首')
  await expect(page.getByPlaceholder('筛选歌手')).toHaveValue('筛选歌手')
  await expect(page.getByText('分页歌曲 26', { exact: true })).toHaveCount(0)
  expect(source.songs).toHaveLength(58)

  await pagination.getByLabel('跳转页码').fill('88')
  await page.getByRole('button', { name: /收藏列表/ }).click()
  await expect(pagination.getByLabel('跳转页码')).toHaveValue('1')
  await page.getByRole('button', { name: /默认列表/ }).click()
  await pagination.getByLabel('跳转页码').fill('88')
  advanceSnapshot(state)
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(pagination.getByLabel('跳转页码')).toHaveValue('1')
  expect(state.unhandled).toEqual([])
})

test('页码输入支持键盘连续跳页且加载结束不抢焦点', async ({ page }) => {
  const state = await installMockApi(page)
  const source = state.playlists[0]
  if (!source) throw new Error('Source playlist is missing')
  source.songs = Array.from({ length: 63 }, (_, index) =>
    song(`keyboard-page-${index + 1}`, `键盘分页歌曲 ${index + 1}`),
  )
  state.snapshots.set(state.snapshotId, clonePlaylists(state.playlists))
  const requestedOffsets: number[] = []
  const pendingPages = new Map(
    [25, 50].map((offset) => [
      offset,
      {
        requested: Promise.withResolvers<void>(),
        response: Promise.withResolvers<void>(),
      },
    ]),
  )
  await page.route(
    `**/api/v1/users/${userId}/playlists/default?**`,
    async (route) => {
      const offset = Number(
        new URL(route.request().url()).searchParams.get('offset'),
      )
      requestedOffsets.push(offset)
      const pending = pendingPages.get(offset)
      if (pending) {
        pending.requested.resolve()
        await pending.response.promise
      }
      await route.fallback()
    },
  )
  const secondPage = pendingPages.get(25)
  const thirdPage = pendingPages.get(50)
  if (!secondPage || !thirdPage) throw new Error('Page gates are missing')
  try {
    await page.goto(`/users/${userId}`)
    const pagination = page.getByRole('navigation', { name: '歌曲分页' })
    const pageInput = pagination.getByLabel('跳转页码')
    await expect(pagination).toContainText('第 1 / 3 页')
    await pageInput.fill('2')
    await pageInput.press('Enter')
    await secondPage.requested.promise
    await expect(pageInput).toBeFocused()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('3')
    await page.keyboard.press('Enter')
    await expect(pageInput).toHaveValue('2')
    expect(requestedOffsets).toEqual([0, 25])
    secondPage.response.resolve()
    await expect(
      page.getByText('键盘分页歌曲 26', { exact: true }),
    ).toBeVisible()
    await expect(pageInput).toBeFocused()

    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('3')
    await page.keyboard.press('Enter')
    await thirdPage.requested.promise
    await expect(pageInput).toBeFocused()
    const searchInput = page.getByPlaceholder('歌曲 ID、名称或任意字段')
    await searchInput.focus()
    thirdPage.response.resolve()
    await expect(
      page.getByText('键盘分页歌曲 51', { exact: true }),
    ).toBeVisible()
    await expect(searchInput).toBeFocused()
    expect(requestedOffsets).toEqual([0, 25, 50])
    expect(state.unhandled).toEqual([])
  } finally {
    for (const pending of pendingPages.values()) pending.response.resolve()
  }
})

test('复制预览识别目标后续页的重复歌曲并保留 ID 类型和真实计数', async ({
  page,
}, testInfo) => {
  const state = await installMockApi(page)
  const target = state.playlists.find(
    (playlist) => playlist.id === 'user:target',
  )
  if (!target) throw new Error('Target playlist is missing')
  target.songs = [
    ...Array.from({ length: 25 }, (_, index) =>
      song(`existing-${index}`, `已有歌曲 ${index}`),
    ),
    song(2, '数字歌曲'),
  ]
  state.snapshots.set(state.snapshotId, clonePlaylists(state.playlists))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/users/${userId}`)
  await page.getByLabel('目标歌单').selectOption('user:target')
  await page.getByLabel('选择 数字歌曲').check()
  await page.getByLabel('选择 字符串歌曲').check()
  await expect(page.getByLabel('复制预览')).toContainText(
    '将新增 1 首，跳过 1 首已存在歌曲。',
  )
  await expect(
    page.getByRole('row').filter({ hasText: '数字歌曲' }),
  ).toContainText('目标已包含')
  await expect(
    page.getByRole('row').filter({ hasText: '字符串歌曲' }),
  ).not.toContainText('目标已包含')
  await page.getByLabel('复制预览').scrollIntoViewIfNeeded()
  await page.screenshot({
    path: testInfo.outputPath('playlist-copy-preview-desktop.png'),
    animations: 'disabled',
  })
  await page.getByRole('button', { name: '复制', exact: true }).click()
  await expect(
    page.getByRole('status').filter({ hasText: '复制完成' }),
  ).toHaveText('复制完成：新增 1 首，跳过 1 首已存在歌曲。')
  expect(lastMutation(state, 'copy')?.body.songIds).toEqual([2, '2'])
  expect(target.songs.filter((item) => item.id === 2)).toHaveLength(1)
  expect(target.songs.filter((item) => item.id === '2')).toHaveLength(1)

  await page.getByLabel('选择 数字歌曲').check()
  await page.getByLabel('选择 字符串歌曲').check()
  await expect(page.getByLabel('复制预览')).toContainText(
    '所选的 2 首歌曲已全部在目标歌单中，无需复制。',
  )
  await expect(
    page.getByRole('button', { name: '复制', exact: true }),
  ).toBeDisabled()
  await expect(
    page.getByRole('button', { name: '移动', exact: true }),
  ).toBeEnabled()
  expect(mutationCount(state, 'copy')).toBe(1)

  await page.getByLabel('选择 数字歌曲').uncheck()
  await page.getByLabel('选择 字符串歌曲').uncheck()
  await page.getByLabel('选择 待移除歌曲').check()
  state.omitCopyCounts = true
  await page.getByRole('button', { name: '复制', exact: true }).click()
  await expect(
    page.getByRole('status').filter({ hasText: '复制已完成' }),
  ).toHaveText('复制已完成。')
  expect(target.songs.some((item) => item.id === 'remove-me')).toBe(true)
  expect(state.unhandled).toEqual([])
})

for (const changedScope of ['target', 'selection', 'snapshot'] as const) {
  test(`迟到的复制预览不能覆盖变化后的 ${changedScope}`, async ({ page }) => {
    const state = await installMockApi(page, 1)
    const requested = Promise.withResolvers<void>()
    const response = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<void>()
    let hold = true
    await page.route('**/song-copy-previews', async (route) => {
      if (!hold) return route.fallback()
      hold = false
      const body = requestBody(route.request())
      const preview = {
        ...copyPreviewResponse(state, 'default', body),
        addedSongCount: 0,
        skippedSongCount: 1,
        existingSongIds: [2],
      }
      requested.resolve()
      await response.promise
      try {
        await route.fulfill({ json: preview })
      } catch {
        // Changing the query key aborts this obsolete request.
      } finally {
        settled.resolve()
      }
    })
    await page.goto(`/users/${userId}`)
    await page.getByLabel('目标歌单').selectOption('user:target')
    await page.getByLabel('选择 数字歌曲').check()
    await requested.promise
    await expect(
      page.getByRole('button', { name: '复制', exact: true }),
    ).toBeDisabled()
    if (changedScope === 'target') {
      await page.getByLabel('目标歌单').selectOption('user:extra-1')
    } else if (changedScope === 'selection') {
      await page.getByLabel('选择 数字歌曲').uncheck()
      await page.getByLabel('选择 字符串歌曲').check()
    } else {
      advanceSnapshot(state)
      await page.getByRole('button', { name: '刷新', exact: true }).click()
      await expect(page.getByText('已选 0 首')).toBeVisible()
      await page.getByLabel('选择 数字歌曲').check()
    }
    await expect(page.getByLabel('复制预览')).toContainText(
      '将新增 1 首，跳过 0 首已存在歌曲。',
    )
    response.resolve()
    await settled.promise
    await expect(page.getByLabel('复制预览')).toContainText(
      '将新增 1 首，跳过 0 首已存在歌曲。',
    )
    await expect(page.getByText('目标已包含', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '复制', exact: true }).click()
    await expect(
      page.getByRole('status').filter({ hasText: '复制完成' }),
    ).toBeVisible()
    expect(lastMutation(state, 'copy')?.body).toMatchObject({
      targetPlaylistId:
        changedScope === 'target' ? 'user:extra-1' : 'user:target',
      songIds: changedScope === 'selection' ? ['2'] : [2],
    })
    expect(state.unhandled).toEqual([])
  })
}

test('复制预览失败可重试，提交冲突后刷新并重新选择', async ({ page }) => {
  const state = await installMockApi(page)
  state.failNextPreview = 503
  await page.goto(`/users/${userId}`)
  await page.getByLabel('选择 数字歌曲').check()
  await expect(page.getByRole('button', { name: '重试预览' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: '复制', exact: true }),
  ).toBeDisabled()
  expect(state.copyPreviews).toHaveLength(1)
  await page.getByRole('button', { name: '重试预览' }).click()
  await expect(page.getByLabel('复制预览')).toContainText(
    '将新增 1 首，跳过 0 首已存在歌曲。',
  )
  state.failNextCopy = true
  await page.getByRole('button', { name: '复制', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(
    '歌单已被其他设备或管理员更新',
  )
  await page.getByRole('button', { name: '立即刷新' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '复制', exact: true }),
  ).toBeDisabled()
  await page.getByLabel('选择 数字歌曲').check()
  await page.getByRole('button', { name: '复制', exact: true }).click()
  await expect(
    page.getByRole('status').filter({ hasText: '复制完成' }),
  ).toBeVisible()
  expect(mutationCount(state, 'copy')).toBe(1)
  expect(state.unhandled).toEqual([])
})

test('单歌单导出使用编码链接并保留完整快照歌曲和 metadata', async ({
  page,
}) => {
  const state = await installMockApi(page)
  const target = state.playlists.find(
    (playlist) => playlist.id === 'user:target',
  )
  if (!target) throw new Error('Target playlist is missing')
  target.id = 'user:旅行/#?'
  target.songs = Array.from({ length: 31 }, (_, index) => ({
    ...song(index + 1, `导出歌曲 ${index + 1}`),
    meta: { songId: index + 1, qualitys: ['flac'] },
  }))
  state.snapshots.set(state.snapshotId, clonePlaylists(state.playlists))
  await page.goto(`/users/${userId}`)
  await page.getByRole('button', { name: /目标歌单/ }).click()
  const exportLink = page.getByRole('link', { name: '导出完整歌单' })
  await expect(exportLink).toHaveAttribute(
    'href',
    `/api/v1/users/${userId}/playlists/user%3A%E6%97%85%E8%A1%8C%2F%23%3F/export?snapshotId=${state.snapshotId}`,
  )
  const exportHref = await exportLink.getAttribute('href')
  if (!exportHref) throw new Error('Playlist export URL is missing')
  await page.getByPlaceholder('歌曲 ID、名称或任意字段').fill('导出歌曲 31')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(
    page.getByRole('navigation', { name: '歌曲分页' }),
  ).toContainText('共 1 首')
  const exportedSnapshotId = state.snapshotId
  target.songs = []
  advanceSnapshot(state)
  const response = await page.evaluate(async (href) => {
    const result = await fetch(href)
    return {
      status: result.status,
      contentDisposition: result.headers.get('Content-Disposition'),
      body: await result.json(),
    }
  }, exportHref)
  expect(response.status).toBe(200)
  expect(response.contentDisposition).toBe(
    'attachment; filename="lx-sync-playlist.json"',
  )
  const exported = response.body as {
    snapshotId: string
    songs: Array<{ id: SongId; meta: unknown }>
  }
  expect(exported.snapshotId).toBe(exportedSnapshotId)
  expect(exported.songs).toHaveLength(31)
  expect(exported.songs[30]).toMatchObject({
    id: 31,
    meta: { songId: 31, qualitys: ['flac'] },
  })
  expect(state.mutations).toEqual([])
  expect(state.unhandled).toEqual([])
})

test('切换同名同音质歌单时丢弃旧草稿，即使歌曲详情仍在加载', async ({
  page,
}) => {
  const state = await installMockApi(page, 1)
  const playlists = state.playlists.filter(
    (playlist) => playlist.type === 'user',
  )
  for (const playlist of playlists) {
    playlist.name = '同名歌单'
    playlist.quality = 'flac'
  }
  state.snapshots.set(state.snapshotId, clonePlaylists(state.playlists))
  const browserErrors = collectBrowserErrors(page)
  const detailResponse = Promise.withResolvers<void>()
  const detailPath = `/api/v1/users/${userId}/playlists/user:extra-1`
  await page.route(
    (url) => decodeURIComponent(url.pathname) === detailPath,
    async (route) => {
      await detailResponse.promise
      await route.fallback()
    },
  )

  try {
    await page.goto(`/users/${userId}#user-playlists`)
    const playlistButtons = page
      .getByRole('complementary', { name: '歌单列表' })
      .getByRole('button', { name: /同名歌单/ })
    await playlistButtons.nth(0).click()
    await expect(page.getByLabel('歌单名称', { exact: true })).toHaveValue(
      '同名歌单',
    )
    await page.getByLabel('歌单名称', { exact: true }).fill('未保存的名称')
    await page.getByLabel('首选音质').selectOption('hires')

    const detailRequest = page.waitForRequest(
      (request) =>
        decodeURIComponent(new URL(request.url()).pathname) === detailPath,
    )
    await playlistButtons.nth(1).click()
    await detailRequest
    await expect(page.getByText('正在加载歌曲…', { exact: true })).toBeVisible()
    await expect(page.getByLabel('歌单名称', { exact: true })).toHaveValue(
      '同名歌单',
    )
    await expect(page.getByLabel('首选音质')).toHaveValue('flac')
    await expect(page.getByRole('button', { name: '保存修改' })).toBeDisabled()
    expect(state.mutations).toEqual([])
  } finally {
    detailResponse.resolve()
  }

  await expect(
    page.getByText('该歌单暂无歌曲。', { exact: true }),
  ).toBeVisible()
  expect(state.unhandled).toEqual([])
  expect(browserErrors).toEqual([])
})

for (const trigger of ['退出登录', '受保护请求失效'] as const) {
  test(`${trigger}后，迟到的会话轮询不能重新打开管理端`, async ({ page }) => {
    const state = await installMockApi(page)
    const browserErrors = collectBrowserErrors(page)
    const sessionResponse = Promise.withResolvers<void>()
    let holdSessionResponse = false
    await page.clock.install()
    await page.route('**/api/v1/auth/session', async (route) => {
      if (holdSessionResponse) await sessionResponse.promise
      await route.fallback()
    })

    try {
      await page.goto(`/users/${userId}`)
      await expect(
        page.getByRole('heading', { name: '测试用户', exact: true }),
      ).toBeVisible()
      holdSessionResponse = true
      const pollRequest = page.waitForRequest(
        (request) => new URL(request.url()).pathname === '/api/v1/auth/session',
      )
      await page.clock.fastForward(60_000)
      await pollRequest

      if (trigger === '退出登录') {
        await page.route('**/api/v1/auth/logout', (route) =>
          route.fulfill({ status: 204 }),
        )
        await page.getByRole('button', { name: '退出登录' }).click()
      } else {
        await page.route(`**/api/v1/users/${userId}/playlists`, (route) =>
          fulfillProblem(route, 401, 'AUTH_INVALID'),
        )
        await page.getByRole('button', { name: '刷新', exact: true }).click()
      }
      await expect(
        page.getByRole('heading', { name: '登录你的账号' }),
      ).toBeVisible()

      const lateResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/v1/auth/session',
      )
      sessionResponse.resolve()
      await (await lateResponse).finished()
      await page.clock.runFor(1_000)
      await expect(
        page.getByRole('heading', { name: '登录你的账号' }),
      ).toBeVisible()
      await expect(
        page.getByRole('heading', { name: '测试用户', exact: true }),
      ).toHaveCount(0)
    } finally {
      sessionResponse.resolve()
    }

    expect(state.unhandled).toEqual([])
    const expectedNetworkError =
      trigger === '受保护请求失效'
        ? 'Failed to load resource: the server responded with a status of 401 (Unauthorized)'
        : null
    expect(
      browserErrors.filter((error) => error !== expectedNetworkError),
    ).toEqual([])
  })
}

test('管理员可创建、改名、删除歌单并批量复制、移动、移除歌曲', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = await installMockApi(page)
  const browserErrors = collectBrowserErrors(page)
  page.on('dialog', (dialog) => dialog.accept())

  await page.goto(`/users/${userId}`)
  await expect(
    page.getByRole('heading', { name: '测试用户', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: '歌单管理', exact: true }),
  ).toBeVisible()

  await test.step('创建、改名并删除自建歌单', async () => {
    await page.getByPlaceholder('新建自建歌单').fill('临时歌单')
    await page.getByRole('button', { name: '新建', exact: true }).click()
    await expect(page.getByRole('button', { name: /临时歌单/ })).toBeVisible()

    await page.getByLabel('歌单名称', { exact: true }).fill('已重命名歌单')
    await page.getByLabel('首选音质').selectOption('hires')
    await page.getByRole('button', { name: '保存修改' }).click()
    await expect.poll(() => mutationCount(state, 'rename')).toBe(1)
    expect(lastMutation(state, 'rename')?.body.quality).toBe('hires')
    await expect(
      page.getByRole('button', { name: /已重命名歌单/ }),
    ).toBeVisible()

    await page.getByRole('button', { name: '删除歌单' }).click()
    await expect(
      page.getByRole('button', { name: /已重命名歌单/ }),
    ).toHaveCount(0)
  })

  await test.step('向空自建歌单添加字符串和数字平台歌曲', async () => {
    await page.getByRole('button', { name: /目标歌单/ }).click()
    await page.getByRole('button', { name: '添加歌曲' }).click()
    await page.getByLabel('音乐来源').selectOption('wy')
    await page.getByRole('radio', { name: '字符串', exact: true }).check()
    await page.getByLabel('平台歌曲 ID').fill('platform-2')
    await page.getByLabel('歌名').fill('字符串平台歌曲')
    await page.getByLabel('歌手', { exact: true }).fill('平台歌手')
    await page.getByLabel('专辑（可选）').fill('平台专辑')
    await page.getByLabel('时长（可选）').fill('3:45')
    await page.getByRole('button', { name: '添加到歌单' }).click()
    await expect.poll(() => mutationCount(state, 'add')).toBe(1)
    expect(lastMutation(state, 'add')?.body.id).toBe('platform-2')
    await expect(
      page.getByText('字符串平台歌曲', { exact: true }),
    ).toBeVisible()

    await page.getByRole('radio', { name: '数字', exact: true }).check()
    await page.getByLabel('平台歌曲 ID').fill('9002')
    await page.getByLabel('歌名').fill('数字平台歌曲')
    await page.getByLabel('歌手', { exact: true }).fill('平台歌手')
    await page.getByRole('button', { name: '添加到歌单' }).click()
    await expect.poll(() => mutationCount(state, 'add')).toBe(2)
    expect(lastMutation(state, 'add')?.body.id).toBe(9002)
    await expect(page.getByText('数字平台歌曲', { exact: true })).toBeVisible()

    await page.getByRole('radio', { name: '字符串', exact: true }).check()
    await page.getByLabel('平台歌曲 ID').fill('platform-2')
    await page.getByLabel('歌名').fill('重复平台歌曲')
    await page.getByLabel('歌手', { exact: true }).fill('平台歌手')
    await page.getByRole('button', { name: '添加到歌单' }).click()
    await expect(page.getByRole('alert')).toContainText(
      '该类型的歌曲 ID 已存在于当前歌单。',
    )
    expect(mutationCount(state, 'add')).toBe(2)

    state.failNextAdd = true
    const readsBeforeConflictRefresh = state.playlistReads
    await page.getByLabel('平台歌曲 ID').fill('after-conflict')
    await page.getByLabel('歌名').fill('冲突后歌曲')
    await page.getByRole('button', { name: '添加到歌单' }).click()
    await expect(page.getByRole('alert')).toContainText(
      '歌单已被其他设备或管理员更新，请刷新后重新操作。',
    )
    await page.getByRole('button', { name: '立即刷新' }).click()
    await expect
      .poll(() => state.playlistReads)
      .toBeGreaterThan(readsBeforeConflictRefresh)
    await expect(page.getByLabel('平台歌曲 ID')).toHaveValue('after-conflict')
    await page.getByRole('button', { name: '添加到歌单' }).click()
    await expect.poll(() => mutationCount(state, 'add')).toBe(3)
    await expect(page.getByText('冲突后歌曲', { exact: true })).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('playlist-add-song-desktop.png'),
      fullPage: false,
      animations: 'disabled',
    })
  })

  await test.step('按来源、歌手和专辑组合筛选当前歌单', async () => {
    await page.getByRole('button', { name: /默认列表/ }).click()
    await page.getByLabel('歌曲来源筛选').selectOption('wy')
    await page.getByPlaceholder('筛选歌手').fill('筛选歌手')
    await page.getByPlaceholder('筛选专辑').fill('筛选专辑')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await expect(page.getByText('筛选目标歌曲', { exact: true })).toBeVisible()
    await expect(page.getByText('数字歌曲', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '清除歌曲筛选' }).click()
    await expect(page.getByText('数字歌曲', { exact: true })).toBeVisible()

    await page.getByLabel('歌曲来源筛选').selectOption('mg')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await expect(
      page.getByText('没有匹配的歌曲。', { exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: '清除歌曲筛选' }).click()
  })

  await test.step('数字与字符串歌曲 ID 在复制和移动时保持区分', async () => {
    await page.getByRole('button', { name: /默认列表/ }).click()
    await page.getByLabel('选择 数字歌曲').check()
    await page.getByLabel('目标歌单').selectOption('user:target')
    await page.getByRole('button', { name: '复制', exact: true }).click()
    await expect.poll(() => mutationCount(state, 'copy')).toBe(1)
    expect(lastMutation(state, 'copy')?.body.songIds).toEqual([2])
    await expect(page.getByText('已选 0 首')).toBeVisible()

    await page.getByRole('button', { name: /目标歌单/ }).click()
    await expect(page.getByText('数字歌曲', { exact: true })).toBeVisible()
    await expect(page.getByText('字符串歌曲', { exact: true })).toHaveCount(0)

    await page.getByRole('button', { name: /默认列表/ }).click()
    await page.getByLabel('选择 字符串歌曲').check()
    await page.getByLabel('目标歌单').selectOption('user:target')
    await page.getByRole('button', { name: '移动', exact: true }).click()
    await expect.poll(() => mutationCount(state, 'move')).toBe(1)
    expect(lastMutation(state, 'move')?.body.songIds).toEqual(['2'])

    await page.getByRole('button', { name: /目标歌单/ }).click()
    await expect(page.getByText('数字歌曲', { exact: true })).toBeVisible()
    await expect(page.getByText('字符串歌曲', { exact: true })).toBeVisible()
  })

  await test.step('批量移除后刷新列表，并对 409 冲突给出恢复入口', async () => {
    await page.getByLabel('选择 数字歌曲').check()
    await page.getByRole('button', { name: '移除', exact: true }).click()
    await expect.poll(() => mutationCount(state, 'remove')).toBe(1)
    expect(lastMutation(state, 'remove')?.body.songIds).toEqual([2])
    await expect(page.getByText('数字歌曲', { exact: true })).toHaveCount(0)
    await expect(page.getByText('字符串歌曲', { exact: true })).toBeVisible()

    state.failNextRename = true
    const playlistReadsBeforeConflictRefresh = state.playlistReads
    await page.getByLabel('歌单名称', { exact: true }).fill('冲突名称')
    await page.getByRole('button', { name: '保存修改' }).click()
    await expect(page.getByRole('alert')).toContainText(
      '歌单已被其他设备或管理员更新，请刷新后重新操作。',
    )
    expect(state.renameRequests).toBe(2)

    await page.getByRole('button', { name: '立即刷新' }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect
      .poll(() => state.playlistReads)
      .toBeGreaterThan(playlistReadsBeforeConflictRefresh)
    await expect(page.getByLabel('歌单名称', { exact: true })).toHaveValue(
      '冲突名称',
    )
    await page.getByRole('button', { name: '保存修改' }).click()
    await expect(page.getByRole('button', { name: /冲突名称/ })).toBeVisible()
    expect(state.renameRequests).toBe(3)

    await page.getByLabel('选择 字符串歌曲').check()
    await page.getByLabel('目标歌单').selectOption('default')
    state.failNextCopy = true
    await page.getByRole('button', { name: '复制', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await page.getByRole('button', { name: '立即刷新' }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.getByLabel('选择 字符串歌曲').check()
    await page.getByLabel('目标歌单').selectOption('default')
    await page.getByRole('button', { name: '移动', exact: true }).click()
    await expect.poll(() => mutationCount(state, 'move')).toBe(2)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  await page.getByRole('heading', { name: '歌单管理' }).scrollIntoViewIfNeeded()
  const compactPlaylistLayout = await page
    .locator('.playlist-browser')
    .evaluate((element) => {
      const sidebar = element.querySelector<HTMLElement>('.playlist-sidebar')
      const content = element.querySelector<HTMLElement>('.playlist-content')
      if (!sidebar || !content) throw new Error('Playlist layout is incomplete')
      const sidebarBox = sidebar.getBoundingClientRect()
      const contentBox = content.getBoundingClientRect()
      return {
        sidebarHeight: sidebarBox.height,
        sidebarTop: sidebarBox.top,
        sidebarRight: sidebarBox.right,
        contentTop: contentBox.top,
        contentLeft: contentBox.left,
      }
    })
  expect(compactPlaylistLayout.sidebarHeight).toBeGreaterThan(220)
  expect(compactPlaylistLayout.contentLeft).toBeGreaterThanOrEqual(
    compactPlaylistLayout.sidebarRight - 1,
  )
  expect(
    Math.abs(
      compactPlaylistLayout.contentTop - compactPlaylistLayout.sidebarTop,
    ),
  ).toBeLessThanOrEqual(1)
  await page.screenshot({
    path: testInfo.outputPath('playlist-management-desktop.png'),
    fullPage: false,
    animations: 'disabled',
  })

  expect(state.unhandled).toEqual([])
  expect(
    browserErrors.filter((message) => !message.includes('409 (Conflict)')),
  ).toEqual([])
  expect(
    browserErrors.filter((message) => message.includes('409 (Conflict)')),
  ).toHaveLength(4)
})

test('侧栏分组展示二级入口并定位现有管理区域', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installMockApi(page, 4)
  const browserErrors = collectBrowserErrors(page)

  await page.goto('/')
  const navigation = page.getByRole('navigation', { name: '主导航' })
  await expect(navigation.getByText('同步管理', { exact: true })).toBeVisible()
  await expect(navigation.getByRole('link', { name: '服务概况' })).toBeVisible()
  await expect(navigation.getByRole('link', { name: '同步用户' })).toBeVisible()
  await expect(navigation.getByRole('link', { name: '新增用户' })).toBeVisible()

  await navigation.getByRole('link', { name: '同步用户' }).click()
  await expect(page).toHaveURL(/#users$/)
  await expect(
    navigation.getByRole('link', { name: '同步用户' }),
  ).toHaveAttribute('aria-current', 'location')
  await expect(page.locator('#users')).toBeInViewport()

  await page.goto(`/users/${userId}`)
  await expect(navigation.getByText('当前用户', { exact: true })).toBeVisible()
  for (const label of ['用户设置', '设备管理', '歌单管理', '快照历史'])
    await expect(navigation.getByRole('link', { name: label })).toBeVisible()

  await navigation.getByRole('link', { name: '歌单管理' }).click()
  await expect(page).toHaveURL(/#user-playlists$/)
  await expect(
    navigation.getByRole('link', { name: '歌单管理' }),
  ).toHaveAttribute('aria-current', 'location')
  await expect(page.locator('#user-playlists')).toBeInViewport()
  await page.screenshot({
    path: testInfo.outputPath('sidebar-secondary-navigation-1440x900.png'),
    fullPage: false,
    animations: 'disabled',
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/users/${userId}`)
  await page.getByRole('button', { name: '打开导航' }).click()
  await expect(navigation.getByRole('link', { name: '设备管理' })).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('sidebar-secondary-navigation-open-390x844.png'),
    fullPage: false,
    animations: 'disabled',
  })
  await navigation.getByRole('link', { name: '设备管理' }).click()
  await expect(page).toHaveURL(/#user-devices$/)
  await expect(page.locator('.sidebar')).not.toHaveClass(/open/)
  await expect(page.locator('#user-devices')).toBeInViewport()
  await page.screenshot({
    path: testInfo.outputPath('sidebar-secondary-navigation-390x844.png'),
    fullPage: false,
    animations: 'disabled',
  })

  expect(browserErrors).toEqual([])
})

test('歌单管理在桌面、平板和手机视口保持可操作', async ({ page }, testInfo) => {
  const state = await installMockApi(page, 18)
  const browserErrors = collectBrowserErrors(page)
  const viewports = [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ] as const

  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    await page.goto(`/users/${userId}`)
    const pageTitle = page.getByRole('heading', {
      name: '测试用户',
      exact: true,
    })
    const playlistHeading = page.getByRole('heading', {
      name: '歌单管理',
      exact: true,
    })
    await expect(pageTitle).toBeVisible()
    await expect(playlistHeading).toBeVisible()

    const pageTitleSize = await pageTitle.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    )
    expect(pageTitleSize).toBe(viewport.width <= 680 ? 24 : 28)

    const typography = await page.evaluate(() => {
      const body = getComputedStyle(document.body)
      const captionElement = document.querySelector<HTMLElement>(
        '.playlist-manager .eyebrow',
      )
      const caption = captionElement
        ? getComputedStyle(captionElement)
        : undefined
      return {
        body: Number.parseFloat(body.fontSize),
        bodyLineHeight: Number.parseFloat(body.lineHeight),
        caption: caption ? Number.parseFloat(caption.fontSize) : 0,
        isIosWebKit: CSS.supports('-webkit-touch-callout', 'none'),
      }
    })
    const expectedBodyTypography =
      viewport.width > 680
        ? { fontSize: 14, lineHeight: 20 }
        : typography.isIosWebKit
          ? { fontSize: 17, lineHeight: 22 }
          : { fontSize: 16, lineHeight: 24 }
    expect(typography.body).toBe(expectedBodyTypography.fontSize)
    expect(typography.bodyLineHeight).toBe(expectedBodyTypography.lineHeight)
    expect(typography.caption).toBeGreaterThanOrEqual(
      viewport.width <= 680 ? 14 : 13,
    )

    const openNavigation = page.getByRole('button', { name: '打开导航' })
    if (viewport.width <= 1024) {
      await expect(openNavigation).toBeVisible()
      const box = await openNavigation.boundingBox()
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44)
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
    } else {
      await expect(openNavigation).toBeHidden()
    }

    await playlistHeading.scrollIntoViewIfNeeded()
    const hasPageOverflow = await page.evaluate(() => {
      const scrollingElement =
        document.scrollingElement ?? document.documentElement
      return scrollingElement.scrollWidth > scrollingElement.clientWidth + 1
    })
    expect(hasPageOverflow).toBe(false)

    const playlistList = page.locator('.playlist-list')
    await expect(playlistList).toHaveCSS('overflow-y', 'auto')
    const scrollMetrics = await playlistList.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      columns: getComputedStyle(element)
        .gridTemplateColumns.split(' ')
        .filter(Boolean).length,
    }))
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(
      scrollMetrics.clientHeight,
    )
    expect(scrollMetrics.columns).toBe(
      viewport.width > 1024 || viewport.width <= 680 ? 1 : 2,
    )

    if (viewport.width > 1024) {
      const desktopLayout = await page
        .locator('.playlist-browser')
        .evaluate((element) => {
          const sidebar =
            element.querySelector<HTMLElement>('.playlist-sidebar')
          const content =
            element.querySelector<HTMLElement>('.playlist-content')
          if (!sidebar || !content)
            throw new Error('Playlist layout is incomplete')
          const browserBox = element.getBoundingClientRect()
          const sidebarBox = sidebar.getBoundingClientRect()
          const contentBox = content.getBoundingClientRect()
          return {
            browserWidth: browserBox.width,
            sidebarWidth: sidebarBox.width,
            sidebarTop: sidebarBox.top,
            sidebarRight: sidebarBox.right,
            contentTop: contentBox.top,
            contentLeft: contentBox.left,
          }
        })
      expect(desktopLayout.sidebarWidth).toBeGreaterThanOrEqual(220)
      expect(desktopLayout.sidebarWidth).toBeLessThanOrEqual(
        desktopLayout.browserWidth - 300,
      )
      expect(desktopLayout.contentLeft).toBeGreaterThanOrEqual(
        desktopLayout.sidebarRight - 1,
      )
      expect(
        Math.abs(desktopLayout.contentTop - desktopLayout.sidebarTop),
      ).toBeLessThanOrEqual(1)

      const desktopSidebarWidth = await page
        .locator('.sidebar')
        .evaluate((element) => element.getBoundingClientRect().width)
      expect(desktopSidebarWidth).toBeLessThanOrEqual(240)
    }

    if (viewport.width <= 680) {
      const inputFontSize = await page
        .getByPlaceholder('新建自建歌单')
        .evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).fontSize),
        )
      expect(inputFontSize).toBeGreaterThanOrEqual(16)

      const targetPlaylistSelect = page.getByLabel('目标歌单')
      const targetPlaylistSelectBox = await targetPlaylistSelect.boundingBox()
      expect(targetPlaylistSelectBox?.height ?? 0).toBeGreaterThanOrEqual(44)
      expect(
        targetPlaylistSelectBox?.height ?? Number.POSITIVE_INFINITY,
      ).toBeLessThanOrEqual(48)

      const longIdMetrics = await page
        .getByText(longSongId, { exact: true })
        .evaluate((element) => ({
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          overflowWrap: getComputedStyle(element).overflowWrap,
        }))
      expect(longIdMetrics.overflowWrap).toBe('anywhere')
      expect(longIdMetrics.scrollWidth).toBeLessThanOrEqual(
        longIdMetrics.clientWidth + 1,
      )

      await page.getByRole('button', { name: /目标歌单/ }).click()
      await expect(page.getByRole('button', { name: '添加歌曲' })).toBeVisible()
      await page.getByRole('button', { name: '添加歌曲' }).click()
      await expect(page.getByLabel('平台歌曲 ID')).toBeVisible()
      const addSongInputFontSize = await page
        .getByLabel('平台歌曲 ID')
        .evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).fontSize),
        )
      expect(addSongInputFontSize).toBeGreaterThanOrEqual(16)
      const hasOpenFormOverflow = await page.evaluate(() => {
        const scrollingElement =
          document.scrollingElement ?? document.documentElement
        return scrollingElement.scrollWidth > scrollingElement.clientWidth + 1
      })
      expect(hasOpenFormOverflow).toBe(false)
      await page.screenshot({
        path: testInfo.outputPath(
          `playlist-add-song-${viewport.width}x${viewport.height}.png`,
        ),
        fullPage: false,
        animations: 'disabled',
      })
      await page.getByRole('button', { name: '关闭添加歌曲' }).click()
    }

    if (viewport.width === 390) {
      await openNavigation.focus()
      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')
      expect(
        await page.evaluate(() =>
          document
            .querySelector('#main-navigation')
            ?.contains(document.activeElement),
        ),
      ).toBe(false)

      await openNavigation.click()
      await expect(page.locator('.sidebar-close')).toBeFocused()
      await expect(page.locator('.mobile-header')).toHaveAttribute('inert', '')
      await expect(page.locator('.workspace')).toHaveAttribute('inert', '')
      await page.keyboard.press('Shift+Tab')
      expect(
        await page.evaluate(() =>
          document
            .querySelector('#main-navigation')
            ?.contains(document.activeElement),
        ),
      ).toBe(true)
      await page.keyboard.press('Tab')
      await expect(page.locator('.sidebar-close')).toBeFocused()
      await page.locator('.sidebar-backdrop').click({
        position: { x: 380, y: 400 },
      })
      await expect(page.getByRole('button', { name: '打开导航' })).toBeFocused()
      await page.getByRole('button', { name: '打开导航' }).click()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: '打开导航' })).toBeFocused()
    }

    await page.screenshot({
      path: testInfo.outputPath(
        `playlist-management-${viewport.width}x${viewport.height}.png`,
      ),
      fullPage: false,
      animations: 'disabled',
    })
  }

  expect(state.unhandled).toEqual([])
  expect(browserErrors).toEqual([])
})

async function installMockApi(
  page: Page,
  extraPlaylistCount = 0,
): Promise<MockState> {
  const state = createMockState(extraPlaylistCount)
  await page.route('**/api/v1/**', (route) => handleApi(route, state))
  return state
}

function createMockState(extraPlaylistCount: number): MockState {
  const extraPlaylists = Array.from(
    { length: extraPlaylistCount },
    (_, index): MockPlaylist => ({
      id: `user:extra-${index + 1}`,
      name: `扩展歌单 ${index + 1}`,
      type: 'user',
      quality: null,
      songs: [],
    }),
  )
  const playlists: MockPlaylist[] = [
    {
      id: 'default',
      name: '默认列表',
      type: 'default',
      quality: null,
      songs: [
        song(2, '数字歌曲'),
        song('2', '字符串歌曲'),
        song('remove-me', '待移除歌曲'),
        song(longSongId, '长标识歌曲'),
        {
          ...song('filter-target', '筛选目标歌曲'),
          singer: '筛选歌手',
          albumName: '筛选专辑',
          source: 'wy',
        },
      ],
    },
    {
      id: 'love',
      name: '收藏列表',
      type: 'love',
      quality: null,
      songs: [],
    },
    {
      id: 'user:target',
      name: '目标歌单',
      type: 'user',
      quality: null,
      songs: [],
    },
    ...extraPlaylists,
  ]
  const initialSnapshotId = snapshotId(1)
  return {
    snapshotIndex: 1,
    snapshotId: initialSnapshotId,
    playlists,
    snapshots: new Map([[initialSnapshotId, clonePlaylists(playlists)]]),
    failNextRename: false,
    failNextCopy: false,
    failNextAdd: false,
    playlistReads: 0,
    renameRequests: 0,
    addRequests: 0,
    copyPreviews: [],
    failNextPreview: null,
    omitCopyCounts: false,
    mutations: [],
    unhandled: [],
  }
}

async function handleApi(route: Route, state: MockState): Promise<void> {
  const request = route.request()
  const method = request.method()
  const url = new URL(request.url())
  const path = decodeURIComponent(url.pathname)
  const playlistCollection = `/api/v1/users/${userId}/playlists`
  const playlistPrefix = `${playlistCollection}/`

  if (method === 'GET' && path === '/api/v1/auth/session') {
    await route.fulfill({
      json: { username: 'admin', expiresAt: '2026-07-24T08:00:00.000Z' },
    })
    return
  }
  if (method === 'GET' && path === '/api/v1/status') {
    await route.fulfill({
      json: {
        serverId: 'mock-server',
        serverName: 'LX Sync',
        startedAt: createdAt,
        onlineDevices: 1,
        syncBasePath: '/sync',
      },
    })
    return
  }
  if (method === 'GET' && path === '/api/v1/users') {
    await route.fulfill({
      json: {
        data: [
          {
            id: userId,
            name: '测试用户',
            enabled: true,
            maxSnapshots: 20,
            addMusicLocationType: 'bottom',
            deviceCount: 1,
            createdAt,
            syncPath: `/sync/${userId}`,
          },
        ],
      },
    })
    return
  }
  if (method === 'GET' && path === `/api/v1/users/${userId}/devices`) {
    await route.fulfill({ json: { data: [] } })
    return
  }
  if (
    method === 'GET' &&
    path === `/api/v1/users/${userId}/sync-domains/list/snapshots`
  ) {
    await route.fulfill({ json: { data: [snapshotSummary(state)] } })
    return
  }
  if (
    method === 'GET' &&
    path === `/api/v1/users/${userId}/sync-domains/dislike/snapshots`
  ) {
    await route.fulfill({
      json: {
        data: [
          {
            id: snapshotId(99),
            hash: 'dislike-hash',
            itemCount: 0,
            byteSize: 2,
            sourceDeviceId: null,
            createdAt,
          },
        ],
      },
    })
    return
  }
  if (method === 'GET' && path === '/api/v1/audit-events') {
    await route.fulfill({ json: { data: [] } })
    return
  }
  if (method === 'GET' && path === playlistCollection) {
    state.playlistReads += 1
    await route.fulfill({ json: playlistListResponse(state) })
    return
  }
  if (method === 'POST' && path === playlistCollection) {
    const body = requestBody(request)
    if (!(await requireCurrentSnapshot(route, body, state))) return
    const playlist: MockPlaylist = {
      id: 'user:created',
      name: stringField(body, 'name'),
      type: 'user',
      quality: null,
      songs: [],
    }
    state.playlists.push(playlist)
    state.mutations.push({ action: 'create', body })
    advanceSnapshot(state)
    await route.fulfill({ status: 201, json: upsertResponse(state, playlist) })
    return
  }
  if (path.startsWith(playlistPrefix)) {
    const [encodedPlaylistId, action] = url.pathname
      .slice(playlistPrefix.length)
      .split('/')
    const playlistId = decodeURIComponent(encodedPlaylistId ?? '')

    if (method === 'GET' && (action === undefined || action === 'export')) {
      const requestedSnapshotId = url.searchParams.get('snapshotId') ?? ''
      const snapshotPlaylists = state.snapshots.get(requestedSnapshotId)
      if (!snapshotPlaylists) {
        await fulfillProblem(route, 404, 'SNAPSHOT_NOT_FOUND')
        return
      }
      const playlist = snapshotPlaylists.find((item) => item.id === playlistId)
      if (!playlist) {
        await fulfillProblem(route, 404, 'PLAYLIST_NOT_FOUND')
        return
      }
      if (action === 'export') {
        await route.fulfill({
          contentType: 'application/json; charset=utf-8',
          headers: {
            'Content-Disposition':
              'attachment; filename="lx-sync-playlist.json"',
          },
          json: {
            format: 'lx-sync.playlist',
            version: 1,
            userId,
            snapshotId: requestedSnapshotId,
            snapshotCreatedAt: createdAt,
            playlist: {
              id: playlist.id,
              type: playlist.type,
              name: playlist.name,
              songCount: playlist.songs.length,
              metadata:
                playlist.type === 'user'
                  ? {
                      id: playlist.id.replace(/^user:/, ''),
                      name: playlist.name,
                      locationUpdateTime: null,
                    }
                  : null,
            },
            songs: playlist.songs,
          },
        })
      } else {
        await route.fulfill({
          json: playlistDetailResponse(requestedSnapshotId, playlist, url),
        })
      }
      return
    }

    const body = requestBody(request)
    if (!(await requireCurrentSnapshot(route, body, state))) return
    const playlist = state.playlists.find((item) => item.id === playlistId)
    if (!playlist) {
      await fulfillProblem(route, 404, 'PLAYLIST_NOT_FOUND')
      return
    }

    if (method === 'PATCH' && action === undefined) {
      state.renameRequests += 1
      if (state.failNextRename) {
        state.failNextRename = false
        advanceSnapshot(state)
        await fulfillProblem(route, 409, 'SNAPSHOT_CONFLICT')
        return
      }
      playlist.name = stringField(body, 'name')
      if (typeof body.quality === 'string' || body.quality === null)
        playlist.quality = body.quality
      state.mutations.push({ action: 'rename', body })
      advanceSnapshot(state)
      await route.fulfill({ json: upsertResponse(state, playlist) })
      return
    }

    if (method === 'DELETE' && action === undefined) {
      state.playlists = state.playlists.filter(
        (item) => item.id !== playlist.id,
      )
      state.mutations.push({ action: 'delete', body })
      advanceSnapshot(state)
      await route.fulfill({ json: mutationResponse(state) })
      return
    }

    if (method === 'POST' && action === 'songs') {
      state.addRequests += 1
      if (state.failNextAdd) {
        state.failNextAdd = false
        advanceSnapshot(state)
        await fulfillProblem(route, 409, 'SNAPSHOT_CONFLICT')
        return
      }
      const id = body.id
      if (typeof id !== 'string' && typeof id !== 'number')
        throw new Error('Expected string or number song ID')
      if (playlist.songs.some((item) => item.id === id)) {
        await fulfillProblem(route, 409, 'SONG_ALREADY_EXISTS')
        return
      }
      const interval = body.interval
      if (typeof interval !== 'string' && interval !== null)
        throw new Error('Expected string or null interval')
      playlist.songs.push({
        id,
        source: stringField(body, 'source'),
        name: stringField(body, 'name'),
        singer: stringField(body, 'singer'),
        albumName: stringField(body, 'albumName'),
        interval,
      })
      state.mutations.push({ action: 'add', body })
      advanceSnapshot(state)
      await route.fulfill({
        status: 201,
        json: { ...mutationResponse(state), affectedSongCount: 1 },
      })
      return
    }

    const songIds = songIdsField(body)
    if (method === 'POST' && action === 'song-copy-previews') {
      state.copyPreviews.push({ playlistId, body })
      if (state.failNextPreview !== null) {
        const status = state.failNextPreview
        state.failNextPreview = null
        await fulfillProblem(
          route,
          status,
          status === 409 ? 'SNAPSHOT_CONFLICT' : 'PREVIEW_UNAVAILABLE',
        )
        return
      }
      await route.fulfill({
        json: copyPreviewResponse(state, playlistId, body),
      })
      return
    }
    if (method === 'DELETE' && action === 'songs') {
      playlist.songs = playlist.songs.filter(
        (item) => !songIds.some((songId) => songId === item.id),
      )
      state.mutations.push({ action: 'remove', body })
      advanceSnapshot(state)
      await route.fulfill({
        json: { ...mutationResponse(state), affectedSongCount: songIds.length },
      })
      return
    }

    if (
      method === 'POST' &&
      (action === 'song-moves' || action === 'song-copies')
    ) {
      if (action === 'song-copies' && state.failNextCopy) {
        state.failNextCopy = false
        advanceSnapshot(state)
        await fulfillProblem(route, 409, 'SNAPSHOT_CONFLICT')
        return
      }
      const targetId = stringField(body, 'targetPlaylistId')
      const target = state.playlists.find((item) => item.id === targetId)
      if (!target) {
        await fulfillProblem(route, 404, 'PLAYLIST_NOT_FOUND')
        return
      }
      const selectedSongs = songIds.map((songId) => {
        const selected = playlist.songs.find((item) => item.id === songId)
        if (!selected) throw new Error(`Mock song ${String(songId)} is missing`)
        return { ...selected }
      })
      const addedSongs = selectedSongs.filter(
        (selected) => !target.songs.some((item) => item.id === selected.id),
      )
      target.songs.push(...addedSongs)
      const mutationAction = action === 'song-moves' ? 'move' : 'copy'
      if (mutationAction === 'move')
        playlist.songs = playlist.songs.filter(
          (item) => !songIds.some((songId) => songId === item.id),
        )
      state.mutations.push({ action: mutationAction, body })
      advanceSnapshot(state)
      await route.fulfill({
        json: {
          ...mutationResponse(state),
          affectedSongCount: songIds.length,
          ...(mutationAction === 'copy' && !state.omitCopyCounts
            ? {
                addedSongCount: addedSongs.length,
                skippedSongCount: songIds.length - addedSongs.length,
              }
            : {}),
        },
      })
      return
    }
  }

  state.unhandled.push(`${method} ${path}`)
  await fulfillProblem(route, 501, 'MOCK_ROUTE_MISSING')
}

function playlistListResponse(state: MockState) {
  return {
    snapshotId: state.snapshotId,
    snapshotCreatedAt: createdAt,
    data: state.playlists.map(playlistSummary),
  }
}

function copyPreviewResponse(
  state: MockState,
  playlistId: string,
  body: Record<string, unknown>,
) {
  const targetId = stringField(body, 'targetPlaylistId')
  const target = state.playlists.find((item) => item.id === targetId)
  if (!target) throw new Error('Mock preview target is missing')
  const songIds = songIdsField(body)
  const existingSongIds = songIds.filter((id) =>
    target.songs.some((item) => item.id === id),
  )
  return {
    ...mutationResponse(state),
    sourcePlaylistId: playlistId,
    targetPlaylistId: targetId,
    requestedSongCount: songIds.length,
    addedSongCount: songIds.length - existingSongIds.length,
    skippedSongCount: existingSongIds.length,
    existingSongIds,
  }
}

function playlistDetailResponse(
  requestedSnapshotId: string,
  playlist: MockPlaylist,
  url: URL,
) {
  const query = (url.searchParams.get('q') ?? '').trim().toLocaleLowerCase()
  const source = url.searchParams.get('source') ?? ''
  const singer = (url.searchParams.get('singer') ?? '')
    .trim()
    .toLocaleLowerCase()
  const albumName = (url.searchParams.get('albumName') ?? '')
    .trim()
    .toLocaleLowerCase()
  const offset = Number(url.searchParams.get('offset') ?? 0)
  const limit = Number(url.searchParams.get('limit') ?? 25)
  const songs = playlist.songs
    .map((item, index) => ({ ...item, position: index + 1 }))
    .filter(
      (item) =>
        [item.id, item.name, item.singer, item.albumName, item.source].some(
          (value) =>
            value !== null && String(value).toLocaleLowerCase().includes(query),
        ) &&
        (source === '' || item.source === source) &&
        (singer === '' || item.singer?.toLocaleLowerCase().includes(singer)) &&
        (albumName === '' ||
          item.albumName?.toLocaleLowerCase().includes(albumName)),
    )
  return {
    snapshotId: requestedSnapshotId,
    snapshotCreatedAt: createdAt,
    playlist: playlistSummary(playlist),
    offset,
    limit,
    total: songs.length,
    data: songs.slice(offset, offset + limit),
  }
}

function playlistSummary(playlist: MockPlaylist) {
  return {
    id: playlist.id,
    name: playlist.name,
    type: playlist.type,
    quality: playlist.quality,
    songCount: playlist.songs.length,
  }
}

function mutationResponse(state: MockState) {
  return { snapshotId: state.snapshotId, snapshotCreatedAt: createdAt }
}

function upsertResponse(state: MockState, playlist: MockPlaylist) {
  return { ...mutationResponse(state), playlist: playlistSummary(playlist) }
}

function snapshotSummary(state: MockState) {
  return {
    id: state.snapshotId,
    hash: `hash-${state.snapshotIndex}`,
    itemCount: state.playlists.reduce(
      (count, playlist) => count + playlist.songs.length,
      0,
    ),
    byteSize: 256,
    sourceDeviceId: null,
    createdAt,
  }
}

async function requireCurrentSnapshot(
  route: Route,
  body: Record<string, unknown>,
  state: MockState,
): Promise<boolean> {
  if (body.expectedSnapshotId === state.snapshotId) return true
  await fulfillProblem(route, 409, 'SNAPSHOT_CONFLICT')
  return false
}

async function fulfillProblem(
  route: Route,
  status: number,
  code: string,
): Promise<void> {
  await route.fulfill({
    status,
    json: { status, code, detail: code, requestId: 'mock-request' },
  })
}

function requestBody(request: Request): Record<string, unknown> {
  const raw: unknown = JSON.parse(request.postData() ?? '{}')
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('Expected a JSON object request body')
  return raw as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string') throw new Error(`Expected string field ${key}`)
  return value
}

function songIdsField(body: Record<string, unknown>): SongId[] {
  const value = body.songIds
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' && typeof item !== 'number')
  )
    throw new Error('Expected string or number songIds')
  return value
}

function advanceSnapshot(state: MockState): void {
  state.snapshotIndex += 1
  state.snapshotId = snapshotId(state.snapshotIndex)
  state.snapshots.set(state.snapshotId, clonePlaylists(state.playlists))
}

function clonePlaylists(playlists: MockPlaylist[]): MockPlaylist[] {
  return playlists.map((playlist) => ({
    ...playlist,
    songs: playlist.songs.map((item) => ({ ...item })),
  }))
}

function snapshotId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function song(id: SongId, name: string): MockSong {
  return {
    id,
    name,
    singer: '测试歌手',
    albumName: '测试专辑',
    source: 'tx',
    interval: '03:30',
  }
}

function mutationCount(
  state: MockState,
  action: MutationRecord['action'],
): number {
  return state.mutations.filter((item) => item.action === action).length
}

function lastMutation(
  state: MockState,
  action: MutationRecord['action'],
): MutationRecord | undefined {
  return state.mutations.findLast((item) => item.action === action)
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}
