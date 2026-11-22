import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { ERROR_CODES, FINALITY_POLICY, canTransition, type ActionStatus } from "../constants.js";
import { AppError } from "../errors.js";
import { withTelemetry } from "./telemetry.js";
import type { IntentInput, ActionRecord } from "../types.js";
import type { CacheService, IndexerCheckpoint } from "./cacheService.js";
import { Amount, InvalidAmountError } from "../amount.js";
import type { RawHorizonEvent } from "./stellarIndexer.js";
import { appendEventLog } from "./eventLogIntegrity.js";

// #504 — getPortfolioSummary previously read payload.token/asset with a
// hardcoded "USDC" fallback whenever it was missing. Today there is
// exactly one canonical, single-asset pool per deployment (see #507
// findings), so a single configured default is still correct — but it's
// now explicit and named, not an inline magic string repeated at each
// call site. Decimals is 0 (not 7) because every existing caller/test
// (tests/portfolio.spec.ts, tests/portfolio-unit.spec.ts) treats
// payload.amount as an already-whole-unit integer (e.g. "100" -> 100),
// matching this endpoint's existing external contract — this is purely
// an internal-precision fix (bigint accumulation instead of float), not
// a change to what unit amounts are expressed in.
const DEFAULT_POOL_ASSET_CODE = "USDC";
const DEFAULT_POOL_ASSET_DECIMALS = 0;

export type ListActionsParams = {
  walletAddress: string;
  status?: ActionStatus;
  type?: string;
  limit: number;
  cursor?: string | null;
};

export type ListActionsResult = {
  items: ActionRecord[];
  nextCursor: string | null;
};

/**
 * The ingestion point a read was served at (#731): `latestLedger` is the
 * Stellar ledger sequence the indexer had fully processed as of this read
 * (`IndexerCheckpoint.latestLedger`, already bumped once per completed
 * indexer batch — see `recordCheckpoint`). It's a genuinely monotonic
 * counter (Stellar ledger sequence numbers only ever increase), not a
 * wall-clock timestamp, so it's immune to clock skew and gives callers an
 * unambiguous way to tell whether two reads came from the same ingestion
 * generation or straddled a burst of new writes. See
 * `backend/docs/READ_CONSISTENCY.md`.
 */
export type IngestionWatermark = {
  latestLedger: number | null;
  asOf: Date | null;
};

export type DashboardSummary = {
  walletAddress: string;
  totalActions: number;
  byStatus: Record<ActionStatus, number>;
  pendingTxHashes: string[];
  isStale: boolean;
  latestActivityAt: Date | null;
  latestConfirmedAt: Date | null;
  watermark: IngestionWatermark;
};

export type LeaseInput = {
  actionId: string;
  workerId: string;
  ttlMs?: number;
};

export type RecoveryLeaseResult = {
  recovered: number;
  expired: number;
};

/**
 * #504-adjacent concurrency hardening: a bounded retry helper for
 * serialization/deadlock conflicts. Postgres `Serializable` transactions
 * (used by `getDashboardSummary` and the mutation paths below) can abort
 * with SQLSTATE 40001 (serialization_failure) or 40P01 (deadlock_detected)
 * when two transactions race. Prisma surfaces these as
 * `PrismaClientKnownRequestError` with code `P2034`. Retrying with jittered
 * backoff is the documented strategy for these — without it, concurrent
 * submissions would surface as spurious 500s instead of converging to the
 * correct domain invariant (one record, no duplicates).
 */
const RETRYABLE_PRISMA_CODES = new Set(["P2034"]);
const MAX_TX_RETRIES = 5;

function isRetryableTxError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return RETRYABLE_PRISMA_CODES.has(err.code);
  }
  return false;
}

function backoffMs(attempt: number): number {
  const base = Math.min(50 * 2 ** attempt, 500);
  return base + Math.floor(Math.random() * 25);
}

export interface ReconcileEventInput {
  txHash: string;
  sorobanEventId: string;
  eventPayload: unknown;
  statusHint: "confirmed" | "reverted";
  ledger?: number;
  /**
   * Close time of the emitting ledger (#751). Used as confirmedAt so replaying
   * the same event always yields the same row; the wall-clock fallback only
   * applies to legacy callers of POST /internal/reconcile that omit it.
   */
  ledgerClosedAt?: Date;
}

export interface ReconcileEventOutcome {
  txHash: string;
  matched: boolean;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") +
    "}"
  );
}

export type ActionConfirmedCallback = (actionId: string, actionType: string) => void;

/** Returns the value of the first key present in `obj` from `keys`, or undefined. */
function firstDefined(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k];
  }
  return undefined;
}

/**
 * Normalizes a value for equality comparison between actionPayload and a
 * decoded event payload: numbers/numeric-strings compare as strings (so
 * `100` and `"100"` agree, but `100` and `100.0` are treated as equal too via
 * a round-trip through Number), and everything else compares as a trimmed
 * string. This intentionally does not attempt currency/precision-aware
 * comparison — an amount that differs even in trailing zeros after
 * normalization is a genuine mismatch, not a false positive to suppress.
 */
function normalize(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) && value.trim() !== "" ? String(n) : value.trim().toLowerCase();
  }
  return JSON.stringify(value);
}

export class LedgerService {
  private onActionConfirmedCallback: ActionConfirmedCallback | null = null;
  private readonly defaultLeaseTtlMs = 5 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly cacheService?: CacheService
  ) {}

  onActionConfirmed(callback: ActionConfirmedCallback): void {
    this.onActionConfirmedCallback = callback;
  }

  async appendChainEvents(events: RawHorizonEvent[]): Promise<void> {
    await this.runSerializable((tx) => appendEventLog(tx, events));
  }

  async quarantineEvent(input: { sorobanEventId: string; ledger: number; contractId: string; txHash: string;
    rawEvent: Record<string, unknown>; reason: string }): Promise<void> {
    await this.prisma.poisonEvent.upsert({ where: { sorobanEventId: input.sorobanEventId },
      create: { ...input, rawEvent: input.rawEvent as Prisma.InputJsonValue }, update: {} });
  }

  async upsertPoolRegistryEntry(input: { salt: string; poolAddress: string; factoryAddress: string;
    admin: string; asset: string; wasmHash: string; deployedLedger: number }): Promise<void> {
    await this.prisma.poolRegistry.upsert({ where: { poolAddress: input.poolAddress }, create: input,
      update: { ...input } });
  }

  /**
   * Runs `fn` inside a `Serializable` transaction, retrying on
   * serialization failures/deadlocks. This is the single choke point every
   * mutation path below routes through, so the retry policy is uniform and
   * auditable. Callers must pass a *pure* function of the transaction client
   * (no external side effects outside `tx`) so a retry is safe.
   */
  private async runSerializable<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_TX_RETRIES; attempt++) {
      try {
        return await this.prisma.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable
        });
      } catch (err) {
        if (!isRetryableTxError(err) || attempt === MAX_TX_RETRIES - 1) {
          throw err;
        }
        lastErr = err;
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      }
    }
    throw lastErr;
  }

  createAction(input: IntentInput & { observedLedger?: number; confirmationDepth?: number }): Promise<ActionRecord> {
    return withTelemetry({ operation: "action.create", actorType: "user" }, () =>
      this.createActionImpl(input)
    );
  }

  private async createActionImpl(input: IntentInput & { observedLedger?: number; confirmationDepth?: number }): Promise<ActionRecord> {
    // Concurrency: the previous read-then-create was a TOCTOU race — two
    // concurrent submissions with the same idempotency key could both miss
    // the `findUnique` and both attempt `create`, with the loser surfacing a
    // raw P2002 unique-violation instead of the idempotent replay the API
    // contract promises. We now run the whole check-and-create inside one
    // Serializable transaction and, on P2002, re-read and return the winner
    // (or conflict if the payload differs). The DB unique constraint on
    // `idempotencyKey` is the source of truth; the transaction just makes
    // the happy path race-free and the loser path deterministic.
    return this.runSerializable(async (tx) => {
      const existing = await tx.actionLedger.findUnique({
        where: { idempotencyKey: input.idempotencyKey }
      });

      if (existing) {
        const samePayload =
          stableStringify(existing.actionPayload) === stableStringify(input.actionPayload) &&
          existing.walletAddress === input.walletAddress &&
          existing.actionType === input.actionType;
        if (!samePayload) {
          throw AppError.conflict(
            ERROR_CODES.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
            "idempotency key reused with a different payload"
          );
        }
        return existing as unknown as ActionRecord;
      }

      const confirmationDepth = input.confirmationDepth ?? FINALITY_POLICY.defaultConfirmationDepth;
      const observedLedger = input.observedLedger ?? 0;
      const finalizedLedger = observedLedger > 0 ? observedLedger + confirmationDepth : null;

      try {
        const created = await tx.actionLedger.create({
          data: {
            idempotencyKey: input.idempotencyKey,
            walletAddress: input.walletAddress,
            actionType: input.actionType,
            actionPayload: input.actionPayload as object,
            observedLedger,
            finalizedLedger,
            confirmationDepth,
            finalityStatus: observedLedger > 0 ? "provisional" : "finalized"
          }
        });
        return created as unknown as ActionRecord;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          // Lost the race: another transaction committed the same key.
          // Re-read and apply the same idempotency contract.
          const winner = await tx.actionLedger.findUnique({
            where: { idempotencyKey: input.idempotencyKey }
          });
          if (!winner) throw err;
          const samePayload =
            stableStringify(winner.actionPayload) === stableStringify(input.actionPayload) &&
            winner.walletAddress === input.walletAddress &&
            winner.actionType === input.actionType;
          if (!samePayload) {
            throw AppError.conflict(
              ERROR_CODES.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
              "idempotency key reused with a different payload"
            );
          }
          return winner as unknown as ActionRecord;
        }
        throw err;
      }
    });
  }

  async acquireLease({ actionId, workerId, ttlMs }: LeaseInput): Promise<boolean> {
    const expiresAt = new Date(Date.now() + (ttlMs ?? this.defaultLeaseTtlMs));
    try {
      await this.prisma.actionLease.create({
        data: { actionId, workerId, expiresAt }
      });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const owned = await this.prisma.actionLease.findUnique({ where: { actionId } });
        if (!owned || owned.expiresAt.getTime() <= Date.now()) {
          const replaced = await this.prisma.actionLease.updateMany({
            where: { actionId, expiresAt: { lte: new Date() } },
            data: { workerId, acquiredAt: new Date(), expiresAt }
          });
          return replaced.count > 0;
        }
        return owned.workerId === workerId;
      }
      throw err;
    }
  }

  async renewLease(actionId: string, workerId: string, ttlMs?: number): Promise<boolean> {
    const ttl = ttlMs ?? this.defaultLeaseTtlMs;
    const expiresAt = new Date(Date.now() + ttl);
    const result = await this.prisma.actionLease.updateMany({
      where: { actionId, workerId },
      data: { expiresAt, acquiredAt: new Date() }
    });
    return result.count > 0;
  }

  async releaseLease(actionId: string, workerId: string): Promise<void> {
    await this.prisma.actionLease.deleteMany({ where: { actionId, workerId } });
  }

  async releaseAllLeasesForWorker(workerId: string): Promise<number> {
    const result = await this.prisma.actionLease.deleteMany({ where: { workerId } });
    return result.count;
  }

  async getIndexerCheckpoint(): Promise<Partial<IndexerCheckpoint> | null> {
    if (this.cacheService) {
      return this.cacheService.getCheckpoint();
    }

    return this.prisma.indexerCheckpoint.findUnique({
      where: { id: "singleton" }
    });
  }

  /**
    * Attach a known transaction hash after wallet submission, requiring an active lease.
    * Reconcile any chain event that arrived before this hash was attached.
   */
  attachTxHash(
    actionId: string,
    txHash: string,
    lease: { workerId: string; ttlMs?: number }
  ): Promise<ActionRecord> {
    return withTelemetry({ operation: "action.attach_tx", actorType: "service" }, () =>
      this.attachTxHashImpl(actionId, txHash, lease)
    );
  }

  private async attachTxHashImpl(
    actionId: string,
    txHash: string,
    lease: { workerId: string; ttlMs?: number }
  ): Promise<ActionRecord> {
    let confirmedAction: { id: string; actionType: string } | null = null;
    try {
      const result = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const row = await tx.actionLedger.findUnique({ where: { id: actionId } });
        if (!row) throw AppError.notFound(`action ${actionId} not found`);

        if (row.txHash === txHash) {
          return row as unknown as ActionRecord;
        }

        const recoveryCheckpoint = row.recoveryCheckpoint as { stage?: string } | null;
        if (row.status === "pending" && recoveryCheckpoint?.stage === "recovery_required") {
          throw AppError.conflict(
            ERROR_CODES.ILLEGAL_TRANSITION,
            "action requires wallet verification before another submission"
          );
        }

        if (!canTransition(row.status, "submitted")) {
          throw AppError.conflict(ERROR_CODES.ILLEGAL_TRANSITION, `cannot attach tx_hash to action in status ${row.status}`);
        }

        // Do not steal an active lease from another worker.
        const now = new Date();
        const currentLease = await tx.actionLease.findUnique({ where: { actionId } });
        if (currentLease && currentLease.workerId !== lease.workerId && currentLease.expiresAt > now) {
          throw AppError.conflict(ERROR_CODES.ILLEGAL_TRANSITION, "action is leased by another worker");
        }
        const expiresAt = new Date(now.getTime() + (lease.ttlMs ?? this.defaultLeaseTtlMs));
        if (!currentLease) {
          await tx.actionLease.create({ data: { actionId, workerId: lease.workerId, expiresAt } });
        } else if (currentLease.workerId === lease.workerId) {
          await tx.actionLease.update({
            where: { actionId },
            data: { acquiredAt: now, expiresAt }
          });
        } else {
          const takeover = await tx.actionLease.updateMany({
            where: { actionId, workerId: currentLease.workerId, expiresAt: { lte: now } },
            data: { workerId: lease.workerId, acquiredAt: now, expiresAt }
          });
          if (takeover.count === 0) {
            throw AppError.conflict(ERROR_CODES.ILLEGAL_TRANSITION, "action lease changed concurrently");
          }
        }
        const pending = await tx.pendingEvent.findUnique({ where: { txHash } });
        const eventLedger = pending?.eventPayload && typeof pending.eventPayload === "object" && "ledger" in pending.eventPayload
          ? Number((pending.eventPayload as Record<string, unknown>).ledger)
          : null;
        const ledger = eventLedger && Number.isFinite(eventLedger) ? eventLedger : row.observedLedger;
        const confirmationDepth = row.confirmationDepth ?? FINALITY_POLICY.defaultConfirmationDepth;
        const finalizedLedger = ledger && ledger > 0 ? ledger + confirmationDepth : null;
        const finalityStatus = ledger && ledger > 0 ? "provisional" : "finalized";
        const submittedAt = new Date();

        const transition = await tx.actionLedger.updateMany({
          where: {
            id: actionId,
            status: "pending",
            NOT: { recoveryCheckpoint: { path: ["stage"], equals: "recovery_required" } }
          },
          data: {
            status: "submitted",
            recoveryCheckpoint: {
              stage: "transaction_submitted",
              checkpointed_at: submittedAt.toISOString()
            },
            txHash,
            submittedAt,
            observedLedger: ledger,
            finalizedLedger,
            finalityStatus
          }
        });
        if (transition.count === 0) {
          throw AppError.conflict(ERROR_CODES.ILLEGAL_TRANSITION, "action changed before transaction attachment");
        }
        let updated = await tx.actionLedger.findUnique({ where: { id: actionId } });
        if (!updated) throw AppError.notFound(`action ${actionId} not found`);

        if (pending) {
          const isReverted = pending.statusHint === "reverted";
          const checkpointedAt = (pending.ledgerClosedAt ?? submittedAt).toISOString();
          updated = await tx.actionLedger.update({
            where: { id: actionId },
            data: {
              status: isReverted ? "reverted" : "confirmed",
              recoveryCheckpoint: {
                stage: isReverted ? "reverted" : "confirmed",
                checkpointed_at: checkpointedAt
              },
              verifiedPayload: pending.eventPayload,
              sorobanEventId: pending.sorobanEventId,
              confirmedAt: pending.ledgerClosedAt ?? submittedAt,
              errorCode: isReverted ? ERROR_CODES.REVERTED_ON_CHAIN : null
            }
          });
          await tx.pendingEvent.update({
            where: { txHash },
            data: { consumedAt: submittedAt }
          });
          if (!isReverted && row.actionType === "select_winner") {
            confirmedAction = { id: actionId, actionType: row.actionType };
          }
        }

        return updated as unknown as ActionRecord;
      });
      if (confirmedAction) {
        try {
          this.onActionConfirmedCallback?.(confirmedAction.id, confirmedAction.actionType);
        } catch {
          // Callback errors must not undo a committed chain confirmation.
        }
      }
      return result;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const target = String(err.meta?.target ?? "");
        if (!target.includes("tx_hash")) {
          throw AppError.conflict(ERROR_CODES.ILLEGAL_TRANSITION, "action lease was acquired concurrently");
        }
        throw AppError.conflict(
          ERROR_CODES.TX_HASH_ALREADY_ATTACHED,
          "tx_hash already attached to another action"
        );
      }
      if ((err as any)?.code === ERROR_CODES.ILLEGAL_TRANSITION || (err as any)?.code === ERROR_CODES.TX_HASH_ALREADY_ATTACHED) {
        throw err;
      }
      throw err;
    }
  }

  cancelAction(id: string, errorCode: string, errorDetail?: string): Promise<ActionRecord> {
    return withTelemetry({ operation: "action.cancel", actorType: "user" }, () =>
      this.cancelActionImpl(id, errorCode, errorDetail)
    );
  }

  private async cancelActionImpl(id: string, errorCode: string, errorDetail?: string): Promise<ActionRecord> {
    const row = await this.prisma.actionLedger.findUnique({ where: { id } });
    if (!row) throw AppError.notFound(`action ${id} not found`);

    if (!canTransition(row.status, "failed")) {
      throw AppError.conflict(
        ERROR_CODES.ILLEGAL_TRANSITION,
        `cannot cancel action in status ${row.status}`
      );
    }

    const updated = await this.prisma.actionLedger.update({
      where: { id },
      data: {
        status: "failed",
        errorCode,
        errorDetail: errorDetail ?? null,
        recoveryCheckpoint: {
          stage: "failed",
          checkpointed_at: new Date().toISOString()
        }
      }
    });
    return updated as unknown as ActionRecord;
  }

  async getAction(id: string): Promise<ActionRecord | null> {
    const row = await this.prisma.actionLedger.findUnique({ where: { id } });
    return row ? (row as unknown as ActionRecord) : null;
  }

  async markExternalActionStarted(id: string): Promise<ActionRecord> {
    const row = await this.prisma.actionLedger.findUnique({ where: { id } });
    if (!row) throw AppError.notFound(`action ${id} not found`);

    const checkpoint = row.recoveryCheckpoint as { stage?: string } | null;
    if (row.status === "pending" && checkpoint?.stage === "external_action_started") {
      return row as unknown as ActionRecord;
    }
    if (row.status === "pending" && checkpoint?.stage === "recovery_required") {
      return row as unknown as ActionRecord;
    }
    if (row.status !== "pending") {
      if (["external_action_started", "transaction_submitted", "recovery_required"].includes(checkpoint?.stage ?? "")) {
        return row as unknown as ActionRecord;
      }
      throw AppError.conflict(ERROR_CODES.ILLEGAL_TRANSITION, `cannot start external action in status ${row.status}`);
    }

    const updated = await this.prisma.actionLedger.updateMany({
      where: { id, status: "pending" },
      data: {
        recoveryCheckpoint: {
          stage: "external_action_started",
          checkpointed_at: new Date().toISOString()
        }
      }
    });
    const current = await this.prisma.actionLedger.findUnique({ where: { id } });
    if (!current) throw AppError.notFound(`action ${id} not found`);
    if (updated.count === 0 && current.status === "pending") {
      throw AppError.conflict(ERROR_CODES.ILLEGAL_TRANSITION, "action checkpoint changed concurrently");
    }
    return current as unknown as ActionRecord;
  }

  /**
   * Verifies that an action's claimed payout facts (winner/recipient, amount,
   * asset) agree with what the finalized on-chain event actually decoded to
   * (#509). `actionPayload` is client-supplied and mutable by anyone with
   * database write access; `verifiedPayload` is populated only from
   * `reconcileEvent`/`attachTxHash`'s pending-event match, both of which are
   * driven exclusively by the indexer reading finalized Soroban events.
   *
   * Returns `verified: false` — never throws — for every disagreement case
   * so callers (e.g. a "payoutConfirmed" flag) can surface *why* verification
   * failed rather than just erroring.
   */
  async verifyPayoutIntegrity(actionId: string): Promise<{
    verified: boolean;
    reason?: string;
    action: ActionRecord | null;
  }> {
    const row = await this.prisma.actionLedger.findUnique({ where: { id: actionId } });
    if (!row) {
      return { verified: false, reason: "action not found", action: null };
    }
    const action = row as unknown as ActionRecord;

    if (action.status === "reverted") {
      return { verified: false, reason: "transaction reverted on-chain", action };
    }
    if (action.status !== "confirmed") {
      // Not yet backed by a finalized event — pending/submitted/failed/orphaned
      // must never be reported as a verified payout, regardless of what
      // actionPayload claims.
      return { verified: false, reason: `action status is ${action.status}, not confirmed`, action };
    }
    if (!action.verifiedPayload) {
      // Should not happen for a `confirmed` row (both reconciliation paths
      // set it), but fail closed rather than assume agreement.
      return { verified: false, reason: "no finalized event payload on record", action };
    }

    const claimed = (action.actionPayload ?? {}) as Record<string, unknown>;
    const verifiedEvent = action.verifiedPayload as Record<string, unknown>;

    // Field names are normalised loosely (winner/recipient, asset/token) since
    // actionPayload and the decoded event payload aren't guaranteed to use
    // identical keys — but every field that both sides *do* provide must
    // agree; a field present on one side and absent on the other is treated
    // as a mismatch rather than silently skipped.
    const fieldPairs: Array<[string, string[]]> = [
      ["recipient", ["winner", "recipient", "to"]],
      ["amount", ["amount", "value"]],
      ["asset", ["asset", "token"]],
      ["contractId", ["contractId", "contract_id"]]
    ];

    for (const [label, keys] of fieldPairs) {
      const claimedVal = firstDefined(claimed, keys);
      const verifiedVal = firstDefined(verifiedEvent, keys);
      if (claimedVal === undefined && verifiedVal === undefined) continue;
      if (normalize(claimedVal) !== normalize(verifiedVal)) {
        return {
          verified: false,
          reason: `${label} mismatch: claimed=${JSON.stringify(claimedVal)} verified=${JSON.stringify(verifiedVal)}`,
          action
        };
      }
    }

    return { verified: true, action };
  }

  async listActions(params: ListActionsParams): Promise<ListActionsResult> {
    const { walletAddress, status, type, limit, cursor } = params;

    const where = {
      walletAddress,
      redactedAt: null,
      ...(status !== undefined && { status }),
      ...(type !== undefined && { actionType: type as ActionStatus })
    };

    const rows = await this.prisma.actionLedger.findMany({
      where: where as Prisma.ActionLedgerWhereInput,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor != null && { cursor: { id: cursor }, skip: 1 })
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return { items: items as unknown as ActionRecord[], nextCursor };
  }

  reconcileEvent(input: ReconcileEventInput): Promise<{ matched: boolean }> {
    return withTelemetry({ operation: "action.reconcile_event", actorType: "system" }, () => this.reconcileEventImpl(input));
  }

  private async reconcileEventImpl(input: ReconcileEventInput): Promise<{ matched: boolean }> {
    return (await this.reconcileEvents([input]))[0]!;
  }

  /** Commit one ordered batch atomically; callbacks and cache writes follow the commit. */
  async reconcileEvents(inputs: ReconcileEventInput[]): Promise<Array<{ matched: boolean }>> {
    if (!inputs.length) return [];
    const result = await this.runSerializable(async (tx) => {
      const outcomes: Array<{ matched: boolean }> = [];
      const callbacks: Array<{ id: string; type: string }> = [];
      const parked: Array<Awaited<ReturnType<typeof tx.pendingEvent.upsert>>> = [];
      for (const input of inputs) {
        const row = await tx.actionLedger.findFirst({ where: { txHash: input.txHash } });
        if (!row) {
          const eventPayload = input.ledger ? { ...(input.eventPayload as object), ledger: input.ledger } : input.eventPayload;
          parked.push(await tx.pendingEvent.upsert({ where: { txHash: input.txHash }, create: {
            txHash: input.txHash, sorobanEventId: input.sorobanEventId, eventPayload: eventPayload as Prisma.InputJsonValue,
            statusHint: input.statusHint, ledgerClosedAt: input.ledgerClosedAt ?? null,
            ...(input.ledgerClosedAt ? { receivedAt: input.ledgerClosedAt } : {}),
          }, update: {} }));
          outcomes.push({ matched: false });
          continue;
        }
        if (row.status === "confirmed" || row.status === "reverted") { outcomes.push({ matched: true }); continue; }
        const ledger = input.ledger ?? row.observedLedger;
        const confirmationDepth = row.confirmationDepth ?? FINALITY_POLICY.defaultConfirmationDepth;
        const confirmedAt = input.ledgerClosedAt ?? row.submittedAt ?? row.createdAt;
        await tx.actionLedger.update({ where: { id: row.id }, data: {
          status: input.statusHint === "reverted" ? "reverted" : "confirmed",
          recoveryCheckpoint: { stage: input.statusHint === "reverted" ? "reverted" : "confirmed", checkpointed_at: confirmedAt.toISOString() },
          sorobanEventId: input.sorobanEventId, verifiedPayload: (input.eventPayload ?? undefined) as Prisma.InputJsonValue,
          confirmedAt, errorCode: input.statusHint === "reverted" ? ERROR_CODES.REVERTED_ON_CHAIN : null,
          observedLedger: ledger ?? row.observedLedger,
          finalizedLedger: ledger && ledger > 0 ? ledger + confirmationDepth : null,
          finalityStatus: ledger && ledger > 0 ? "provisional" : "finalized",
        } });
        if (input.statusHint === "confirmed" && row.actionType === "select_winner") callbacks.push({ id: row.id, type: row.actionType });
        await tx.actionLease.deleteMany({ where: { actionId: row.id } });
        outcomes.push({ matched: true });
      }
      return { outcomes, callbacks, parked };
    });
    for (const callback of result.callbacks) {
      try { this.onActionConfirmedCallback?.(callback.id, callback.type); }
      catch { /* Committed reconciliation survives callback failures. */ }
    }
    for (const row of result.parked) await this.cacheService?.setPendingEvent({
      ...row, statusHint: row.statusHint === "reverted" ? "reverted" : "confirmed",
    });
    return result.outcomes;
  }

  /**
   * Creates a compensating entry for an invalidated provisional event.
   * This preserves auditability by appending a new record rather than deleting history.
   * The compensating entry references the original action via compensatesId.
   */
  async createCompensatingEntry(input: {
    originalActionId: string;
    walletAddress: string;
    actionType: "compensating";
    actionPayload: Record<string, unknown>;
    idempotencyKey: string;
    reason: string;
  }): Promise<ActionRecord> {
    const original = await this.prisma.actionLedger.findUnique({ where: { id: input.originalActionId } });
    if (!original) throw AppError.notFound(`original action ${input.originalActionId} not found`);

    if (original.finalityStatus === "finalized") {
      throw AppError.conflict(
        ERROR_CODES.ILLEGAL_TRANSITION,
        "cannot create compensating entry for finalized action; use manual reconciliation"
      );
    }

    // Mark the original as invalidated
    await this.prisma.actionLedger.update({
      where: { id: input.originalActionId },
      data: { finalityStatus: "invalidated" }
    });

    // Create the compensating entry
    const compensating = await this.prisma.actionLedger.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        walletAddress: input.walletAddress,
        actionType: input.actionType,
        actionPayload: {
          ...input.actionPayload,
          originalActionId: input.originalActionId,
          reason: input.reason,
          originalTxHash: original.txHash,
          originalStatus: original.status
        } as object,
        finalityStatus: "finalized",
        observedLedger: null,
        finalizedLedger: null,
        confirmationDepth: null,
        compensatesId: input.originalActionId
      }
    });

    return compensating as unknown as ActionRecord;
  }

  /**
   * Finalizes provisional entries whose confirmation depth has been reached.
   * Called periodically by a background job (e.g., indexer checkpoint advancement).
   * Returns the number of entries finalized.
   */
  async finalizeProvisionalEntries(currentLedger: number): Promise<number> {
    const provisional = await this.prisma.actionLedger.findMany({
      where: {
        finalityStatus: "provisional",
        finalizedLedger: { not: null, lte: currentLedger }
      },
      select: { id: true }
    });

    if (provisional.length === 0) return 0;

    await this.prisma.actionLedger.updateMany({
      where: { id: { in: provisional.map((r) => r.id) } },
      data: { finalityStatus: "finalized" }
    });

    return provisional.length;
  }

  /**
   * Checks if a provisional entry has been invalidated by a reorg.
   * This would be called when the indexer detects a gap or receives a conflicting event.
   * Returns the invalidated action IDs.
   */
  async detectInvalidatedProvisional(currentLedger: number, knownValidTxHashes: Set<string>): Promise<string[]> {
    const provisional = await this.prisma.actionLedger.findMany({
      where: {
        finalityStatus: "provisional",
        txHash: { not: null }
      },
      select: { id: true, txHash: true, observedLedger: true }
    });

    const invalidated: string[] = [];
    for (const row of provisional) {
      if (row.txHash && !knownValidTxHashes.has(row.txHash)) {
        // The tx hash is no longer in the canonical chain
        // Check if we've passed the max tracking depth
        if (row.observedLedger && currentLedger - row.observedLedger > FINALITY_POLICY.maxTrackedDepth) {
          invalidated.push(row.id);
        }
      }
    }

    return invalidated;
  }

  /**
   * Gets all provisional entries for a wallet (for UI pending indicators).
   */
  async getProvisionalEntries(walletAddress: string): Promise<ActionRecord[]> {
    const rows = await this.prisma.actionLedger.findMany({
      where: { walletAddress, finalityStatus: "provisional" },
      orderBy: { createdAt: "desc" }
    });
    return rows as unknown as ActionRecord[];
  }

  /**
   * Gets the finality policy for documentation/UI display.
   */
  getFinalityPolicy(): typeof FINALITY_POLICY {
    return FINALITY_POLICY;
  }

  async findByIdempotencyKey(key: string): Promise<ActionRecord | null> {
    const row = await this.prisma.actionLedger.findUnique({ where: { idempotencyKey: key } });
    return (row as unknown as ActionRecord) ?? null;
  }

  /**
   * #731: the three reads below (status counts, pending tx hashes, latest
   * activity) previously ran as separate round-trips against the live
   * table. Under burst ingestion — e.g. right after a round closes and
   * `reconcileEvents` commits a batch of confirmations — a write landing
   * between two of those round-trips could make `byStatus`/`totalActions`
   * (read first) reflect a different moment than `latestActivityAt`/
   * `latestConfirmedAt` (read last): a torn, internally-inconsistent
   * summary. Running all three inside one `Serializable` transaction
   * pins them to a single snapshot, the same pattern already used by
   * `DashboardAggregateService.refreshAggregates`. The returned
   * `watermark.latestLedger` is read from the same transaction, so it
   * always describes the exact ingestion point this summary was computed
   * at — see `backend/docs/READ_CONSISTENCY.md`.
   */
  async getDashboardSummary(
    walletAddress: string,
    options: { staleAfterMs?: number; now?: Date } = {}
  ): Promise<DashboardSummary> {
    const staleAfterMs = options.staleAfterMs ?? 5 * 60 * 1000;
    const now = options.now ?? new Date();

    return this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const grouped = await tx.actionLedger.groupBy({
          by: ["status"],
          where: { walletAddress },
          _count: { _all: true }
        });

        const byStatus: Record<ActionStatus, number> = {
          pending: 0,
          submitted: 0,
          confirmed: 0,
          failed: 0,
          reverted: 0,
          orphaned: 0
        };
        let totalActions = 0;
        for (const row of grouped) {
          const key = row.status as ActionStatus;
          const count = row._count._all;
          byStatus[key] = count;
          totalActions += count;
        }

        const pendingRows = await tx.actionLedger.findMany({
          where: { walletAddress, status: "submitted", txHash: { not: null } },
          select: { txHash: true },
          orderBy: { submittedAt: "desc" },
          take: 25
        });
        const pendingTxHashes = pendingRows
          .map((r: { txHash: string | null }) => r.txHash)
          .filter((h: string | null): h is string => typeof h === "string" && h.length > 0);

        const latestRows = await tx.actionLedger.findMany({
          where: { walletAddress },
          orderBy: { updatedAt: "desc" },
          select: { createdAt: true, confirmedAt: true, updatedAt: true },
          take: 1
        });
        const latestRow = latestRows[0] ?? null;
        const latestActivityAt = latestRow?.createdAt ?? null;
        const latestConfirmedAt = latestRow?.confirmedAt ?? null;
        const isStale =
          latestRow != null && now.getTime() - latestRow.updatedAt.getTime() > staleAfterMs;

        const checkpoint = await tx.indexerCheckpoint.findUnique({ where: { id: "singleton" } });
        const watermark: IngestionWatermark = {
          latestLedger: checkpoint?.latestLedger ?? null,
          asOf: checkpoint?.lastSuccessSyncTime ?? null
        };

        return {
          walletAddress,
          totalActions,
          byStatus,
          pendingTxHashes,
          isStale,
          latestActivityAt,
          latestConfirmedAt,
          watermark
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  async exportActivity(params: {
    walletAddress: string;
    from?: Date;
    to?: Date;
    actionType?: string;
    limit: number;
  }): Promise<ActionRecord[]> {
    const { walletAddress, from, to, actionType, limit } = params;
    const rows = await this.prisma.actionLedger.findMany({
      where: {
        walletAddress,
        redactedAt: null,
        ...(actionType !== undefined ? { actionType: actionType as any } : {}),
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {})
              }
            }
          : {})
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit
    });
    return rows as unknown as ActionRecord[];
  }

  async scrubWallet(walletAddress: string): Promise<{ scrubbed: number }> {
    const result = await this.prisma.actionLedger.updateMany({
      where: { walletAddress, redactedAt: null },
      data: {
        actionPayload: Prisma.DbNull as unknown as never,
        redactedAt: new Date()
      }
    });
    return { scrubbed: result.count };
  }

  async getPortfolioSummary(walletAddress: string) {
    const actions = await this.prisma.actionLedger.findMany({
      where: { walletAddress },
      orderBy: { createdAt: "desc" }
    });

    // #504 — balances are accumulated per (vaultId, assetCode) using
    // bigint Amount arithmetic, never plain floats. A pool whose payloads
    // report an asset that doesn't match its own running balance's asset
    // is a genuine data inconsistency (two different assets claiming the
    // same vaultId) rather than something to silently add together, so
    // it's surfaced via invalidActionCount instead of merged.
    //
    // The vault's canonical asset is established from its EARLIEST
    // confirmed action, not whichever action happens to be visited first.
    // `actions` is fetched `orderBy: createdAt desc`, so without this a
    // late-arriving action (e.g. a spoofed/malformed payload reporting the
    // wrong token) would silently become the accepted baseline and cause
    // every earlier, legitimate action for that vault to be flagged as the
    // mismatch and dropped — inverting the intent of this guard.
    const vaultCanonicalToken: Record<string, string> = {};
    const confirmedActionsChronological = actions
      .filter((a) => a.status === "confirmed")
      .slice()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const action of confirmedActionsChronological) {
      const payload = action.actionPayload as Record<string, unknown> | null;
      if (!payload) continue;

      const vaultId = String(payload.vault_id ?? payload.pool_id ?? "default");
      if (!(vaultId in vaultCanonicalToken)) {
        vaultCanonicalToken[vaultId] = String(payload.token ?? payload.asset ?? DEFAULT_POOL_ASSET_CODE);
      }
    }

    const poolBalances: Record<string, { balance: Amount; token: string }> = {};
    let totalClaimed: Amount | null = null;
    let invalidActionCount = 0;

    const confirmedActions = actions.filter((a) => a.status === "confirmed");
    for (const action of confirmedActions) {
      const payload = action.actionPayload as Record<string, unknown> | null;
      if (!payload) continue;

      const vaultId = String(payload.vault_id ?? payload.pool_id ?? "default");
      const token = String(payload.token ?? payload.asset ?? DEFAULT_POOL_ASSET_CODE);
      const canonicalToken = vaultCanonicalToken[vaultId] ?? token;

      // #509: for claim/select_winner (payout-bearing actions), the amount
      // must come from the finalized event's decoded payload when one is on
      // record — actionPayload is client-supplied and mutable, and this
      // figure is exactly the "claimable_amount" the wallet UI displays as
      // fact. Deposit/withdraw amounts still read actionPayload: the wallet
      // itself signs those transactions, so there's no third-party payout
      // trust boundary to cross for them the way there is for a payout the
      // *admin* settles on the wallet's behalf.
      const isPayoutAction = action.actionType === "claim" || action.actionType === "select_winner";
      const verified = action.verifiedPayload as Record<string, unknown> | null;
      if (isPayoutAction && !verified) {
        // A claim/select_winner confirmed on-chain but with no verified
        // payload on record (shouldn't happen — both reconciliation paths
        // always set it for a confirmed row — but if data predates this
        // column, or the event decode failed silently upstream) is excluded
        // rather than trusting an unverified actionPayload amount.
        invalidActionCount++;
        continue;
      }
      const amountSource = isPayoutAction && verified ? verified : payload;
      const amountToken = isPayoutAction && verified
        ? String(verified.token ?? verified.asset ?? token)
        : token;

      let amount: Amount;
      try {
        amount = Amount.fromPayload(amountSource, amountToken, DEFAULT_POOL_ASSET_DECIMALS);
      } catch (err) {
        if (err instanceof InvalidAmountError) {
          invalidActionCount++;
          continue;
        }
        throw err;
      }

      if (amountToken !== canonicalToken) {
        // This action's asset doesn't match the vault's canonical asset
        // (established from its earliest confirmed action) — a data
        // inconsistency, not something to combine. Skip rather than
        // silently mixing units into one balance.
        invalidActionCount++;
        continue;
      }

      if (!poolBalances[vaultId]) {
        poolBalances[vaultId] = { balance: Amount.zero(canonicalToken, DEFAULT_POOL_ASSET_DECIMALS), token: canonicalToken };
      }

      if (action.actionType === "deposit") {
        poolBalances[vaultId].balance = poolBalances[vaultId].balance.add(amount);
      } else if (action.actionType === "withdraw") {
        poolBalances[vaultId].balance = poolBalances[vaultId].balance.subtract(amount);
      } else if (isPayoutAction) {
        totalClaimed = totalClaimed ? totalClaimed.add(amount) : amount;
      }
    }

    let totalDeposits: Amount | null = null;
    const activePositions = Object.entries(poolBalances)
      .filter(([, data]) => data.balance.isPositive())
      .map(([vaultId, data]) => {
        // Only combine into the grand total when the asset matches every
        // other position seen so far — otherwise leave totalDeposits as
        // whichever single asset started the accumulation and surface the
        // mismatch, rather than silently summing incompatible units.
        if (!totalDeposits) {
          totalDeposits = data.balance;
        } else if (totalDeposits.assetCode === data.balance.assetCode) {
          totalDeposits = totalDeposits.add(data.balance);
        } else {
          invalidActionCount++;
        }
        return {
          vault_id: vaultId,
          // Converted back to Number at the response boundary to preserve
          // this endpoint's existing external contract (tests assert
          // plain numbers here) — the accumulation above happens entirely
          // in bigint, so this conversion can't itself reintroduce the
          // precision loss the float-based code had.
          balance: Number(data.balance.raw),
          token: data.token
        };
      });

    const recentActivity = actions.slice(0, 5).map((a) => ({
      id: a.id,
      action_type: a.actionType,
      status: a.status,
      tx_hash: a.txHash,
      created_at: a.createdAt,
      payload: a.actionPayload
    }));

    return {
      wallet_address: walletAddress,
      total_deposits: Number((totalDeposits ?? Amount.zero(DEFAULT_POOL_ASSET_CODE, DEFAULT_POOL_ASSET_DECIMALS)).raw),
      active_positions: activePositions,
      pending_rewards: 0,
      claimable_amount: Number((totalClaimed ?? Amount.zero(DEFAULT_POOL_ASSET_CODE, DEFAULT_POOL_ASSET_DECIMALS)).raw),
      invalid_action_count: invalidActionCount,
      recent_activity: recentActivity
    };
  }

  async updateIndexerCheckpoint(input: {
    latestLedger: number;
    lastProcessedEventId?: string | null;
    lastError?: string | null;
    success: boolean;
    indexerVersion?: string;
  }): Promise<any> {
    const now = new Date();
    const needsExisting =
      input.lastProcessedEventId === undefined || (!input.success && input.lastError === undefined) || (input.indexerVersion === undefined);
    const existing = needsExisting ? await this.getIndexerCheckpoint() : null;
    const lastProcessedEventId =
      input.lastProcessedEventId !== undefined
        ? input.lastProcessedEventId
        : existing?.lastProcessedEventId ?? null;
    const lastError = input.success
      ? null
      : input.lastError !== undefined
        ? input.lastError
        : existing?.lastError ?? null;
    const indexerVersion = input.indexerVersion !== undefined ? input.indexerVersion : existing?.indexerVersion ?? null;

    if (this.cacheService) {
      const lastSuccessSyncTime = input.success ? now : (existing?.lastSuccessSyncTime ?? now);
      await this.cacheService.setCheckpoint({
        latestLedger: input.latestLedger,
        lastProcessedEventId,
        lastSyncTime: now,
        lastSuccessSyncTime,
        lastError,
        indexerVersion
      });
      return { id: "singleton" };
    }

    return this.prisma.indexerCheckpoint.upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        latestLedger: input.latestLedger,
        lastProcessedEventId,
        lastSyncTime: now,
        lastError,
        lastSuccessSyncTime: input.success ? now : undefined,
        indexerVersion
      },
      update: {
        latestLedger: input.latestLedger,
        lastProcessedEventId,
        lastSyncTime: now,
        lastError,
        lastSuccessSyncTime: input.success ? now : undefined,
        indexerVersion
      }
    });
  }

  /**
   * Lightweight ingestion watermark (#731) for read endpoints that don't
   * need a full snapshot transaction of their own — a single query/cache
   * read whose only job is to say "as of what ingestion point was this
   * response computed". Callers doing multiple related reads (like
   * `getDashboardSummary` above) should read the checkpoint inside their
   * own transaction instead, so the watermark is guaranteed to match the
   * data it's reported alongside rather than being read moments apart.
   */
  async getIngestionWatermark(): Promise<IngestionWatermark> {
    const checkpoint = this.cacheService
      ? await this.cacheService.getCheckpoint()
      : await this.prisma.indexerCheckpoint.findUnique({ where: { id: "singleton" } });

    return {
      latestLedger: checkpoint?.latestLedger ?? null,
      asOf: checkpoint?.lastSuccessSyncTime ?? null
    };
  }

  async getIndexerHealth(options: { staleAfterMs?: number; now?: Date } = {}): Promise<any> {
    const staleAfterMs = options.staleAfterMs ?? 5 * 60 * 1000;
    const now = options.now ?? new Date();

    const checkpoint = this.cacheService
      ? await this.cacheService.getCheckpoint()
      : await this.prisma.indexerCheckpoint.findUnique({
          where: { id: "singleton" }
        });

    if (!checkpoint) {
      return {
        status: "degraded",
        latest_ledger: 0,
        last_processed_event_id: null,
        last_sync_time: null,
        last_success_sync_time: null,
        last_error: null,
        sync_lag: 0,
        message: "No indexer checkpoint found"
      };
    }

    const lastSuccessSyncTime = checkpoint.lastSuccessSyncTime || now;
    const elapsedSinceLastSuccess = now.getTime() - lastSuccessSyncTime.getTime();
    const estimatedLedgerLag = Math.max(0, Math.floor(elapsedSinceLastSuccess / 5000));

    let status = "healthy";
    let message = "Indexer is healthy and syncing";

    if (checkpoint.lastError) {
      status = "degraded";
      message = `Indexer reported error: ${checkpoint.lastError}`;
    } else if (elapsedSinceLastSuccess > staleAfterMs) {
      status = "lagging";
      message = `Indexer is lagging. Last successful sync was ${Math.round(elapsedSinceLastSuccess / 1000)}s ago`;
    }

    return {
      status,
      latest_ledger: checkpoint.latestLedger,
      last_processed_event_id: checkpoint.lastProcessedEventId ?? null,
      last_sync_time: checkpoint.lastSyncTime || now,
      last_success_sync_time: lastSuccessSyncTime,
      last_error: checkpoint.lastError,
      sync_lag: estimatedLedgerLag,
      message
    };
  }

  /** Marks stale external operations for investigation without resubmitting them. */
  async recoverSubmittedLeases(
    workerId?: string,
    options: { ttlMs?: number; batchSize?: number; dryRun?: boolean } = {}
  ): Promise<RecoveryLeaseResult> {
    const ttlMs = options.ttlMs ?? this.defaultLeaseTtlMs;
    const batchSize = options.batchSize ?? 50;
    const dryRun = options.dryRun ?? false;

    const cutoff = new Date(Date.now() - ttlMs);

    // Only consider submitted actions old enough to have outlived their worker.
    const candidates = await this.prisma.actionLedger.findMany({
      where: {
        status: "submitted",
        OR: [
          { submittedAt: { lte: cutoff } },
          { submittedAt: null, updatedAt: { lte: cutoff } }
        ]
      },
      orderBy: { submittedAt: "asc" },
      take: batchSize
    });

    const stalePending = await this.prisma.actionLedger.findMany({
      where: {
        status: "pending",
        updatedAt: { lte: cutoff },
        recoveryCheckpoint: { path: ["stage"], equals: "external_action_started" }
      },
      orderBy: { updatedAt: "asc" },
      take: batchSize,
      select: { id: true }
    });
    const uncertainPendingIds = stalePending.map((row) => row.id);

    if (candidates.length === 0 && uncertainPendingIds.length === 0) {
      return { recovered: 0, expired: 0 };
    }

    const leases = candidates.length > 0
      ? await this.prisma.actionLease.findMany({
          where: { actionId: { in: candidates.map((c) => c.id) } }
        })
      : [];
    const expiredIds = new Set(
      leases
        .filter((l) => l.expiresAt.getTime() <= Date.now())
        .map((l) => l.actionId)
    );
    const noLeaseIds = new Set(
      candidates.filter((c) => !leases.some((l) => l.actionId === c.id)).map((c) => c.id)
    );
    const targetIds = [...new Set([...expiredIds, ...noLeaseIds])];

    if (targetIds.length === 0 && uncertainPendingIds.length === 0) {
      return { recovered: 0, expired: 0 };
    }

    if (dryRun) {
      return { recovered: 0, expired: targetIds.length + uncertainPendingIds.length };
    }

    const checkpointedAt = new Date().toISOString();
    const [updated, pendingUpdated] = await Promise.all([
      targetIds.length > 0
        ? this.prisma.actionLedger.updateMany({
            where: { id: { in: targetIds }, status: "submitted" },
            data: {
              status: "orphaned",
              errorCode: ERROR_CODES.ORPHAN_TTL_EXPIRED,
              errorDetail: "Transaction outcome is unknown. Verify the transaction on-chain before retrying.",
              recoveryCheckpoint: {
                stage: "recovery_required",
                checkpointed_at: checkpointedAt,
                recovery_worker: workerId ?? null
              }
            }
          })
        : Promise.resolve({ count: 0 }),
      uncertainPendingIds.length > 0
        ? this.prisma.actionLedger.updateMany({
            where: { id: { in: uncertainPendingIds }, status: "pending", updatedAt: { lte: cutoff } },
            data: {
              recoveryCheckpoint: {
                stage: "recovery_required",
                checkpointed_at: checkpointedAt,
                previous_stage: "external_action_started",
                recovery_worker: workerId ?? null
              }
            }
          })
        : Promise.resolve({ count: 0 })
    ]);

    if (targetIds.length > 0) {
      // Release expired leases; the original transaction remains the source of truth.
      await this.prisma.actionLease.deleteMany({ where: { actionId: { in: targetIds } } });
    }

    return {
      recovered: updated.count + pendingUpdated.count,
      expired: targetIds.length + uncertainPendingIds.length
    };
  }

  /**
   * List submitted actions that are eligible for recovery work (no active lease).
   */
  /**
   * #778: cursor-based listing of recoverable (submitted, no active lease)
   * actions.  Ordering on (submittedAt, id) is stable: newly-submitted rows
   * always appear *after* the current page, so callers never skip or see
   * duplicate records even when rows are inserted or transition status while
   * paginating.
   *
   * @param limit   - max records per page (default 25)
   * @param cursor  - id of the last record seen on the previous page
   */
  async listRecoverableActions(
    limit = 25,
    cursor?: string | null,
  ): Promise<{ items: Awaited<ReturnType<typeof this["prisma"]["actionLedger"]["findMany"]>>; nextCursor: string | null }> {
    const rows = await this.prisma.actionLedger.findMany({
      where: { status: "submitted" },
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      ...(cursor != null ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    const leases = await this.prisma.actionLease.findMany({
      where: { actionId: { in: items.map((c) => c.id) } },
    });
    const leased = new Set(leases.map((l) => l.actionId));
    const filtered = items.filter((c) => !leased.has(c.id));

    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;
    return { items: filtered, nextCursor };
  }
}
