# 从 lxserver v2.0 迁移

本手册只适用于 `XCQ0607/lxserver v2.0.0` 的完整 `DATA_PATH` 备份。导入目标必须是空的 LX-Sync 专用数据库或专用 schema；工具不会合并已有 LX-Sync 数据，也不会覆盖非空目标。

## 迁移内容

导入器验证并迁移：

- `serverInfo.json` 中的 v2 server ID。
- `users.json` 中的用户、连接凭据派生密钥、用户级快照上限和歌曲插入位置。
- 每个用户的设备、`list` / `dislike` 当前 head、设备同步基线和全部物理 `snapshot_*` 文件。
- 每个用户一条不含访问码、设备密钥或同步内容的迁移审计事件。

上游管理接口会扫描全部物理快照供恢复，因此导入器不会只保留 `snapshotInfo.json` 引用的文件。所有引用必须存在，所有物理快照的文件名哈希和内容都必须匹配，否则 dry-run 失败。

单个元数据或快照文件不得超过 LX-Sync 协议一致的 8 MiB 边界；超限文件会在解析前被拒绝。

从未同步过的域可能只有空的 `snapshot` 目录而没有 `snapshotInfo.json`，导入器会为其创建空 head；若目录中已有快照却缺少索引，则拒绝猜测当前 head。

LX-Sync 始终保留不含用户 ID 的根兼容入口。若多个上游用户使用相同连接访问码，根认证无法可靠区分用户，导入器会拒绝该备份。先在上游为这些用户设置不同访问码，完成一次可恢复备份后再迁移。

## 1. 准备与备份

1. 停止上游服务写入，复制完整 `DATA_PATH`，保留原目录的只读备份和完整性校验。
2. 准备名称明确、当前 schema 无无关表的空 PostgreSQL 目标；不要指向正在运行的生产库。
3. 准备 LX-Sync 正常启动所需的配置。`DATABASE_URL`、`MASTER_KEY` 和管理员密码只通过环境或 Secret 注入，不写入命令历史、文档或日志。
4. 构建当前源码：

```powershell
pnpm --filter @lx-sync/server build
```

## 2. 只读 dry-run

从仓库根目录运行：

```powershell
pnpm --filter @lx-sync/server exec node dist/tools/lxserver-v2-import.js --source "D:\backup\lxserver-data"
```

dry-run 不连接数据库，只读取备份并输出用户数、设备数、源快照数、去重后快照数、设备基线数和 head 项目数等聚合摘要。它不会输出用户名、访问码、设备 ID、设备密钥、server ID、歌名或同步 payload。

`--max-snapshots <1..1000>` 和 `--add-music-location-type <top|bottom>` 仅是缺少用户级配置时的默认值。导入器优先并原样保留上游用户配置。导入时全部合法物理快照都会写入；后续产生新快照时，LX-Sync 按该上限裁剪未被当前 head 或设备 baseline 引用的历史。

## 3. 隔离写入验证

确认 dry-run 摘要后，在隔离目标配置中同时满足以下门禁：

- `ALLOW_LXSERVER_V2_IMPORT=1`。
- 命令包含 `--apply`。
- `--expected-database` 与 `DATABASE_URL` 中的数据库名精确一致。
- 当前 schema 为空或只包含完整且无数据的 LX-Sync 表，不含无关表。

示例中的名称均为占位值：

```powershell
$env:ALLOW_LXSERVER_V2_IMPORT = "1"
pnpm --filter @lx-sync/server exec node dist/tools/lxserver-v2-import.js --source "D:\backup\lxserver-data" --apply --expected-database "lx_sync_import_test"
```

工具先检查目标边界，再创建当前 migration 表结构，最后在单个数据库事务中写入业务数据并复核行数。业务导入失败会回滚该事务；已经创建的空表结构可能保留，可在确认仍为空后修正源数据并重试。

## 4. 后验复核与切换

写入成功后至少核对：

1. 输出摘要与 dry-run 完全一致。
2. 管理端用户数、设备数和两个同步域的当前 head 符合预期。
3. 抽样导出历史快照，核对列表数量和“不喜欢”规则。
4. 使用隔离客户端分别验证已有设备认证和新设备连接，确认用户归属正确。
5. 检查审计与应用日志，不应出现访问码、密钥、完整请求 URL 或同步内容。

切换前再次停止旧服务写入，重新制作最终备份并重复 dry-run/导入，避免验证期间的数据漂移。同一份目标不支持增量补导；如需重做，必须使用新的空专用目标。生产切换、删除失败目标或停用旧服务都属于独立高风险操作，需要单独确认和回滚窗口。
