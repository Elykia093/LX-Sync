import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

const adminUsername = requiredEnvironment('ADMIN_USERNAME')
const adminPassword = requiredEnvironment('ADMIN_PASSWORD')

test('管理员可从失败登录恢复并完成用户管理与审计旅程', async ({ page }) => {
  const userName = `e2e-${randomUUID().slice(0, 12)}`
  const connectionCode = `code-${randomUUID()}`
  let userId = ''

  await test.step('错误登录返回可恢复的认证错误', async () => {
    await page.goto('/')
    await expect(
      page.getByRole('heading', { name: '登录你的账号' }),
    ).toBeVisible()

    await page.getByLabel('管理员账号').fill(adminUsername)
    await page.getByLabel('管理员密码').fill('incorrect-e2e-password')
    const loginResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/auth/login',
    )
    await page.getByRole('button', { name: '登录', exact: true }).click()

    expect((await loginResponse).status()).toBe(401)
    await expect(page.getByRole('alert')).toContainText('Authentication failed')
  })

  await test.step('管理员登录并创建唯一同步用户', async () => {
    await page.getByLabel('管理员密码').fill(adminPassword)
    const loginResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/auth/login',
    )
    await page.getByRole('button', { name: '登录', exact: true }).click()

    expect((await loginResponse).status()).toBe(200)
    await expect(
      page.getByRole('heading', { name: '仪表盘', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('img', { name: `当前管理员：${adminUsername}` }),
    ).toBeVisible()

    await page.getByLabel('用户名称').fill(userName)
    await page.getByLabel('连接访问码', { exact: true }).fill(connectionCode)
    await page.getByLabel('快照保留数（留空使用服务默认）').fill('7')
    await page.getByLabel('新增歌曲位置').selectOption('top')
    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/users',
    )
    await page.getByRole('button', { name: '创建用户' }).click()

    const createResponse = await createResponsePromise
    expect(createResponse.status()).toBe(201)
    const createdUser = (await createResponse.json()) as { id: string }
    userId = createdUser.id
    expect(createdUser.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    await expect(
      page.getByRole('link', { name: new RegExp(userName) }),
    ).toBeVisible()
  })

  await test.step('用户详情设置可更新并在刷新后持久化', async () => {
    await page.getByRole('link', { name: new RegExp(userName) }).click()
    await expect(page).toHaveURL(/\/users\/[0-9a-f-]+$/i)
    await expect(
      page.getByRole('heading', { name: userName, exact: true }),
    ).toBeVisible()

    await page.getByLabel('快照保留数', { exact: true }).fill('17')
    await page.getByLabel('新增歌曲位置').selectOption('bottom')
    const updateResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        /\/api\/v1\/users\/[0-9a-f-]+$/i.test(new URL(response.url()).pathname),
    )
    await page.getByRole('button', { name: '保存设置' }).click()

    const updateResponse = await updateResponsePromise
    expect(updateResponse.status()).toBe(200)
    expect(await updateResponse.json()).toMatchObject({
      name: userName,
      enabled: true,
      maxSnapshots: 17,
      addMusicLocationType: 'bottom',
    })

    await page.reload()
    await expect(
      page.getByRole('heading', { name: userName, exact: true }),
    ).toBeVisible()
    await expect(page.getByLabel('快照保留数', { exact: true })).toHaveValue(
      '17',
    )
    await expect(page.getByLabel('新增歌曲位置')).toHaveValue('bottom')
  })

  await test.step('歌单写入、组合筛选和快照导出贯通真实服务', async () => {
    const playlistName = `e2e-playlist-${randomUUID().slice(0, 8)}`
    const songId = `e2e-song-${randomUUID().slice(0, 8)}`
    const songName = 'E2E 平台歌曲'
    const singer = 'E2E 歌手'
    const albumName = 'E2E 专辑'

    await page.getByPlaceholder('新建自建歌单').fill(playlistName)
    const createPlaylistResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          `/api/v1/users/${userId}/playlists`,
    )
    await page.getByRole('button', { name: '新建', exact: true }).click()

    const createPlaylistResponse = await createPlaylistResponsePromise
    expect(createPlaylistResponse.status()).toBe(201)
    const createdPlaylist = (await createPlaylistResponse.json()) as {
      playlist: { id: string; name: string }
    }
    expect(createdPlaylist.playlist.name).toBe(playlistName)
    await expect(
      page.getByRole('button', { name: new RegExp(playlistName) }),
    ).toBeVisible()

    await page.getByRole('button', { name: '添加歌曲' }).click()
    await page.getByLabel('平台歌曲 ID').fill(songId)
    await page.getByLabel('歌名', { exact: true }).fill(songName)
    await page.getByLabel('歌手', { exact: true }).fill(singer)
    await page.getByLabel('专辑（可选）').fill(albumName)
    await page.getByLabel('时长（可选）').fill('3:45')
    const addSongResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          `/api/v1/users/${userId}/playlists/${encodeURIComponent(createdPlaylist.playlist.id)}/songs`,
    )
    await page.getByRole('button', { name: '添加到歌单' }).click()

    const addSongResponse = await addSongResponsePromise
    expect(addSongResponse.status()).toBe(201)
    expect(await addSongResponse.json()).toMatchObject({ affectedSongCount: 1 })
    await expect(
      page.getByRole('row').filter({ hasText: songId }),
    ).toContainText(songName)

    await page.getByLabel('歌曲来源筛选').selectOption('wy')
    await page.getByLabel('歌手筛选').fill(singer)
    await page.getByLabel('专辑筛选').fill(albumName)
    const filterResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return (
        response.request().method() === 'GET' &&
        url.pathname ===
          `/api/v1/users/${userId}/playlists/${encodeURIComponent(createdPlaylist.playlist.id)}` &&
        url.searchParams.get('source') === 'wy' &&
        url.searchParams.get('singer') === singer &&
        url.searchParams.get('albumName') === albumName
      )
    })
    await page.getByRole('button', { name: '搜索', exact: true }).click()

    const filterResponse = await filterResponsePromise
    expect(filterResponse.status()).toBe(200)
    expect(await filterResponse.json()).toMatchObject({ total: 1 })
    await expect(
      page.getByRole('row').filter({ hasText: songId }),
    ).toContainText(singer)

    const listSnapshotPanel = page
      .getByRole('heading', { name: '歌单快照', exact: true })
      .locator('..')
    const downloadPromise = page.waitForEvent('download')
    await listSnapshotPanel
      .getByRole('link', { name: '导出', exact: true })
      .first()
      .click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(
      /^lx-sync-list-[0-9a-f-]+\.json$/i,
    )
    const downloadPath = await download.path()
    expect(downloadPath).not.toBeNull()
    const exported = JSON.parse(
      await readFile(downloadPath as string, 'utf8'),
    ) as {
      format: string
      version: number
      userId: string
      domain: string
      snapshot: { data: { userList: Array<{ id: string }> } }
    }
    expect(exported).toMatchObject({
      format: 'lx-sync.snapshot',
      version: 1,
      userId,
      domain: 'list',
    })
    expect(exported.snapshot.data.userList).toContainEqual(
      expect.objectContaining({
        id: createdPlaylist.playlist.id.replace(/^user:/, ''),
      }),
    )
  })

  await test.step('审计记录包含用户和歌单写入', async () => {
    const auditResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/v1/audit-events',
    )
    await page.getByRole('link', { name: '审计记录' }).click()

    expect((await auditResponsePromise).status()).toBe(200)
    await expect(
      page.getByRole('heading', { name: '审计记录', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('cell', { name: 'user.create', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('cell', { name: 'user.update', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('cell', { name: 'playlist.create', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('cell', { name: 'playlist.songs.add', exact: true }),
    ).toBeVisible()
  })

  await test.step('退出后返回登录页', async () => {
    const logoutResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/auth/logout',
    )
    await page.getByRole('button', { name: '退出登录' }).click()

    expect((await logoutResponsePromise).status()).toBe(204)
    await expect(
      page.getByRole('heading', { name: '登录你的账号' }),
    ).toBeVisible()
  })
})

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for browser E2E`)
  return value
}
