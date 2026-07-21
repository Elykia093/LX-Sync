import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'

const adminUsername = requiredEnvironment('ADMIN_USERNAME')
const adminPassword = requiredEnvironment('ADMIN_PASSWORD')

test('管理员可从失败登录恢复并完成用户管理与审计旅程', async ({ page }) => {
  const userName = `e2e-${randomUUID().slice(0, 12)}`
  const connectionCode = `code-${randomUUID()}`

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
      page.getByRole('heading', { name: new RegExp(adminUsername) }),
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

  await test.step('审计记录包含创建和设置更新', async () => {
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
