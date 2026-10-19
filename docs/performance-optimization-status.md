# LX-Sync 0.7.0 性能与监控状态

## 同步初始化

list/dislike 域在一次连接初始化中并行启动。同一用户的操作仍受 `runExclusive` 保护；持久化仍分别使用 `sync_heads` 行锁与 CAS。未修改 LX v4 握手、wire payload 或 `featureVersion`。

该实现没有可引用的性能基线或压测结果，不承诺固定比例的延迟提升。

## 数据库索引

不新增索引迁移。现有 `device_sync_state_primary (device_id, domain)` 主键已覆盖设备 baseline 点查；`sync_snapshots_user_domain_content (user_id, domain, content_hash)` 唯一约束已覆盖快照去重查询；`audit_events_created (created_at)` 已覆盖审计时间排序。重复建相同列顺序的索引会增加存储和写入成本。

如需后续索引优化，先在隔离测试数据库采集真实 SQL、`EXPLAIN (ANALYZE, BUFFERS)` 和写入成本，再单独设计迁移。

## Prometheus 指标

`/metrics` 使用以下指标名与低基数标签：

| 指标 | 标签 | 说明 |
|---|---|---|
| `lx_sync_http_request_duration_seconds` | `method`, `route`, `status_code` | HTTP 延迟 |
| `lx_sync_http_request_total` | `method`, `route`, `status_code` | HTTP 请求数 |
| `lx_sync_active_connections` | 无 | 活跃 WebSocket 连接数 |
| `lx_sync_websocket_connections_total` | `status` | WebSocket 连接尝试结果 |
| `lx_sync_operation_duration_seconds` | `operation` | 初始化和同步动作延迟 |
| `lx_sync_operation_total` | `operation`, `status` | 成功/错误计数 |

监控组件在 `compose.monitoring.yml` 中单独定义；默认 `docker compose up` 不启动监控 UI。Prometheus 仅在本地 overlay 抓取 `app:9527`，Grafana 和 Prometheus 端口仅绑定 `127.0.0.1`，Grafana 凭据必须通过 `.env` 提供。

## 发版验证

发版前必须运行 `pnpm check`、真实 PostgreSQL integration 和管理员 Playwright E2E。只有在基线、样本规模和对比环境可复现时，才发布定量性能结论。
