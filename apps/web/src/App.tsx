import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  Activity,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Home,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Menu,
  Plus,
  Radio,
  ScrollText,
  Settings2,
  UsersRound,
  X,
} from 'lucide-react'
import {
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useState,
} from 'react'
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
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
  sessionExpiredEventName,
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
  const queryClient = useQueryClient()
  const session = useQuery<Session | null>({
    queryKey: queryKeys.session,
    queryFn: api.session,
    retry: false,
    refetchInterval: 60_000,
  })
  useEffect(() => {
    const expireSession = () => applyLoggedOutState(queryClient)
    window.addEventListener(sessionExpiredEventName, expireSession)
    return () =>
      window.removeEventListener(sessionExpiredEventName, expireSession)
  }, [queryClient])

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
        <Route
          path="/"
          element={<Dashboard username={session.data.username} />}
        />
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
        <div className="login-card-body">
          <div className="login-brand">
            <span className="brand-mark large">LX</span>
            <strong>LX Sync</strong>
          </div>
          <div className="login-heading">
            <h1 id="login-title">登录你的账号</h1>
            <p>进入 LX Sync 管理控制台</p>
          </div>
          {serviceError && (
            <p className="notice error" role="status">
              后端服务未连接，当前仅可预览登录界面（HTTP {serviceError.status}
              ）。
            </p>
          )}
          <form className="stack login-form" onSubmit={submit}>
            <Field
              label="管理员账号"
              name="username"
              placeholder="请输入管理员账号"
              autoComplete="username"
              required
            />
            <Field
              label="管理员密码"
              name="password"
              placeholder="请输入管理员密码"
              type="password"
              autoComplete="current-password"
              required
            />
            {login.error && <ErrorMessage error={login.error} />}
            <button
              className="primary login-submit"
              type="submit"
              disabled={login.isPending}
            >
              {login.isPending ? '登录中…' : '登录'}
            </button>
          </form>
        </div>
        <footer className="login-card-footer">自托管 LX Music 同步服务</footer>
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
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => applyLoggedOutState(queryClient),
  })
  const routeTitle = location.pathname.startsWith('/users/')
    ? '用户详情'
    : location.pathname === '/audit'
      ? '审计记录'
      : '概览'

  useEffect(() => {
    if (!location.hash) return
    document
      .getElementById(location.hash.slice(1))
      ?.scrollIntoView({ block: 'start' })
  }, [location.hash])

  return (
    <div className="app-shell">
      <header className="mobile-header">
        <Link
          className="mobile-brand"
          to="/"
          aria-label="LX Sync 概览"
          onClick={() => setSidebarOpen(false)}
        >
          <span className="brand-mark compact">LX</span>
          <span>
            <strong>LX Sync</strong>
            <small>{routeTitle}</small>
          </span>
        </Link>
        <button
          className="menu-toggle"
          type="button"
          aria-label={sidebarOpen ? '关闭导航' : '打开导航'}
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          {sidebarOpen ? (
            <X aria-hidden="true" size={20} />
          ) : (
            <Menu aria-hidden="true" size={20} />
          )}
        </button>
      </header>
      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <Link
          className="sidebar-brand"
          to="/"
          aria-label="LX Sync 概览"
          onClick={() => setSidebarOpen(false)}
        >
          <span className="brand-mark">LX</span>
          <strong>LX Sync</strong>
          <span className="admin-pill">Admin</span>
        </Link>
        <button
          className="sidebar-close"
          type="button"
          aria-label="关闭导航"
          onClick={() => setSidebarOpen(false)}
        >
          <X aria-hidden="true" size={19} />
        </button>
        <div className="sidebar-profile">
          <span className="profile-avatar">
            {username.slice(0, 1).toUpperCase()}
            <i aria-hidden="true" />
          </span>
          <span>
            <strong>{username}</strong>
            <small>系统管理员</small>
          </span>
        </div>
        <nav aria-label="主导航">
          <div className="nav-group">
            <div className="nav-group-title">
              <LayoutDashboard aria-hidden="true" size={16} />
              <span>概览</span>
              <ChevronDown aria-hidden="true" size={16} />
            </div>
            <div className="nav-group-items">
              <NavLink
                to="/"
                end
                onClick={() => setSidebarOpen(false)}
                className={({ isActive }) =>
                  isActive || location.pathname.startsWith('/users/')
                    ? 'active'
                    : undefined
                }
              >
                <Home aria-hidden="true" size={16} />
                <span>首页</span>
              </NavLink>
            </div>
          </div>
          <div className="nav-group">
            <div className="nav-group-title">
              <Settings2 aria-hidden="true" size={16} />
              <span>系统管理</span>
              <ChevronDown aria-hidden="true" size={16} />
            </div>
            <div className="nav-group-items">
              <NavLink to="/audit" onClick={() => setSidebarOpen(false)}>
                <ScrollText aria-hidden="true" size={16} />
                <span>审计记录</span>
              </NavLink>
            </div>
          </div>
        </nav>
        <div className="sidebar-footer">
          <div className="connection-state">
            <span aria-hidden="true" />
            <div>
              <strong>服务已连接</strong>
              <small>{username}</small>
            </div>
          </div>
          <button
            className="sidebar-action"
            type="button"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            <LogOut aria-hidden="true" size={17} />
            <span>{logout.isPending ? '退出中…' : '退出登录'}</span>
          </button>
        </div>
      </aside>
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          type="button"
          aria-label="关闭导航"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <section className="workspace">
        {logout.error && (
          <div className="shell-notice">
            <ErrorMessage error={logout.error} />
          </div>
        )}
        <main className="content">{children}</main>
      </section>
    </div>
  )
}

function Dashboard({ username }: { username: string }) {
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
        title={`${getGreeting()}，${username}`}
        description="这是您的同步服务数据概览"
        actions={
          <div className="page-actions">
            <a className="button primary" href="#new-user">
              <Plus aria-hidden="true" size={16} />
              新增用户
            </a>
          </div>
        }
      />
      <section className="metric-grid" aria-label="服务状态">
        <Metric
          label="同步用户"
          value={users.data?.data.length ?? '—'}
          detail="已配置同步账号"
          icon={UsersRound}
          tone="site"
        />
        <Metric
          label="在线设备"
          value={status.data?.onlineDevices ?? '—'}
          detail="当前有效连接"
          icon={Radio}
          tone="success"
        />
        <Metric
          label="服务状态"
          value={
            status.isSuccess ? '运行中' : status.isError ? '不可用' : '读取中'
          }
          detail="每 15 秒自动刷新"
          icon={Activity}
          tone={status.isError ? 'danger' : 'info'}
        />
        <Metric
          label="启动时间"
          value={status.data ? '已启动' : '—'}
          detail={
            status.data ? formatDate(status.data.startedAt) : '等待服务数据'
          }
          icon={Clock3}
          tone="info"
        />
      </section>
      {status.error && <ErrorMessage error={status.error} />}

      <div className="two-column">
        <section className="panel" id="users">
          <div className="panel-heading">
            <div>
              <h2>同步用户</h2>
              <p>管理访问码、设备与快照</p>
            </div>
          </div>
          {users.error ? (
            <ErrorMessage error={users.error} />
          ) : users.isPending ? (
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

        <section className="panel" id="new-user">
          <div className="panel-heading">
            <div>
              <h2>新增同步用户</h2>
              <p>创建账号并配置同步策略</p>
            </div>
          </div>
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
          <SyncAddress syncPath={user.syncPath} />
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
        {revoke.error && <ErrorMessage error={revoke.error} />}
        {devices.error ? (
          <ErrorMessage error={devices.error} />
        ) : devices.isPending ? (
          <p className="muted">正在加载设备…</p>
        ) : devices.data?.data.length ? (
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

function SyncAddress({ syncPath }: { syncPath: string | null }) {
  const [copied, setCopied] = useState(false)
  const address = syncAddress(window.location.origin, syncPath)

  const copyAddress = async () => {
    if (!navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="sync-address">
      <span>同步服务地址</span>
      <div className="sync-address-value">
        <code>{address}</code>
        <button
          type="button"
          className="icon-button"
          title="复制同步服务地址"
          aria-label="复制同步服务地址"
          onClick={() => void copyAddress()}
        >
          {copied ? (
            <Check aria-hidden="true" size={17} />
          ) : (
            <Copy aria-hidden="true" size={17} />
          )}
        </button>
      </div>
      <small>{syncPath ? '独立同步路径已启用' : '使用兼容根路径'}</small>
    </div>
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
        {snapshots.isPending ? (
          <p className="muted">正在加载快照…</p>
        ) : snapshots.error ? null : snapshots.data?.data.length ? (
          snapshots.data.data.map((snapshot: Snapshot) => (
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
          ))
        ) : (
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
        {audit.error ? (
          <ErrorMessage error={audit.error} />
        ) : audit.isPending ? (
          <p className="muted">正在加载审计记录…</p>
        ) : audit.data?.data.length ? (
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
          <Empty>暂无审计记录。</Empty>
        )}
      </section>
    </>
  )
}

function PageHeader({
  title,
  description,
  back = false,
  actions,
}: {
  title: string
  description: string
  back?: boolean
  actions?: ReactNode
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
      {actions}
    </header>
  )
}

function Metric({
  label,
  value,
  detail,
  icon: Icon,
  tone,
}: {
  label: string
  value: ReactNode
  detail: string
  icon: LucideIcon
  tone: 'site' | 'success' | 'danger' | 'info'
}) {
  return (
    <article className={`metric metric-${tone}`}>
      <div className="metric-heading">
        <span>{label}</span>
        <span className="metric-icon">
          <Icon aria-hidden="true" size={16} />
        </span>
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
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

function getGreeting() {
  const hour = new Date().getHours()
  if (hour < 6) return '夜深了'
  if (hour < 9) return '早上好'
  if (hour < 12) return '上午好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  if (hour < 22) return '晚上好'
  return '夜深了'
}

export function applyLoggedOutState(queryClient: QueryClient): void {
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== queryKeys.session[0],
  })
  queryClient.setQueryData<Session | null>(queryKeys.session, null)
}

export function syncAddress(origin: string, syncPath: string | null): string {
  return `${origin}${syncPath ?? ''}`
}
