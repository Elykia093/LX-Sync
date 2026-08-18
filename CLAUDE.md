# LX-Sync 项目说明

本文是 LX-Sync 的深层项目上下文，供开发、审计和发布使用。日常操作规则见 `AGENTS.md`；开始改动前必须同时遵守两份文件。

## 1. 项目定位与当前状态

LX-Sync 是面向 LX Music 的自托管同步服务，兼容 LX Music v4 的 HTTP 握手和 WebSocket 同步流程。它保存歌单与“不喜欢”规则，提供多设备合并、有限历史快照、设备撤销、快照恢复、审计记录和同源 React 管理端。

- 当前项目版本：`0.4.0`。
- 当前阶段：SemVer `0.x.y` 初始开发阶段，README 标记为 Alpha。
- 部署模型：单实例模块化单体。
- 持久化事实源：PostgreSQL。
- 管理端：同源 React SPA，不是公开或跨域管理 API。
- 明确不在当前范围：Redis、多实例广播、消息队列、分布式锁、SSO/RBAC、SSR、移动端应用和 Kubernetes Chart。

当前 `0.4.0` 是向后兼容功能发布，不改变 LX v4 wire format、管理 API 或 PostgreSQL schema。

## 2. 文档分工与证据优先级

- `AGENTS.md`：日常开发入口，保存必须执行的短规则、边界和检查清单。
- `CLAUDE.md`：保存技术栈、调用链、协议、数据、鉴权、状态管理、部署和版本决策。
- `README.md`：面向使用者的安装、运维和功能说明。
- `docs/api.md`：管理 API v1 的消费契约。

发生冲突时按以下顺序判断：运行/测试结果与现行 workflow > 迁移和源码 > package manifest/部署配置 > 本文与 API 文档 > README。确认冲突后必须同步修正文档，不能让旧说明继续充当事实。

## 3. 技术栈

| 层 | 实现 |
|---|---|
| Runtime | Node.js 24.18.0 LTS、TypeScript 7.0.2、ES modules |
| 包管理 | pnpm 11.14.0 workspace |
| HTTP | Fastify 5.10.0、`@fastify/cookie`、`@fastify/static` |
| WebSocket/RPC | `ws` 8.21.1、`message2call` 0.1.3 |
| 数据校验 | Zod 4.4.3 |
| 数据库 | PostgreSQL 18、Kysely 0.29.4、`pg` 8.22.0 |
| 前端 | React 19.2.7、React Router 7.18.1、TanStack Query 5.101.2、Vite 8.1.5 |
| 质量 | Biome 2.5.4、Vitest 4.1.10、Playwright 1.61.1 |
| 容器 | 多阶段 Docker build、Compose、GHCR 多平台镜像 |

依赖使用精确版本。`message2call@0.1.3` 是协议兼容基线，仓库补丁只修复其类型声明中的 `viod` 拼写，不改变运行时或 wire format。

## 4. 仓库结构

| 路径 | 职责 |
|---|---|
| `apps/server/src/index.ts` | 加载配置、迁移、repository、HTTP、WebSocket、清理任务和关闭顺序 |
| `apps/server/src/config.ts` | 环境变量 schema、默认值和安全边界 |
| `apps/server/src/http/app.ts` | 健康检查、LX HTTP 握手、管理 API、SPA 静态托管 |
| `apps/server/src/protocol/` | LX v4 常量、feature version 和 wire 类型 |
| `apps/server/src/sync/` | 认证、gateway、连接 registry、同步引擎、三方合并、快照和日志 |
| `apps/server/src/db/migrations/` | PostgreSQL 物理 schema 事实源 |
| `apps/server/src/db/schema.ts` | Kysely 类型映射 |
| `apps/server/src/db/repository.ts` | 持久化、事务、行锁、CAS、快照保留和审计 |
| `apps/server/src/security/crypto.ts` | 协议兼容加密、AES-GCM 静态加密、摘要和随机 ID |
| `apps/web/src/main.tsx` | React、Router 和 QueryClient 装配 |
| `apps/web/src/api.ts` | 管理 API 调用、Zod 响应校验、Problem JSON 错误映射 |
| `apps/web/src/App.tsx` | 页面路由、查询缓存、mutation 和本地 UI 状态 |
| `tests/e2e/` | 真实服务和 PostgreSQL 上的浏览器旅程 |
| `.github/workflows/` | CI、协议集成、镜像验证与发布 |
| `Dockerfile` / `compose.yaml` | 生产镜像结构和本地单实例部署 |

根 workspace 只包含 `apps/*`。server 和 web 不通过内部 workspace package 互相导入；生产镜像把 server 构建产物与 web 静态产物组合到同一个 runtime。

## 5. 启动与关闭链路

### 5.1 服务启动

`apps/server/src/index.ts` 的顺序是：

1. `loadConfig()` 使用 Zod 解析环境变量。
2. `createDatabase()` 建立最大 10 连接的 PostgreSQL pool，并启用 `CamelCasePlugin`。
3. `migrateToLatest()` 从构建后的 `db/migrations` 自动执行向前迁移。
4. 创建 `Repository`，删除过期管理会话，确保 singleton `service_metadata` 存在。
5. 创建 `LxAuthService` 和进程内 `ConnectionRegistry`。
6. `buildApp()` 注册 Fastify hooks、健康检查、LX HTTP 端点、管理 API 和静态文件。
7. `createLxGateway()` 在同一 HTTP server 上接管 WebSocket upgrade。
8. 每小时清理过期管理会话。
9. 监听 `HOST:PORT`。

收到 `SIGINT` 或 `SIGTERM` 后，服务依次关闭 WebSocket gateway、Fastify 和数据库。Gateway 先停止接收 upgrade，向连接发送正常关闭码，5 秒后强制终止仍未退出的 socket。

### 5.2 本地开发

- `pnpm dev`：启动 server 的 `tsx watch`，从根 `.env` 读取配置。
- `pnpm dev:web`：启动 Vite；开发服务器代理 `/api`，浏览器入口通常是 `http://localhost:5173`。
- 可只用 `docker compose up -d db` 启动 PostgreSQL。

### 5.3 容器启动

Dockerfile 先冻结安装 workspace 依赖，构建 server 和 web，再把 server 生产依赖、`dist` 和 web `dist` 复制到只含 Node runtime 的镜像。容器以非 root `node` 用户执行 `node server/dist/index.js`。

Compose 固定 PostgreSQL 18-alpine OCI digest，等待数据库健康后启动单个 app 容器。app 使用只读根文件系统、`/tmp` tmpfs、丢弃全部 Linux capabilities，并通过 `/health/ready` 检查数据库可用性。

## 6. HTTP 与管理 API

### 6.1 健康与静态资源

- `GET /health/live`：只证明进程存活。
- `GET /health/ready`：执行 `select 1`；数据库不可用时返回 503。
- production build 存在时 Fastify 直接托管 React 静态资源；未知非 API GET 回退到 `index.html`。

### 6.2 管理 API v1

管理 API 固定前缀 `/api/v1`，仅供同源 SPA 使用。主要资源包括 session、status、users、devices、playlists、snapshots 和 audit events。歌单管理复用 LX `ListAction` 和不可变快照模型：所有写请求携带 `expectedSnapshotId`，在用户级串行任务内执行 PostgreSQL head 行锁/CAS、快照与审计同事务写入，并向已就绪的在线 list 连接广播；客户端确认后才推进对应设备 baseline。详细字段与错误码见 `docs/api.md`。

所有非 GET/HEAD/OPTIONS 管理请求必须携带与 `PUBLIC_ORIGIN` 完全相同的 `Origin`。请求对象使用 strict Zod schema，未知字段被拒绝。API 返回 `Cache-Control: no-store`，错误统一为 `application/problem+json`，客户端按 `status` 和 `code` 分支。

## 7. LX v4 同步协议

### 7.1 兼容入口

- `GET /hello` 返回固定 `Hello~::^-^::~v4~`。
- `GET /id` 返回固定前缀加持久化 server ID。
- `GET /ah` 完成访问码或已登记设备的 HTTP 认证。
- 根路径和 `/socket` WebSocket upgrade 使用 query `i`（设备 ID）和 `t`（设备密文）；前者保留旧客户端兼容，后者是洛雪移动端使用的入口。
- 配置 `SYNC_BASE_PATH` 后增加 `/<base>/:userId/hello|id|ah` 和 `/<base>/:userId` / `/<base>/:userId/socket` scoped WebSocket；根入口始终保留。

用户 UUID 只缩小候选范围，不是凭据。scoped 设备必须同时属于目标用户。

### 7.2 认证阶段

新设备连接访问码先经 MD5 截取派生为 LX 兼容 AES-128-ECB key。客户端提交 RSA 公钥，服务端生成随机 `clientId` 和 128-bit device key，以 RSA-OAEP 返回并把 device key 用 `MASTER_KEY` 加密存储。

已登记设备通过 device key 完成 `/ah` 和 WebSocket token 校验。HTTP/LX 失败尝试采用有界的单实例内存限流；它不是跨实例或边缘限流。

### 7.3 RPC、压缩和连接生命周期

- `message2call@0.1.3` 提供 base、`list` queue 和 `dislike` queue。
- `LX_SYNC.featureVersion` 当前为 `list: 1`、`dislike: 1`。
- 超过 1024 字符的 JSON frame 使用 `cg_` + gzip + Base64；小 frame 保持原始 JSON。
- WebSocket `maxPayload`、解压输出和出站 buffered amount 上限均为 8 MiB。
- 入站消息和出站发送分别串行化，RPC timeout 为 120 秒。
- server 每 30 秒 ping；移动设备额外接收文本 `ping`。
- 同一设备建立新连接前，旧连接先被停用并等待该用户的在途任务完成。

### 7.4 同步与冲突

同步域只有 `list` 和 `dislike`。初始化先协商 enabled features，再比较远端 MD5 与当前 head：

- hash 相同：不传全量数据，只推进该设备基线。
- 有历史设备基线：以 server head、client 数据和共享 baseline 做三方合并。
- 无基线：空侧直接接受非空侧；两侧均有内容时询问客户端 sync mode。

同一用户的引擎操作经进程内 `ConnectionRegistry.runExclusive()` 串行化。持久化时 repository 再对 `sync_heads` 行执行 `FOR UPDATE`，并核对调用方读取的 `expectedSnapshotId`。冲突抛出 `SnapshotConflictError`，引擎重新读取并合并，最多尝试 3 次。

保存成功后，动作只广播给同一进程内、同一用户、已完成对应域初始化且不是来源设备的连接。目标确认接收后才推进其设备 baseline；发送失败会记录脱敏日志并关闭目标连接。

这些内存结构和广播语义决定了当前只能运行一个应用实例。直接扩副本会造成连接不可见、广播丢失、限流/session 清理不一致和单机串行保护失效。

## 8. PostgreSQL 数据模型

`apps/server/src/db/migrations/` 是物理数据库结构的事实源，`db/schema.ts` 是必须同步维护的 Kysely 类型映射。

| 表 | 作用与关键约束 |
|---|---|
| `service_metadata` | singleton `id=1`，持久化 server ID |
| `sync_users` | 用户、加密 auth key、启用状态、快照上限、插入位置；name 大小写不敏感唯一 |
| `devices` | 用户所属设备、加密 device key、最后连接和撤销时间；用户删除时级联 |
| `sync_snapshots` | 不可变 list/dislike payload、协议 MD5、内容 SHA-256、尺寸和来源；同用户/域/content hash 唯一 |
| `sync_heads` | 每用户/域当前 snapshot 与单调递增 version；复合主键 |
| `device_sync_state` | 每设备/域最近成功同步 snapshot；复合主键 |
| `admin_sessions` | 只保存 session ID 的 SHA-256、绝对过期时间和最近访问 |
| `audit_events` | 管理写操作的 actor、action、target 和受控 metadata |

应用代码使用 camelCase；`CamelCasePlugin` 映射 PostgreSQL snake_case。

`apps/server/src/tools/` 提供两个只面向空专用目标的离线导入入口：`lxserver-v2-import` 读取 `XCQ0607/lxserver v2.0.0` 的完整数据目录，`lx-music-sync-server-import` 读取官方 data format v2 目录和单独的 JSON 用户配置。两者先生成脱敏 dry-run 计划，apply 时要求来源专用环境开关、目标数据库名确认，并在单个事务中写入业务数据和审计后复核行数。

### 8.1 事务不变量

- 创建用户、list 初始 head、dislike 初始 head 和对应审计在一个事务内。
- 注册设备先锁定用户行，再统计未撤销设备，单用户上限 100。
- 用户更新、设备撤销、session 创建/删除、快照恢复与对应审计保持同事务。
- `saveSnapshot()` 在一个事务内锁 head、验证 CAS、去重写 snapshot、切换 head、按需更新来源设备 baseline，并裁剪历史。
- 裁剪不能删除当前 head 或任何设备 baseline 仍引用的 snapshot。
- restore 只切换 head 并递增 version，不改写历史 snapshot；执行前会断开该用户在线连接。

除非同时补齐数据库并发测试，不得把这些步骤拆出事务或移除行锁/CAS。管理写操作涉及审计时，业务写和审计必须共同成功或共同回滚。

## 9. 鉴权、安全与日志

### 9.1 管理会话

- 管理员用户名/密码来自环境，不保存在数据库。
- 登录使用 timing-safe 字符串比较和单实例 IP 尝试限流。
- 成功后生成随机 256-bit base64url session ID；浏览器只收到 Cookie，数据库只存 SHA-256。
- Cookie 为 `HttpOnly`、`SameSite=Strict`、`Path=/api/v1`；production 启用 `Secure`。
- session 采用 1-720 小时绝对 TTL；访问间隔达到 5 分钟才刷新 `lastSeenAt`，每小时清理过期记录。

当前没有管理员 MFA 或 RBAC。对公网部署必须使用 TLS、来源限制、长随机密码和外部限流/监控。

### 9.2 密钥与兼容密码学

- `MASTER_KEY` 必须是 32 字节 Base64，使用 AES-256-GCM 随机 nonce 加密 auth/device key。
- `MASTER_KEY` 丢失会使数据库中的同步凭据不可恢复；备份必须独立包含数据库和密钥。
- LX 的 MD5 与 AES-128-ECB 仅为 v4 互操作，不代表现代安全协议；外层 HTTPS/WSS 是必要边界。
- 访问码、设备 key、session ID 和数据库连接串不得进入日志、审计或错误响应。

### 9.3 日志

Fastify logger 遮盖 `req.url`、Authorization、Cookie 和 Set-Cookie。同步日志使用稳定 `event`、随机 `connectionId`、`pathMode` 及用户/设备/快照的 12 位 SHA-256 引用；异常只记录类型，不记录 message、stack 或客户端输入。

反向代理、WAF/CDN 和托管负载均衡器也必须禁止记录完整 URI/query，因为 WebSocket query 含协议凭据，scoped path 含用户路由标识。

## 10. 前端状态管理

`apps/web/src/main.tsx` 创建单一 `QueryClient`：query 默认不在窗口聚焦时刷新；仅 5xx/网络类错误最多重试一次；mutation 不自动重试。

服务端状态由 TanStack Query 管理：

- `session` 决定登录页或受保护 Router。
- `status`、`users`、`devices(userId)`、`snapshots(userId, domain)`、`audit` 使用稳定 query key。
- 创建/更新/撤销/恢复成功后只失效相关 query。
- 登录成功直接写 session cache。
- 登出成功或受保护 API 返回 401 时，移除所有受保护 cache，再把 session 明确写成 `null`。

React `useState` 只用于 sidebar、复制提示和表单等局部 UI 状态。`apps/web/src/api.ts` 对所有成功响应使用 Zod 解析，对错误解析 Problem JSON；缺失的旧 server 可选字段通过 schema default 兼容为 `null`。

BrowserRouter 路由为 dashboard `/`、用户详情 `/users/:userId` 和审计 `/audit`，未知路径回到 dashboard。

## 11. 测试与质量基线

| 命令 | 覆盖范围 |
|---|---|
| `pnpm lint` | Biome 格式、语法和静态规则 |
| `pnpm typecheck` | server、web 与 E2E TypeScript 类型 |
| `pnpm test` | server/web Vitest 单元与组件级测试 |
| `pnpm test:coverage` | Vitest coverage |
| `pnpm --filter @lx-sync/server test:integration` | 真实 PostgreSQL 上的 v4 协议、广播、CAS 与事务回滚 |
| `pnpm test:e2e` | Chromium + 构建后服务 + PostgreSQL 的管理员关键旅程 |
| `pnpm build` | server JS 与 web 静态产物 |
| `pnpm check` | lint、typecheck、test、build |

真实 PostgreSQL 测试有双重安全门：`TEST_DATABASE_URL` 的数据库名必须明确包含 `test`，且 `ALLOW_TEST_DATABASE_WRITE=1`。测试创建随机 schema 并清理；禁止指向生产库。

协议集成客户端独立实现握手常量、AES/MD5 和 `cg_` codec，不导入 server 协议/安全运行时代码，防止实现和测试同源漂移。核心覆盖包括双域同步与广播、并发 CAS、事务步骤失败回滚、message2call 0.1.3 frame、消息大小、鉴权、日志脱敏和前端 session cache 清理。

## 12. 单实例扩展边界

以下状态当前只存在于应用进程：

- WebSocket 连接集合和同设备替换。
- 同用户 `runExclusive` promise queue。
- 在线设备广播。
- 登录与 LX 认证尝试限流。
- session 定时清理调度。

因此当前禁止直接增加 app replicas，也不添加 Redis、MQ、分布式锁或数据库通知作为局部补丁。若未来明确需要多实例，至少先定义：

1. WebSocket 连接归属和跨实例定向广播。
2. 用户级操作的全局顺序、幂等和故障恢复。
3. session/限流一致性与清理任务单活。
4. PostgreSQL 锁、CAS 和消息投递之间的事务边界。
5. 滚动发布期间的新旧协议兼容矩阵。

该设计应作为独立架构变更，经负载、故障和回滚测试后实施。

## 13. SemVer 版本决策

项目采用 [Semantic Versioning 2.0.0 中文规范](https://semver.org/lang/zh-CN/)。规范版本由三个非负整数表示：`MAJOR.MINOR.PATCH`。

### 13.1 变更分类

- `MAJOR`：稳定兼容承诺下，不兼容的管理 API、LX wire/feature version、数据格式或可观察行为变更。
- `MINOR`：向后兼容的新功能、新 API 字段或可选能力。
- `PATCH`：向后兼容的问题、安全或文档/构建修复。
- 预发布：`-alpha`、`-beta`、`-rc` 等，例如 `0.2.0-alpha.1`、`1.0.0-rc.1`；优先级低于对应正式版。
- 构建元数据：`+metadata`，例如 `0.2.0+sha.abcdef`；不参与版本优先级比较。

`0.x.y` 属于初始开发阶段，公共兼容承诺尚未稳定。此阶段：

- `PATCH` 仍只承载向后兼容修复。
- 向后兼容功能提升 `MINOR`。
- 计划内不兼容变更通常也提升 `MINOR`，必须在 release notes 明确协议/API/数据影响、迁移和回滚；不能藏在 PATCH 中。
- 首次对公共行为作出稳定承诺时发布 `1.0.0`，具体时机由维护者明确决定。

`1.0.0` 之后严格执行：breaking -> MAJOR、compatible feature -> MINOR、compatible fix -> PATCH。

### 13.2 示例

| 当前版本 | 变更 | 下一个版本 |
|---|---|---|
| `0.1.0` | 向后兼容 bug fix | `0.1.1` |
| `0.1.0` | 新增向后兼容管理能力 | `0.2.0` |
| `0.1.0` | 初始阶段计划内 LX 协议破坏并提供迁移说明 | `0.2.0` |
| `0.2.0` | 首次稳定兼容承诺 | `1.0.0` |
| `1.3.2` | 向后兼容功能 | `1.4.0` |
| `1.3.2` | 不兼容 API/协议/数据行为 | `2.0.0` |

### 13.3 统一版本源

仓库采用统一单版本，不独立发布 server 或 web。以下 `version` 必须完全一致：

- 根 `package.json`
- `apps/server/package.json`
- `apps/web/package.json`

release workflow 在 tag 事件中读取三者；任一不一致即失败。tag 还必须精确等于 `v${rootVersion}`。普通 release 使用 `vX.Y.Z`，预发布和构建元数据保留完整 SemVer 后缀，例如 `v0.2.0-rc.1`、`v0.2.0+build.42`。

文档、Compose 本地 image label 或其他展示版本在发布准备时一并复核，但不能成为第四个权威版本源。

## 14. 发布流程与 GHCR 行为

本仓库不因版本文件变更自动创建 tag。标准发布步骤：

1. 根据第 13 节判断版本，并同步三个 package manifest。
2. 编写 release notes，列出兼容性、用户影响、协议/API/数据变化、迁移、已知问题和回滚方式。
3. 运行 `pnpm check`；按影响面补真实 PostgreSQL integration、Playwright E2E 和镜像验证。
4. 通过 PR 合并到 `main`，确认发布 commit 可从 `origin/main` 到达。
5. 在该 commit 创建且仅创建一次 `v<完整版本>` tag。
6. 等待 release workflow 完成源码门禁、数据库协议集成、双架构构建、SBOM、provenance 和 tag 提升验证。
7. 从 workflow 摘要记录不可变镜像 digest；生产部署和回滚使用 digest。

`.github/workflows/release.yml` 当前行为：

- PR 默认只验证 `linux/amd64`、`linux/arm64` 构建；同仓库 PR 带 `publish-image` 标签才发布 PR/SHA 测试标签，fork PR 保持只读。
- `main` push 发布 `edge` 和完整 SHA 标签。
- `v*.*.*` tag 通过版本与 main 可达性门禁后，发布完整 SemVer、`major.minor` 和 SHA 标签。
- workflow 先推 `candidate-<commit SHA>`，验证 manifest 包含 amd64/arm64，并为同一 digest 生成 SBOM 与 GitHub provenance attestation，之后才提升最终标签。
- `latest` 明确禁用。
- 最终标签逐一解析并确认仍指向 build 输出的同一 digest。

`edge`、PR tag、SemVer tag 和 `major.minor` tag 都是名称引用；生产发布证据必须记录 immutable digest。已发布 tag 不得移动或复用。

## 15. 改动判断速查

| 改动 | 必查影响 |
|---|---|
| `protocol/`、message2call、握手/压缩/动作 | LX v4 兼容、feature version、独立协议集成、SemVer breaking 判断 |
| `repository.ts`、migration、schema | producer/consumer、事务、约束、回滚、真实 PostgreSQL 测试 |
| `gateway.ts`、`engine.ts` | 单实例边界、同用户顺序、广播、baseline、断线和并发 CAS |
| 管理 API | `docs/api.md`、Origin/session、安全响应、web Zod schema 和缓存失效 |
| session/auth/security | Cookie、日志脱敏、密钥备份、限流和 E2E |
| web query/mutation | query key、401 清理、mutation 重试和受保护缓存 |
| Docker/workflow/version | 三 manifest 一致、tag、main 可达、同一 digest、SBOM/provenance、无 `latest` |

任何不确定的协议、数据或发布变更，先按更高风险分类并补证据；不要用当前 `0.x` 阶段掩盖迁移影响。
