# LX Sync

面向 LX Music 的自托管同步服务：使用 PostgreSQL 保存歌单与“不喜欢”规则，提供 LX Music v4 兼容握手、WebSocket 实时同步、历史快照，以及一个同源 React 管理端。

> [!IMPORTANT]
> 本项目是非官方实现，与 LX Music / 洛雪音乐助手及其作者没有隶属或背书关系。当前状态为 **Alpha**，请先在非关键数据上验证，并建立可恢复备份。

## 能做什么

- 兼容 LX Music v4 的 `/hello`、`/id`、`/ah` 与 WebSocket 同步流程。
- 同步歌单和“不喜欢”规则，处理多设备增量合并与冲突重试。
- 用 PostgreSQL 保存每个同步域的当前 head、设备同步基线和有限历史快照。
- 管理同步用户、连接访问码、设备撤销、快照恢复和审计记录。
- 使用不透明 HttpOnly Cookie 保护同源管理端。
- 单容器运行 Fastify API、LX WebSocket 和 React 静态资源。

当前不做 Redis、消息队列、多实例广播、SSO/RBAC、公开管理 API、SSR、移动端应用或 Kubernetes Chart。需要水平扩展前，必须先解决 WebSocket 连接归属和跨实例广播，不能直接增加副本。

## 架构

```mermaid
flowchart LR
  LX["LX Music 客户端"] -->|"HTTP 握手 + WebSocket"| S["Fastify 单进程服务"]
  W["React 管理端"] -->|"同源 REST + HttpOnly Cookie"| S
  S --> E["同步引擎\nlist / dislike"]
  S --> A["管理 API\n用户 / 设备 / 快照 / 审计"]
  E --> P[("PostgreSQL 18.4-alpine")]
  A --> P
```

这是模块化单体：Fastify 负责 HTTP 和静态资源，`ws + message2call` 负责 LX 长连接，Kysely 负责数据库访问。应用代码使用 camelCase，`CamelCasePlugin` 将物理表和列统一映射为 PostgreSQL snake_case。

## 技术栈

以下版本按 2026-07-20 的稳定/LTS 线精确锁定，不追 Current、RC 或 nightly。CI、容器与本地开发默认只验证表中的当前锁定基线；旧版本、旧发行变体和旧工具链不再作为适配目标。升级仍必须固定具体版本与 OCI digest，不能使用漂移的 `latest`。Docker Engine / Compose 一行记录的是本次测试服务器基线，GitHub-hosted runner 的 Docker 版本由平台管理：

| 层 | 版本 |
|---|---:|
| Node.js | 24.18.0 LTS |
| pnpm | 11.14.0 |
| Docker Engine / Compose | 29.6.2 / 5.3.1 |
| TypeScript | 7.0.2 |
| Fastify / `@fastify/static` / `@fastify/cookie` | 5.10.0 / 10.1.0 / 11.1.2 |
| PostgreSQL | 18.4-alpine |
| Kysely / `pg` | 0.29.4 / 8.22.0 |
| `ws` | 8.21.1 |
| Zod | 4.4.3 |
| React / React DOM | 19.2.7 |
| Vite / React plugin | 8.1.5 / 6.0.3 |
| React Router / TanStack Query | 7.18.1 / 5.101.2 |
| Vitest / Biome | 4.1.10 / 2.5.4 |

唯一刻意保留的旧版本是 `message2call@0.1.3`。其 2.x 改变了 wire message 格式，而现有 LX 客户端和上游同步服务仍以 0.1.3 为协议基线；升级它属于协议迁移，不是普通依赖更新。

该旧版本发布的类型声明把 `void` 误写为 `viod`；仓库通过 pnpm 的可审计补丁只修复这一处声明，不修改运行时代码或 wire 格式。

## Docker 快速启动

当前验证基线为 Docker Engine 29.6.2 与 Compose 5.3.1；旧版 Engine、Compose 和旧版 Compose 文件行为不作兼容保证。

1. 复制环境模板并修改占位值：

   ```powershell
   Copy-Item .env.example .env
   ```

2. 生成 32 字节主密钥，将输出写入 `.env` 的 `MASTER_KEY`。不要把真实输出提交到 Git：

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

3. 至少修改 `POSTGRES_PASSWORD`、`ADMIN_PASSWORD`、`MASTER_KEY`。管理员密码建议由密码管理器生成；`PUBLIC_ORIGIN` 必须是浏览器实际访问的来源，例如 `https://sync.example.com`。

4. 构建并启动：

   ```powershell
   docker compose up -d --build
   docker compose ps
   ```

5. 打开 `http://localhost:9527`，使用 `.env` 中的管理员账号登录。模板默认以 `NODE_ENV=development` 支持本地 HTTP；首次启动会自动执行数据库迁移。

以上只适合本机验证。通过 HTTPS 对外提供服务前，必须将 `.env` 的 `NODE_ENV` 改为 `production`，并把 `PUBLIC_ORIGIN` 改成实际 HTTPS 来源；否则管理 Cookie 不会启用 `Secure`，服务也不会发送 HSTS。

查看日志：

```powershell
docker compose logs -f app
```

停止服务不会删除数据库卷：

```powershell
docker compose down
```

不要在没有备份的情况下执行 `docker compose down -v`。

## 连接 LX Music

1. 在管理端创建同步用户并设置至少 8 个字符的连接访问码。
2. 在 LX Music 的同步设置中填写管理端用户详情显示的同步服务地址。默认是根地址，例如 `https://sync.example.com`；启用独立同步路径后形如 `https://sync.example.com/base/<用户 UUID>`。
3. 输入该同步用户的连接访问码并完成设备登记。

访问码不会被管理端再次显示。轮换访问码会断开该用户的在线设备，但已登记设备仍使用各自设备密钥；若要强制某台设备失效，请在“设备”中撤销它。

可选的 `SYNC_BASE_PATH=/base` 会为每个用户增加独立同步入口，缩小首次登记时需要尝试的用户候选范围，并避免相同连接访问码造成歧义。用户 UUID 只是不可预测的路由标识，不是认证凭据；服务端仍会完整校验连接访问码或设备密钥及设备归属。根路径始终保留，用于旧客户端和回滚。该变量只影响 LX 同步入口，不是管理站的整站 `BASE_PATH`；管理 API、SPA 和静态资源继续使用根路径。

协议必须经过支持 WebSocket upgrade 的反向代理。管理端与 API 应保持同源；不要将 `/api/v1` 暴露为允许任意跨域凭证请求的接口。

## 本地开发

要求 Node.js 24.18.0、pnpm 11.14.0 和 PostgreSQL 18.4。Compose 默认启动固定的 `postgres:18.4-alpine`；旧 Node.js、pnpm、PostgreSQL 版本及其他 PostgreSQL 发行变体不作为适配目标。

```powershell
corepack enable
corepack prepare pnpm@11.14.0 --activate
pnpm install --frozen-lockfile
Copy-Item .env.example .env
```

编辑 `.env`：把 `DATABASE_URL` 指向本地 PostgreSQL，将 `NODE_ENV` 保持为 `development`，并把 `PUBLIC_ORIGIN` 改为 `http://localhost:5173`。准备好 `.env` 后可以只启动 Compose 数据库：

```powershell
docker compose up -d db
pnpm dev
```

另开一个终端启动 Vite：

```powershell
pnpm dev:web
```

Vite 在 `http://localhost:5173` 提供管理端并代理 `/api`。生产构建由服务端直接托管 `apps/web/dist`。

常用命令：

| 命令 | 作用 |
|---|---|
| `pnpm typecheck` | 对 server 和 web 执行真实 TypeScript 类型检查 |
| `pnpm test` | 运行 Vitest 测试 |
| `pnpm --filter @lx-sync/server test:integration` | 使用 `TEST_DATABASE_URL` 运行真实 PostgreSQL 协议集成测试 |
| `pnpm lint` | 运行 Biome 检查 |
| `pnpm build` | 构建服务端 JS 和前端静态资源 |
| `pnpm check` | 依次执行 lint、typecheck、test、build |

真实 PostgreSQL 测试会创建并删除随机 `lx_sync_test_*` schema。为防止误指向生产库，数据库名必须明确包含 `test`，并同时设置 `ALLOW_TEST_DATABASE_WRITE=1`：

```powershell
$env:TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/lx_sync_test'
$env:ALLOW_TEST_DATABASE_WRITE='1'
pnpm --filter @lx-sync/server test:integration
```

协议 E2E 的测试客户端固定于上述 LX v4 参考提交，自行实现握手常量、AES/MD5 和 `cg_` gzip codec，不导入服务端的协议或安全运行时代码；套件同时覆盖小型 message2call raw frame 与双向压缩帧，避免客户端和服务端同源漂移后仍一起通过。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `DATABASE_URL` | 是 | — | PostgreSQL 连接串；不要写入日志或仓库 |
| `MASTER_KEY` | 是 | — | 32 字节 Base64 主密钥，用于 AES-256-GCM 静态加密 |
| `ADMIN_PASSWORD` | 是 | — | 管理员密码，长度 12–256 |
| `ADMIN_USERNAME` | 否 | `admin` | 管理员账号 |
| `SERVER_NAME` | 否 | `LX Sync` | 返回给 LX 客户端的服务名 |
| `HOST` / `PORT` | 否 | `127.0.0.1` / `9527` | 监听地址和端口；容器内使用 `0.0.0.0` |
| `NODE_ENV` | 否 | `development` | `development`、`test` 或 `production` |
| `PUBLIC_ORIGIN` | 生产建议必填 | 当前请求来源 | 允许管理端写请求的精确 Origin，不带末尾 `/` |
| `SYNC_BASE_PATH` | 否 | 关闭 | 独立用户同步路径前缀，例如 `/base`；必须是无末尾 `/` 的绝对路径 |
| `SESSION_TTL_HOURS` | 否 | `24` | 管理会话绝对有效期，1–720 小时 |
| `MAX_SNAPSHOTS` | 否 | `10` | 新同步用户的默认快照保留数，1–1000 |
| `TRUST_PROXY` | 否 | `false` | 仅在服务紧邻一跳可信反向代理时启用 |
| `LOG_LEVEL` | 否 | `info` | Fastify/Pino 日志级别 |
| `WEB_DIST_PATH` | 否 | 自动定位 | 自定义 React 构建目录的绝对路径 |
| `POSTGRES_PASSWORD` | Compose 必填 | — | Compose 数据库账号密码 |

生产环境的 `DATABASE_URL`、`MASTER_KEY` 和密码应由 Secret 管理系统注入。丢失 `MASTER_KEY` 会导致已保存的同步用户派生密钥和设备密钥无法解密；它必须与数据库备份分开、加密保存并定期验证可恢复性。

## 数据与快照

- `sync_users`：同步用户及加密后的派生认证密钥。
- `devices`：已登记设备、加密设备密钥、最后连接和撤销状态。
- `sync_snapshots`：不可变同步快照；协议 MD5 只用于 LX 兼容，内容去重使用独立 SHA-256。
- `sync_heads`：每个用户、每个同步域当前指向的快照。
- `device_sync_state`：设备上次成功同步基线，用于三方合并。
- `admin_sessions`：只保存不透明会话 ID 的 SHA-256 摘要。
- `audit_events`：管理员关键写操作，不记录访问码、Cookie 或密钥。

快照写入和 head 切换位于同一数据库事务，并对 head 加锁；并发修改发生冲突时，同步引擎最多重新合并 3 次。默认容量假设是单实例、低并发家庭/小团队部署（不超过约 100 个同步用户、每用户 100 台有效设备、默认每域 10 个历史快照）；这不是压测结论。更大规模需要先验证 payload 大小、连接数、数据库锁等待、存储增长和恢复时间。

单条 LX WebSocket 消息压缩前和解压后均限制为 8 MiB；单个快照最多包含 100 个自建歌单和合计 10,000 首歌曲，嵌套 JSON 也有深度、节点数、属性数与字符串长度上限。超过边界的连接会被拒绝，不会写入快照。

## 反向代理示例

以下 Nginx 片段同时转发 HTTP、管理 API 和 WebSocket；TLS 证书配置请按实际环境补齐：

```nginx
http {
    # Do not log any URI or query value: scoped paths contain the user route
    # identifier, and LX WebSocket authentication uses sensitive query values.
    log_format lx_sync '$remote_addr - $remote_user [$time_local] '
                       '"$request_method $server_protocol" $status $body_bytes_sent';
    access_log /var/log/nginx/access.log lx_sync;

    server {
        listen 443 ssl http2;
        server_name sync.example.com;

        client_max_body_size 1m;

        location / {
            proxy_pass http://127.0.0.1:9527;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_read_timeout 180s;
        }
    }
}
```

该 `log_format` 只约束 Nginx access log。Nginx error log、WAF/CDN 和托管负载均衡器也可能记录完整请求行，生产环境必须分别关闭 URI/query 采集或限制级别、访问权限与保留期后再验证。

对应环境设置：

```dotenv
NODE_ENV=production
PUBLIC_ORIGIN=https://sync.example.com
TRUST_PROXY=true
```

只在应用紧邻一跳受控反向代理时启用 `TRUST_PROXY`，并在防火墙层禁止绕过代理直接访问应用端口。多级代理链需先按真实拓扑调整信任策略；生产必须使用 HTTPS/WSS。

## 安全边界

- 管理端会话使用随机 256-bit ID；数据库仅保存 SHA-256，Cookie 为 HttpOnly、SameSite=Strict，生产启用 Secure。
- 所有管理写请求校验精确 `Origin`，输入由 Zod 白名单解析，未知字段被拒绝。
- LX 连接访问码仅用于派生兼容协议密钥；派生密钥和设备密钥使用 AES-256-GCM 静态加密。
- 登录和 LX 握手有单实例内存限流；它不能替代反向代理/WAF 的账号、IP 和全局限流。
- 应用访问日志会遮盖请求 URL、Cookie、Authorization 和 Set-Cookie；反向代理也必须避免记录 URI/query。审计 metadata 不写入访问码或密钥。
- 同步生命周期日志使用稳定的 `event`、随机 `connectionId`、`pathMode`，以及用户、设备和快照 ID 的 12 位 SHA-256 引用；域、结果、重试次数和耗时按事件记录。日志不记录原始标识、访问码、设备密钥、协议 payload、歌名、异常详情或 WebSocket query。
- LX v4 兼容协议包含历史加密设计（AES-128-ECB、MD5 派生）。它们仅用于与现有客户端互操作，不能视为现代密码协议；外层 TLS 是必要防护。
- 当前没有管理员 MFA、RBAC、跨实例 session cache 或密钥在线轮换。将管理端暴露到公网前，应至少限制来源、启用 TLS、使用长随机密码并监控失败登录。

管理 API 契约见 [docs/api.md](docs/api.md)。

## 备份与恢复

备份必须同时覆盖 PostgreSQL 和当前 `MASTER_KEY`。以下命令只演示 Compose 环境；先确认磁盘空间、权限和备份保留策略：

```powershell
docker compose exec db pg_dump -U lx_sync -d lx_sync -Fc -f /tmp/lx-sync.dump
docker compose cp db:/tmp/lx-sync.dump ./lx-sync.dump
```

恢复会覆盖目标库对象，属于破坏性操作。应先停止 `app`、在隔离环境演练并核对备份文件，再按维护窗口执行：

```powershell
docker compose stop app
docker compose cp ./lx-sync.dump db:/tmp/lx-sync.dump
docker compose exec db pg_restore --clean --if-exists -U lx_sync -d lx_sync /tmp/lx-sync.dump
docker compose start app
```

恢复后至少验证 `/health/ready`、管理员登录、用户/设备数量、两个同步域 head、一次测试设备同步和日志脱敏。当前尚未给出经过演练的 RPO/RTO；生产部署必须自行设定并定期做恢复演练。

## 升级与回滚

1. 先备份数据库和密钥，并保留上一版不可变镜像 digest。
2. 在测试环境用同一镜像执行迁移、登录、LX 握手、同步和快照恢复冒烟。
3. 生产启动时自动运行向前迁移；不要让多个不同版本长期并行。
4. 若仅代码异常且迁移仍向后兼容，可回滚上一镜像；涉及数据语义变化时优先 roll-forward，不能假设 `docker compose down` 会回滚数据库。

`SYNC_BASE_PATH` 不涉及数据库迁移。若独立路径异常，先把使用 scoped 地址的客户端改回服务 Origin 根地址，再将该变量设为空并重启；直接清空变量会使仍保存 scoped 地址的客户端失联。无法同步修改客户端时，应在回滚窗口暂时保留 scoped 路由。旧根路径和已有设备密钥在启用期间始终保持兼容。

结构化日志字段也是纯代码增量，不改数据库或 wire format；回滚上一镜像即可撤销，日志消费者应容忍新事件字段缺失。

### CI 与镜像发布

`.github/workflows/ci.yml` 在 PR、`main` push 和手动触发时运行冻结依赖安装、lint、类型检查、单元测试、真实 PostgreSQL 协议集成测试和构建。`CI / Check and protocol integration` 适合作为所有 PR 的 required check。

镜像工作流遵循以下规则：

- 影响镜像的 PR 默认只预构建 `linux/amd64`、`linux/arm64`，不登录仓库或推送制品。同仓库 PR 显式添加 `publish-image` 标签后，会发布 `pr-<PR 编号>` 和 SHA 测试标签；fork PR 无论标签如何都只有只读构建权限。
- `pr-<PR 编号>` 会随 PR 更新，是便于测试的可变标签；需要固定测试输入时，应从发布摘要取得 digest 并使用 `ghcr.io/elykia093/lx-sync@sha256:<digest>`。手动触发仍只执行源码、PostgreSQL 和构建验证，不发布镜像。
- 推送 `main` 会发布 `edge` 和 `sha-<完整提交 SHA>` 标签；`edge` 仅用于跟踪主干，不应作为生产部署标识。
- 推送 `v*.*.*` tag 时，tag 必须精确等于 `v${package.json.version}`，根 package 与 server package 版本必须一致，且目标 commit 必须可从 `origin/main` 到达；通过后发布完整语义版本、`major.minor` 和 SHA 标签。
- PostgreSQL 18.4-alpine service 以 OCI digest 固定，并作为唯一数据库测试基线。工作流显式禁用 `latest`，先只推送 `candidate-<提交 SHA>`，用 `imagetools inspect` 确认 manifest 同时包含 amd64 与 arm64，并为该 digest 发布 SBOM 和 GitHub provenance attestation；全部成功后才提升 edge/semver/SHA 正式标签并逐一确认仍指向同一 digest。
- 发布摘要会记录不可变 digest。生产部署与回滚必须使用 `ghcr.io/elykia093/lx-sync@sha256:<digest>`，不能只依赖可变标签。仓库内 `compose.yaml` 的 `lx-sync:0.1.0` 是本地源码构建标签，不代表已发布的 GHCR 制品。

GitHub ruleset、tag 保护、required checks、GHCR 可见性和保留策略属于仓库外配置，工作流无法自行证明它们已启用。首次发布前应至少将上述 CI check 设为合并门禁，限制 release tag 的创建权限，并确认 GHCR 不会清理仍用于回滚的 digest。回滚应用时切换到上一条已验证 digest；数据库迁移仍按前述兼容性判断决定回滚或 roll-forward。

## 协议来源与许可证

LX 同步握手、消息行为和数据动作参考 [`lyswhut/lx-music-sync-server`](https://github.com/lyswhut/lx-music-sync-server) 的 Apache-2.0 实现，协议核对基线为提交 `d47aca4284a7c4d9ef755df1f44fb0b0a5b2af36`。`message2call` 以 MIT 许可证分发。

项目代码采用 [Apache License 2.0](LICENSE)，第三方与上游说明见 [NOTICE](NOTICE)。LX Music 名称与相关标识归其权利人所有。

## 参考项目

- [`lyswhut/lx-music-sync-server`](https://github.com/lyswhut/lx-music-sync-server)
- [`XCQ0607/lxserver`](https://github.com/XCQ0607/lxserver)
