# LX-Sync 性能监控部署指南

本文档说明如何部署和使用 LX-Sync 的 Prometheus + Grafana 监控栈。

---

## 快速启动

### 使用 Docker Compose（推荐）

默认 Compose 只启动 LX-Sync 与 PostgreSQL。需要本地监控时，先在 `.env` 配置 `GRAFANA_ADMIN_USER` 和唯一的长随机 `GRAFANA_ADMIN_PASSWORD`，再使用 overlay：

```powershell
docker compose -f compose.yaml -f compose.monitoring.yml up -d
```

监控 overlay 仅绑定 `127.0.0.1`：Prometheus 为 `http://localhost:9090`，Grafana 为 `http://localhost:3030`。监控 UI 不会随默认应用部署开放。

### 访问地址

| 服务 | URL | 凭据 |
|---|---|---|
| LX-Sync 管理端 | http://localhost:9527 | `.env` 中配置 |
| Prometheus | http://localhost:9090 | 仅本机回环 |
| Grafana | http://localhost:3030 | `.env` 中配置 |

---

## 配置 Grafana

监控 overlay 要求 `.env` 中设置 `GRAFANA_ADMIN_USER` 和 `GRAFANA_ADMIN_PASSWORD`，不会使用默认口令。Grafana 会自动加载 provisioning 文件中的 Prometheus 数据源和根目录仪表盘 `grafana-dashboard.json`。

Prometheus 与 Grafana 仅绑定本机回环地址。`/metrics` 本身没有鉴权。生产部署应使用独立的 digest 固定镜像、TLS 与访问控制；反向代理必须限制 `/metrics`，并通过防火墙或网络策略限制对应用宿主端口的直连，不能只依赖反代规则。

## 仪表盘说明

导入的仪表盘包含 6 个核心面板：

### 1. HTTP Request Rate
显示每秒 HTTP 请求速率，按方法、路由和状态码分类。

**用途**: 识别流量模式和异常请求峰值。

### 2. HTTP Request Duration (P95)
显示 HTTP 请求 P95 延迟。

**用途**: 监控用户体验质量，P95 > 2s 需要优化。

### 3. Active WebSocket Connections
显示当前活跃的 WebSocket 连接数。

**用途**: 监控在线设备数量，突增可能表示客户端重连风暴。

### 4. Sync Operation Success Rate
显示同步操作成功率百分比。

**用途**: 监控同步服务健康度，低于 95% 需要调查。

### 5. Sync Operation Duration (Avg)
显示各类同步操作的平均延迟。

**用途**: 识别慢操作类型（初始化、动作处理）。

### 6. Sync Operation Rate
显示同步操作速率，按操作类型和结果分类。

**用途**: 监控同步活动频率和失败模式。

---

## 告警配置

### 查看已配置告警

访问 Prometheus UI → **Alerts** 查看当前告警状态。

已预配置 8 条告警规则（见 `alerts.yml`）：

| 告警 | 触发条件 | 严重级别 |
|---|---|---|
| **HighHTTPLatency** | P95 > 2s 持续 5 分钟 | Warning |
| **HighHTTPErrorRate** | 5xx 率 > 5% 持续 5 分钟 | Critical |
| **HighWebSocketConnections** | 连接数 > 100 持续 10 分钟 | Warning |
| **WebSocketConnectionSpike** | 1 分钟内握手尝试超过 20 次 | Warning |
| **HighSyncOperationFailureRate** | 失败率 > 5% 持续 5 分钟 | Critical |
| **SlowSyncOperations** | 平均延迟 > 3s 持续 10 分钟 | Warning |
| **NoSyncActivity** | 30 分钟无操作 | Info |
| **ServiceDown** | 无法抓取 /metrics 持续 1 分钟 | Critical |

### 配置告警通知

Prometheus 需要配合 Alertmanager 发送通知。修改 `prometheus.yml`:

```yaml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']
```

然后在 `compose.yaml` 中添加 Alertmanager 服务，并配置通知渠道（Email/Slack/PagerDuty）。

---

## 生产环境建议

### 1. 数据持久化

Compose 已配置持久卷：
- `prometheus-data`: Prometheus 时间序列数据（保留 30 天）
- `grafana-data`: Grafana 配置和仪表盘

**备份**:
```bash
docker compose -f compose.yaml -f compose.monitoring.yml exec prometheus tar czf - /prometheus | gzip > prometheus-backup.tar.gz
```

### 2. 性能调优

**Prometheus 存储优化**:
```yaml
command:
  - '--storage.tsdb.retention.time=90d'        # 延长保留期
  - '--storage.tsdb.retention.size=50GB'       # 限制磁盘用量
  - '--storage.tsdb.min-block-duration=2h'     # 调整压缩策略
```

**抓取间隔**:
```yaml
scrape_interval: 15s  # 默认，适合生产
scrape_interval: 5s   # 开发/调试，更高精度但更多存储
```

### 3. 安全加固

**Grafana**:
```yaml
environment:
  - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD}  # 使用强密码
  - GF_USERS_ALLOW_SIGN_UP=false                           # 禁止注册
  - GF_AUTH_ANONYMOUS_ENABLED=false                        # 禁止匿名
```

**Prometheus**:
```yaml
command:
  - '--web.enable-admin-api=false'  # 禁用管理 API
```

**反向代理**:
生产环境应通过 Nginx/Traefik 代理并启用 TLS：

```nginx
location /grafana/ {
    proxy_pass http://grafana:3000/;
    proxy_set_header Host $host;
}

location /prometheus/ {
    proxy_pass http://prometheus:9090/;
    proxy_set_header Host $host;
    # 添加 Basic Auth 或 OAuth
}
```

### 4. 资源限制

在 `compose.yaml` 中添加资源约束：

```yaml
services:
  prometheus:
    deploy:
      resources:
        limits:
          memory: 2G
          cpus: '1'
        reservations:
          memory: 512M

  grafana:
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '0.5'
```

---

## 常见查询

### Prometheus 查询语言 (PromQL) 示例

#### 1. 实时 HTTP 请求速率
```promql
rate(lx_sync_http_request_total[1m])
```

#### 2. P99 HTTP 延迟
```promql
histogram_quantile(0.99, rate(lx_sync_http_request_duration_seconds_bucket[5m]))
```

#### 3. 同步成功率（过去 1 小时）
```promql
sum(increase(lx_sync_operation_total{status="success"}[1h])) /
sum(increase(lx_sync_operation_total[1h])) * 100
```

#### 4. 每分钟新建连接数
```promql
increase(lx_sync_active_connections[1m])
```

#### 5. 慢请求计数（> 1s）
```promql
sum(rate(lx_sync_http_request_duration_seconds_bucket{le="1.0"}[5m]))
```

---

## 故障排查

### Prometheus 无法抓取指标

**检查网络**:
```bash
docker compose -f compose.yaml -f compose.monitoring.yml exec prometheus wget -O- http://app:9527/metrics
```

**检查 LX-Sync 服务**:
```bash
curl http://localhost:9527/metrics
```

**查看 Prometheus 日志**:
```bash
docker compose -f compose.yaml -f compose.monitoring.yml logs prometheus
```

### Grafana 无法连接 Prometheus

**验证数据源**:
```bash
docker compose -f compose.yaml -f compose.monitoring.yml exec grafana curl http://prometheus:9090/-/healthy
```

**检查网络**:
```bash
docker compose -f compose.yaml -f compose.monitoring.yml exec grafana nslookup prometheus
```

### 仪表盘无数据

1. 确认时间范围（右上角）选择正确
2. 确认 Prometheus 有数据：访问 http://localhost:9090/graph
3. 运行查询：`lx_sync_http_request_total`
4. 如果返回空，等待下一个抓取周期（默认 15 秒）

---

## 卸载

### 停止服务但保留数据

```bash
docker compose -f compose.yaml -f compose.monitoring.yml down
```

### 完全删除（包括数据）

```bash
docker compose -f compose.yaml -f compose.monitoring.yml down -v
```

**警告**: `-v` 会删除 PostgreSQL、Prometheus 和 Grafana 的所有数据。

---

## 参考资源

- [Prometheus 官方文档](https://prometheus.io/docs/)
- [Grafana 官方文档](https://grafana.com/docs/)
- [PromQL 查询示例](https://prometheus.io/docs/prometheus/latest/querying/examples/)
- [prom-client Node.js 库](https://github.com/siimon/prom-client)

---

**维护者**: LX-Sync Team
**最后更新**: 2026-09-13
