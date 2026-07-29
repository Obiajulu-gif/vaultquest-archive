# Prometheus Metrics Setup

This document explains the Prometheus metrics integration in the VaultQuest backend.

## Overview

The backend exposes a `/metrics` endpoint that provides detailed metrics in Prometheus format (OpenMetrics text format). These metrics can be scraped by Prometheus or any compatible monitoring system.

## Available Metrics

### HTTP Metrics

#### `http_requests_total` (Counter)

Total number of HTTP requests by method, route, and status code.

**Labels:** `method`, `route`, `status_code`

Example:

```
http_requests_total{method="POST", route="/api/actions", status_code="200"} 42
```

#### `http_request_duration_seconds` (Histogram)

HTTP request duration distribution in seconds.

**Labels:** `method`, `route`, `status_code`

**Buckets:** 0.1s, 0.5s, 1s, 2s, 5s, 10s

Example query:

```promql
rate(http_request_duration_seconds_sum[5m]) / rate(http_request_duration_seconds_count[5m])
```

#### `http_request_size_bytes` (Histogram)

HTTP request size distribution in bytes.

**Labels:** `method`, `route`

**Buckets:** 100, 1000, 10000, 100000

#### `http_response_size_bytes` (Histogram)

HTTP response size distribution in bytes.

**Labels:** `method`, `route`, `status_code`

**Buckets:** 100, 1000, 10000, 100000

### Database Metrics

#### `action_ledger_total` (Gauge)

Total number of action ledger entries in the database.

#### `pending_events_total` (Gauge)

Total number of pending events waiting to be processed.

#### `saved_pools_total` (Gauge)

Total number of saved pools in the database.

#### `user_quests_total` (Gauge)

Total number of user quests in the database.

#### `vault_settlements_total` (Gauge)

Total number of vault settlements in the database.

### Action Status Metrics

#### `action_ledger_by_status` (Gauge)

Number of actions by status.

**Labels:** `status`

Statuses: `pending`, `submitted`, `confirmed`, `failed`, `reverted`, `orphaned`

#### `action_ledger_by_type` (Gauge)

Number of actions by type.

**Labels:** `action_type`

Types: `deposit`, `withdraw`, `create_vault`, `claim`, `select_winner`

### Business Metrics

#### `total_vault_deposits` (Gauge)

Total vault deposits in the protocol (sum of TVL across all active pools).

#### `active_participants_total` (Gauge)

Number of active participants across all vaults.

#### `total_vaults` (Gauge)

Total number of active vaults.

### Cache Metrics

#### `cache_hit_rate` (Gauge)

Cache hit rate (0-1, where 1 = 100% hit rate).

#### `cache_evictions_total` (Counter)

Total number of cache evictions.

### Indexer Metrics

#### `indexer_latest_ledger` (Gauge)

Latest ledger number processed by the indexer.

#### `indexer_last_sync_timestamp` (Gauge)

Timestamp of the last successful indexer sync (Unix timestamp).

#### `indexer_sync_errors_total` (Counter)

Total number of indexer sync errors.

### Default Node.js Metrics

The following standard Node.js metrics are also exposed:

- `process_resident_memory_bytes` - Process resident memory
- `process_cpu_seconds_total` - Process CPU time
- `nodejs_version_info` - Node.js version
- `nodejs_heap_size_total_bytes` - Total heap size
- `nodejs_heap_size_used_bytes` - Used heap size
- And more...

## Prometheus Configuration

### Example `prometheus.yml` Configuration

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    monitor: "vaultquest-backend"

scrape_configs:
  - job_name: "vaultquest-backend"
    static_configs:
      - targets: ["localhost:3000"]
    metrics_path: "/metrics"
    scrape_interval: 15s
    scrape_timeout: 10s
```

### With Authentication (if needed)

```yaml
scrape_configs:
  - job_name: "vaultquest-backend"
    static_configs:
      - targets: ["https://api.example.com:3000"]
    metrics_path: "/metrics"
    scheme: "https"
    basic_auth:
      username: "prometheus"
      password: "your-password"
```

## Docker Compose Example

```yaml
version: "3.8"

services:
  backend:
    image: vaultquest/backend:latest
    ports:
      - "3000:3000"
    environment:
      PORT: "3000"
      # ... other env vars

  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus_data:/prometheus
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"
      - "--storage.tsdb.path=/prometheus"

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3001:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin
    volumes:
      - grafana_data:/var/lib/grafana
    depends_on:
      - prometheus

volumes:
  prometheus_data:
  grafana_data:
```

## Useful Prometheus Queries

### Request Rate (requests per second)

```promql
rate(http_requests_total[5m])
```

### Average Request Duration

```promql
rate(http_request_duration_seconds_sum[5m]) / rate(http_request_duration_seconds_count[5m])
```

### P95 Request Duration

```promql
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))
```

### Error Rate

```promql
rate(http_requests_total{status_code=~"5.."}[5m])
```

### Active Participants

```promql
active_participants_total
```

### Indexer Lag (seconds behind latest block)

```promql
time() - indexer_last_sync_timestamp
```

### Database Size Trends

```promql
rate(action_ledger_total[1h])
```

### Cache Hit Rate

```promql
cache_hit_rate
```

## Accessing the Metrics Endpoint

The metrics are available at:

```
GET /metrics
```

### Direct Access

```bash
curl http://localhost:3000/metrics
```

### Example Output

```
# HELP http_requests_total Total number of HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",route="/health",status_code="200"} 150
http_requests_total{method="POST",route="/api/actions",status_code="200"} 42
http_requests_total{method="POST",route="/api/actions",status_code="400"} 2

# HELP http_request_duration_seconds HTTP request duration in seconds
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{method="POST",route="/api/actions",status_code="200",le="0.1"} 40
http_request_duration_seconds_bucket{method="POST",route="/api/actions",status_code="200",le="0.5"} 41
http_request_duration_seconds_bucket{method="POST",route="/api/actions",status_code="200",le="1"} 42
...
```

## Integration with Grafana

### Add Prometheus Data Source

1. Open Grafana (default: http://localhost:3001)
2. Go to Configuration → Data Sources
3. Click "Add data source"
4. Select "Prometheus"
5. Set URL to `http://prometheus:9090`
6. Click "Save & Test"

### Create Dashboards

Import pre-built dashboards or create custom ones using the metrics. Some popular options:

- [Node Exporter Full](https://grafana.com/grafana/dashboards/1860)
- [Prometheus Stats](https://grafana.com/grafana/dashboards/2)

## Alerting

Example alert rules (`alerts.yml`):

```yaml
groups:
  - name: vaultquest
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status_code=~"5.."}[5m]) > 0.05
        for: 5m
        annotations:
          summary: "High error rate detected"
          description: "Error rate is {{ $value | humanizePercentage }}"

      - alert: IndexerLagged
        expr: time() - indexer_last_sync_timestamp > 300
        for: 5m
        annotations:
          summary: "Indexer is lagging"
          description: "Last sync was {{ $value }}s ago"

      - alert: HighMemoryUsage
        expr: process_resident_memory_bytes / 1024 / 1024 / 1024 > 2
        for: 5m
        annotations:
          summary: "High memory usage"
          description: "Using {{ $value | humanize }}GB of memory"
```

## Notes

- The `/metrics` endpoint is excluded from rate limiting to allow frequent scrapes
- Metrics are collected in-memory and reset on server restart
- For production setups, consider adding persistence layer for long-term metrics storage
- Default Node.js metrics are automatically collected by `prom-client`

## References

- [Prometheus Documentation](https://prometheus.io/docs/)
- [prom-client Library](https://github.com/siimon/prom-client)
- [OpenMetrics Format](https://openmetrics.io/)
