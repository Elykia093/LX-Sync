# LX-Sync 开发规范

## 开始之前

1. 先完整阅读根目录的 `CLAUDE.md`。它记录项目架构、协议、数据模型、鉴权、部署和版本发布事实。
2. 再读取本次改动直接涉及的源码、测试和配置；不要只依据 README、目录名或旧文档修改。
3. 保持改动聚焦。不要顺手重构、升级依赖、改变协议或扩大部署范围。

若本文件与代码事实冲突，以当前源码、迁移、测试和 workflow 为准，并在同一改动中修正文档。若本文件与 `CLAUDE.md` 冲突，先核对源码，再同步修正两份文档。

## 目录边界

- `apps/server/src/index.ts`：服务启动、资源装配与优雅关闭入口。
- `apps/server/src/http/`：Fastify 健康检查、LX HTTP 握手、管理 API 和静态资源托管。
- `apps/server/src/sync/`：LX WebSocket、认证、同步引擎、合并、校验、快照和日志。
- `apps/server/src/protocol/`：LX v4 兼容常量和 wire 类型；属于公开兼容边界。
- `apps/server/src/db/migrations/`：PostgreSQL 物理 schema 的事实源。
- `apps/server/src/db/schema.ts`：Kysely 类型映射，必须与迁移保持一致。
- `apps/server/src/db/repository.ts`：持久化、事务、行锁、审计和快照保留规则。
- `apps/server/src/security/`：协议兼容加密、静态加密、摘要与随机值。
- `apps/web/src/api.ts`：管理 API 客户端、响应校验与会话失效传播。
- `apps/web/src/App.tsx`：管理端路由、查询、变更和页面状态。
- `docs/api.md`：管理 API 对外契约说明。
- `.github/workflows/`、`Dockerfile`、`compose.yaml`：质量检查、镜像构建和部署入口。

不要直接编辑 `dist/`、覆盖率报告、Playwright 产物或其他生成文件。

## 架构边界

当前部署模型是单实例模块化单体：一个 Node.js 进程同时提供 Fastify HTTP、LX WebSocket 和 React 静态资源，PostgreSQL 是唯一持久化存储。

- `ConnectionRegistry`、用户级串行任务、在线连接广播、登录/LX 尝试限流和定时会话清理均在进程内。
- 不引入 Redis、多实例广播、消息队列、分布式锁或多副本部署。
- 不把 PostgreSQL `LISTEN/NOTIFY`、轮询或其他机制当作未经设计的跨实例广播替代品。
- 如需求明确要求水平扩展，先设计连接归属、跨实例广播、单活任务、限流/session 一致性和故障恢复，再单独实施。

## PostgreSQL 与事务规则

- PostgreSQL 是用户、设备、同步 head、设备基线、快照、管理会话和审计事件的唯一事实源；内存状态不得成为可恢复业务数据的唯一副本。
- schema 变更必须新增 Kysely migration，并同步 `db/schema.ts`、repository、测试和文档。不要改写已经发布的 migration。
- 多步写入必须明确原子边界。用户创建、初始双域 head、管理写操作与审计、会话与审计、快照写入/head 切换/设备基线/裁剪必须维持现有事务语义。
- 快照更新必须在事务内锁定对应 `sync_heads` 行，核对 `expectedSnapshotId`，再写快照并切换 head。禁止把读取、写入和 head 更新拆成无保护步骤。
- 设备基线只能在数据已持久化且必要的客户端交付成功后推进；失败时不得制造“已同步”状态。
- 保留外键、唯一约束、check constraint 和物理 snake_case 约定；应用层继续使用 camelCase 与 `CamelCasePlugin`。
- 任何真实数据库写入测试必须使用名称明确包含 `test` 的数据库，并同时设置 `ALLOW_TEST_DATABASE_WRITE=1`。

## 协议与 WebSocket 规则

- 兼容目标是 LX Music v4：`/hello`、`/id`、`/ah`、根 WebSocket，以及启用 `SYNC_BASE_PATH` 后的 scoped 等价路径。
- `LX_SYNC.featureVersion` 当前 `list=1`、`dislike=1`。改变版本、字段、动作、握手文本、加密、压缩或 close code 都是协议变更。
- `message2call@0.1.3` 是刻意固定的 wire 基线；2.x wire format 不兼容，不能作为普通依赖升级。
- 根路径是旧客户端和回滚兼容入口。新增 scoped 路径不能移除或改变根路径行为。
- 单条消息压缩前后均受 8 MiB 边界约束；保留入站串行解析、出站串行发送、buffer 上限、心跳和 5 秒关闭宽限。
- 同一用户的同步写路径必须经 `runExclusive` 串行化，并继续依赖 PostgreSQL head 行锁与 CAS 防御并发；二者职责不同，不能互相替代。
- 当前冲突重算最多 3 次。调整重试次数前必须有测试和明确的并发依据。
- 广播只发往同一进程内同一用户、已就绪且非来源设备的连接。发送失败要记录脱敏事件并关闭目标连接。

## 安全与日志

- 不提交或记录 `DATABASE_URL`、`MASTER_KEY`、管理员密码、连接访问码、Cookie、设备密钥、WebSocket query 或完整带凭据 URL。
- 管理会话保持不透明随机 ID；数据库只保存 SHA-256 摘要。Cookie 保持 `HttpOnly`、`SameSite=Strict`、`Path=/api/v1`，生产环境启用 `Secure`。
- 管理写请求必须精确校验 `Origin`；请求体继续使用 strict Zod schema，拒绝未知字段。
- 连接派生密钥和设备密钥继续使用 AES-256-GCM 静态加密。LX 协议中的 AES-128-ECB/MD5 仅为兼容，不能复用于新安全设计；生产必须使用 TLS/WSS。
- 保留 HTTP logger 对 URL、Authorization、Cookie、Set-Cookie 的遮盖。同步日志只使用随机 `connectionId` 和哈希截断引用。
- 日志、审计 metadata 和错误响应不得包含客户端 payload、歌名、访问码、密钥、原始标识或内部异常详情。
- `TRUST_PROXY=true` 只适用于紧邻一跳可信代理且应用端口无法被绕过的部署。

## 前端规则

- TanStack Query 管理服务端状态；React 本地状态只用于表单和短暂 UI 状态。
- 所有 API 响应先在 `apps/web/src/api.ts` 用 Zod 校验，再进入查询缓存。
- mutation 成功后更新或失效精确 query key；退出登录或受保护接口返回 401 时清除受保护缓存并显式写入未登录会话状态。
- 管理端与 API 保持同源，不新增 Bearer Token 或跨域凭据模式。

## 测试与质量门禁

- 纯文档/workflow 改动至少运行 `git diff --check`、`pnpm lint`、`pnpm typecheck`，并对新增脚本逻辑做正向和负向检查。
- 协议、事务、鉴权、状态或数据行为改动必须补相应 Vitest 测试；跨层关键路径再运行真实 PostgreSQL integration。
- 管理端关键旅程或路由/会话行为改变时运行 Playwright E2E。
- 依赖和容器改动还要运行 `pnpm build`，并按影响面验证镜像。
- 不把“命令未运行”写成“已通过”；环境缺失或测试失败必须如实记录。

常用命令：

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm --filter @lx-sync/server test:integration`
- `pnpm test:e2e`
- `pnpm build`
- `pnpm check`

## SemVer 版本标准

项目采用 [Semantic Versioning 2.0.0 中文规范](https://semver.org/lang/zh-CN/)，版本格式为 `MAJOR.MINOR.PATCH`：

- `MAJOR`：不兼容的 API、LX 协议或数据行为变更。
- `MINOR`：向后兼容的功能新增。
- `PATCH`：向后兼容的问题修复。
- 预发布版本使用 `-alpha`、`-beta`、`-rc` 等标识，可附点分序号，例如 `0.2.0-rc.1`。
- 构建元数据使用 `+metadata`，例如 `0.2.0+build.42`；它不影响版本优先级。
- `0.x.y` 表示初始开发阶段。此阶段兼容性承诺以仓库文档和 release notes 为准；计划内的不兼容变更通常提升 `MINOR` 并明确迁移影响，`PATCH` 仍只用于兼容修复。
- `1.0.0` 表示首次正式稳定兼容承诺，时机由项目维护者明确决定，不能因普通改动自动重置或跳升。

当前版本 `0.5.0` 是合法 SemVer；本规范落地本身不触发版本重置或发布。

仓库采用统一单版本。以下三个 manifest 的 `version` 必须完全一致：

- `package.json`
- `apps/server/package.json`
- `apps/web/package.json`

## 发布与 Git 规则

1. 根据兼容性影响选择下一个版本，更新三个 package manifest；涉及预发布时三者使用完全相同的完整版本。
2. 完成 lint、typecheck、测试、构建和受影响的集成/E2E 检查，复核迁移、协议、回滚和 release notes。
3. 通过 PR 合并到 `main`；禁止从不可达提交发布。
4. 在 `main` 可达的发布提交上创建 `v<version>` tag，例如 `v0.1.1` 或 `v0.2.0-rc.1`。tag 必须精确等于 `v${package.json.version}`，并与另外两个 manifest 一致。
5. 不移动、复用或覆盖已经发布的 tag。生产部署和回滚使用不可变镜像 digest，不依赖 `latest`、`edge` 或其他可变标签。

- 不执行用户未要求的 commit、tag、push、force push、rebase、发布或数据库写入。
- 提交前检查 `git status` 和 `git diff`，保留用户已有未提交改动；不要重置、覆盖或清理无关文件。
- 发布 workflow 必须继续验证 tag commit 可从 `origin/main` 到达。
