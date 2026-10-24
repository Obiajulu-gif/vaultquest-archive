/**
 * Historical Trend Aggregation Service for Maintainer Analytics
 *
 * Provides time-series aggregated metrics for usage, failures, recovery actions,
 * and important domain activity over configurable time windows.
 *
 * This service:
 * - Defines trend metrics and aggregation windows (hour, day, week, month)
 * - Performs deterministic aggregation for consistent results
 * - Handles data privacy by redacting sensitive information
 * - Provides export/report shape with schema versioning
 */

import type { PrismaClient } from "@prisma/client";

/**
 * Aggregation window types
 */
export type AggregationWindow = "hour" | "day" | "week" | "month";

/**
 * Trend metric names
 */
export type TrendMetric =
  | "total_deposits"
  | "total_withdrawals"
  | "total_claims"
  | "failed_transactions"
  | "active_users"
  | "pool_count"
  | "total_tvl"
  | "prize_distributed"
  | "recovery_actions"
  | "conflict_resolutions";

/**
 * Aggregation window duration in milliseconds
 */
export const WINDOW_DURATIONS: Record<AggregationWindow, number> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

/**
 * Current schema version for trend aggregates
 */
export const TREND_SCHEMA_VERSION = 1;

/**
 * Trend aggregate record
 */
export interface TrendAggregate {
  id: string;
  metricName: TrendMetric;
  window: AggregationWindow;
  windowStart: Date;
  windowEnd: Date;
  value: number;
  count: number;
  metadata: Record<string, unknown> | null;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Trend aggregation query options
 */
export interface TrendAggregationOptions {
  metricName: TrendMetric;
  window: AggregationWindow;
  startDate: Date;
  endDate: Date;
  includeMetadata?: boolean;
}

/**
 * Trend aggregation result
 */
export interface TrendAggregationResult {
  metricName: TrendMetric;
  window: AggregationWindow;
  data: Array<{
    windowStart: Date;
    windowEnd: Date;
    value: number;
    count: number;
    metadata?: Record<string, unknown>;
  }>;
  schemaVersion: number;
  generatedAt: Date;
}

/**
 * Export format for trend data
 */
export interface TrendExport {
  schemaVersion: number;
  exportDate: Date;
  metrics: Record<TrendMetric, TrendAggregationResult>;
  metadata: {
    startDate: Date;
    endDate: Date;
    windows: AggregationWindow[];
    generatedBy: string;
  };
}

/**
 * Privacy redaction rules
 */
interface PrivacyRule {
  field: string;
  action: "redact" | "hash" | "keep";
}

const PRIVACY_RULES: PrivacyRule[] = [
  { field: "walletAddress", action: "hash" },
  { field: "email", action: "redact" },
  { field: "privateKey", action: "redact" },
  { field: "seedPhrase", action: "redact" },
];

export class TrendAggregationService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Aggregate trend data for a specific metric and time range
   *
   * @param options Aggregation options
   * @returns Aggregated trend data
   */
  async aggregateTrends(
    options: TrendAggregationOptions
  ): Promise<TrendAggregationResult> {
    const { metricName, window, startDate, endDate, includeMetadata = false } = options;

    // Generate window boundaries
    const windows = this.generateWindows(window, startDate, endDate);

    // Aggregate data for each window
    const data = await Promise.all(
      windows.map(async ({ start, end }) => {
        const result = await this.aggregateForWindow(metricName, start, end, includeMetadata);
        return {
          windowStart: start,
          windowEnd: end,
          value: result.value,
          count: result.count,
          metadata: result.metadata,
        };
      })
    );

    return {
      metricName,
      window,
      data,
      schemaVersion: TREND_SCHEMA_VERSION,
      generatedAt: new Date(),
    };
  }

  /**
   * Aggregate multiple metrics for a time range
   *
   * @param metrics Array of metric names to aggregate
   * @param window Aggregation window
   * @param startDate Start date
   * @param endDate End date
   * @returns Map of metric names to aggregation results
   */
  async aggregateMultipleMetrics(
    metrics: TrendMetric[],
    window: AggregationWindow,
    startDate: Date,
    endDate: Date
  ): Promise<Record<TrendMetric, TrendAggregationResult>> {
    const results = await Promise.all(
      metrics.map((metricName) =>
        this.aggregateTrends({ metricName, window, startDate, endDate })
      )
    );

    return results.reduce(
      (acc, result) => {
        acc[result.metricName] = result;
        return acc;
      },
      {} as Record<TrendMetric, TrendAggregationResult>
    );
  }

  /**
   * Persist aggregated trend data
   *
   * @param aggregate Trend aggregate to persist
   * @returns Persisted aggregate
   */
  async persistAggregate(aggregate: Omit<TrendAggregate, "id" | "createdAt" | "updatedAt">): Promise<TrendAggregate> {
    return this.prisma.trendAggregate.create({
      data: {
        ...aggregate,
        schemaVersion: TREND_SCHEMA_VERSION,
      },
    });
  }

  /**
   * Retrieve persisted trend aggregates
   *
   * @param metricName Metric name
   * @param window Aggregation window
   * @param startDate Start date
   * @param endDate End date
   * @returns Array of trend aggregates
   */
  async getAggregates(
    metricName: TrendMetric,
    window: AggregationWindow,
    startDate: Date,
    endDate: Date
  ): Promise<TrendAggregate[]> {
    return this.prisma.trendAggregate.findMany({
      where: {
        metricName,
        window,
        windowStart: { gte: startDate },
        windowEnd: { lte: endDate },
        schemaVersion: TREND_SCHEMA_VERSION,
      },
      orderBy: { windowStart: "asc" },
    });
  }

  /**
   * Export trend data for a time range
   *
   * @param metrics Metrics to include
   * @param windows Windows to include
   * @param startDate Start date
   * @param endDate End date
   * @returns Export data structure
   */
  async exportTrends(
    metrics: TrendMetric[],
    windows: AggregationWindow[],
    startDate: Date,
    endDate: Date
  ): Promise<TrendExport> {
    const metricsResults = await Promise.all(
      metrics.map((metricName) =>
        this.aggregateMultipleMetrics([metricName], windows[0], startDate, endDate)
      )
    );

    const allMetrics: Record<TrendMetric, TrendAggregationResult> = {};
    for (const result of metricsResults) {
      Object.assign(allMetrics, result);
    }

    return {
      schemaVersion: TREND_SCHEMA_VERSION,
      exportDate: new Date(),
      metrics: allMetrics,
      metadata: {
        startDate,
        endDate,
        windows,
        generatedBy: "trend-aggregation-service",
      },
    };
  }

  /**
   * Generate time windows for aggregation
   *
   * @param window Window type
   * @param startDate Start date
   * @param endDate End date
   * @returns Array of window boundaries
   */
  private generateWindows(
    window: AggregationWindow,
    startDate: Date,
    endDate: Date
  ): Array<{ start: Date; end: Date }> {
    const duration = WINDOW_DURATIONS[window];
    const windows: Array<{ start: Date; end: Date }> = [];

    let currentStart = new Date(startDate);
    currentStart.setMilliseconds(0);
    currentStart.setSeconds(0);
    currentStart.setMinutes(0);

    // Align to window boundary
    if (window === "hour") {
      // Already aligned
    } else if (window === "day") {
      currentStart.setHours(0);
    } else if (window === "week") {
      currentStart.setHours(0);
      const dayOfWeek = currentStart.getDay();
      currentStart.setDate(currentStart.getDate() - dayOfWeek);
    } else if (window === "month") {
      currentStart.setHours(0);
      currentStart.setDate(1);
    }

    while (currentStart < endDate) {
      const currentEnd = new Date(currentStart.getTime() + duration);
      if (currentEnd > endDate) {
        windows.push({ start: currentStart, end: endDate });
        break;
      }
      windows.push({ start: currentStart, end: currentEnd });
      currentStart = currentEnd;
    }

    return windows;
  }

  /**
   * Aggregate data for a specific window
   *
   * @param metricName Metric to aggregate
   * @param windowStart Window start
   * @param windowEnd Window end
   * @param includeMetadata Whether to include metadata
   * @returns Aggregated value and count
   */
  private async aggregateForWindow(
    metricName: TrendMetric,
    windowStart: Date,
    windowEnd: Date,
    includeMetadata: boolean
  ): Promise<{ value: number; count: number; metadata?: Record<string, unknown> }> {
    switch (metricName) {
      case "total_deposits":
        return this.aggregateDeposits(windowStart, windowEnd, includeMetadata);
      case "total_withdrawals":
        return this.aggregateWithdrawals(windowStart, windowEnd, includeMetadata);
      case "total_claims":
        return this.aggregateClaims(windowStart, windowEnd, includeMetadata);
      case "failed_transactions":
        return this.aggregateFailedTransactions(windowStart, windowEnd, includeMetadata);
      case "active_users":
        return this.aggregateActiveUsers(windowStart, windowEnd, includeMetadata);
      case "pool_count":
        return this.aggregatePoolCount(windowStart, windowEnd, includeMetadata);
      case "total_tvl":
        return this.aggregateTVL(windowStart, windowEnd, includeMetadata);
      case "prize_distributed":
        return this.aggregatePrizeDistributed(windowStart, windowEnd, includeMetadata);
      case "recovery_actions":
        return this.aggregateRecoveryActions(windowStart, windowEnd, includeMetadata);
      case "conflict_resolutions":
        return this.aggregateConflictResolutions(windowStart, windowEnd, includeMetadata);
      default:
        return { value: 0, count: 0 };
    }
  }

  /**
   * Aggregate deposit metrics
   */
  private async aggregateDeposits(
    windowStart: Date,
    windowEnd: Date,
    includeMetadata: boolean
  ): Promise<{ value: number; count: number; metadata?: Record<string, unknown> }> {
    const deposits = await this.prisma.actionLedger.findMany({
      where: {
        actionType: "deposit",
        status: "confirmed",
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: {
        actionPayload: true,
        walletAddress: true,
        createdAt: true,
      },
    });

    const totalAmount = deposits.reduce((sum, deposit) => {
      const payload = deposit.actionPayload as Record<string, unknown> | null;
      const amount = Number(payload?.amount ?? 0);
      return sum + amount;
    }, 0);

    const uniqueWallets = new Set(deposits.map((d) => d.walletAddress));

    const metadata = includeMetadata
      ? {
          uniqueWallets: uniqueWallets.size,
          averageDeposit: deposits.length > 0 ? totalAmount / deposits.length : 0,
        }
      : undefined;

    return { value: totalAmount, count: deposits.length, metadata };
  }

  /**
   * Aggregate withdrawal metrics
   */
  private async aggregateWithdrawals(
    windowStart: Date,
    windowEnd: Date,
    includeMetadata: boolean
  ): Promise<{ value: number; count: number; metadata?: Record<string, unknown> }> {
    const withdrawals = await this.prisma.actionLedger.findMany({
      where: {
        actionType: "withdraw",
        status: "confirmed",
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: {
        actionPayload: true,
        walletAddress: true,
      },
    });

    const totalAmount = withdrawals.reduce((sum, withdrawal) => {
      const payload = withdrawal.actionPayload as Record<string, unknown> | null;
      const amount = Number(payload?.amount ?? 0);
      return sum + amount;
    }, 0);

    const metadata = includeMetadata
      ? {
          uniqueWallets: new Set(withdrawals.map((w) => w.walletAddress)).size,
          averageWithdrawal: withdrawals.length > 0 ? totalAmount / withdrawals.length : 0,
        }
      : undefined;

    return { value: totalAmount, count: withdrawals.length, metadata };
  }

  /**
   * Aggregate claim metrics
   */
  private async aggregateClaims(
    windowStart: Date,
    windowEnd: Date,
    includeMetadata: boolean
  ): Promise<{ value: number; count: number; metadata?: Record<string, unknown> }> {
    const claims = await this.prisma.actionLedger.findMany({
      where: {
        actionType: "claim",
        status: "confirmed",
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: {
        actionPayload: true,
        walletAddress: true,
      },
    });

    const totalAmount = claims.reduce((sum, claim) => {
      const payload = claim.actionPayload as Record<string, unknown> | null;
      const amount = Number(payload?.amount ?? 0);
      return sum + amount;
    }, 0);

    const metadata = includeMetadata
      ? {
          uniqueWallets: new Set(claims.map((c) => c.walletAddress)).size,
          averageClaim: claims.length > 0 ? totalAmount / claims.length : 0,
        }
      : undefined;

    return { value: totalAmount, count: claims.length, metadata };
  }

  /**
   * Aggregate failed transaction metrics
   */
  private async aggregateFailedTransactions(
    windowStart: Date,
    windowEnd: Date,
    includeMetadata: boolean
  ): Promise<{ value: number; count: number; metadata?: Record<string, unknown> }> {
    const failed = await this.prisma.actionLedger.findMany({
      where: {
        status: { in: ["failed", "reverted", "orphaned"] },
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: {
        actionType: true,
        errorCode: true,
        walletAddress: true,
      },
    });

    const byActionType = failed.reduce(
      (acc, tx) => {
        acc[tx.actionType] = (acc[tx.actionType] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const metadata = includeMetadata
      ? {
          byActionType,
          uniqueWallets: new Set(failed.map((f) => f.walletAddress)).size,
        }
      : undefined;

    return { value: failed.length, count: failed.length, metadata };
  }

  /**
   * Aggregate active user metrics
   */
  private async aggregateActiveUsers(
    windowStart: Date,
    windowEnd: Date,
    includeMetadata: boolean
  ): Promise<{ value: number; count: number; metadata?: Record<string, unknown> }> {
    const activeUsers = await this.prisma.actionLedger.groupBy({
      by: ["walletAddress"],
      where: {
        status: "confirmed",
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      _count: true,
    });

    return { value: activeUsers.length, count: activeUsers.length };
  }

  /**
   * Aggregate pool count metrics
   */
  private async aggregatePoolCount(
    windowStart: Date,
    windowEnd: Date,
    includeMetadata: boolean
  ): Promise<{ value: number; count: number; metadata?: Record<string, unknown> }> {
    const pools = await this.prisma.savedPool.findMany({
      where: {
        createdAt: { gte: windowStart, lte: windowEnd },
      },
    });

    const activePools = pools.filter((p) => p.status === "active");

    const metadata = includeMetadata
      ? {
          totalPools: pools.length,
          activePools: activePools.length,
        }
      : undefined;

    return { value: activePools.length, count: pools.length, metadata };
  }

  /**
   * Aggregate TVL metrics
   */
  private async aggregateTVL(
    windowStart: Date,
    windowEnd: Date,
    includeMetadata: boolean
  ): Promise<{ value: number; count: number; metadata?: Record<string, unknown> }> {
    const savedPools = await this.prisma.savedPool.findMany({
      where: {
        status: "active",
      },
      select: {
        tvl: true,
      },
    });

    const totalTVL = savedPools.reduce((sum, pool) => {
      return sum + Number(pool.tvl ?? "0");
    }, 0);

    return { value: totalTVL, count: savedPools.length };
  }

  /**
   * Aggregate prize distributed metrics
   */
  private async aggregatePrizeDistributed(
    windowStart: Date,
    windowEnd: Date,
    includeMetadata: boolean
  ): Promise<{ value: number; count: number; metadata?: Record<string, unknown> }> {
    const claims = await this.prisma.actionLedger.findMany({
      where: {
        actionType: "claim",
        status: "confirmed",
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: {
        actionPayload: true,
      },
    });

    const totalPrize = claims.reduce((sum, claim) => {
      const payload = claim.actionPayload as Record<string, unknown> | null;
      const amount = Number(payload?.amount ?? 0);
      return sum + amount;
    }, 0);

    return { value: totalPrize, count: claims.length };
  }

  /**
   * Aggregate recovery action metrics
   */
  private async aggregateRecoveryActions(
    windowStart: Date,
    windowEnd: Date,
    includeMetadata: boolean
  ): Promise<{ value: number; count: number; metadata?: Record<string, unknown> }> {
    // Count actions that were retried and succeeded
    const retriedActions = await this.prisma.actionLedger.findMany({
      where: {
        retryCount: { gt: 0 },
        status: "confirmed",
        createdAt: { gte: windowStart, lte: windowEnd },
      },
    });

    const metadata = includeMetadata
      ? {
          byRetryCount: retriedActions.reduce(
            (acc, action) => {
              acc[action.retryCount] = (acc[action.retryCount] || 0) + 1;
              return acc;
            },
            {} as Record<number, number>
          ),
        }
      : undefined;

    return { value: retriedActions.length, count: retriedActions.length, metadata };
  }

  /**
   * Aggregate conflict resolution metrics
   */
  private async aggregateConflictResolutions(
    windowStart: Date,
    windowEnd: Date,
    includeMetadata: boolean
  ): Promise<{ value: number; count: number; metadata?: Record<string, unknown> }> {
    // Count actions with conflict-related error codes
    const conflictActions = await this.prisma.actionLedger.findMany({
      where: {
        errorCode: { contains: "CONCURRENT" },
        createdAt: { gte: windowStart, lte: windowEnd },
      },
    });

    return { value: conflictActions.length, count: conflictActions.length };
  }

  /**
   * Apply privacy redaction to data
   *
   * @param data Data to redact
   * @returns Redacted data
   */
  applyPrivacyRedaction(data: Record<string, unknown>): Record<string, unknown> {
    const redacted = { ...data };

    for (const rule of PRIVACY_RULES) {
      if (rule.field in redacted) {
        if (rule.action === "redact") {
          delete redacted[rule.field];
        } else if (rule.action === "hash") {
          const value = redacted[rule.field];
          if (typeof value === "string") {
            redacted[rule.field] = this.hashString(value);
          }
        }
      }
    }

    return redacted;
  }

  /**
   * Simple hash function for privacy
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }
}
