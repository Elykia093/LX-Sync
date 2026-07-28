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
| GET | `/api/v1/users/:userId/playlists` | 无 | `200 { snapshotId, snapshotCreatedAt, data: PlaylistSummary[] }` | 400, 401, 404, 409 |
| GET | `/api/v1/users/:userId/playlists/:playlistId` | 必填 `snapshotId`（UUID）；可选 `q`、`singer`、`albumName`（各最大 256 字符）、`source`（`kw/kg/tx/wy/mg`）、`offset`（默认 0、最大 10000）、`limit`（默认 50、最大 100） | `200 { snapshotId, snapshotCreatedAt, playlist, offset, limit, total, data: PlaylistSong[] }` | 400, 401, 404, 409 |
| POST | `/api/v1/users/:userId/playlists` | `{ name, expectedSnapshotId }` | `201 { snapshotId, snapshotCreatedAt, playlist }` | 400, 401, 403, 404, 409, 413 |
| PATCH | `/api/v1/users/:userId/playlists/:playlistId` | `{ name, expectedSnapshotId }` | `200 { snapshotId, snapshotCreatedAt, playlist }` | 400, 401, 403, 404, 409, 413 |
| DELETE | `/api/v1/users/:userId/playlists/:playlistId` | `{ expectedSnapshotId }` | `200 { snapshotId, snapshotCreatedAt }` | 400, 401, 403, 404, 409, 413 |
| POST | `/api/v1/users/:userId/playlists/:playlistId/songs` | `{ id, source, name, singer, albumName?, interval?, expectedSnapshotId }` | `201 { snapshotId, snapshotCreatedAt, affectedSongCount: 1 }` | 400, 401, 403, 404, 409, 413 |
| DELETE | `/api/v1/users/:userId/playlists/:playlistId/songs` | `{ songIds, expectedSnapshotId }` | `200 { snapshotId, snapshotCreatedAt, affectedSongCount }` | 400, 401, 403, 404, 409, 413 |
| POST | `/api/v1/users/:userId/playlists/:playlistId/song-moves` | `{ targetPlaylistId, songIds, expectedSnapshotId }` | `200 { snapshotId, snapshotCreatedAt, affectedSongCount }` | 400, 401, 403, 404, 409, 413 |
| POST | `/api/v1/users/:userId/playlists/:playlistId/song-copies` | `{ targetPlaylistId, songIds, expectedSnapshotId }` | `200 { snapshotId, snapshotCreatedAt, affectedSongCount }` | 400, 401, 403, 404, 409, 413 |
| GET | `/api/v1/users/:userId/sync-domains/:domain/snapshots` | `limit`，默认 50、最大 100 | `200 { data: Snapshot[] }` | 400, 401, 404 |
| GET | `/api/v1/users/:userId/sync-domains/:domain/snapshots/:snapshotId/export` | 无 | `200` JSON attachment（`lx-sync.snapshot` v1） | 400, 401, 404 |
| POST | `/api/v1/users/:userId/sync-domains/:domain/snapshots/:snapshotId/restorations` | 无 | `201 { snapshotId }` + `Location` | 400, 401, 403, 404 |
| GET | `/api/v1/audit-events` | `limit`，默认 100、最大 200 | `200 { data: AuditEvent[] }` | 400, 401 |

`PATCH /users/:userId` 将“字段缺失”解释为保持不变；当前可写字段均不接受 `null`，空对象会被拒绝。设备 `DELETE` 表示撤销而非物理删除，重复调用返回 `204`，不会泄露设备是否曾存在。轮换连接访问码、停用用户、撤销设备和恢复快照都会断开受影响的在线连接。

### 歌单读取与管理

歌单摘要读取当前 `list` head，并返回可用于后续详情读取或写入比较的 `snapshotId`。摘要固定包含内置歌单 `default`、`love`，以及按同步顺序排列、对外 ID 为 `user:${rawId}` 的自建歌单。

歌曲详情必须使用 `GET /api/v1/users/:userId/playlists/:playlistId?snapshotId=<uuid>[&q=<text>][&source=wy][&singer=<text>][&albumName=<text>][&offset=0][&limit=50]` 并显式传入摘要返回的 `snapshotId`；未启用的可选筛选参数应省略，未知查询参数返回 `400 VALIDATION_FAILED`。服务端始终读取该用户 `list` 域中的指定不可变快照，不会在分页或搜索期间悄悄切换到当前 head；快照不存在时返回 `404 SNAPSHOT_NOT_FOUND`。歌曲明细只返回 `id`、原列表 `position`、`name`、`singer`、`albumName`、`source`、`interval`，其中 JSON `id` 保持 `string | number`。除 `id` 外的旧快照字段可能缺失，此时返回 `null`。`q` 对歌曲 ID、名称、歌手、专辑和来源做不区分大小写的包含搜索；可选 `source` 对 `kw`、`kg`、`tx`、`wy`、`mg` 做精确筛选，`singer` 与 `albumName` 做不区分大小写的包含筛选，多个条件按 AND 组合。搜索范围固定为路径指定的单个歌单，返回的 `position` 仍是歌曲在该歌单原快照中的位置。

所有歌单写接口都必须携带当前 `list` head 的 `expectedSnapshotId`。如果 head 已变化或该 ID 已过期，返回 `409 SNAPSHOT_CONFLICT`；客户端必须重新读取摘要并让管理员基于新快照重试。新建和改名后的歌单名称长度为 1–64 个字符。内置歌单允许移除、移动和复制歌曲，但不允许改名、删除歌单本体或通过管理端新增歌曲，违反时返回 `409 PLAYLIST_IMMUTABLE`。歌单不存在时返回 `404 PLAYLIST_NOT_FOUND`；同一快照内存在重复的自建歌单原始 ID、无法唯一解析 `user:${rawId}` 时，歌单摘要、详情和写接口均返回 `409 PLAYLIST_ID_AMBIGUOUS`。自建歌单 raw ID 为 LX 保留值 `default` 或 `love` 时仍可改名或删除，但涉及歌曲的新增、移除、移动和复制会返回同一歧义错误，避免 wire action 错误命中内置歌单。新建操作超过 100 个自建歌单，或新增/复制操作会使快照超过合计 10,000 首歌曲时，返回 `409 PLAYLIST_CAPACITY_EXCEEDED`，且不写入快照或审计。

管理端新增歌曲只接受白名单结构，不接受客户端直接提交任意 `MusicInfo` 或扩展 metadata。`source` 必须是 `kw`、`kg`、`tx`、`wy`、`mg` 之一；`id` 表示该来源的平台歌曲 ID，允许至少包含一个 ASCII 字母或数字、且其余字符仅为 ASCII 字母、数字、下划线或连字符的字符串，或大于 0 的安全整数，并保持 JSON `string | number` 原始类型。服务端拒绝 `unknown`、`local`、`temp`、`undefined`、`null` 等伪 ID、这些值的下划线或连字符前缀形式、仅由分隔符组成的值、路径和带扩展名的文件名。`name` 与 `singer` 为裁剪后 1–256 字符，`albumName` 可选且最多 256 字符，`interval` 可省略或使用 `m:ss`/`mm:ss`/`mmm:ss` 形式。服务端会从这些字段生成同时包含 LX 当前 `meta.songId`/`meta.albumName` 和旧客户端基础字段的受控歌曲对象，但不会访问第三方平台验证歌曲是否真实存在，也不会补齐音质、封面或来源专属播放 metadata。目标歌单已有相同类型、相同 `id` 时返回 `409 SONG_ALREADY_EXISTS`；数字 `2` 与字符串 `"2"` 仍是不同 ID。

`songIds` 是非空且元素唯一的数组，每个元素允许为 JSON `string | number`；请求数组自身包含重复值时返回 `400 VALIDATION_FAILED`。服务端从 `expectedSnapshotId` 对应的当前 head 中恢复完整 `MusicInfo`，不信任客户端提交的歌曲对象；任一歌曲在来源歌单不存在时返回 `404 SONG_NOT_FOUND`，同一请求 ID 在来源歌单命中多首歌曲时返回 `409 SONG_ID_AMBIGUOUS`。移动和复制的 `targetPlaylistId` 使用与摘要相同的歌单 ID，目标不存在时同样返回 `404 PLAYLIST_NOT_FOUND`；来源与目标相同则返回 `409 PLAYLIST_TARGET_INVALID`。`affectedSongCount` 等于校验通过的请求歌曲数。

写接口沿用管理 Cookie、精确 `Origin` 校验、strict 请求 schema、Problem JSON 和 `Cache-Control: no-store`。每次成功写入都在同一 PostgreSQL 事务中锁定对应 head 行、执行 CAS、写入或复用内容相同的不可变快照、切换 head、按保留策略裁剪快照并写入审计；业务写入与审计要么同时成功，要么同时回滚。审计 action 分别为 `playlist.create`、`playlist.rename`、`playlist.delete`、`playlist.songs.add`、`playlist.songs.remove`、`playlist.songs.move` 和 `playlist.songs.copy`。审计 metadata 只能包含 `domain`、`affectedSongCount` 等受控域信息和计数，不包含歌名、歌曲或歌单原始 ID，也不包含客户端 payload。

快照保存成功后，服务端在同一用户级串行任务内向该用户所有已完成 `list` 初始化且已就绪的在线连接广播。每个客户端确认接收后才推进该设备 baseline；离线、未就绪或发送失败的设备不推进，发送失败的连接会被关闭。

快照导出仅接受已登录管理会话，并严格绑定用户、同步域和快照 ID。响应使用 `Content-Disposition: attachment`，内容格式为 `lx-sync.snapshot` v1，包含快照元数据和同步域数据。导出是只读操作，不改变当前 head、设备基线或快照保留计数；导出文件包含同步数据，不应公开分享。

访问码必须是非空字符串。服务端不裁剪内容，也不设置字符集或字段级长度限制；空格、符号和 Unicode 均按原样参与密钥派生。整个 JSON 请求仍受 1 MiB 请求体上限约束。访问码只在请求中短暂出现，服务端仅保存其派生密钥的 AES-256-GCM 密文；API、日志和审计记录均不回显访问码。

`syncBasePath` 和 `User.syncPath` 在 `SYNC_BASE_PATH` 未启用时为 `null`。启用后，`syncBasePath` 返回配置的前缀，`User.syncPath` 返回可直接附加到公开 Origin 的用户同步路径。两个字段均为只读、向后兼容的新增响应字段；滚动部署或回滚期间，管理端会把旧服务缺失的字段解释为 `null`。

## 健康检查

- `GET /health/live`：仅表示进程存活，不访问数据库。
- `GET /health/ready`：执行轻量数据库查询；数据库不可用时返回 `503`。

## LX 兼容接口

`GET /hello`、`GET /id`、`GET /ah` 保留 LX Music v4 固定握手。WebSocket upgrade 兼容根路径（旧客户端）和 `/socket`（洛雪移动端），并使用 query `i`（设备 ID）、`t`（设备密文）鉴权；这两个 query 只属于上游兼容协议，不能用于管理 API。

设置 `SYNC_BASE_PATH=/base` 后，同时提供 `/base/:userId/hello`、`/base/:userId/id`、`/base/:userId/ah` 和 `/base/:userId` / `/base/:userId/socket` WebSocket upgrade。`:userId` 必须是 UUID；scoped `/ah` 只加载现有且启用的目标用户，已登记设备还必须属于该用户。未知、停用或不匹配的用户仍按协议认证失败处理。路径只用于候选隔离，不能替代连接访问码、设备密钥或 TLS。管理 API、SPA 和静态资源仍部署在根路径；该配置不是整站 `BASE_PATH`。

兼容端点刻意保留上游纯文本响应和 `message2call@0.1.3` wire format。2.x 改变了消息格式，不能直接升级。
