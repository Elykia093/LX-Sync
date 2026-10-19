import { Counter, Gauge, Histogram, Registry } from 'prom-client'

export const registry = new Registry()

// HTTP 请求指标
export const httpRequestDuration = new Histogram({
  name: 'lx_sync_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [registry],
})

export const httpRequestTotal = new Counter({
  name: 'lx_sync_http_request_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
})

// WebSocket 连接指标
export const wsConnectionsActive = new Gauge({
  name: 'lx_sync_active_connections',
  help: 'Number of active WebSocket connections',
  registers: [registry],
})

export const wsConnectionsTotal = new Counter({
  name: 'lx_sync_websocket_connections_total',
  help: 'Total number of WebSocket connections',
  labelNames: ['status'],
  registers: [registry],
})

// 同步操作指标
export const syncOperationDuration = new Histogram({
  name: 'lx_sync_operation_duration_seconds',
  help: 'Sync operation duration in seconds',
  labelNames: ['operation'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [registry],
})

export const syncOperationTotal = new Counter({
  name: 'lx_sync_operation_total',
  help: 'Total number of sync operations',
  labelNames: ['operation', 'status'],
  registers: [registry],
})
