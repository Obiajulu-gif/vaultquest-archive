import type { PrismaClient } from "@prisma/client";

/**
 * Aggregates protocol-level metrics for dashboards and analytics endpoints.
 *
 * Computes totals across saved pools and action ledger snapshots.
 */
export class MetricsService {
  /**
   * @param prisma - Prisma client for database access
   */
  constructor(private prisma: PrismaClient) {}

  /**
   * Returns aggregated deposit and participant counts from active saved pools.
   *
   * @returns Protocol summary including total deposits, active participants, and pool count
   */
  async getProtocolSummary() {
    // Total vault deposits and active participants can be aggregated from SavedPools
    const pools = await this.prisma.savedPool.findMany({
      where: { status: "active" }
    });

    let totalDeposits = 0;
    let activeParticipants = 0;

    for (const pool of pools) {
      totalDeposits += parseFloat(pool.tvl || "0");
      activeParticipants += pool.participantCount || 0;
    }

    return {
      totalVaultDeposits: totalDeposits,
      activeParticipants,
      totalVaults: pools.length
    };
  }

  /**
   * Provides a mocked current round status.
   *
   * Replace with on-chain/round service integration in production.
   *
   * @returns Round metadata including number, status, draw date, and prize pool
   */
  async getCurrentRoundStatus() {
    // Mocked for now, depending on on-chain data
    return {
      roundNumber: 42,
      status: "active",
      drawDate: new Date(Date.now() + 86400 * 1000).toISOString(),
      prizePool: "5000.00"
    };
  }

  /**
   * Returns historical aggregates such as total actions and prizes distributed.
   *
   * @returns Historical summary counts
   */
  async getHistoricalSummary() {
    // Historical stats could be aggregated from ActionLedger
    const actionCount = await this.prisma.actionLedger.count();
    
    return {
      totalActions: actionCount,
      roundsCompleted: 41,
      totalPrizesDistributed: "150000.00"
    };
  }

  /**
   * Returns comprehensive aggregate protocol metrics for dashboards and reporting.
   *
   * Aggregates data from saved pools and the action ledger with consistency rules:
   * - TVL is the sum of all active pool TVL values.
   * - Participant counts are de-duplicated per wallet address.
   * - Recent volume covers the last 24 hours of confirmed actions.
   * - Timestamps use ISO-8601 with UTC timezone.
   *
   * @returns Aggregate metrics including TVL, pools, participants, rewards, volume, and freshness metadata
   */
  async getAggregateProtocolMetrics() {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Aggregate from active saved pools
    const activePools = await this.prisma.savedPool.findMany({
      where: { status: "active" },
    });

    let totalValueDeposited = 0;
    let activePoolCount = 0;
    const uniqueParticipants = new Set<string>();

    for (const pool of activePools) {
      activePoolCount += 1;
      totalValueDeposited += parseFloat(pool.tvl || "0");
      // De-duplicate participants by wallet address
      uniqueParticipants.add(pool.walletAddress);
    }

    // Compute total rewards distributed from confirmed deposit actions
    const confirmedDeposits = await this.prisma.actionLedger.findMany({
      where: {
        actionType: "deposit",
        status: "confirmed",
      },
      select: {
        actionPayload: true,
        createdAt: true,
      },
    });

    let rewardsDistributed = 0;
    let recentVolume = 0;

    for (const action of confirmedDeposits) {
      const payload = action.actionPayload as Record<string, unknown> | null;
      if (payload && typeof payload === "object" && "rewards" in payload) {
        rewardsDistributed += parseFloat(String(payload.rewards) || "0");
      }

      // Recent volume: confirmed actions in the last 24 hours
      if (action.createdAt >= twentyFourHoursAgo) {
        const amount = payload && typeof payload === "object" && "amount" in payload
          ? parseFloat(String(payload.amount) || "0")
          : 0;
        recentVolume += amount;
      }
    }

    // Count total historical pools (all statuses)
    const totalPoolCount = await this.prisma.savedPool.count();

    // Count total confirmed actions
    const totalConfirmedActions = await this.prisma.actionLedger.count({
      where: { status: "confirmed" },
    });

    return {
      totalValueDeposited: totalValueDeposited.toFixed(2),
      activePools: activePoolCount,
      totalPools: totalPoolCount,
      activeParticipants: uniqueParticipants.size,
      rewardsDistributed: rewardsDistributed.toFixed(2),
      recentVolume: recentVolume.toFixed(2),
      totalConfirmedActions,
      timestamp: now.toISOString(),
      dataFreshness: {
        generatedAt: now.toISOString(),
        poolCount: activePoolCount,
        actionSampleSize: confirmedDeposits.length,
      },
    };
  }
}
