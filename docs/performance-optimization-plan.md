# LX-Sync 性能优化实施计划

> 本文保留未实施的优化提案，不是可直接执行的部署手册。性能百分比是历史目标，不是实测结果；当前代码状态以 `docs/performance-optimization-status.md` 为准。索引迁移已取消，连接池参数未实现，多实例/Redis 变更须先完成独立架构设计。

## 优化目标

- **短期测量目标**（1-2 周）：建立可复现的首次同步与重连基线；暂不设定加速百分比。
- **中期目标**（1 个月）：支持 20+ 设备并发同步无明显排队
- **长期目标**（3 个月）：支持增量同步，大歌单（5000+ 首）秒级完成

---

## 阶段 1：索引审查（不新增索引）

本阶段原提案已复核并取消：`device_sync_state_primary (device_id, domain)` 已覆盖 baseline 点查；`sync_snapshots_user_domain_content (user_id, domain, content_hash)` 已覆盖快照去重查询；`audit_events_created (created_at)` 已覆盖审计时间排序。重复创建同列顺序的索引会增加存储与写入成本。

目前没有可引用的 `EXPLAIN (ANALYZE, BUFFERS)` 或生产规模基准。后续索引调整须先在隔离测试库复核真实 SQL、执行计划、表规模和写入成本，再单独设计迁移；不要运行旧版本节中的迁移命令。

---

## 阶段 2：配置调优（提案，未实施）

### 任务 2.1：数据库连接池容量

当前 server 连接池在 `apps/server/src/db/connection.ts` 固定为 10 个连接；`pool_max` URL 参数和 `DB_MAX_CONNECTIONS` 环境变量均未实现。不要将它们写入 `.env` 或 Compose 并假设会生效。

若未来确需调整，先以受控测试环境采集并发连接、等待时间和 PostgreSQL 资源数据，再同步修改 config schema、连接池创建逻辑、`.env.example`、部署文档与测试。单实例上限和 PostgreSQL 可用连接数必须一起核算。

### 任务 2.2：PostgreSQL 参数调优（可选）
**负责人**：DBA
**工作量**：30 分钟
**依赖**：DBA 已确认目标 PostgreSQL 版本、资源预算和隔离验证环境
**优先级**：P2（仅在数据库性能瓶颈时）

**步骤**：
1. 检查当前配置
   ```sql
   SHOW shared_buffers;
   SHOW work_mem;
   SHOW effective_cache_size;
   ```

2. 根据内存调整（假设 2GB 可用内存）
   ```ini
   # 容器环境通过命令行参数
   services:
     db:
       command:
         - postgres
         - -c
         - shared_buffers=512MB
         - -c
         - work_mem=16MB
         - -c
         - effective_cache_size=1GB
   ```

3. 重启数据库并验证
   ```bash
   docker compose restart db
   docker compose exec db psql -U lxsync -c "SHOW shared_buffers;"
   ```

**验收标准**：
- 参数生效且资源使用在 DBA 批准的预算内。
- 查询变化通过真实工作负载和执行计划验证；不预设提升百分比。
- 数据库资源阈值由 DBA 按环境容量确定。

**跳过条件**：
- 当前数据库查询时间 <50ms
- 内存资源受限（<1GB 可用）

---

## 阶段 3：代码优化（P1，2 周内）

### 任务 3.1：list/dislike 并行初始化（0.7.0 已实现）

初始化先完成 feature 协商，然后在同一用户级 `runExclusive` 任务中并行执行启用域。每个域仍独立读取 head、应用 CAS 写入和推进设备 baseline；LX v4 wire format 与 `featureVersion` 不变。

测试与风险证据见 `apps/server/src/sync/engine.test.ts` 和 `apps/server/src/protocol.integration.test.ts`。目前没有经过负载测试的延迟基线，不报告固定加速比例。

### 任务 3.2：设备替换等待（保持现状）

新连接等待同设备旧连接的在途用户任务完成，是同用户写入顺序和快照 CAS 的保护边界。不要将 `closeDevice()` 改为 fire-and-forget，也不要在旧写入尚未完成时登记新连接。

只有基准测试证明等待时间是瓶颈后，才能另行设计并发策略；必须验证旧写入不会晚于新连接写入、同用户队列顺序、CAS 重试和断线清理。

### 任务 3.3：Head 缓存优化（可选）
**负责人**：后端开发
**工作量**：6 小时
**依赖**：3.2 完成
**优先级**：P2（仅在数据库仍是瓶颈时）

**实现**：

在 `SyncEngine` 中添加进程内 LRU 缓存：

```typescript
import { LRUCache } from 'lru-cache'

export class SyncEngine {
  private headCache = new LRUCache<string, SnapshotRecord>({
    max: 1000, // 最多缓存 1000 个用户×域
    ttl: 60_000, // 60 秒过期
  })

  constructor(
    private readonly repository: SyncRepository,
    private readonly hub: ConnectionHub,
    private readonly logger?: SyncLogger,
  ) {}

  private async getCachedHead(
    domain: SyncDomain,
    userId: string,
  ): Promise<SnapshotRecord> {
    const key = `${userId}:${domain}`
    const cached = this.headCache.get(key)
    if (cached) {
      this.logger?.debug({ userId, domain }, 'Head cache hit')
      return cached
    }
    const head = await this.repository.getHead(domain, userId)
    this.headCache.set(key, head)
    return head
  }

  private invalidateHeadCache(userId: string, domain: SyncDomain): void {
    this.headCache.delete(`${userId}:${domain}`)
  }

  // 在 syncList/syncDislike 中使用 getCachedHead
  // 在 saveSnapshot 成功后调用 invalidateHeadCache
}
```

**测试**：
1. 缓存命中率统计
2. 并发更新时缓存失效正确性
3. 内存使用监控（1000 条目约 <10MB）

**验收标准**：
- Head cache 收益由基准数据确认；不预设延迟或命中率。
- 缓存命中率由实际负载数据确定。
- 更新后立即读取返回最新数据，且 CAS/失效路径通过并发测试。

**跳过条件**：
- 当前 head 查询耗时 <10ms
- 单实例场景下收益有限

---

## 阶段 4：协议与架构升级（P2，1-3 个月）

### 任务 4.1：增量同步协议设计
**负责人**：架构师 + 客户端负责人
**工作量**：2 周（设计 1 周 + 原型 1 周）
**依赖**：阶段 3 完成

**目标**：
- 定义 `featureVersion: 2` 的增量同步格式
- 客户端只发送变更的歌曲/歌单，而非全量数据
- 服务端应用增量合并算法

**设计要点**：
```typescript
interface ListDelta {
  baseHash: string           // 基于哪个快照的增量
  addedSongs: Song[]        // 新增歌曲
  removedSongIds: string[]  // 删除的歌曲 ID
  modifiedPlaylists: Array<{ // 修改的歌单
    id: string
    name?: string
    addedSongs?: string[]   // 歌单内新增歌曲 ID
    removedSongs?: string[]
  }>
}
```

**里程碑**：
1. RFC 文档评审通过
2. 服务端实现增量应用逻辑
3. 客户端 PR 提交到 LX Music 社区
4. Beta 测试（5+ 用户）

**交付物**：
- `docs/protocol-v2-incremental-sync.md`
- 服务端实现 PR
- 客户端兼容性矩阵

---

### 任务 4.2：多实例架构方案
**负责人**：架构师
**工作量**：4 周（设计 1 周 + 实现 2 周 + 测试 1 周）
**依赖**：4.1 完成
**优先级**：P3（仅在单实例无法满足时）

**问题**：
当前限制单实例的状态：
- WebSocket 连接注册表（进程内 Map）
- 用户级操作队列（进程内 Promise）
- 在线设备广播（只能发给同进程连接）
- 登录限流（进程内计数）

**方案**：
1. **引入 Redis**：
   - 连接注册：`HSET connections:${userId} ${deviceId} ${instanceId}`
   - 分布式锁：`SETNX lock:user:${userId}`
   - 广播路由：`PUBLISH sync:${userId} ${action}`

2. **消息队列**（可选，RabbitMQ/NATS）：
   - 跨实例广播投递保证
   - 操作日志持久化

3. **数据库通知**（备选）：
   - PostgreSQL `LISTEN/NOTIFY`
   - 仅通知事件，不传输大数据

**里程碑**：
1. 架构设计评审
2. Redis 集成（连接注册 + 锁）
3. 跨实例广播实现
4. 故障转移测试（杀死一个实例）
5. 灰度发布（2 实例）
6. 生产验证（3+ 实例）

**交付物**：
- `docs/architecture-multi-instance.md`
- Redis 配置模板
- Kubernetes Deployment YAML（如果需要）

---

## 阶段 5：监控与持续优化（P1，持续进行）

### 任务 5.1：Prometheus 本地监控（0.7 实现中）

当前指标契约和本地 Compose overlay 以 `apps/server/src/metrics.ts`、`prometheus.yml`、`alerts.yml`、`grafana-dashboard.json` 与 `docs/monitoring-setup.md` 为准。指标标签不包含 user ID；生产环境需将 `/metrics` 限制在受信监控网络内。

发版前验证 Prometheus 目标端口、PromQL 指标名/标签与代码导出一致；告警通知需要额外部署和配置 Alertmanager。监控功能不构成同步延迟基准。

---

### 任务 5.2：性能回归测试
**负责人**：QA + 开发
**工作量**：2 天
**依赖**：5.1 完成

**实现**：
```typescript
// tests/performance/sync-benchmark.test.ts
import { describe, it, expect } from 'vitest'

describe('Sync Performance Benchmark', () => {
  it('should complete initial sync within 2s', async () => {
    const start = Date.now()
    await client.connect()
    await client.waitForSync()
    const duration = Date.now() - start
    expect(duration).toBeLessThan(2000)
  })

  it('should handle 10 concurrent connections', async () => {
    const clients = Array.from({ length: 10 }, () => createClient())
    const start = Date.now()
    await Promise.all(clients.map(c => c.connect()))
    const duration = Date.now() - start
    expect(duration).toBeLessThan(5000)
  })
})
```

**验收标准**：
- 基准测试只有在稳定、代表性数据集建立后才纳入 CI。
- 回归阈值必须依据测量方差设定，不能先验固定为 20%。
- 发版基准测试需固定数据集、客户端版本和运行环境。

---

## 当前状态与验收

- 并行初始化属于代码实现变化；没有可引用的基线和负载测试，不报告延迟下降百分比。
- 数据库查询依赖 migration 001 已建立的主键、唯一约束和审计索引；本版本不新增性能索引。
- Prometheus/Grafana 作为显式本地 overlay 提供；它不代表生产告警通道或容量验证。
- 增量同步协议、多实例和连接池调优均未在本版本实现。

性能比较需使用隔离环境、固定客户端/数据规模/镜像版本，记录多次运行的 median 与 P95；不得用估算替代实测。

---

## 风险与边界

- 并行域初始化必须保留用户级 `runExclusive`、各域 head 行锁和 CAS；不得为了缩短握手延迟取消这些边界。
- 设备替换等待旧用户任务完成是写入顺序保护；异步关闭方案未获批准。
- LX v4 增量协议和多实例广播都需要独立兼容/架构设计；Redis 不作为当前单实例部署的局部补丁。
- 生产监控需通过受控网络、认证与 digest 固定制品配置；本地 overlay 不能替代该部署设计。

---

## 后续验证

1. 在符合项目门禁的临时 PostgreSQL test 数据库运行协议 integration。
2. 运行 Playwright 管理端 E2E，验证歌单分页、导出、复制预览与会话状态。
3. 使用隔离客户端和代表性数据建立同步延迟、数据库执行计划与资源使用基线。
4. 只有测量显示瓶颈且存在索引缺口时，才提出新 migration。


## 参考资料

- [性能优化详细指南](./performance-optimization.md)
- [PostgreSQL 索引最佳实践](https://www.postgresql.org/docs/current/indexes.html)
- [LX Music 同步协议文档](../apps/server/src/protocol/index.ts)
- [message2call RPC 框架](https://github.com/lyswhut/message2call)
