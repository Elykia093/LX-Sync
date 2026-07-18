import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { FormEvent, InputHTMLAttributes, ReactNode } from 'react'
import {
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from 'react-router-dom'
import {
  ApiError,
  api,
  type Device,
  type Session,
  type Snapshot,
  type SyncUser,
} from './api.js'

export const queryKeys = {
  session: ['session'] as const,
  status: ['status'] as const,
  users: ['users'] as const,
  devices: (userId: string) => ['devices', userId] as const,
  snapshots: (userId: string, domain: string) =>
    ['snapshots', userId, domain] as const,
  audit: ['audit'] as const,
}

export function sessionLoginError(error: unknown): ApiError | null {
  return error instanceof ApiError && [401, 502, 503].includes(error.status)
    ? error
    : null
}

export function App() {
  const session = useQuery<Session | null>({
    queryKey: queryKeys.session,
    queryFn: api.session,
    retry: false,
    refetchInterval: 60_000,
  })
  if (session.isPending) return <Centered>正在读取会话…</Centered>
  if (session.data === null) return <LoginPage serviceError={null} />
  const loginError = sessionLoginError(session.error)
  if (loginError)
    return (
      <LoginPage serviceError={loginError.status === 401 ? null : loginError} />
    )
  if (session.error)
    return (
      <Centered>
        <ErrorMessage error={session.error} />
      </Centered>
    )

  return (
    <AppShell username={session.data.username}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/users/:userId" element={<UserDetail />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}

function LoginPage({ serviceError }: { serviceError: ApiError | null }) {
  const queryClient = useQueryClient()
  const login = useMutation({
    mutationFn: api.login,
    onSuccess: (session) =>
      queryClient.setQueryData(queryKeys.session, session),
  })

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    login.mutate({
      username: String(form.get('username') ?? ''),
      password: String(form.get('password') ?? ''),
    })
  }

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <p className="eyebrow">SELF-HOSTED SYNC</p>
        <h1 id="login-title">LX Sync</h1>
        <p className="muted">登录后管理同步用户、设备与快照。</p>
        {serviceError && (
          <p className="notice error" role="status">
            后端服务未连接，当前仅可预览登录界面（HTTP {serviceError.status}）。
          </p>
        )}
        <form className="stack" onSubmit={submit}>
          <Field
            label="管理员账号"
            name="username"
            autoComplete="username"
            required
          />
          <Field
            label="管理员密码"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          {login.error && <ErrorMessage error={login.error} />}
          <button className="primary" type="submit" disabled={login.isPending}>
            {login.isPending ? '登录中…' : '登录'}
          </button>
        </form>
      </section>
    </main>
  )
}

function AppShell({
  username,
  children,
}: {
  username: string
  children: ReactNode
}) {
  const queryClient = useQueryClient()
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => applyLoggedOutState(queryClient),
  })

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/">
          LX Sync
        </Link>
        <nav aria-label="主导航">
          <Link to="/">概览</Link>
          <Link to="/audit">审计</Link>
        </nav>
        <div className="account">
          <span>{username}</span>
          <button
            className="text-button"
            type="button"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            退出
          </button>
        </div>
      </header>
      {logout.error && (
        <div className="shell-notice">
          <ErrorMessage error={logout.error} />
        </div>
      )}
      <main className="content">{children}</main>
    </div>
  )
}

function Dashboard() {
  const queryClient = useQueryClient()
  const status = useQuery({
    queryKey: queryKeys.status,
    queryFn: api.status,
    refetchInterval: 15_000,
  })
  const users = useQuery({ queryKey: queryKeys.users, queryFn: api.users })
  const create = useMutation({
    mutationFn: api.createUser,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.users }),
  })

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const target = event.currentTarget
    const form = new FormData(target)
    const maxSnapshots = String(form.get('maxSnapshots') ?? '').trim()
    create.mutate(
      {
        name: String(form.get('name') ?? ''),
        connectionCode: String(form.get('connectionCode') ?? ''),
        ...(maxSnapshots === '' ? {} : { maxSnapshots: Number(maxSnapshots) }),
        addMusicLocationType:
          form.get('addMusicLocationType') === 'top' ? 'top' : 'bottom',
      },
      { onSuccess: () => target.reset() },
    )
  }

  return (
    <>
      <PageHeader
        title="服务概览"
        description="管理 LX Music v4 同步账号与运行状态。"
      />
      <section className="metric-grid" aria-label="服务状态">
        <Metric
          label="服务状态"
          value={
            status.isSuccess ? '运行中' : status.isError ? '不可用' : '读取中'
          }
        />
        <Metric label="在线设备" value={status.data?.onlineDevices ?? '—'} />
        <Metric label="同步用户" value={users.data?.data.length ?? '—'} />
        <Metric
          label="启动时间"
          value={status.data ? formatDate(status.data.startedAt) : '—'}
        />
      </section>
      {(status.error || users.error) && (
        <ErrorMessage error={status.error ?? users.error} />
      )}

      <div className="two-column">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">USERS</p>
              <h2>同步用户</h2>
            </div>
          </div>
          {users.isPending ? (
            <p className="muted">正在加载…</p>
          ) : users.data?.data.length ? (
            <div className="user-list">
              {users.data.data.map((user) => (
                <Link
                  className="user-row"
                  to={`/users/${user.id}`}
                  key={user.id}
                >
                  <span>
                    <strong>{user.name}</strong>
                    <small>{user.deviceCount} 台有效设备</small>
                  </span>
                  <span className={user.enabled ? 'badge success' : 'badge'}>
                    {user.enabled ? '启用' : '停用'}
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <Empty>还没有同步用户。</Empty>
          )}
        </section>

        <section className="panel">
          <p className="eyebrow">CREATE</p>
          <h2>新增同步用户</h2>
          <form className="stack" onSubmit={submit}>
            <Field label="用户名称" name="name" maxLength={64} required />
            <Field
              label="连接访问码"
              name="connectionCode"
              type="password"
              minLength={8}
              maxLength={256}
              required
            />
            <div className="form-grid">
              <Field
                label="快照保留数（留空使用服务默认）"
                name="maxSnapshots"
                type="number"
                min={1}
                max={1000}
                placeholder="服务默认"
              />
              <label>
                新增歌曲位置
                <select name="addMusicLocationType" defaultValue="bottom">
                  <option value="bottom">底部</option>
                  <option value="top">顶部</option>
                </select>
              </label>
            </div>
            {create.error && <ErrorMessage error={create.error} />}
            <button
              className="primary"
              type="submit"
              disabled={create.isPending}
            >
              {create.isPending ? '创建中…' : '创建用户'}
            </button>
          </form>
        </section>
      </div>
    </>
  )
}

function UserDetail() {
  const { userId } = useParams()
  const users = useQuery({ queryKey: queryKeys.users, queryFn: api.users })
  if (!userId) return <Navigate to="/" replace />
  if (users.isPending) return <Centered>正在加载用户…</Centered>
  if (users.error) return <ErrorMessage error={users.error} />
  const user = users.data.data.find((item) => item.id === userId)
  if (!user) return <Empty>用户不存在或已不可见。</Empty>
  return <UserDetailContent user={user} />
}

function UserDetailContent({ user }: { user: SyncUser }) {
  const queryClient = useQueryClient()
  const devices = useQuery({
    queryKey: queryKeys.devices(user.id),
    queryFn: () => api.devices(user.id),
  })
  const update = useMutation({
    mutationFn: (input: {
      enabled: boolean
      maxSnapshots: number
      addMusicLocationType: 'top' | 'bottom'
    }) => api.updateUser(user.id, input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.users }),
  })
  const rotate = useMutation({
    mutationFn: (code: string) => api.rotateCredential(user.id, code),
  })
  const revoke = useMutation({
    mutationFn: (clientId: string) => api.revokeDevice(user.id, clientId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.devices(user.id),
      })
      void queryClient.invalidateQueries({ queryKey: queryKeys.users })
    },
  })

  const saveSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    update.mutate({
      enabled: form.get('enabled') === 'on',
      maxSnapshots: Number(form.get('maxSnapshots')),
      addMusicLocationType:
        form.get('addMusicLocationType') === 'top' ? 'top' : 'bottom',
    })
  }

  const rotateCredential = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!window.confirm('轮换后旧访问码立即失效，并会断开在线设备。继续吗？'))
      return
    const target = event.currentTarget
    rotate.mutate(String(new FormData(target).get('connectionCode') ?? ''), {
      onSuccess: () => target.reset(),
    })
  }

  return (
    <>
      <PageHeader
        title={user.name}
        description={`创建于 ${formatDate(user.createdAt)} · ${user.deviceCount} 台有效设备`}
        back
      />
      <div className="two-column">
        <section className="panel">
          <p className="eyebrow">SETTINGS</p>
          <h2>同步设置</h2>
          <form className="stack" onSubmit={saveSettings}>
            <label className="checkbox">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={user.enabled}
              />
              允许设备连接
            </label>
            <Field
              label="快照保留数"
              name="maxSnapshots"
              type="number"
              min={1}
              max={1000}
              defaultValue={user.maxSnapshots}
              required
            />
            <label>
              新增歌曲位置
              <select
                name="addMusicLocationType"
                defaultValue={user.addMusicLocationType}
              >
                <option value="bottom">底部</option>
                <option value="top">顶部</option>
              </select>
            </label>
            {update.error && <ErrorMessage error={update.error} />}
            <button
              className="primary"
              type="submit"
              disabled={update.isPending}
            >
              {update.isPending ? '保存中…' : '保存设置'}
            </button>
          </form>
        </section>
        <section className="panel">
          <p className="eyebrow">CREDENTIAL</p>
          <h2>轮换连接访问码</h2>
          <p className="muted">
            轮换后会断开该用户的在线设备；旧访问码立即失效。
          </p>
          <form className="stack" onSubmit={rotateCredential}>
            <Field
              label="新连接访问码"
              name="connectionCode"
              type="password"
              minLength={8}
              maxLength={256}
              required
            />
            {rotate.error && <ErrorMessage error={rotate.error} />}
            {rotate.isSuccess && (
              <p className="notice success-text">访问码已轮换。</p>
            )}
            <button
              className="secondary"
              type="submit"
              disabled={rotate.isPending}
            >
              {rotate.isPending ? '轮换中…' : '轮换访问码'}
            </button>
          </form>
        </section>
      </div>

      <section className="panel section-gap">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">DEVICES</p>
            <h2>设备</h2>
          </div>
        </div>
        {devices.error && <ErrorMessage error={devices.error} />}
        {revoke.error && <ErrorMessage error={revoke.error} />}
        {devices.data?.data.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>设备</th>
                  <th>类型</th>
                  <th>最后连接</th>
                  <th>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {devices.data.data.map((device) => (
                  <DeviceRow
                    key={device.clientId}
                    device={device}
                    pending={revoke.isPending}
                    onRevoke={() => {
                      if (
                        window.confirm(
                          `撤销设备“${device.deviceName}”后，该设备需要重新登记。继续吗？`,
                        )
                      )
                        revoke.mutate(device.clientId)
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>暂无已登记设备。</Empty>
        )}
      </section>

      <div className="two-column section-gap">
        <SnapshotPanel userId={user.id} domain="list" title="歌单快照" />
        <SnapshotPanel
          userId={user.id}
          domain="dislike"
          title="不喜欢规则快照"
        />
      </div>
    </>
  )
}

function DeviceRow({
  device,
  pending,
  onRevoke,
}: {
  device: Device
  pending: boolean
  onRevoke: () => void
}) {
  return (
    <tr>
      <td>
        <strong>{device.deviceName}</strong>
        <small className="block mono">{shortId(device.clientId)}</small>
      </td>
      <td>{device.isMobile ? '移动端' : '桌面端'}</td>
      <td>
        {device.lastConnectAt ? formatDate(device.lastConnectAt) : '从未连接'}
      </td>
      <td className="actions">
        <button
          className="danger"
          type="button"
          onClick={onRevoke}
          disabled={pending || device.revokedAt !== null}
        >
          {device.revokedAt ? '已撤销' : '撤销'}
        </button>
      </td>
    </tr>
  )
}

function SnapshotPanel({
  userId,
  domain,
  title,
}: {
  userId: string
  domain: 'list' | 'dislike'
  title: string
}) {
  const queryClient = useQueryClient()
  const snapshots = useQuery({
    queryKey: queryKeys.snapshots(userId, domain),
    queryFn: () => api.snapshots(userId, domain),
  })
  const restore = useMutation({
    mutationFn: (snapshotId: string) =>
      api.restoreSnapshot(userId, domain, snapshotId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.snapshots(userId, domain),
      }),
  })
  return (
    <section className="panel">
      <p className="eyebrow">SNAPSHOTS</p>
      <h2>{title}</h2>
      {snapshots.error && <ErrorMessage error={snapshots.error} />}
      {restore.error && <ErrorMessage error={restore.error} />}
      <div className="snapshot-list">
        {snapshots.data?.data.map((snapshot: Snapshot) => (
          <div className="snapshot-row" key={snapshot.id}>
            <span>
              <strong>{formatDate(snapshot.createdAt)}</strong>
              <small>
                {snapshot.itemCount} 项 · {formatBytes(snapshot.byteSize)}
              </small>
            </span>
            <button
              className="text-button"
              type="button"
              disabled={restore.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    `恢复 ${formatDate(snapshot.createdAt)} 的快照会替换当前 ${title} 并断开相关在线设备。继续吗？`,
                  )
                )
                  restore.mutate(snapshot.id)
              }}
            >
              恢复
            </button>
          </div>
        ))}
        {!snapshots.isPending && !snapshots.data?.data.length && (
          <Empty>暂无快照。</Empty>
        )}
      </div>
    </section>
  )
}

function AuditPage() {
  const audit = useQuery({
    queryKey: queryKeys.audit,
    queryFn: api.auditEvents,
  })
  return (
    <>
      <PageHeader
        title="审计记录"
        description="管理端关键写操作，不包含访问码或会话值。"
      />
      <section className="panel">
        {audit.error && <ErrorMessage error={audit.error} />}
        {audit.data?.data.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作者</th>
                  <th>动作</th>
                  <th>对象</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.data.map((event) => (
                  <tr key={event.id}>
                    <td>{formatDate(event.createdAt)}</td>
                    <td>{event.actor}</td>
                    <td>
                      <code>{event.action}</code>
                    </td>
                    <td>
                      {event.targetId
                        ? shortId(event.targetId)
                        : event.targetType}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !audit.isPending && <Empty>暂无审计记录。</Empty>
        )}
      </section>
    </>
  )
}

function PageHeader({
  title,
  description,
  back = false,
}: {
  title: string
  description: string
  back?: boolean
}) {
  const navigate = useNavigate()
  return (
    <header className="page-header">
      {back && (
        <button
          className="back"
          type="button"
          onClick={() => navigate(-1)}
          aria-label="返回"
        >
          ←
        </button>
      )}
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
    </header>
  )
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function Field({
  label,
  name,
  ...props
}: { label: string; name: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label>
      {label}
      <input name={name} {...props} />
    </label>
  )
}

function ErrorMessage({ error }: { error: unknown }) {
  const message =
    error instanceof ApiError
      ? `${error.message}${error.requestId ? ` · ${error.requestId}` : ''}`
      : error instanceof Error
        ? error.message
        : '发生未知错误'
  return (
    <p className="notice error" role="alert">
      {message}
    </p>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <main className="centered">{children}</main>
}
function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}
function formatBytes(value: number) {
  return value < 1024
    ? `${value} B`
    : value < 1024 ** 2
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 ** 2).toFixed(1)} MB`
}
function shortId(value: string) {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value
}

export function applyLoggedOutState(queryClient: QueryClient): void {
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== queryKeys.session[0],
  })
  queryClient.setQueryData<Session | null>(queryKeys.session, null)
}
