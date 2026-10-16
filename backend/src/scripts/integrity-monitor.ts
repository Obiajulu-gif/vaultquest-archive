import { PrismaClient } from "@prisma/client";

export type IntegrityIssue = {
  category: "orphaned" | "duplicate" | "stale" | "inconsistent";
  recordId: string;
  message: string;
  remediation: string;
};

export async function checkIntegrity(prisma: PrismaClient): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];
  const now = new Date();

  // 1. Orphaned records: Pending events that haven't been consumed in >1h
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const orphanedEvents = await prisma.pendingEvent.findMany({
    where: {
      consumedAt: null,
      receivedAt: { lt: oneHourAgo },
    },
    take: 100,
  });
  for (const event of orphanedEvents) {
    issues.push({
      category: "orphaned",
      recordId: event.txHash,
      message: `PendingEvent ${event.txHash} received at ${event.receivedAt.toISOString()} but never consumed.`,
      remediation: "Check StellarIndexer logs. You may need to manually invoke the reconciler to process this event.",
    });
  }

  // 2. Inconsistent records: Confirmed actions missing txHash
  const inconsistentActions = await prisma.actionLedger.findMany({
    where: {
      status: "confirmed",
      txHash: null,
    },
    take: 100,
  });
  for (const act of inconsistentActions) {
    issues.push({
      category: "inconsistent",
      recordId: act.id,
      message: `ActionLedger ${act.id} is confirmed but missing txHash.`,
      remediation: "Investigate how this action bypassed on-chain confirmation. Revert status to pending or attach missing txHash.",
    });
  }

  // 3. Stale records: Actions stuck in pending for >24h
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const staleActions = await prisma.actionLedger.findMany({
    where: {
      status: { in: ["pending", "submitted"] },
      createdAt: { lt: twentyFourHoursAgo },
    },
    take: 100,
  });
  for (const act of staleActions) {
    issues.push({
      category: "stale",
      recordId: act.id,
      message: `ActionLedger ${act.id} is stuck in ${act.status} since ${act.createdAt.toISOString()}.`,
      remediation: "Use the pending-recovery API to retry or fail this action.",
    });
  }

  // 4. Duplicate records: Multiple pending actions from the same wallet for the same action type within 1 minute
  // (Identifies possible client-side double-submission bugs escaping idempotency)
  const recentActions = await prisma.actionLedger.findMany({
    where: {
      createdAt: { gte: twentyFourHoursAgo },
    },
    orderBy: { createdAt: "desc" },
  });
  
  const seen = new Map<string, Date>();
  for (const act of recentActions) {
    const key = `${act.walletAddress}-${act.actionType}`;
    const lastSeen = seen.get(key);
    if (lastSeen && Math.abs(lastSeen.getTime() - act.createdAt.getTime()) < 60000) {
      issues.push({
        category: "duplicate",
        recordId: act.id,
        message: `ActionLedger ${act.id} is a potential duplicate of another ${act.actionType} action from ${act.walletAddress} within 1 minute.`,
        remediation: "Review the actions to ensure they are distinct intents. If duplicate, cancel the pending action.",
      });
    }
    seen.set(key, act.createdAt);
  }

  return issues;
}

export async function runMonitor() {
  const prisma = new PrismaClient();
  try {
    const issues = await checkIntegrity(prisma);
    if (issues.length === 0) {
      console.log("No integrity issues found.");
      return;
    }
    console.log(`Found ${issues.length} integrity issues:`);
    console.log(JSON.stringify(issues, null, 2));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMonitor();
}
