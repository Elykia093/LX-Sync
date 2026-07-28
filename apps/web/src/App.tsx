import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  Activity,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  Info,
  LayoutDashboard,
  ListMusic,
  LogOut,
  type LucideIcon,
  Menu,
  Monitor,
  MoveRight,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  ScrollText,
  Search,
  Server,
  Trash2,
  UsersRound,
  X,
} from 'lucide-react'
import {
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useRef,
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
  type ManagedSongSource,
  type PlaylistSong,
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
  playlists: (userId: string) => ['playlists', userId] as const,
  playlistSongs: (
    userId: string,
    playlistId: string,
    snapshotId: string,
    q: string,
    source: string,
    singer: string,
    albumName: string,
    offset: number,
    limit: number,
  ) =>
    [
      'playlist-songs',
      userId,
      playlistId,
      snapshotId,
      q,
      source,
      singer,
      albumName,
      offset,
      limit,
    ] as const,
  snapshots: (userId: string, domain: string) =>
    ['snapshots', userId, domain] as const,
  audit: ['audit'] as const,
}

const playlistPageSize = 25
type ManagedSongIdKind = 'string' | 'number'
const managedSongIdPattern = /^[A-Za-z0-9_-]+$/
const managedSongIdContentPattern = /[A-Za-z0-9]/
const pseudoSongIdPattern = /^(?:unknown|local|temp|undefined|null)(?:[_-]|$)/i
const managedNumericSongIdPattern = /^\d+$/
const managedIntervalPattern = /^\d{1,3}:[0-5]\d$/

export function managedSongIdFromForm(
  kind: ManagedSongIdKind,
  rawValue: string,
): string | number | null {
  const value = rawValue.trim()
  if (kind === 'string')
    return value.length > 0 &&
      value.length <= 1024 &&
      managedSongIdPattern.test(value) &&
      managedSongIdContentPattern.test(value) &&
      !pseudoSongIdPattern.test(value)
      ? value
      : null
  const numericValue = Number(value)
  return value.length > 0 &&
    managedNumericSongIdPattern.test(value) &&
    Number.isSafeInteger(numericValue) &&
    numericValue > 0
    ? numericValue
    : null
}

export async function invalidatePlaylistManagementQueries(
  queryClient: QueryClient,
  userId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.playlists(userId) }),
    queryClient.invalidateQueries({ queryKey: ['playlist-songs', userId] }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.snapshots(userId, 'list'),
    }),
    queryClient.invalidateQueries({ queryKey: queryKeys.audit }),
  ])
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
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const sidebarCloseRef = useRef<HTMLButtonElement>(null)
  const serviceStatus = useQuery({
    queryKey: queryKeys.status,
    queryFn: api.status,
    refetchInterval: 15_000,
  })
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => applyLoggedOutState(queryClient),
  })
  const routeTitle = location.pathname.startsWith('/users/')
    ? '用户详情'
    : location.pathname === '/audit'
      ? '审计记录'
      : '概览'

  const closeSidebar = () => {
    setSidebarOpen(false)
    requestAnimationFrame(() => menuButtonRef.current?.focus())
  }

  useEffect(() => {
    if (!location.hash) return
    document
      .getElementById(location.hash.slice(1))
      ?.scrollIntoView({ block: 'start' })
  }, [location.hash])
  useEffect(() => {
    if (!sidebarOpen) return
    sidebarCloseRef.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setSidebarOpen(false)
      requestAnimationFrame(() => menuButtonRef.current?.focus())
    }
    const keepFocusInsideSidebar = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const sidebar = sidebarRef.current
      if (!sidebar) return
      const focusable = Array.from(
        sidebar.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (element) =>
          !element.hasAttribute('hidden') &&
          element.getAttribute('aria-hidden') !== 'true' &&
          element.offsetParent !== null,
      )
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      if (!sidebar.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    window.addEventListener('keydown', keepFocusInsideSidebar)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('keydown', keepFocusInsideSidebar)
    }
  }, [sidebarOpen])
  const serviceStatusLabel = serviceStatus.isPending
    ? '正在读取服务状态'
    : serviceStatus.isError
      ? '服务连接异常'
      : '服务已连接'

  return (
    <div className="app-shell">
      <header
        className="mobile-header"
        aria-hidden={sidebarOpen || undefined}
        inert={sidebarOpen || undefined}
      >
        <div className="topbar-left">
          <button
            ref={menuButtonRef}
            className="menu-toggle"
            type="button"
            aria-label={sidebarOpen ? '关闭导航' : '打开导航'}
            aria-expanded={sidebarOpen}
            aria-controls="main-navigation"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            {sidebarOpen ? (
              <X aria-hidden="true" size={20} />
            ) : (
              <Menu aria-hidden="true" size={20} />
            )}
          </button>
          <Link
            className="mobile-brand"
            to="/"
            aria-label="LX Sync 概览"
            onClick={() => setSidebarOpen(false)}
          >
            <span className="brand-mark compact">LX</span>
            <span>
              <strong>LX Sync</strong>
              <small>管理平台</small>
            </span>
          </Link>
          <div className="topbar-context">
            <BookOpen aria-hidden="true" size={18} />
            <span>{routeTitle}</span>
          </div>
        </div>
        <div className="topbar-actions">
          <span
            className={`topbar-status${serviceStatus.isPending ? ' loading' : serviceStatus.isError ? ' error' : ''}`}
            title={serviceStatusLabel}
            role="status"
            aria-label={serviceStatusLabel}
          >
            <Monitor aria-hidden="true" size={18} />
            <i aria-hidden="true" />
          </span>
          <span
            className="topbar-avatar"
            title={username}
            role="img"
            aria-label={`当前管理员：${username}`}
          >
            {username.slice(0, 1).toUpperCase()}
          </span>
        </div>
      </header>
      <aside
        ref={sidebarRef}
        id="main-navigation"
        className={`sidebar${sidebarOpen ? ' open' : ''}`}
      >
        <Link
          className="sidebar-brand"
          to="/"
          aria-label="LX Sync 概览"
          onClick={() => setSidebarOpen(false)}
        >
          <span className="brand-mark">LX</span>
          <span className="sidebar-brand-copy">
            <strong>LX Sync</strong>
            <small>管理平台</small>
          </span>
        </Link>
        <button
          ref={sidebarCloseRef}
          className="sidebar-close"
          type="button"
          aria-label="关闭导航"
          onClick={closeSidebar}
        >
          <X aria-hidden="true" size={19} />
        </button>
        <nav aria-label="主导航">
          <NavLink
            to="/"
            end
            onClick={() => setSidebarOpen(false)}
            className={({ isActive }) =>
              isActive || location.pathname.startsWith('/users/')
                ? 'nav-link active'
                : 'nav-link'
            }
          >
            <LayoutDashboard aria-hidden="true" size={18} />
            <span>仪表盘</span>
          </NavLink>
          <NavLink
            className="nav-link"
            to="/audit"
            onClick={() => setSidebarOpen(false)}
          >
            <ScrollText aria-hidden="true" size={18} />
            <span>审计记录</span>
          </NavLink>
        </nav>
        <div className="sidebar-footer">
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
          <button
            className="sidebar-action"
            type="button"
            title={logout.isPending ? '退出中…' : '退出登录'}
            aria-label={logout.isPending ? '退出中…' : '退出登录'}
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            <LogOut aria-hidden="true" size={17} />
          </button>
        </div>
      </aside>
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          type="button"
          tabIndex={-1}
          aria-label="关闭导航"
          onClick={closeSidebar}
        />
      )}
      <section
        className="workspace"
        aria-hidden={sidebarOpen || undefined}
        inert={sidebarOpen || undefined}
      >
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

  const serviceState = status.isSuccess
    ? '运行正常'
    : status.isError
      ? '服务不可用'
      : '正在读取'
  const serviceNotice = status.isPending
    ? '正在读取同步服务与数据库状态。'
    : status.isError
      ? '同步服务暂时不可用，请检查服务配置与数据库连接。'
      : 'LX Sync 管理端已连接，服务数据每 15 秒自动刷新。'

  return (
    <div className="dashboard-page">
      <section
        className={`dashboard-notice${status.isPending ? ' loading' : status.isError ? ' error' : ''}`}
        aria-live="polite"
      >
        <Info aria-hidden="true" size={19} />
        <div>
          <strong>系统公告</strong>
          <p>{serviceNotice}</p>
        </div>
      </section>
      <PageHeader title="仪表盘" description={`欢迎回来，${username}`} />

      <div className="dashboard-overview">
        <section className="panel dashboard-account-card">
          <div className="panel-heading">
            <div>
              <h2>服务信息</h2>
              <p>当前同步服务状态和连接概况</p>
            </div>
          </div>
          <div className="account-stat-grid">
            <div>
              <span>服务名称</span>
              <strong>{status.data?.serverName ?? '—'}</strong>
            </div>
            <div>
              <span>服务状态</span>
              <strong className={status.isError ? 'danger-text' : ''}>
                {serviceState}
              </strong>
            </div>
            <div>
              <span>在线设备</span>
              <strong className="accent-text">
                {status.data?.onlineDevices ?? '—'}
              </strong>
            </div>
          </div>
        </section>

        <section className="dashboard-spotlight">
          <Server aria-hidden="true" size={42} />
          <div>
            <h2>同步服务</h2>
            <p>{status.isSuccess ? '当前服务运行正常' : serviceState}</p>
            <small>{users.data?.data.length ?? '—'} 个同步用户</small>
          </div>
          <a className="spotlight-action" href="#new-user">
            <Plus aria-hidden="true" size={16} />
            新增同步用户
          </a>
        </section>
      </div>
      {status.error && <ErrorMessage error={status.error} />}

      <section className="dashboard-section" aria-labelledby="quick-actions">
        <h2 id="quick-actions">快捷操作</h2>
        <div className="metric-grid">
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
            value={serviceState}
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
        </div>
      </section>

      <div className="two-column dashboard-management">
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
    </div>
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
          <div className="table-wrap device-table-wrap">
            <table className="device-table">
              <caption className="sr-only">设备列表</caption>
              <thead>
                <tr>
                  <th scope="col">设备</th>
                  <th scope="col">类型</th>
                  <th scope="col">最后连接</th>
                  <th scope="col">
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

      <PlaylistManager userId={user.id} />

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
      <td data-label="设备">
        <strong>{device.deviceName}</strong>
        <small className="block mono">{shortId(device.clientId)}</small>
      </td>
      <td data-label="类型">{device.isMobile ? '移动端' : '桌面端'}</td>
      <td data-label="最后连接">
        {device.lastConnectAt ? formatDate(device.lastConnectAt) : '从未连接'}
      </td>
      <td className="actions" data-label="操作">
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

function PlaylistManager({ userId }: { userId: string }) {
  const queryClient = useQueryClient()
  const [playlistSearch, setPlaylistSearch] = useState('')
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(
    null,
  )
  const [createName, setCreateName] = useState('')
  const [renameName, setRenameName] = useState('')
  const [songSearchInput, setSongSearchInput] = useState('')
  const [songQuery, setSongQuery] = useState('')
  const [songSourceInput, setSongSourceInput] = useState<
    ManagedSongSource | ''
  >('')
  const [songSourceQuery, setSongSourceQuery] = useState<
    ManagedSongSource | ''
  >('')
  const [songSingerInput, setSongSingerInput] = useState('')
  const [songSingerQuery, setSongSingerQuery] = useState('')
  const [songAlbumInput, setSongAlbumInput] = useState('')
  const [songAlbumQuery, setSongAlbumQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [songSelection, setSongSelection] = useState<{
    scope: string
    ids: PlaylistSong['id'][]
  }>({ scope: '', ids: [] })
  const [selectedTargetPlaylistId, setSelectedTargetPlaylistId] = useState('')
  const [showAddSong, setShowAddSong] = useState(false)
  const [addSongSource, setAddSongSource] = useState<ManagedSongSource>('wy')
  const [addSongIdKind, setAddSongIdKind] =
    useState<ManagedSongIdKind>('string')
  const [addSongId, setAddSongId] = useState('')
  const [addSongName, setAddSongName] = useState('')
  const [addSongSinger, setAddSongSinger] = useState('')
  const [addSongAlbum, setAddSongAlbum] = useState('')
  const [addSongInterval, setAddSongInterval] = useState('')
  const [addSongValidationError, setAddSongValidationError] = useState<
    string | null
  >(null)
  const playlists = useQuery({
    queryKey: queryKeys.playlists(userId),
    queryFn: () => api.playlists(userId),
  })
  const snapshotId = playlists.data?.snapshotId ?? ''
  const selectedPlaylistExists = playlists.data?.data.some(
    (playlist) => playlist.id === selectedPlaylistId,
  )
  const activePlaylistId = selectedPlaylistExists
    ? selectedPlaylistId
    : (playlists.data?.data[0]?.id ?? null)
  const activePlaylist = playlists.data?.data.find(
    (playlist) => playlist.id === activePlaylistId,
  )
  const songs = useQuery({
    queryKey: queryKeys.playlistSongs(
      userId,
      activePlaylistId ?? '',
      snapshotId,
      songQuery,
      songSourceQuery,
      songSingerQuery,
      songAlbumQuery,
      offset,
      playlistPageSize,
    ),
    queryFn: () => {
      if (!activePlaylistId) throw new Error('Playlist is not selected')
      return api.playlistSongs(userId, activePlaylistId, {
        snapshotId,
        q: songQuery,
        source: songSourceQuery,
        singer: songSingerQuery,
        albumName: songAlbumQuery,
        offset,
        limit: playlistPageSize,
      })
    },
    enabled: activePlaylistId !== null && snapshotId !== '',
  })
  useEffect(() => {
    if (songs.data === undefined) return
    const nextOffset = playlistOffsetForTotal(
      offset,
      songs.data.total,
      playlistPageSize,
    )
    if (nextOffset !== offset) setOffset(nextOffset)
  }, [offset, songs.data])
  useEffect(() => {
    setRenameName(activePlaylist?.name ?? '')
  }, [activePlaylist?.name])
  const selectionScope = `${activePlaylistId ?? ''}\u0000${snapshotId}\u0000${songQuery}\u0000${songSourceQuery}\u0000${songSingerQuery}\u0000${songAlbumQuery}\u0000${offset}`
  const selectedSongIds =
    songSelection.scope === selectionScope ? songSelection.ids : []
  const updateSelectedSongIds = (
    update: (current: PlaylistSong['id'][]) => PlaylistSong['id'][],
  ) =>
    setSongSelection((current) => ({
      scope: selectionScope,
      ids: update(current.scope === selectionScope ? current.ids : []),
    }))
  const clearSelectedSongIds = () =>
    setSongSelection({ scope: selectionScope, ids: [] })
  const normalizedPlaylistSearch = playlistSearch.trim().toLocaleLowerCase()
  const visiblePlaylists =
    playlists.data?.data.filter(
      (playlist) =>
        normalizedPlaylistSearch === '' ||
        playlist.name.toLocaleLowerCase().includes(normalizedPlaylistSearch),
    ) ?? []
  const targetPlaylists =
    playlists.data?.data.filter(
      (playlist) => playlist.id !== activePlaylistId,
    ) ?? []
  const targetPlaylistId = targetPlaylists.some(
    (playlist) => playlist.id === selectedTargetPlaylistId,
  )
    ? selectedTargetPlaylistId
    : (targetPlaylists[0]?.id ?? '')
  const pageSongs = songs.data?.data ?? []
  const hasActiveSongFilters = Boolean(
    songQuery || songSourceQuery || songSingerQuery || songAlbumQuery,
  )
  const allPageSongsSelected =
    pageSongs.length > 0 &&
    pageSongs.every((song) => selectedSongIds.includes(song.id))

  const invalidateManagementData = () =>
    invalidatePlaylistManagementQueries(queryClient, userId)

  const createPlaylist = useMutation({
    mutationFn: (input: { name: string; expectedSnapshotId: string }) =>
      api.createPlaylist(userId, input),
    retry: false,
    onSuccess: async (response) => {
      setCreateName('')
      setSelectedPlaylistId(response.playlist.id)
      await invalidateManagementData()
    },
  })
  const renamePlaylist = useMutation({
    mutationFn: (input: {
      playlistId: string
      name: string
      expectedSnapshotId: string
    }) =>
      api.renamePlaylist(userId, input.playlistId, {
        name: input.name,
        expectedSnapshotId: input.expectedSnapshotId,
      }),
    retry: false,
    onSuccess: invalidateManagementData,
  })
  const deletePlaylist = useMutation({
    mutationFn: (input: { playlistId: string; expectedSnapshotId: string }) =>
      api.deletePlaylist(userId, input.playlistId, input.expectedSnapshotId),
    retry: false,
    onSuccess: async () => {
      setSelectedPlaylistId(null)
      clearSelectedSongIds()
      await invalidateManagementData()
    },
  })
  const addSong = useMutation({
    mutationFn: (input: {
      playlistId: string
      id: string | number
      source: ManagedSongSource
      name: string
      singer: string
      albumName: string
      interval: string | null
      expectedSnapshotId: string
    }) =>
      api.addPlaylistSong(userId, input.playlistId, {
        id: input.id,
        source: input.source,
        name: input.name,
        singer: input.singer,
        albumName: input.albumName,
        interval: input.interval,
        expectedSnapshotId: input.expectedSnapshotId,
      }),
    retry: false,
    onSuccess: async () => {
      setAddSongId('')
      setAddSongName('')
      setAddSongSinger('')
      setAddSongAlbum('')
      setAddSongInterval('')
      setAddSongValidationError(null)
      setSongSearchInput('')
      setSongQuery('')
      setSongSourceInput('')
      setSongSourceQuery('')
      setSongSingerInput('')
      setSongSingerQuery('')
      setSongAlbumInput('')
      setSongAlbumQuery('')
      setOffset(0)
      await invalidateManagementData()
    },
  })
  const removeSongs = useMutation({
    mutationFn: (input: {
      playlistId: string
      songIds: PlaylistSong['id'][]
      expectedSnapshotId: string
    }) =>
      api.removePlaylistSongs(userId, input.playlistId, {
        songIds: input.songIds,
        expectedSnapshotId: input.expectedSnapshotId,
      }),
    retry: false,
    onSuccess: async () => {
      clearSelectedSongIds()
      await invalidateManagementData()
    },
  })
  const moveSongs = useMutation({
    mutationFn: (input: {
      playlistId: string
      targetPlaylistId: string
      songIds: PlaylistSong['id'][]
      expectedSnapshotId: string
    }) =>
      api.movePlaylistSongs(userId, input.playlistId, {
        targetPlaylistId: input.targetPlaylistId,
        songIds: input.songIds,
        expectedSnapshotId: input.expectedSnapshotId,
      }),
    retry: false,
    onSuccess: async () => {
      clearSelectedSongIds()
      await invalidateManagementData()
    },
  })
  const copySongs = useMutation({
    mutationFn: (input: {
      playlistId: string
      targetPlaylistId: string
      songIds: PlaylistSong['id'][]
      expectedSnapshotId: string
    }) =>
      api.copyPlaylistSongs(userId, input.playlistId, {
        targetPlaylistId: input.targetPlaylistId,
        songIds: input.songIds,
        expectedSnapshotId: input.expectedSnapshotId,
      }),
    retry: false,
    onSuccess: async () => {
      clearSelectedSongIds()
      await invalidateManagementData()
    },
  })

  const resetMutationErrors = () => {
    createPlaylist.reset()
    renamePlaylist.reset()
    deletePlaylist.reset()
    addSong.reset()
    removeSongs.reset()
    moveSongs.reset()
    copySongs.reset()
    setAddSongValidationError(null)
  }

  const selectPlaylist = (playlistId: string) => {
    resetMutationErrors()
    setSelectedPlaylistId(playlistId)
    setSongSearchInput('')
    setSongQuery('')
    setSongSourceInput('')
    setSongSourceQuery('')
    setSongSingerInput('')
    setSongSingerQuery('')
    setSongAlbumInput('')
    setSongAlbumQuery('')
    setOffset(0)
    setShowAddSong(false)
  }

  const searchSongs = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSongQuery(songSearchInput.trim())
    setSongSourceQuery(songSourceInput)
    setSongSingerQuery(songSingerInput.trim())
    setSongAlbumQuery(songAlbumInput.trim())
    setOffset(0)
  }

  const clearSongSearch = () => {
    setSongSearchInput('')
    setSongQuery('')
    setSongSourceInput('')
    setSongSourceQuery('')
    setSongSingerInput('')
    setSongSingerQuery('')
    setSongAlbumInput('')
    setSongAlbumQuery('')
    setOffset(0)
  }

  const refresh = async () => {
    resetMutationErrors()
    clearSelectedSongIds()
    await playlists.refetch()
    await queryClient.invalidateQueries({
      queryKey: ['playlist-songs', userId],
    })
  }

  const submitCreatePlaylist = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = createName.trim()
    if (!name || !snapshotId) return
    resetMutationErrors()
    createPlaylist.mutate({ name, expectedSnapshotId: snapshotId })
  }

  const submitRenamePlaylist = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = renameName.trim()
    if (!name || !snapshotId || !activePlaylistId) return
    resetMutationErrors()
    renamePlaylist.mutate({
      playlistId: activePlaylistId,
      name,
      expectedSnapshotId: snapshotId,
    })
  }

  const confirmDeletePlaylist = () => {
    if (!snapshotId || !activePlaylistId || activePlaylist?.type !== 'user')
      return
    if (
      window.confirm(
        `删除歌单“${activePlaylist.name}”会更新同步快照并同步到设备。继续吗？`,
      )
    ) {
      resetMutationErrors()
      deletePlaylist.mutate({
        playlistId: activePlaylistId,
        expectedSnapshotId: snapshotId,
      })
    }
  }

  const submitAddSong = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!activePlaylistId || !snapshotId || activePlaylist?.type !== 'user')
      return
    resetMutationErrors()
    const id = managedSongIdFromForm(addSongIdKind, addSongId)
    const name = addSongName.trim()
    const singer = addSongSinger.trim()
    const albumName = addSongAlbum.trim()
    const interval = addSongInterval.trim()
    if (id === null) {
      setAddSongValidationError('请输入有效的平台歌曲 ID。')
      return
    }
    if (!name || !singer) {
      setAddSongValidationError('歌名和歌手不能为空。')
      return
    }
    if (interval !== '' && !managedIntervalPattern.test(interval)) {
      setAddSongValidationError('时长格式应为 m:ss、mm:ss 或 mmm:ss。')
      return
    }
    addSong.mutate({
      playlistId: activePlaylistId,
      id,
      source: addSongSource,
      name,
      singer,
      albumName,
      interval: interval || null,
      expectedSnapshotId: snapshotId,
    })
  }

  const togglePageSongs = (checked: boolean) => {
    const pageSongIds = pageSongs.map((song) => song.id)
    updateSelectedSongIds((current) =>
      checked
        ? [
            ...current,
            ...pageSongIds.filter((songId) => !current.includes(songId)),
          ]
        : current.filter((songId) => !pageSongIds.includes(songId)),
    )
  }

  const toggleSong = (songId: PlaylistSong['id'], checked: boolean) => {
    updateSelectedSongIds((current) =>
      checked
        ? current.includes(songId)
          ? current
          : [...current, songId]
        : current.filter((item) => item !== songId),
    )
  }

  const removeSelectedSongs = () => {
    if (!activePlaylistId || !snapshotId || selectedSongIds.length === 0) return
    if (
      window.confirm(`从当前歌单移除已选的 ${selectedSongIds.length} 首歌曲？`)
    ) {
      resetMutationErrors()
      removeSongs.mutate({
        playlistId: activePlaylistId,
        songIds: selectedSongIds,
        expectedSnapshotId: snapshotId,
      })
    }
  }

  const transferSelectedSongs = (mode: 'move' | 'copy') => {
    if (
      !activePlaylistId ||
      !targetPlaylistId ||
      !snapshotId ||
      selectedSongIds.length === 0
    )
      return
    const input = {
      playlistId: activePlaylistId,
      targetPlaylistId,
      songIds: selectedSongIds,
      expectedSnapshotId: snapshotId,
    }
    resetMutationErrors()
    if (mode === 'move') moveSongs.mutate(input)
    else copySongs.mutate(input)
  }

  const activeMutationPending =
    createPlaylist.isPending ||
    renamePlaylist.isPending ||
    deletePlaylist.isPending ||
    addSong.isPending ||
    removeSongs.isPending ||
    moveSongs.isPending ||
    copySongs.isPending
  const detailPlaylist = songs.data?.playlist ?? activePlaylist

  return (
    <section className="panel section-gap playlist-manager">
      <div className="panel-heading playlist-manager-heading">
        <div>
          <p className="eyebrow">PLAYLISTS</p>
          <h2>歌单管理</h2>
          <p>管理当前同步快照中的自建歌单和歌曲，写入会更新同步快照。</p>
        </div>
        <button
          className="button ghost playlist-refresh"
          type="button"
          onClick={() => void refresh()}
          disabled={
            playlists.isFetching || songs.isFetching || activeMutationPending
          }
        >
          <RefreshCw aria-hidden="true" size={16} />
          刷新
        </button>
      </div>
      {playlists.error && <ErrorMessage error={playlists.error} />}
      <PlaylistMutationError
        error={createPlaylist.error}
        onRefresh={() => void refresh()}
      />
      <div className="playlist-browser">
        <aside className="playlist-sidebar" aria-label="歌单列表">
          <label className="search-field">
            <span className="sr-only">搜索歌单</span>
            <Search aria-hidden="true" size={17} />
            <input
              type="search"
              value={playlistSearch}
              placeholder="搜索歌单"
              onChange={(event) => setPlaylistSearch(event.target.value)}
            />
          </label>
          <form className="playlist-create" onSubmit={submitCreatePlaylist}>
            <label>
              <span className="sr-only">新歌单名称</span>
              <input
                value={createName}
                maxLength={64}
                placeholder="新建自建歌单"
                onChange={(event) => setCreateName(event.target.value)}
              />
            </label>
            <button
              className="primary"
              type="submit"
              disabled={
                !createName.trim() || !snapshotId || activeMutationPending
              }
            >
              <Plus aria-hidden="true" size={16} />
              新建
            </button>
          </form>
          <div className="playlist-list">
            {playlists.isPending ? (
              <p className="muted">正在加载歌单…</p>
            ) : visiblePlaylists.length ? (
              visiblePlaylists.map((playlist) => (
                <button
                  key={playlist.id}
                  className={`playlist-item${activePlaylistId === playlist.id ? ' active' : ''}`}
                  type="button"
                  aria-pressed={activePlaylistId === playlist.id}
                  onClick={() => selectPlaylist(playlist.id)}
                >
                  <span>
                    <strong>{playlist.name}</strong>
                    <small>{playlistTypeLabel(playlist.type)}</small>
                  </span>
                  <b>{playlist.songCount} 首</b>
                </button>
              ))
            ) : playlists.error ? null : (
              <Empty>没有匹配的歌单。</Empty>
            )}
          </div>
          {playlists.data && (
            <small className="playlist-snapshot-time">
              当前快照：{formatDate(playlists.data.snapshotCreatedAt)}
            </small>
          )}
        </aside>

        <div className="playlist-content">
          <div className="playlist-content-heading">
            <div>
              <span className="playlist-title-icon">
                <ListMusic aria-hidden="true" size={18} />
              </span>
              <span>
                <strong>{detailPlaylist?.name ?? '选择歌单'}</strong>
                <small>
                  {detailPlaylist
                    ? `${detailPlaylist.songCount} 首歌曲`
                    : '从左侧选择要查看的歌单'}
                </small>
              </span>
            </div>
          </div>
          {activePlaylistId && (
            <form className="playlist-song-search" onSubmit={searchSongs}>
              <label className="search-field">
                <span className="sr-only">搜索歌曲</span>
                <Search aria-hidden="true" size={17} />
                <input
                  type="search"
                  value={songSearchInput}
                  placeholder="歌曲 ID、名称或任意字段"
                  onChange={(event) => setSongSearchInput(event.target.value)}
                />
              </label>
              <label>
                <span className="sr-only">歌曲来源筛选</span>
                <select
                  aria-label="歌曲来源筛选"
                  value={songSourceInput}
                  onChange={(event) =>
                    setSongSourceInput(
                      event.target.value as ManagedSongSource | '',
                    )
                  }
                >
                  <option value="">全部来源</option>
                  <option value="wy">网易云</option>
                  <option value="tx">QQ 音乐</option>
                  <option value="kw">酷我</option>
                  <option value="kg">酷狗</option>
                  <option value="mg">咪咕</option>
                </select>
              </label>
              <label>
                <span className="sr-only">歌手筛选</span>
                <input
                  value={songSingerInput}
                  placeholder="筛选歌手"
                  maxLength={256}
                  onChange={(event) => setSongSingerInput(event.target.value)}
                />
              </label>
              <label>
                <span className="sr-only">专辑筛选</span>
                <input
                  value={songAlbumInput}
                  placeholder="筛选专辑"
                  maxLength={256}
                  onChange={(event) => setSongAlbumInput(event.target.value)}
                />
              </label>
              <div className="playlist-song-search-actions">
                <button className="secondary" type="submit">
                  <Search aria-hidden="true" size={16} />
                  搜索
                </button>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="清除歌曲筛选"
                  title="清除歌曲筛选"
                  onClick={clearSongSearch}
                  disabled={
                    !songSearchInput &&
                    !songQuery &&
                    !songSourceInput &&
                    !songSourceQuery &&
                    !songSingerInput &&
                    !songSingerQuery &&
                    !songAlbumInput &&
                    !songAlbumQuery
                  }
                >
                  <X aria-hidden="true" size={17} />
                </button>
              </div>
            </form>
          )}
          {activePlaylist?.type === 'user' && (
            <form className="playlist-rename" onSubmit={submitRenamePlaylist}>
              <label>
                <span>歌单名称</span>
                <input
                  value={renameName}
                  maxLength={64}
                  onChange={(event) => setRenameName(event.target.value)}
                />
              </label>
              <button
                className="secondary"
                type="submit"
                disabled={
                  !renameName.trim() ||
                  !snapshotId ||
                  renameName.trim() === activePlaylist.name ||
                  activeMutationPending
                }
              >
                <Pencil aria-hidden="true" size={16} />
                保存名称
              </button>
              <button
                className="danger"
                type="button"
                onClick={confirmDeletePlaylist}
                disabled={activeMutationPending}
              >
                <Trash2 aria-hidden="true" size={16} />
                删除歌单
              </button>
              <button
                className="primary"
                type="button"
                aria-expanded={showAddSong}
                aria-controls="playlist-add-song-form"
                onClick={() => {
                  addSong.reset()
                  setAddSongValidationError(null)
                  setShowAddSong((current) => !current)
                }}
                disabled={activeMutationPending}
              >
                <Plus aria-hidden="true" size={16} />
                添加歌曲
              </button>
            </form>
          )}
          <PlaylistMutationError
            error={renamePlaylist.error ?? deletePlaylist.error}
            onRefresh={() => void refresh()}
          />
          {activePlaylist?.type === 'user' && showAddSong && (
            <form
              id="playlist-add-song-form"
              className="playlist-add-song"
              onSubmit={submitAddSong}
            >
              <div className="playlist-add-song-heading">
                <strong>添加平台歌曲</strong>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="关闭添加歌曲"
                  title="关闭"
                  onClick={() => {
                    addSong.reset()
                    setAddSongValidationError(null)
                    setShowAddSong(false)
                  }}
                >
                  <X aria-hidden="true" size={17} />
                </button>
              </div>
              <div className="playlist-add-song-grid">
                <label>
                  <span>音乐来源</span>
                  <select
                    value={addSongSource}
                    onChange={(event) =>
                      setAddSongSource(event.target.value as ManagedSongSource)
                    }
                    disabled={activeMutationPending}
                  >
                    <option value="wy">网易云</option>
                    <option value="tx">QQ 音乐</option>
                    <option value="kw">酷我</option>
                    <option value="kg">酷狗</option>
                    <option value="mg">咪咕</option>
                  </select>
                </label>
                <fieldset className="playlist-id-kind">
                  <legend>ID 类型</legend>
                  <div className="segmented-control">
                    <label>
                      <input
                        type="radio"
                        name="managed-song-id-kind"
                        value="string"
                        checked={addSongIdKind === 'string'}
                        onChange={() => setAddSongIdKind('string')}
                        disabled={activeMutationPending}
                      />
                      <span>字符串</span>
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="managed-song-id-kind"
                        value="number"
                        checked={addSongIdKind === 'number'}
                        onChange={() => setAddSongIdKind('number')}
                        disabled={activeMutationPending}
                      />
                      <span>数字</span>
                    </label>
                  </div>
                </fieldset>
                <label>
                  <span>平台歌曲 ID</span>
                  <input
                    value={addSongId}
                    type={addSongIdKind === 'number' ? 'number' : 'text'}
                    inputMode={addSongIdKind === 'number' ? 'numeric' : 'text'}
                    min={addSongIdKind === 'number' ? 1 : undefined}
                    step={addSongIdKind === 'number' ? 1 : undefined}
                    maxLength={addSongIdKind === 'string' ? 1024 : undefined}
                    required
                    aria-invalid={addSongValidationError !== null}
                    onChange={(event) => {
                      setAddSongId(event.target.value)
                      setAddSongValidationError(null)
                    }}
                    disabled={activeMutationPending}
                  />
                </label>
                <label>
                  <span>歌名</span>
                  <input
                    value={addSongName}
                    maxLength={256}
                    required
                    onChange={(event) => setAddSongName(event.target.value)}
                    disabled={activeMutationPending}
                  />
                </label>
                <label>
                  <span>歌手</span>
                  <input
                    value={addSongSinger}
                    maxLength={256}
                    required
                    onChange={(event) => setAddSongSinger(event.target.value)}
                    disabled={activeMutationPending}
                  />
                </label>
                <label>
                  <span>专辑（可选）</span>
                  <input
                    value={addSongAlbum}
                    maxLength={256}
                    onChange={(event) => setAddSongAlbum(event.target.value)}
                    disabled={activeMutationPending}
                  />
                </label>
                <label>
                  <span>时长（可选）</span>
                  <input
                    value={addSongInterval}
                    inputMode="numeric"
                    placeholder="3:45"
                    pattern="\d{1,3}:[0-5]\d"
                    onChange={(event) => setAddSongInterval(event.target.value)}
                    disabled={activeMutationPending}
                  />
                </label>
              </div>
              <div className="playlist-add-song-actions">
                {addSong.isSuccess && (
                  <span className="success-text" role="status">
                    歌曲已添加
                  </span>
                )}
                <button
                  className="primary"
                  type="submit"
                  disabled={!snapshotId || activeMutationPending}
                >
                  <Plus aria-hidden="true" size={16} />
                  {addSong.isPending ? '正在添加…' : '添加到歌单'}
                </button>
              </div>
              {addSongValidationError && (
                <p className="notice error" role="alert">
                  {addSongValidationError}
                </p>
              )}
              <PlaylistMutationError
                error={addSong.error}
                onRefresh={() => void refresh()}
              />
            </form>
          )}

          {songs.error ? (
            <PlaylistMutationError
              error={songs.error}
              onRefresh={() => void refresh()}
            />
          ) : !activePlaylistId ? (
            <Empty>暂无可查看歌单。</Empty>
          ) : songs.isPending ? (
            <p className="muted">正在加载歌曲…</p>
          ) : songs.data?.data.length ? (
            <>
              <div className="playlist-batch-toolbar">
                <span aria-live="polite">已选 {selectedSongIds.length} 首</span>
                <label>
                  <span>目标歌单</span>
                  <select
                    value={targetPlaylistId}
                    onChange={(event) =>
                      setSelectedTargetPlaylistId(event.target.value)
                    }
                    disabled={targetPlaylists.length === 0}
                  >
                    {targetPlaylists.map((playlist) => (
                      <option key={playlist.id} value={playlist.id}>
                        {playlist.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => transferSelectedSongs('copy')}
                    disabled={
                      selectedSongIds.length === 0 ||
                      !targetPlaylistId ||
                      activeMutationPending
                    }
                  >
                    <Copy aria-hidden="true" size={16} />
                    复制
                  </button>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => transferSelectedSongs('move')}
                    disabled={
                      selectedSongIds.length === 0 ||
                      !targetPlaylistId ||
                      activeMutationPending
                    }
                  >
                    <MoveRight aria-hidden="true" size={16} />
                    移动
                  </button>
                  <button
                    className="danger"
                    type="button"
                    onClick={removeSelectedSongs}
                    disabled={
                      selectedSongIds.length === 0 || activeMutationPending
                    }
                  >
                    <Trash2 aria-hidden="true" size={16} />
                    移除
                  </button>
                </div>
              </div>
              <PlaylistMutationError
                error={removeSongs.error ?? moveSongs.error ?? copySongs.error}
                onRefresh={() => void refresh()}
              />
              <div className="table-wrap playlist-table-wrap">
                <table className="playlist-song-table">
                  <caption className="sr-only">
                    {detailPlaylist?.name ?? '当前歌单'}歌曲列表
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">
                        <label className="selection-control">
                          <span className="sr-only">选择本页全部歌曲</span>
                          <input
                            className="selection-checkbox"
                            type="checkbox"
                            checked={allPageSongsSelected}
                            onChange={(event) =>
                              togglePageSongs(event.target.checked)
                            }
                          />
                        </label>
                      </th>
                      <th scope="col">#</th>
                      <th scope="col">歌曲</th>
                      <th scope="col">歌手</th>
                      <th scope="col">专辑</th>
                      <th scope="col">来源</th>
                      <th scope="col">时长</th>
                    </tr>
                  </thead>
                  <tbody>
                    {songs.data.data.map((song) => (
                      <tr key={`${song.position}:${typeof song.id}:${song.id}`}>
                        <td data-label="选择">
                          <label className="selection-control">
                            <span className="sr-only">
                              选择 {song.name ?? String(song.id)}
                            </span>
                            <input
                              className="selection-checkbox"
                              type="checkbox"
                              checked={selectedSongIds.includes(song.id)}
                              onChange={(event) =>
                                toggleSong(song.id, event.target.checked)
                              }
                            />
                          </label>
                        </td>
                        <td data-label="序号">{song.position}</td>
                        <td data-label="歌曲">
                          <strong>{song.name ?? '未提供名称'}</strong>
                          <small className="block mono playlist-song-id">
                            {song.id}
                          </small>
                        </td>
                        <td data-label="歌手">{song.singer ?? '—'}</td>
                        <td data-label="专辑">{song.albumName ?? '—'}</td>
                        <td data-label="来源">{sourceLabel(song.source)}</td>
                        <td data-label="时长">{song.interval ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="playlist-pagination">
                <span aria-live="polite">
                  第 {songs.data.offset + 1}–
                  {Math.min(
                    songs.data.offset + songs.data.data.length,
                    songs.data.total,
                  )}{' '}
                  首，共 {songs.data.total} 首
                </span>
                <div>
                  <button
                    className="text-button"
                    type="button"
                    disabled={offset === 0 || songs.isFetching}
                    onClick={() =>
                      setOffset(Math.max(0, offset - playlistPageSize))
                    }
                  >
                    <ChevronLeft aria-hidden="true" size={16} />
                    上一页
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    disabled={
                      offset + playlistPageSize >= songs.data.total ||
                      songs.isFetching
                    }
                    onClick={() => setOffset(offset + playlistPageSize)}
                  >
                    下一页
                    <ChevronRight aria-hidden="true" size={16} />
                  </button>
                </div>
              </div>
            </>
          ) : (
            <Empty>
              {hasActiveSongFilters ? '没有匹配的歌曲。' : '该歌单暂无歌曲。'}
            </Empty>
          )}
        </div>
      </div>
    </section>
  )
}

function PlaylistMutationError({
  error,
  onRefresh,
}: {
  error: unknown
  onRefresh: () => void
}) {
  if (!error) return null
  if (
    error instanceof ApiError &&
    ['SNAPSHOT_CONFLICT', 'SNAPSHOT_NOT_FOUND'].includes(error.code)
  )
    return (
      <div className="notice error playlist-conflict" role="alert">
        <span>歌单已被其他设备或管理员更新，请刷新后重新操作。</span>
        <button className="text-button" type="button" onClick={onRefresh}>
          立即刷新
        </button>
      </div>
    )
  if (error instanceof ApiError && error.code === 'PLAYLIST_IMMUTABLE')
    return (
      <p className="notice error" role="alert">
        默认列表和收藏列表不能改名、删除或手动新增歌曲。
      </p>
    )
  if (error instanceof ApiError && error.code === 'SONG_ALREADY_EXISTS')
    return (
      <p className="notice error" role="alert">
        该类型的歌曲 ID 已存在于当前歌单。
      </p>
    )
  if (error instanceof ApiError && error.code === 'PLAYLIST_ID_AMBIGUOUS')
    return (
      <p className="notice error" role="alert">
        当前快照存在重复歌单标识，请先在 LX Music 客户端修复后刷新。
      </p>
    )
  return <ErrorMessage error={error} />
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
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.snapshots(userId, domain),
      })
      if (domain === 'list') {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.playlists(userId),
        })
        void queryClient.invalidateQueries({
          queryKey: ['playlist-songs', userId],
        })
      }
    },
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
              <div className="snapshot-actions">
                <a
                  className="text-button"
                  href={api.snapshotExportPath(userId, domain, snapshot.id)}
                  download={`lx-sync-${domain}-${snapshot.id}.json`}
                  title="导出快照 JSON"
                >
                  <Download aria-hidden="true" size={14} />
                  导出
                </a>
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
              <caption className="sr-only">审计记录列表</caption>
              <thead>
                <tr>
                  <th scope="col">时间</th>
                  <th scope="col">操作者</th>
                  <th scope="col">动作</th>
                  <th scope="col">对象</th>
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

function playlistTypeLabel(type: 'default' | 'love' | 'user') {
  if (type === 'default') return '默认列表'
  if (type === 'love') return '收藏列表'
  return '自建歌单'
}

function sourceLabel(source: string | null) {
  if (!source) return '—'
  return (
    {
      kw: '酷我',
      kg: '酷狗',
      tx: 'QQ 音乐',
      wy: '网易云',
      mg: '咪咕',
    }[source] ?? source
  )
}

export function playlistOffsetForTotal(
  offset: number,
  total: number,
  pageSize: number,
) {
  if (offset === 0 || offset < total) return offset
  if (total === 0) return 0
  return Math.floor((total - 1) / pageSize) * pageSize
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
