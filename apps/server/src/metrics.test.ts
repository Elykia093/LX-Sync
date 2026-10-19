import { expect, it } from 'vitest'
import {
  httpRequestDuration,
  httpRequestTotal,
  registry,
  syncOperationDuration,
  syncOperationTotal,
  wsConnectionsActive,
  wsConnectionsTotal,
} from './metrics.js'

it('exports the metric names and labels used by the monitoring configuration', async () => {
  httpRequestDuration.observe(
    { method: 'GET', route: '/health/ready', status_code: '200' },
    0.05,
  )
  httpRequestTotal.inc({
    method: 'GET',
    route: '/health/ready',
    status_code: '200',
  })
  wsConnectionsActive.set(1)
  wsConnectionsTotal.inc({ status: 'success' })
  syncOperationDuration.observe({ operation: 'initialize' }, 0.1)
  syncOperationTotal.inc({ operation: 'initialize', status: 'error' })

  const output = await registry.metrics()

  expect(output).toContain(
    'lx_sync_http_request_duration_seconds_bucket{le="0.05",method="GET",route="/health/ready",status_code="200"} 1',
  )
  expect(output).toContain(
    'lx_sync_http_request_total{method="GET",route="/health/ready",status_code="200"} 1',
  )
  expect(output).toContain('lx_sync_active_connections 1')
  expect(output).toContain(
    'lx_sync_websocket_connections_total{status="success"} 1',
  )
  expect(output).toContain(
    'lx_sync_operation_duration_seconds_sum{operation="initialize"} 0.1',
  )
  expect(output).toContain(
    'lx_sync_operation_total{operation="initialize",status="error"} 1',
  )
})
