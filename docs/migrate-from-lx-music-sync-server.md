# 从官方 LX Music 同步服务器迁移

本手册适用于 `lyswhut/lx-music-sync-server 2.1.2`（提交 `d47aca4284a7c4d9ef755df1f44fb0b0a5b2af36`）及其 data format v2。输入必须包含停止写入后制作的完整 `DATA_PATH` 备份，以及单独准备的 JSON 用户配置。目标必须是空的 LX-Sync 专用 PostgreSQL 数据库或专用 schema。

## 为什么需要 JSON 配置

官方服务器只把 `serverInfo.json`、设备、快照和设备同步基线保存在 `DATA_PATH`。用户名和连接访问码来自 `config.js`、`CONFIG_PATH` 或 `LX_USER_*` 环境变量，不会写入数据目录，因此不能只靠 `DATA_PATH` 恢复认证信息。

导入器只接受 JSON，不会加载或执行 `config.js`。根据旧服务的实际配置创建一个受限 JSON 文件：

```json
{
  "maxSnapshotNum": 10,
  "list.addMusicLocationType": "top",
  "users": [
    {
      "name": "user1",
      "password": "replace-with-existing-connection-code"
    }
  ]
}
```

也可包含官方配置中的 `serverName`、`proxy.enabled` 和 `proxy.header`，但这些字段不会迁移。用户对象可以带自己的 `maxSnapshotNum` 和 `list.addMusicLocationType`，其优先级高于全局值。JSON 文件含真实访问码，应使用最小权限保存，并与备份一起安全销毁或归档。

## 迁移内容与限制

导入器验证并迁移：

- 原 server ID、用户和连接凭据派生密钥。
- 已登记设备及其设备密钥。
- `list` / `dislike` 的当前 head、全部物理快照和设备同步基线。
- 快照上限、歌曲插入位置，以及不含凭据和同步内容的迁移审计事件。

所有非空快照引用必须存在，文件名 MD5 必须与内容匹配。官方从 data format v1 升级后可能为尚未同步的设备留下空 baseline 记录，导入器会保留设备并忽略该空 baseline。

单个元数据或快照文件不得超过 8 MiB；每个用户最多 100 个自建歌单、所有歌单合计最多 10,000 首歌曲，解析后的 JSON 最多 200,000 个节点；单用户设备数不得超过 100。超限数据会在 dry-run 阶段被拒绝。同名用户、重复连接访问码和未被 JSON 配置映射的用户目录也会导致失败；确认该目录确属已删除用户后，只从迁移副本中移出并重新 dry-run，不要修改原始备份。

工具保留 JSON 配置中的快照上限，不会因物理快照较多而静默放大。导入时全部合法物理快照都会写入；后续产生新快照时，LX-Sync 按该上限裁剪未被当前 head 或设备 baseline 引用的历史。工具不迁移日志、进程配置或反向代理配置，也不合并已有 LX-Sync 数据。

## 1. 停写与备份

1. 停止官方服务器，确认没有客户端继续写入。
2. 复制完整 `DATA_PATH`，记录完整性校验，并保留只读原始备份。
3. 从旧 `config.js`、JSON `CONFIG_PATH` 或 `LX_USER_*` Secret 整理 JSON 用户配置；不要把真实访问码写进仓库或命令行。
4. 准备名称明确的空 PostgreSQL 目标和新的 LX-Sync `MASTER_KEY`，然后构建服务端：

```powershell
pnpm --filter @lx-sync/server build
```

## 2. 只读 dry-run

```powershell
pnpm --filter @lx-sync/server exec node dist/tools/lx-music-sync-server-import.js --source "D:\backup\official-sync-data" --config "D:\backup\official-config.json"
```

dry-run 不连接数据库，只输出用户、设备、源快照、去重后快照、baseline 和 head 项目数等聚合摘要。输出不会包含用户名、访问码、设备 ID、密钥、server ID、歌名或同步 payload。

若 JSON 没有全局配置，可使用 `--max-snapshots <1..1000>` 和 `--add-music-location-type <top|bottom>` 提供默认值。官方默认值分别是 `10` 和 `top`。

## 3. 隔离写入

确认 dry-run 后，在隔离目标中同时满足：

- `ALLOW_LX_MUSIC_SYNC_SERVER_IMPORT=1`。
- 命令带 `--apply`。
- `--expected-database` 与 `DATABASE_URL` 的数据库名精确一致。
- 当前 schema 为空，或只含完整且无数据的 LX-Sync 表，并且没有无关表。

```powershell
$env:ALLOW_LX_MUSIC_SYNC_SERVER_IMPORT = "1"
pnpm --filter @lx-sync/server exec node dist/tools/lx-music-sync-server-import.js --source "D:\backup\official-sync-data" --config "D:\backup\official-config.json" --apply --expected-database "lx_sync_import_test"
```

工具先验证源数据和目标边界，再在当前 schema 创建 LX-Sync 表，并在单个事务中写入业务数据、审计记录和行数复核。业务导入失败会整体回滚；已创建的空表可能保留，确认仍为空后才能重试。

## 4. 后验复核与切换

1. 确认 apply 摘要与 dry-run 完全一致。
2. 在管理端核对用户、设备、双域 head 和历史快照数量。
3. 抽样导出 list/dislike 快照并核对内容。
4. 使用隔离客户端验证已有设备认证、新设备注册、首次同步和增量传播。
5. 检查审计和日志，确认没有访问码、设备密钥、完整带凭据 URL 或同步内容。

验证期间若旧服务恢复写入，切换前必须重新停写、重新备份并导入新的空目标。同一目标不支持增量补导或覆盖重做；生产切换、删除失败目标和停用旧服务需要单独的维护窗口与回滚方案。
