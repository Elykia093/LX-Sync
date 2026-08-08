# PostgreSQL 备份与恢复

本文定义 LX-Sync 的生产备份基线。数据库 dump 与 `MASTER_KEY` 必须作为两个独立恢复对象保存；缺少任意一项，都不能称为可恢复备份。

## 恢复目标

- 初始目标：每天至少一次完整逻辑备份，`RPO <= 24h`，`RTO <= 2h`。
- 上述数值只是小规模单实例部署的起始目标。只有在目标环境完成计时恢复演练后，才能把它们记为已验证。
- 需要更小 RPO 时，应为 PostgreSQL 另行启用受监控的 WAL 归档/PITR；逻辑 dump 不能提供时间点恢复。

## 备份对象与隔离

每次备份分为两个对象，并使用相同的 UTC 备份 ID 关联：

1. 数据对象：PostgreSQL custom-format dump、数据库清单和 SHA-256 校验文件。
2. 密钥托管对象：当前 `MASTER_KEY`、密钥版本标识和独立 SHA-256 校验文件。

数据对象与密钥托管对象必须写入不同的加密仓库、bucket 或至少不同的受控前缀，并使用不同上传凭据。上传身份不授予删除权限；远端启用对象锁或等价的不可变保留。备份工具的加密密码也不得与 `MASTER_KEY` 相同或保存在仓库中。

数据库 dump 不包含 `MASTER_KEY`。不得把 `.env`、真实连接串、管理员密码或未加密密钥混入数据对象。

## 创建备份

以下示例面向 Linux Compose 主机。先确认目标路径位于专用临时目录，且剩余空间足够：

```bash
set -eu
umask 077
backup_id="$(date -u +%Y%m%dT%H%M%SZ)"
db_bundle="/var/backups/lx-sync/${backup_id}/database"
key_bundle="/var/backups/lx-sync/${backup_id}/key"
install -d -m 700 "$db_bundle" "$key_bundle"

docker compose exec -T db \
  pg_dump -U lx_sync -d lx_sync -Fc -Z 9 > "$db_bundle/lx-sync.dump"
docker compose exec -T db pg_dump --version > "$db_bundle/postgresql-version.txt"
docker compose exec -T db pg_restore --list \
  < "$db_bundle/lx-sync.dump" > "$db_bundle/restore-list.txt"
sha256sum "$db_bundle/lx-sync.dump" > "$db_bundle/SHA256SUMS"
```

随后由 Secret 管理系统把当前密钥直接导出到 `$key_bundle/master-key.b64`，文件权限设为 `0600`。不要把密钥输出到终端历史或日志。导出命令因 Secret 提供方而异，不能用读取并回显 `.env` 的通用命令替代。完成后在密钥目录内生成仅随加密对象保存的 `SHA256SUMS`。

两个目录分别上传到客户端加密的远端仓库。以下 `restic` 示例只展示边界，仓库地址、对象存储凭据和密码文件由部署环境注入：

```bash
RESTIC_PASSWORD_FILE=/run/secrets/lx-sync-restic-db-password \
  restic -r s3:s3.example.invalid/lx-sync-database \
  backup "$db_bundle" --tag lx-sync --tag "$backup_id"

RESTIC_PASSWORD_FILE=/run/secrets/lx-sync-restic-key-password \
  restic -r s3:s3.example.invalid/lx-sync-key-escrow \
  backup "$key_bundle" --tag lx-sync-key --tag "$backup_id"
```

临时目录必须位于受控的加密文件系统。确认两个远端 snapshot、完整性检查和记录均成功后，立即删除本地 `key_bundle` 明文目录；普通文件删除不等于 SSD 或云盘上的可证明安全擦除，因此不能把临时目录放在共享、未加密或会被其他备份任务再次采集的位置。

上传成功必须记录：备份 ID、应用版本与不可变镜像 digest、PostgreSQL 版本、两个远端 snapshot ID、文件大小、校验结果和执行时间。不得记录密钥值、连接串或仓库密码。

建议保留至少 7 个日备份、5 个周备份和 12 个月备份。清理使用独立维护身份，并只删除已超过对象锁期限的对象；日常上传身份不得执行 `forget --prune` 或远端删除。

## 隔离恢复演练

恢复属于破坏性操作。生产恢复前必须先在隔离的 PostgreSQL 18 实例和隔离网络完成以下步骤：

1. 按同一个备份 ID 分别取回数据库对象和密钥托管对象，运行备份工具完整性检查并验证两个 `SHA256SUMS`。
2. 创建名称明确包含 `test` 的空数据库，例如 `lx_sync_restore_test`；不得连接生产数据库。
3. 使用 `pg_restore --exit-on-error --no-owner --no-privileges` 恢复 dump，并保存开始时间、结束时间与退出码。
4. 使用备份记录中的同一不可变应用镜像 digest启动单实例服务，把恢复出的密钥通过 Secret 挂载注入，不写入镜像或日志。
5. 验证 `/health/ready`、管理员登录、用户/设备/审计数量、每个用户的 `list` 与 `dislike` head、历史快照可读、一次测试设备同步和一次快照导出。
6. 检查恢复期间的应用、代理和数据库日志，确认没有 Cookie、连接访问码、设备密钥、`MASTER_KEY`、完整 query 或歌曲 payload。
7. 记录实际 RPO/RTO、失败步骤和修复项；演练环境验证后销毁测试数据和临时明文文件。

至少每季度演练一次，并在 Secret 轮换、PostgreSQL 大版本升级、备份工具或对象存储策略变化后追加演练。没有最近一次成功演练证据时，发布说明必须把恢复能力标记为“未验证”。

## 生产恢复

生产恢复需要单独变更窗口和明确授权。执行前停止 `app`，保留故障库的只读快照，确认目标备份 ID、应用镜像 digest、密钥版本和回滚点。恢复后先完成健康、鉴权和数据只读核验，再允许 LX 客户端重新连接。

如果仅应用代码异常且数据库 schema/数据语义仍兼容，优先回滚到上一不可变镜像 digest，不恢复数据库。不要用 `docker compose down -v`、未指定目标库的 `pg_restore --clean` 或“最新备份”自动选择替代人工确认。
