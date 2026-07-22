# LX Sync 管理 API v1

管理 API 位于 `/api/v1`，仅供同源管理端使用。登录成功后，服务端设置名为 `lx_sync_session` 的不透明 Cookie；数据库只保存其 SHA-256 摘要，不返回 Bearer Token，也不接受 query token。

Cookie 属性：

- `HttpOnly`
- `SameSite=Strict`
- `Secure`（生产环境）
- `Path=/api/v1`
- 绝对过期时间由 `SESSION_TTL_HOURS` 决定

所有 `POST`、`PUT`、`PATCH`、`DELETE` 请求必须携带与 `PUBLIC_ORIGIN` 完全一致的 `Origin`。所有 JSON 请求对象拒绝未知字段；认证响应和管理 API 响应均带 `Cache-Control: no-store`。时间使用 RFC 3339 UTC 字符串。

## 错误模型

错误使用 `application/problem+json`：

```json
{
  "type": "about:blank",
  "title": "Unauthorized",
  "status": 401,
  "code": "AUTH_INVALID",
  "detail": "Authentication failed",
  "requestId": "req-1"
}
```

客户端只能按 `status` 和 `code` 分支，不应解析 `detail` 文案。

JSON 请求体为空或语法无效时返回 `400 INVALID_JSON`；请求体超过 1 MiB 时返回 `413 PAYLOAD_TOO_LARGE`。两者均使用上述 Problem JSON，且不会回显原始请求体或解析器内部错误。

## 接口

| 方法 | 路径 | 输入 | 成功响应 | 主要错误 |
|---|---|---|---|---|
| POST | `/api/v1/auth/login` | `{ username, password }` | `200 { username, expiresAt }` + Cookie | 400, 401, 403, 413, 429 |
| POST | `/api/v1/auth/logout` | 无 | `204` + 清除 Cookie | 401, 403 |
| GET | `/api/v1/auth/session` | 无 | `200 { username, expiresAt }` | 401 |
| GET | `/api/v1/status` | 无 | `200 { serverId, serverName, startedAt, onlineDevices, syncBasePath }` | 401 |
| GET | `/api/v1/users` | 无 | `200 { data: User[] }`，每个用户含只读 `syncPath` | 401 |
| POST | `/api/v1/users` | `{ name, connectionCode, maxSnapshots?, addMusicLocationType? }` | `201 User` + `Location` | 400, 401, 403, 409, 413 |
| PATCH | `/api/v1/users/:userId` | `enabled`、`maxSnapshots`、`addMusicLocationType` 中至少一项 | `200 User` | 400, 401, 403, 404, 413 |
| PUT | `/api/v1/users/:userId/connection-credential` | `{ connectionCode }` | `204` | 400, 401, 403, 404, 413 |
| GET | `/api/v1/users/:userId/devices` | 无 | `200 { data: Device[] }` | 401, 404 |
| DELETE | `/api/v1/users/:userId/devices/:clientId` | 无 | `204`（幂等撤销） | 400, 401, 403, 404 |
| GET | `/api/v1/users/:userId/sync-domains/:domain/snapshots` | `limit`，默认 50、最大 100 | `200 { data: Snapshot[] }` | 400, 401, 404 |
| POST | `/api/v1/users/:userId/sync-domains/:domain/snapshots/:snapshotId/restorations` | 无 | `201 { snapshotId }` + `Location` | 400, 401, 403, 404 |
| GET | `/api/v1/audit-events` | `limit`，默认 100、最大 200 | `200 { data: AuditEvent[] }` | 400, 401 |

`PATCH /users/:userId` 将“字段缺失”解释为保持不变；当前可写字段均不接受 `null`，空对象会被拒绝。设备 `DELETE` 表示撤销而非物理删除，重复调用返回 `204`，不会泄露设备是否曾存在。轮换连接访问码、停用用户、撤销设备和恢复快照都会断开受影响的在线连接。

访问码必须是非空字符串。服务端不裁剪内容，也不设置字符集或字段级长度限制；空格、符号和 Unicode 均按原样参与密钥派生。整个 JSON 请求仍受 1 MiB 请求体上限约束。访问码只在请求中短暂出现，服务端仅保存其派生密钥的 AES-256-GCM 密文；API、日志和审计记录均不回显访问码。

`syncBasePath` 和 `User.syncPath` 在 `SYNC_BASE_PATH` 未启用时为 `null`。启用后，`syncBasePath` 返回配置的前缀，`User.syncPath` 返回可直接附加到公开 Origin 的用户同步路径。两个字段均为只读、向后兼容的新增响应字段；滚动部署或回滚期间，管理端会把旧服务缺失的字段解释为 `null`。

## 健康检查

- `GET /health/live`：仅表示进程存活，不访问数据库。
- `GET /health/ready`：执行轻量数据库查询；数据库不可用时返回 `503`。

## LX 兼容接口

`GET /hello`、`GET /id`、`GET /ah` 保留 LX Music v4 固定握手。WebSocket upgrade 兼容根路径（旧客户端）和 `/socket`（洛雪移动端），并使用 query `i`（设备 ID）、`t`（设备密文）鉴权；这两个 query 只属于上游兼容协议，不能用于管理 API。

设置 `SYNC_BASE_PATH=/base` 后，同时提供 `/base/:userId/hello`、`/base/:userId/id`、`/base/:userId/ah` 和 `/base/:userId` / `/base/:userId/socket` WebSocket upgrade。`:userId` 必须是 UUID；scoped `/ah` 只加载现有且启用的目标用户，已登记设备还必须属于该用户。未知、停用或不匹配的用户仍按协议认证失败处理。路径只用于候选隔离，不能替代连接访问码、设备密钥或 TLS。管理 API、SPA 和静态资源仍部署在根路径；该配置不是整站 `BASE_PATH`。

兼容端点刻意保留上游纯文本响应和 `message2call@0.1.3` wire format。2.x 改变了消息格式，不能直接升级。
