# LX-Sync 0.7.0 性能改动摘要

本文只记录当前代码实现，不记录未经基准测试的收益估算。

## 同步初始化

服务端在 feature 协商后并行初始化启用的 `list` 与 `dislike` 域；用户级 `runExclusive`、PostgreSQL head 行锁和 CAS 保持不变。LX v4 wire format 与 `featureVersion` 未变。

没有代表性负载的前后基线，因此不声明固定加速比例。

## 数据库

本版本不新增索引迁移。已有 `device_sync_state_primary`、`sync_snapshots_user_domain_content` 与 `audit_events_created` 索引覆盖当前 baseline、快照去重和审计排序路径。旧的候选迁移与性能收益估算已从发布范围移除。

## 监控

服务导出 HTTP、WebSocket 和同步操作指标。Prometheus/Grafana 在单独的 Compose overlay 中本地启用，绑定回环地址；Grafana 凭据通过 `.env` 注入。生产监控应使用独立的 digest 固定镜像和受控网络。

## 验证

版本发布前的完整 `pnpm check`、PostgreSQL integration、Playwright E2E 和 Compose 配置验证结果应记录在 release notes / CI run；未运行的检查不得标为通过。
