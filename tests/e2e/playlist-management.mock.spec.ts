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
  mutations: MutationRecord[]
  unhandled: string[]
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
    await page.getByRole('button', { name: '保存名称' }).click()
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
    await page.getByRole('button', { name: '保存名称' }).click()
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
    await page.getByRole('button', { name: '保存名称' }).click()
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
      songs: [],
    }),
  )
  const playlists: MockPlaylist[] = [
    {
      id: 'default',
      name: '默认列表',
      type: 'default',
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
      songs: [],
    },
    {
      id: 'user:target',
      name: '目标歌单',
      type: 'user',
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
      songs: [],
    }
    state.playlists.push(playlist)
    state.mutations.push({ action: 'create', body })
    advanceSnapshot(state)
    await route.fulfill({ status: 201, json: upsertResponse(state, playlist) })
    return
  }
  if (path.startsWith(playlistPrefix)) {
    const [playlistId, action] = path.slice(playlistPrefix.length).split('/')

    if (method === 'GET' && action === undefined) {
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
      await route.fulfill({
        json: playlistDetailResponse(requestedSnapshotId, playlist, url),
      })
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
      target.songs.push(...selectedSongs)
      const mutationAction = action === 'song-moves' ? 'move' : 'copy'
      if (mutationAction === 'move')
        playlist.songs = playlist.songs.filter(
          (item) => !songIds.some((songId) => songId === item.id),
        )
      state.mutations.push({ action: mutationAction, body })
      advanceSnapshot(state)
      await route.fulfill({
        json: { ...mutationResponse(state), affectedSongCount: songIds.length },
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
