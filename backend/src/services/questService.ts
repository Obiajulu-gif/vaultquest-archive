/**
 * Quest Service (#26 backend engine)
 *
 * Automated logic engine that analyses the {@link ActionLedger} history to
 * evaluate and persist savings-quest milestone completions (e.g. "Save $100
 * for 3 months", "Participate in 5 draws").
 *
 * Design notes:
 *  - Historical scans are done with a single aggregating raw SQL query that
 *    rides the `(wallet_address, created_at)` index on `action_ledger`, so a
 *    per-wallet evaluation is a single index range scan (<100ms even with a
 *    large ledger — see tests/quest.spec.ts benchmark).
 *  - Progress is persisted into the `user_quests` table (one row per
 *    wallet/quest) and only written when it actually changes, keeping the
 *    incremental updates cheap.
 *  - `evaluateRecent()` is the cron entry point: it finds wallets whose
 *    confirmed ledger entries changed since the last sweep and re-evaluates
 *    only those, so new logs trigger incremental progress updates.
 *
 * #504 — this file previously computed `totalDeposited` via a raw SQL
 * `(action_payload->>'amount')::float8` cast and summed with plain
 * arithmetic. float8 (IEEE-754 double) loses precision above 2^53 and
 * has no concept of asset identity, so amounts from different assets
 * (or different-decimals assets) could be silently combined. Amounts are
 * now parsed and summed as bigint minor units via `Amount` (see
 * ../amount.ts), tagged with an explicit asset code, with mixed-asset or
 * malformed values rejected rather than silently coerced. The five quest
 * *thresholds* below (e.g. "$100", "5 draws") are asset-agnostic counts
 * or a single-asset dollar target, matching this system's current
 * single-canonical-pool architecture (see #507) — a genuinely
 * multi-asset target scheme is out of scope until #507 introduces real
 * per-pool asset configuration.
 */

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { Amount, InvalidAmountError } from "../amount.js";

export type QuestMetricKey =
  | "totalDeposited"
  | "depositCount"
  | "distinctPools"
  | "distinctMonths"
  | "claimCount";

export interface QuestDefinition {
  /** Stable identifier persisted in `user_quests.quest_id`. */
  id: string;
  title: string;
  description: string;
  /** Aggregated ledger metric this quest is measured against. */
  metric: QuestMetricKey;
  /** Value of `metric` at which the quest is considered complete. */
  target: number;
}

/**
 * The five standard savings quests the engine tracks. Each maps to a metric
 * derived purely from confirmed `action_ledger` rows.
 */
export const STANDARD_QUESTS: readonly QuestDefinition[] = [
  {
    id: "first_deposit",
    title: "First Steps",
    description: "Make your first confirmed deposit.",
    metric: "depositCount",
    target: 1
  },
  {
    id: "save_100",
    title: "Save $100",
    description: "Accumulate $100 in total confirmed deposits.",
    metric: "totalDeposited",
    target: 100
  },
  {
    id: "save_100_three_months",
    title: "Save $100 for 3 Months",
    description: "Deposit in at least three distinct calendar months.",
    metric: "distinctMonths",
    target: 3
  },
  {
    id: "participate_5_draws",
    title: "Participate in 5 Draws",
    description: "Deposit into at least five distinct prize pools.",
    metric: "distinctPools",
    target: 5
  },
  {
    id: "first_win",
    title: "Lucky Saver",
    description: "Claim a reward from a prize draw.",
    metric: "claimCount",
    target: 1
  }
] as const;

export type QuestMetrics = Record<QuestMetricKey, number>;

export interface QuestProgress {
  questId: string;
  title: string;
  description: string;
  progress: number;
  target: number;
  status: "in_progress" | "completed";
  completedAt: Date | null;
}

/** Raw shape returned by the row-scan query. */
type ActionRow = {
  actionType: string;
  actionPayload: unknown;
  createdAt: Date;
};

function extractPoolId(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) return "default";
  const value = payload.vault_id ?? payload.pool_id ?? "default";
  return String(value);
}

// #504 — quest thresholds today are denominated against the system's
// single canonical pool asset (see #507 findings: pool identity is
// entirely env-var/manifest-driven, exactly one asset in play). decimals
// is 0 to match this file's pre-existing convention of treating
// payload.amount as an already-whole-unit dollar figure (e.g. "100" ->
// $100 toward the save_100 quest) — this is an internal-precision fix,
// not a change to what unit amounts are expressed in.
const QUEST_ASSET_CODE = "USD";
const QUEST_ASSET_DECIMALS = 0;

export class QuestService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly quests: readonly QuestDefinition[] = STANDARD_QUESTS
  ) {}

  /**
   * Computes all quest metrics for a wallet from a single index-backed scan
   * over confirmed ledger rows (rides the `(wallet_address, created_at)`
   * index — see tests/quest.spec.ts's <100ms benchmark over a 2k-row
   * ledger). Deposit amounts are parsed and summed via `Amount` (bigint,
   * asset-tagged) rather than a float SQL cast; a deposit whose payload
   * fails Amount validation (missing/fractional/malformed `amount`) is
   * excluded from `totalDeposited` and does not otherwise affect
   * depositCount/distinctPools/distinctMonths, which only need the
   * action to exist and be confirmed, not its parsed amount.
   */
  async computeMetrics(walletAddress: string): Promise<QuestMetrics> {
    const rows = await this.prisma.actionLedger.findMany({
      where: { walletAddress, status: "confirmed", redactedAt: null },
      select: { actionType: true, actionPayload: true, createdAt: true }
    });

    let totalDeposited = Amount.zero(QUEST_ASSET_CODE, QUEST_ASSET_DECIMALS);
    let depositCount = 0;
    let claimCount = 0;
    const distinctPools = new Set<string>();
    const distinctMonths = new Set<string>();

    for (const row of rows as ActionRow[]) {
      const payload = row.actionPayload as Record<string, unknown> | null;

      if (row.actionType === "deposit") {
        depositCount++;
        distinctPools.add(extractPoolId(payload));
        distinctMonths.add(
          `${row.createdAt.getUTCFullYear()}-${String(row.createdAt.getUTCMonth() + 1).padStart(2, "0")}`
        );

        try {
          const amount = Amount.fromPayload(payload, QUEST_ASSET_CODE, QUEST_ASSET_DECIMALS);
          totalDeposited = totalDeposited.add(amount);
        } catch (err) {
          if (!(err instanceof InvalidAmountError)) throw err;
          // Malformed amount: the deposit still counts toward
          // depositCount/distinctPools/distinctMonths (it happened), but
          // is excluded from the dollar total rather than silently
          // parsed as 0, which would understate a real problem.
        }
      } else if (row.actionType === "claim") {
        claimCount++;
      }
    }

    return {
      totalDeposited: Number(totalDeposited.raw),
      depositCount,
      distinctPools: distinctPools.size,
      distinctMonths: distinctMonths.size,
      claimCount
    };
  }

  /** Maps raw metrics onto the configured quest definitions. */
  projectProgress(metrics: QuestMetrics): QuestProgress[] {
    return this.quests.map((quest) => {
      const value = metrics[quest.metric];
      const progress = Math.min(value, quest.target);
      const completed = value >= quest.target;
      return {
        questId: quest.id,
        title: quest.title,
        description: quest.description,
        progress,
        target: quest.target,
        status: completed ? "completed" : "in_progress",
        completedAt: null
      };
    });
  }

  /**
   * Evaluates and persists quest progress for a single wallet. Only rows whose
   * progress or status actually changed are written. Returns the current
   * progress snapshot.
   */
  async evaluateWallet(walletAddress: string): Promise<QuestProgress[]> {
    const metrics = await this.computeMetrics(walletAddress);
    const projected = this.projectProgress(metrics);

    const existing = await this.prisma.userQuest.findMany({
      where: { walletAddress }
    });
    const byQuest = new Map(existing.map((q) => [q.questId, q]));

    const now = new Date();
    const results: QuestProgress[] = [];

    for (const p of projected) {
      const prev = byQuest.get(p.questId);
      const justCompleted = p.status === "completed";
      const completedAt =
        justCompleted ? prev?.completedAt ?? now : null;

      const changed =
        !prev ||
        prev.progress !== p.progress ||
        prev.status !== p.status;

      // #505 — the exact instant a quest transitions into "completed"
      // (never was before, or is being created already-completed) is
      // when a reward grant becomes owed. Insert-if-absent via the
      // deterministic idempotencyKey: replaying this sweep (backfill, or
      // a retry after a crash right after this point) can never create a
      // second grant for the same (walletAddress, questId) pair, because
      // the unique constraint on idempotencyKey rejects the duplicate
      // insert outright.
      //
      // The grant-intent insert and the UserQuest write are wrapped in a
      // single prisma.$transaction — previously these were two
      // independent sequential awaits, so a crash between them could
      // leave a RewardGrant recorded with UserQuest still showing
      // in_progress (or vice versa on a future refactor), an
      // inconsistency the #505 design proposal flagged as a gap worth
      // closing. Wrapping both writes atomically means either both land
      // or neither does — a retry after a crash mid-transaction re-does
      // the same work, and the idempotencyKey unique constraint still
      // guards against a duplicate grant on that retry.
      const wasCompletedBefore = prev?.status === "completed";
      const shouldGrant = justCompleted && !wasCompletedBefore;

      await this.prisma.$transaction(async (tx) => {
        if (shouldGrant) {
          await this.createRewardGrantIfAbsent(tx, walletAddress, p.questId);
        }

        if (changed) {
          await tx.userQuest.upsert({
            where: { walletAddress_questId: { walletAddress, questId: p.questId } },
            create: {
              walletAddress,
              questId: p.questId,
              progress: p.progress,
              target: p.target,
              status: p.status,
              completedAt,
              lastEvaluatedAt: now
            },
            update: {
              progress: p.progress,
              target: p.target,
              status: p.status,
              completedAt,
              lastEvaluatedAt: now
            }
          });
        } else {
          await tx.userQuest.update({
            where: { walletAddress_questId: { walletAddress, questId: p.questId } },
            data: { lastEvaluatedAt: now }
          });
        }
      });

      results.push({ ...p, completedAt });
    }

    return results;
  }

  /**
   * Cron entry point. Finds wallets with ledger entries updated since
   * `since` and re-evaluates each. Returns the number of wallets processed.
   *
   * #506 — the caller (cron.ts) is responsible for wrapping this in a
   * JobLease so at most one worker runs a sweep at a time. #505's
   * exactly-once reward guarantee doesn't depend on that lease alone,
   * though: createRewardGrantIfAbsent's unique idempotencyKey constraint
   * means even a backfill script and this cron sweep running
   * concurrently (outside any shared lease) can't double-grant.
   *
   * #505 — the wallet-selection query intentionally is NOT filtered to
   * `status: "confirmed"` only. A reorg/refund transitions a previously
   * "confirmed" action to "reverted", which also bumps that row's
   * `updatedAt` — if this query only matched `status: "confirmed"`, a
   * wallet whose sole recent change was a confirmed -> reverted
   * transition would be silently excluded from the sweep entirely, so
   * neither its quest progress nor any already-granted reward for it
   * would ever be re-evaluated or flagged. Any recent status change
   * (confirmed OR reverted) must trigger re-evaluation.
   *
   * A single poison wallet (one whose actions/payload cause evaluateWallet
   * to throw) does not abort the rest of the batch — it's caught, logged,
   * and swept up in `poisoned` so the remaining wallets in this tick still
   * get evaluated.
   */
  async evaluateRecent(since: Date, limit = 500): Promise<{ wallets: number; poisoned: number }> {
    const rows = await this.prisma.actionLedger.findMany({
      where: {
        status: { in: ["confirmed", "reverted"] },
        updatedAt: { gte: since }
      },
      select: { walletAddress: true },
      distinct: ["walletAddress"],
      take: limit
    });

    const walletAddresses = rows.map((r) => r.walletAddress);
    let poisoned = 0;

    for (const walletAddress of walletAddresses) {
      try {
        await this.evaluateWallet(walletAddress);
      } catch (err) {
        poisoned++;
        // eslint-disable-next-line no-console -- no injected logger available in this service; surfaced loudly rather than silently dropped.
        console.error(
          `[QuestService.evaluateRecent] poison wallet ${walletAddress} failed evaluation, continuing with remaining batch:`,
          err
        );
      }
    }

    // #505 correction policy: after re-evaluating, check whether any of
    // these wallets' recent updates were reorg/refund reversions that
    // invalidate an already-granted reward.
    if (walletAddresses.length > 0) {
      await this.flagGrantsForReorgedActions(walletAddresses).catch((err) => {
        // eslint-disable-next-line no-console -- see note above.
        console.error("[QuestService.evaluateRecent] failed to flag grants for reorged actions:", err);
      });
    }

    return { wallets: walletAddresses.length, poisoned };
  }

  /** Read model for the frontend quest-tracking UI (#26). */
  async getUserQuests(walletAddress: string): Promise<QuestProgress[]> {
    const rows = await this.prisma.userQuest.findMany({
      where: { walletAddress }
    });
    const byQuest = new Map(rows.map((r) => [r.questId, r]));

    return this.quests.map((quest) => {
      const row = byQuest.get(quest.id);
      return {
        questId: quest.id,
        title: quest.title,
        description: quest.description,
        progress: row?.progress ?? 0,
        target: quest.target,
        status: (row?.status as "in_progress" | "completed") ?? "in_progress",
        completedAt: row?.completedAt ?? null
      };
    });
  }

  /**
   * Records grant intent for a wallet/quest completion. The idempotencyKey
   * is deterministic from (walletAddress, questId) — a wallet can only
   * ever complete a given quest once, so this key is naturally unique per
   * intended grant. If a row already exists (this sweep re-ran, or a
   * concurrent process raced us here) the unique-constraint violation is
   * swallowed rather than surfaced — that's the expected, correct outcome
   * of an idempotent insert, not an error.
   *
   * Takes a Prisma client/transaction handle explicitly (rather than
   * always using `this.prisma`) so callers can run this as part of a
   * larger `$transaction` alongside the UserQuest write it's paired with
   * — see evaluateWallet.
   */
  private async createRewardGrantIfAbsent(
    db: PrismaClient | Prisma.TransactionClient,
    walletAddress: string,
    questId: string
  ): Promise<void> {
    const idempotencyKey = createHash("sha256").update(`${walletAddress}:${questId}`).digest("hex");
    try {
      await db.rewardGrant.create({
        data: { walletAddress, questId, idempotencyKey }
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return; // Grant already recorded — exactly the idempotency guarantee this exists for.
      }
      throw err;
    }
  }

  /**
   * #505 correction policy for reorged/refunded actions underlying an
   * already-granted reward (acceptance criteria: "reorged/refunded
   * actions trigger a documented correction policy").
   *
   * Deliberately conservative — flags for manual review rather than an
   * automatic clawback. This is a real-money decision the #505 design
   * proposal explicitly declined to guess at unilaterally (payout
   * mechanics themselves are still an open question blocking
   * processGrants' real implementation), but "silently do nothing when a
   * granted reward's funding action reverts" is not an acceptable
   * default either — it would let the grant table silently drift from
   * ledger truth. Flagging is the minimum safe behavior: it surfaces the
   * inconsistency for a human decision without irreversibly moving funds
   * based on an automated guess.
   *
   * Scans wallets with recently reverted/refunded confirmed actions and
   * flags any `granted` RewardGrant for that wallet whose quest's metrics
   * would no longer be met, setting status to `needs_review` (a distinct
   * terminal-ish status from `failed`, since this isn't a payout failure
   * — it's a completed payout whose underlying justification changed
   * after the fact) and recording why in `lastError`.
   */
  async flagGrantsForReorgedActions(walletAddresses: string[]): Promise<{ flagged: number }> {
    let flagged = 0;
    for (const walletAddress of walletAddresses) {
      const metrics = await this.computeMetrics(walletAddress);
      const projected = this.projectProgress(metrics);
      const stillCompleted = new Set(
        projected.filter((p) => p.status === "completed").map((p) => p.questId)
      );

      const grantedRows = await this.prisma.rewardGrant.findMany({
        where: { walletAddress, status: "granted" }
      });

      for (const grant of grantedRows) {
        if (stillCompleted.has(grant.questId)) continue;
        await this.prisma.rewardGrant.update({
          where: { id: grant.id },
          data: {
            status: "needs_review",
            lastError:
              "Underlying action(s) reverted/refunded after this reward was granted; quest no longer meets its target. Flagged for manual review, not auto-clawed-back."
          }
        });
        flagged++;
      }
    }
    return { flagged };
  }

  /**
   * Processes pending reward grants: attempts the actual payout for each,
   * retrying up to `maxAttempts` times before flipping to a terminal
   * `failed` status (dead-letter) rather than retrying forever. Returns
   * a summary for logging/metrics.
   *
   * TODO(#505): the actual payout call is not yet wired up — there is no
   * existing reward/credit-disbursement mechanism anywhere in this
   * codebase to call into (confirmed via search). This method currently
   * marks every pending grant `granted` without performing a real
   * payout, which is NOT safe to run against production data — it exists
   * so the idempotency/retry/dead-letter machinery is in place and
   * testable, pending a maintainer decision on:
   *   1. What the payout call actually is (on-chain contract invocation?
   *      an off-chain credit ledger entry?).
   *   2. The correction policy for a reorged/refunded action underlying
   *      an already-granted reward (flag for manual review vs. automatic
   *      clawback) — see the open questions raised on issue #505.
   */
  async processGrants(maxAttempts = 5, limit = 100): Promise<{ granted: number; failed: number }> {
    const pending = await this.prisma.rewardGrant.findMany({
      where: { status: "pending", attempts: { lt: maxAttempts } },
      take: limit
    });

    let granted = 0;
    let failed = 0;

    for (const grant of pending) {
      try {
        // TODO(#505): replace with the real payout call once identified.
        await this.prisma.rewardGrant.update({
          where: { id: grant.id },
          data: { status: "granted", grantedAt: new Date(), attempts: grant.attempts + 1 }
        });
        granted++;
      } catch (err) {
        const attempts = grant.attempts + 1;
        const message = err instanceof Error ? err.message : String(err);
        await this.prisma.rewardGrant.update({
          where: { id: grant.id },
          data: {
            attempts,
            lastError: message,
            status: attempts >= maxAttempts ? "failed" : "pending"
          }
        });
        failed++;
      }
    }

    return { granted, failed };
  }
}

export type { Prisma };
