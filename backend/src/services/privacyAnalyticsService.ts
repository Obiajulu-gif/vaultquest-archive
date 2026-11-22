import { Prisma, type PrismaClient } from "@prisma/client";

type ActionBucket = { action_type: string; status: string; count: number };
type StatusBucket = { status: string; count: number };

/** On-demand aggregate analytics; no raw identifiers or payloads are selected or stored. */
export class PrivacyAnalyticsService {
  constructor(private readonly prisma: PrismaClient) {}

  async summarize(days = 30) {
    const lookbackDays = Number.isInteger(days) ? Math.max(1, Math.min(days, 90)) : 30;
    const generatedAt = new Date();
    const from = new Date(generatedAt.getTime() - lookbackDays * 86_400_000);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const [actions, settlements, rewards, jobs, participants] = await Promise.all([
        tx.$queryRaw<ActionBucket[]>(Prisma.sql`
          SELECT action_type::text AS action_type, status::text AS status, COUNT(*)::int AS count
          FROM action_ledger WHERE created_at >= ${from}
          GROUP BY action_type, status ORDER BY action_type, status
        `),
        tx.$queryRaw<StatusBucket[]>(Prisma.sql`
          SELECT state AS status, COUNT(*)::int AS count FROM vault_settlements
          WHERE created_at >= ${from} GROUP BY state ORDER BY state
        `),
        tx.$queryRaw<StatusBucket[]>(Prisma.sql`
          SELECT status, COUNT(*)::int AS count FROM reward_grants
          WHERE created_at >= ${from} GROUP BY status ORDER BY status
        `),
        tx.$queryRaw<StatusBucket[]>(Prisma.sql`
          SELECT status, COUNT(*)::int AS count FROM background_jobs
          WHERE created_at >= ${from} GROUP BY status ORDER BY status
        `),
        tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
          SELECT COUNT(DISTINCT wallet_address)::int AS count FROM action_ledger
          WHERE created_at >= ${from}
        `),
      ]);
      const distinctWallets = Number(participants[0]?.count ?? 0);
      return {
        generatedAt: generatedAt.toISOString(),
        window: { days: lookbackDays, from: from.toISOString(), to: generatedAt.toISOString() },
        privacy: {
          stored: false,
          rawIdentifiersIncluded: false,
          minimumCohortSize: 5,
          distinctWalletsSuppressed: distinctWallets < 5,
        },
        activity: {
          total: actions.reduce((sum, bucket) => sum + Number(bucket.count), 0),
          byActionAndStatus: actions.map((bucket) => ({
            actionType: bucket.action_type,
            status: bucket.status,
            count: Number(bucket.count),
          })),
        },
        settlements: settlements.map(({ status, count }) => ({ status, count: Number(count) })),
        rewards: rewards.map(({ status, count }) => ({ status, count: Number(count) })),
        backgroundJobs: jobs.map(({ status, count }) => ({ status, count: Number(count) })),
        participants: { distinctWallets: distinctWallets >= 5 ? distinctWallets : null },
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
