import {
  Counter,
  Gauge,
  Histogram,
  register,
  collectDefaultMetrics,
  type Registry,
} from "prom-client";
import type { Logger } from "pino";

export class PrometheusMetrics {
  private registry: Registry;

  // HTTP metrics
  readonly httpRequestDuration: Histogram;
  readonly httpRequestTotal: Counter;
  readonly httpRequestSize: Histogram;
  readonly httpResponseSize: Histogram;

  // Application metrics
  readonly actionLedgerSize: Gauge;
  readonly pendingEventsSize: Gauge;
  readonly savedPoolsSize: Gauge;
  readonly userQuestsSize: Gauge;
  readonly vaultSettlementsSize: Gauge;

  // Action metrics
  readonly actionLedgerByStatus: Gauge;
  readonly actionLedgerByType: Gauge;

  // Business metrics
  readonly totalVaultDeposits: Gauge;
  readonly activeParticipants: Gauge;
  readonly totalVaults: Gauge;

  // Cache metrics
  readonly cacheHitRate: Gauge;
  readonly cacheEvictions: Counter;

  // Indexer metrics
  readonly indexerLatestLedger: Gauge;
  readonly indexerLastSyncTime: Gauge;
  readonly indexerSyncErrors: Counter;

  constructor(logger?: Logger) {
    this.registry = register;

    // Collect default Node.js metrics
    collectDefaultMetrics({ register: this.registry });

    // Initialize HTTP metrics
    this.httpRequestDuration = new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request duration in seconds",
      labelNames: ["method", "route", "status_code"],
      buckets: [0.1, 0.5, 1, 2, 5, 10],
      registers: [this.registry],
    });

    this.httpRequestTotal = new Counter({
      name: "http_requests_total",
      help: "Total number of HTTP requests",
      labelNames: ["method", "route", "status_code"],
      registers: [this.registry],
    });

    this.httpRequestSize = new Histogram({
      name: "http_request_size_bytes",
      help: "HTTP request size in bytes",
      labelNames: ["method", "route"],
      buckets: [100, 1000, 10000, 100000],
      registers: [this.registry],
    });

    this.httpResponseSize = new Histogram({
      name: "http_response_size_bytes",
      help: "HTTP response size in bytes",
      labelNames: ["method", "route", "status_code"],
      buckets: [100, 1000, 10000, 100000],
      registers: [this.registry],
    });

    // Initialize Database metrics
    this.actionLedgerSize = new Gauge({
      name: "action_ledger_total",
      help: "Total number of action ledger entries",
      registers: [this.registry],
    });

    this.pendingEventsSize = new Gauge({
      name: "pending_events_total",
      help: "Total number of pending events",
      registers: [this.registry],
    });

    this.savedPoolsSize = new Gauge({
      name: "saved_pools_total",
      help: "Total number of saved pools",
      registers: [this.registry],
    });

    this.userQuestsSize = new Gauge({
      name: "user_quests_total",
      help: "Total number of user quests",
      registers: [this.registry],
    });

    this.vaultSettlementsSize = new Gauge({
      name: "vault_settlements_total",
      help: "Total number of vault settlements",
      registers: [this.registry],
    });

    // Initialize Action status metrics
    this.actionLedgerByStatus = new Gauge({
      name: "action_ledger_by_status",
      help: "Number of actions by status",
      labelNames: ["status"],
      registers: [this.registry],
    });

    this.actionLedgerByType = new Gauge({
      name: "action_ledger_by_type",
      help: "Number of actions by type",
      labelNames: ["action_type"],
      registers: [this.registry],
    });

    // Initialize Business metrics
    this.totalVaultDeposits = new Gauge({
      name: "total_vault_deposits",
      help: "Total vault deposits in protocol",
      registers: [this.registry],
    });

    this.activeParticipants = new Gauge({
      name: "active_participants_total",
      help: "Number of active participants",
      registers: [this.registry],
    });

    this.totalVaults = new Gauge({
      name: "total_vaults",
      help: "Total number of active vaults",
      registers: [this.registry],
    });

    // Initialize Cache metrics
    this.cacheHitRate = new Gauge({
      name: "cache_hit_rate",
      help: "Cache hit rate (0-1)",
      registers: [this.registry],
    });

    this.cacheEvictions = new Counter({
      name: "cache_evictions_total",
      help: "Total number of cache evictions",
      registers: [this.registry],
    });

    // Initialize Indexer metrics
    this.indexerLatestLedger = new Gauge({
      name: "indexer_latest_ledger",
      help: "Latest ledger processed by indexer",
      registers: [this.registry],
    });

    this.indexerLastSyncTime = new Gauge({
      name: "indexer_last_sync_timestamp",
      help: "Timestamp of last indexer sync",
      registers: [this.registry],
    });

    this.indexerSyncErrors = new Counter({
      name: "indexer_sync_errors_total",
      help: "Total indexer sync errors",
      registers: [this.registry],
    });

    logger?.info("Prometheus metrics initialized");
  }

  /**
   * Record HTTP request metrics
   */
  recordHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
    requestSize?: number,
    responseSize?: number,
  ) {
    this.httpRequestDuration.observe(
      { method, route, status_code: statusCode },
      durationSeconds,
    );

    this.httpRequestTotal.inc({
      method,
      route,
      status_code: statusCode,
    });

    if (requestSize) {
      this.httpRequestSize.observe({ method, route }, requestSize);
    }

    if (responseSize) {
      this.httpResponseSize.observe(
        { method, route, status_code: statusCode },
        responseSize,
      );
    }
  }

  /**
   * Record action ledger metrics
   */
  recordActionLedgerByStatus(status: string, count: number) {
    this.actionLedgerByStatus.set({ status }, count);
  }

  recordActionLedgerByType(actionType: string, count: number) {
    this.actionLedgerByType.set({ action_type: actionType }, count);
  }

  /**
   * Record cache metrics
   */
  recordCacheHitRate(hitRate: number) {
    this.cacheHitRate.set(hitRate);
  }

  recordCacheEviction() {
    this.cacheEvictions.inc();
  }

  /**
   * Record indexer metrics
   */
  recordIndexerLatestLedger(ledgerNumber: number) {
    this.indexerLatestLedger.set(ledgerNumber);
  }

  recordIndexerLastSyncTime(timestamp: number) {
    this.indexerLastSyncTime.set(timestamp);
  }

  recordIndexerSyncError() {
    this.indexerSyncErrors.inc();
  }

  /**
   * Get all metrics in Prometheus text format
   */
  async metrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Get content type for Prometheus metrics
   */
  getContentType(): string {
    return this.registry.contentType;
  }
}

// Singleton instance
let prometheusMetrics: PrometheusMetrics | undefined;

export function getPrometheusMetrics(logger?: Logger): PrometheusMetrics {
  if (!prometheusMetrics) {
    prometheusMetrics = new PrometheusMetrics(logger);
  }
  return prometheusMetrics;
}
