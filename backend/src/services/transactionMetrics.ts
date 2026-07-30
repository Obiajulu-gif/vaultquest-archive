import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";

export type ActionType =
  | "deposit"
  | "claim"
  | "withdrawal"
  | "pool_creation"
  | "admin_action";

export interface TransactionTimestamp {
  actionId: string;
  actionType: ActionType;
  network: string;
  walletAddress: string;
  submittedAt: Date;
  confirmedAt: Date | null;
  indexedAt: Date | null;
}

export interface ConfirmationMetrics {
  actionType: ActionType;
  network: string;
  count: number;
  p50: number;
  p95: number;
  p99: number;
  avgSubmissionToConfirmation: number;
  avgConfirmationToIndexing: number;
  avgTotal: number;
}

export class TransactionMetricsService {
  constructor(
    private prisma: PrismaClient,
    private logger?: Logger,
  ) {}

  async recordTimestamp(data: TransactionTimestamp): Promise<void> {
    try {
      await this.prisma.transactionMetric.create({
        data: {
          actionId: data.actionId,
          actionType: data.actionType,
          network: data.network,
          walletAddress: data.walletAddress,
          submittedAt: data.submittedAt,
          confirmedAt: data.confirmedAt,
          indexedAt: data.indexedAt,
        },
      });

      this.logger?.info(
        { actionId: data.actionId, actionType: data.actionType },
        "Transaction timestamp recorded",
      );
    } catch (err) {
      this.logger?.error(
        { err, actionId: data.actionId },
        "Failed to record transaction timestamp",
      );
      throw err;
    }
  }

  async getMetricsByActionType(
    actionType: ActionType,
    network?: string,
    since?: Date,
  ): Promise<ConfirmationMetrics | null> {
    try {
      const where: any = {
        actionType,
        confirmedAt: { not: null },
        indexedAt: { not: null },
      };

      if (network) where.network = network;
      if (since) where.submittedAt = { gte: since };

      const records = await this.prisma.transactionMetric.findMany({
        where,
        select: {
          submittedAt: true,
          confirmedAt: true,
          indexedAt: true,
        },
      });

      if (records.length === 0) return null;

      const durations = records.map((r) => {
        const submissionToConfirmation = r.confirmedAt
          ? r.confirmedAt.getTime() - r.submittedAt.getTime()
          : 0;
        const confirmationToIndexing =
          r.indexedAt && r.confirmedAt
            ? r.indexedAt.getTime() - r.confirmedAt.getTime()
            : 0;
        const total = r.indexedAt
          ? r.indexedAt.getTime() - r.submittedAt.getTime()
          : 0;

        return {
          submissionToConfirmation,
          confirmationToIndexing,
          total,
        };
      });

      const sorted = [...durations].map((d) => d.total).sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
      const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
      const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;

      const avgSubmissionToConfirmation =
        durations.reduce((sum, d) => sum + d.submissionToConfirmation, 0) /
        durations.length;
      const avgConfirmationToIndexing =
        durations.reduce((sum, d) => sum + d.confirmationToIndexing, 0) /
        durations.length;
      const avgTotal =
        durations.reduce((sum, d) => sum + d.total, 0) / durations.length;

      return {
        actionType,
        network: network || "all",
        count: records.length,
        p50,
        p95,
        p99,
        avgSubmissionToConfirmation,
        avgConfirmationToIndexing,
        avgTotal,
      };
    } catch (err) {
      this.logger?.error({ err, actionType }, "Failed to calculate metrics");
      throw err;
    }
  }

  async getAllMetrics(since?: Date): Promise<ConfirmationMetrics[]> {
    const actionTypes: ActionType[] = [
      "deposit",
      "claim",
      "withdrawal",
      "pool_creation",
      "admin_action",
    ];
    const results: ConfirmationMetrics[] = [];

    for (const actionType of actionTypes) {
      const metrics = await this.getMetricsByActionType(
        actionType,
        undefined,
        since,
      );
      if (metrics) results.push(metrics);
    }

    return results;
  }
}
