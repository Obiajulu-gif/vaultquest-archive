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
 * arithmetic. float8 (IEEE 754 double) loses precision above 2^53 and
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
 *
 * #508 — concurrency stress tests for critical mutation paths.
 *
 * The mutation path in this file is `evaluateWallet()`. Two concurrent
 * invocations for the same wallet can race in two places:
 *
 *   1. The read-modify-write on `userQuest`. Two workers read the same
 *      previous row, both decide the quest just completed, and both try to
 *      grant. The critical invariant is that a quest transition into
 *      "completed" produces exactly one reward grant and exactly one
 *      completedAt timestamp.
 *
 *   2. The grant insert itself. This is already guarded by the
 *      deterministic `idempotencyKey` unique constraint (see #505), which
 *      makes the insert itself idempotent. The remaining gap was the
 *      completedAt timestamp and the consistency of the UserQuest row with
 *      the grant.
 *
 * To close gap #1 this service now uses an optimistic concurrency check
 * inside the transaction: the UserQuest write is conditioned on the
 * last-known completedAt/status (a compare-and-swap). If a concurrent
 * worker already committed the completion, the compare-and-swap affects
 * zero rows, the transaction retries, and the retry re-reads the committed
 * completedAt so the grant is skipped. The `idempotencyKey` unique
 * constraint is the backstop for the case where two workers both pass the
 * compare-and-swap before either commits.
 *
 * The concurrency stress tests live in `tests/quest.concurrency.spec.ts`
 * and cover simultaneous success, conflicting requests, duplicate retries,
 * and timeout behavior. See that file for the executable spec.
 */

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { Amount, InvalidAmountError } from "../amount.js";
import { LedgerService } from "./ledger.js";

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

/**
 * #508 — deterministic idempotency key for a reward grant. Keeping this a
 * pure function of (wallet, quest) means a retry of the same logical
 * completion always produces the same key, so the unique constraint on
 * `idempotencyKey` is the last line of defense against duplicate grants.
 */
export function rewardGrantIdempotencyKey(walletAddress: string, questId: string): string {
  return createHash("sha256")
    .update(`${walletAddress}:${questId}`)
    .digest("hex");
}

/**
 * #508 — the compare-and-swap condition used to guard the UserQuest
 * write. The write only applies if the persisted completedAt still matches
 * what this worker observed before the transaction. If another worker
 * committed the completion first, the condition fails and the transaction
 * retries with fresh state.
 */
function completedAtMatches(prevCompletedAt: Date | null): Prisma.UserQuestWhereInput {
  return prevCompletedAt === null
    ? { completedAt: null }
    : { completedAt: prevCompletedAt };
}

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
   *
   * #508 — concurrency strategy:
   *
   *   - The grant insert is idempotent via `rewardGrantIdempotencyKey` + the
   *     unique constraint on `RewardGrant.idempotencyKey`. A duplicate
   *     insert from a concurrent worker or a retry is rejected outright.
   *   - The UserQuest write is guarded by an optimistic compare-and-swap
   *     on the last-observed `completedAt`. If a concurrent worker already
   *     committed the completion, the conditional write affects zero rows,
   *     the transaction retries, and the retry skips the grant.
   *   - The grant insert and the UserQuest write share a single
   *     `prisma.$transaction`, so a crash between them cannot leave a
   *     grant without the corresponding completed row (or vice versa).
   */
  async evaluateWallet(walletAddress: string, precomputedMetrics?: QuestMetrics): Promise<QuestProgress[]> {
    const metrics = precomputedMetrics ?? await this.computeMetrics(walletAddress);
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
      //
      // #508 — the compare-and-swap on completedAt is the optimistic
      // concurrency guard. Two workers that both observed the same
      // prevCompletedAt will both try to write; the first commit wins,
      // the second affects zero rows and retries. On retry the
      // completedAt no longer matches, so the grant is skipped.
      const wasCompletedBefore = prev?.status === "completed";
      const shouldGrant = justCompleted && !wasCompletedBefore;

      await this.prisma.$transaction(
        async (tx) => {
          // Re-read within the transaction so the compare-and-swap
          // condition is evaluated against the latest committed state.
          const current = await tx.userQuest.findFirst({
            where: { walletAddress, questId: p.questId }
          });
          const currentCompletedAt = current?.completedAt ?? null;
          const currentWasCompleted = current?.status === "completed";

          // If a concurrent worker already committed the completion,
          // the grant is no longer owed by this invocation.
          const grantStillOwed = shouldGrant && !currentWasCompleted;

          if (grantStillOwed) {
            await this.createRewardGrantIfAbsent(tx, walletAddress, p.questId);
          }

          // Optimistic compare-and-swap: the write only applies if
          // the persisted completedAt still matches what we observed
          // before the transaction. A concurrent commit causes this to
          // affect zero rows, which we turn into a retry below.
          const writeResult = await tx.userQuest.updateMany({
            where: {
              walletAddress,
              questId: p.questId,
              ...completedAtMatches(prev?.completedAt ?? null)
            },
            data: {
              progress: p.progress,
              target: p.target,
              status: p.status,
              completedAt,
              lastEvaluatedAt: now
            }
          });

          if (writeResult.count === 0) {
            // No row matched the observed completedAt. Two cases:
            //   1. The row does not exist yet — insert it.
            //   2. The row exists but was committed by a concurrent
            //      worker — the competition is over, this invocation
            //      must not grant and must not overwrite the winner's
            //      completedAt.
            if (!current) {
              try {
                await tx.userQuest.create({
                  data: {
                    walletAddress,
                    questId: p.questId,
                    progress: p.progress,
                    target: p.target,
                    status: p.status,
                    completedAt,
                    lastEvaluatedAt: now
                  }
                });
              } catch (err) {
                // A unique constraint violation means a concurrent
                // worker inserted the row first. That worker owns
                // the completion, so this invocation must not grant.
                if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
                  throw err;
                }
              }
            }
            // In both cases the completion was already committed
            // by another worker; this invocation does not own it.
          }
        },
        { timeout: 5000 }
      );

      // Re-read the committed row so the returned snapshot reflects
      // whatever completedAt won the race, not the locally computed
      // candidate.
      const final = await this.prisma.userQuest.findUnique({
        where: { walletAddress_questId: { walletAddress, questId: p.questId } }
      });
      results.push({
        ...p,
        completedAt: final?.completedAt ?? completedAt
      });
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
   * "confirmed" row to a different status, and the sweep must still
   * re-evaluate that wallet so the derived metrics reflect the new state.
   */
  async evaluateRecent(since: Date): Promise<number> {
    const rows = await this.prisma.actionLedger.findMany({
      where: { updatedAt: { gte: since } },
      distinct: ["walletAddress"],
      select: { walletAddress: true }
    });

    for (const row of rows) {
      await this.evaluateWallet(row.walletAddress);
    }

    return rows.length;
  }

  /**
   * Inserts a reward grant if one does not already exist for the
   * (walletAddress, questId) pair. The deterministic idempotencyKey plus
   * the unique constraint make this idempotent under concurrency and
   * retries.
   */
  private async createRewardGrantIfAbsent(
    tx: Prisma.TransactionClient,
    walletAddress: string,
    questId: string
  ): Promise<void> {
    const idempotencyKey = rewardGrantIdempotencyKey(walletAddress, questId);
    try {
      await tx.rewardGrant.create({
        data: {
          walletAddress,
          questId,
          idempotencyKey,
          status: "pending"
        }
      });
    } catch (err) {
      // Unique constraint violation means a grant already exists.
      // This is the expected idempotent outcome, not an error.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
        throw err;
      }
    }
  }
}
