# 性能优化状态与验证口径

本文区分已实现的运行行为和仍需测量的优化建议，不把估算值写成性能结果。

## 已实现

- list 和 dislike 域在一次初始化中并行启动；同一用户仍由 `runExclusive` 串行保护，两个域继续分别使用 PostgreSQL head 行锁与 CAS。LX v4 wire format 与 `featureVersion` 不变。
- `/metrics` 暴露低基数 HTTP、WebSocket 和同步操作指标。数据库查询、用户 ID、快照数量等未接入的指标不导出。
- 现有 `device_sync_state_primary` 主键和 `sync_snapshots_user_domain_content` 唯一约束已覆盖相应查找/去重索引前缀；本版本不再新增重复索引迁移。

## 未验证项

当前没有可引用的同步延迟基线、索引 EXPLAIN 对比或并发容量压测。并行初始化可能减少等待，但本项目不据此承诺固定百分比的加速。后续性能结论需基于隔离测试环境中的重复测量，并记录数据规模、设备数、客户端版本和环境。

## 本地监控

默认 Compose 只启动应用与 PostgreSQL。需要本机 Prometheus/Grafana 时，在 `.env` 设置独立的 `GRAFANA_ADMIN_USER` 与长随机 `GRAFANA_ADMIN_PASSWORD`，再运行：

```powershell
docker compose -f compose.yaml -f compose.monitoring.yml up -d
```

监控端口只绑定 `127.0.0.1`。公开反向代理应拒绝 `/metrics`；生产监控应使用独立、digest 固定并有访问控制的部署配置。

## 验证入口

- `pnpm check`：lint、typecheck、单元测试与构建。
- `pnpm --filter @lx-sync/server test:integration`：需独立 test 数据库并设置 `ALLOW_TEST_DATABASE_WRITE=1`。
- `pnpm test:e2e`：需独立 test 数据库和允许测试写入的环境变量。
- 任何索引或连接池调整前，先核对真实 SQL 与现有约束索引，并在隔离数据库比较执行计划和写入成本。
