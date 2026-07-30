import { Prisma } from "@prisma/client";
import type { PrismaClient, IndexerCheckpoint } from "@prisma/client";
import { ERROR_CODES, canTransition, ActionStatus } from "../constants.js";
import { AppError } from "../errors.js";
import type { IntentInput, ActionRecord } from "../types.js";
import type { CacheService } from "./cacheService.js";
import { Amount, InvalidAmountError } from "../amount.js";

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

export type DashboardSummary = {
  walletAddress: string;
  totalActions: number;
  byStatus: Record<ActionStatus, number>;
  pendingTxHashes: string[];
  isStale: boolean;
  latestActivityAt: Date | null;
  latestConfirmedAt: Date | null;
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

function stableStringify(value: unknown): string {
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

export class LedgerService {
  private onActionConfirmedCallback: ActionConfirmedCallback | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly cacheService?: CacheService
  ) {}

  onActionConfirmed(callback: ActionConfirmedCallback): void {
    this.onActionConfirmedCallback = callback;
  }

  async createAction(input: IntentInput): Promise<ActionRecord> {
    const existing = await this.prisma.actionLedger.findUnique({
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

    const created = await this.prisma.actionLedger.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        walletAddress: input.walletAddress,
        actionType: input.actionType,
        actionPayload: input.actionPayload as object
      }
    });
    return created as unknown as ActionRecord;
  }

  /**
   * Acquire a work lease for an action. CAS-insert into action_leases only if
   * no row exists for this action or any existing lease is expired.
   */
  async acquireLease({ actionId, workerId, ttlMs }: LeaseInput): Promise<boolean> {
    const ttl = ttlMs ?? this.defaultLeaseTtlMs;
    const expiresAt = new Date(Date.now() + ttl);

    try {
      await this.prisma.actionLease.create({
        data: { actionId, workerId, expiresAt }
      });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // Lease already exists — bump only if expired or stale.
        const owned = await this.prisma.actionLease.findUnique({ where: { actionId } });
        if (!owned || owned.expiresAt.getTime() <= Date.now()) {
          const replaced = await this.prisma.actionLease.updateMany({
            where: { actionId, expiresAt: { lte: new Date() } },
            data: { workerId, acquiredAt: new Date(), expiresAt }
          });
          return replaced.count > 0;
        }
        // Active lease held by a different worker.
        return false;
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
   * Convert pending -> submitted atomically, requiring an active lease.
   * Also persists envelope evidence before any external submission.
   */
  async attachTxHash(
    actionId: string,
    txHash: string,
    lease: { workerId: string; ttlMs?: number }
  ): Promise<ActionRecord> {
    try {
      return await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const row = await tx.actionLedger.findUnique({ where: { id: actionId } });
        if (!row) throw AppError.notFound(`action ${actionId} not found`);

        if (row.txHash === txHash) {
          return row as unknown as ActionRecord;
        }

        if (!canTransition(row.status, "submitted")) {
          throw AppError.conflict(
            ERROR_CODES.ILLEGAL_TRANSITION,
            `cannot attach tx_hash to action in status ${row.status}`
          );
        }

        // Acquire/renew lease for this worker on this action.
        const expiresAt = new Date(Date.now() + (lease.ttlMs ?? this.defaultLeaseTtlMs));
        const leaseUpsert = await tx.actionLease.upsert({
          where: { actionId },
          create: { actionId, workerId: lease.workerId, expiresAt },
          update: {
            workerId: lease.workerId,
            acquiredAt: new Date(),
            expiresAt
          }
        });
        if (leaseUpsert.workerId !== lease.workerId) {
          throw AppError.conflict(ERROR_CODES.ILLEGAL_TRANSITION, "action is leased by another worker");
        }

        const owner = await tx.actionLedger.findFirst({
          where: { txHash, NOT: { id: actionId } }
        });
        if (owner) {
          throw AppError.conflict(
            ERROR_CODES.TX_HASH_ALREADY_ATTACHED,
            `tx_hash already attached to action ${owner.id}`
          );
        }

        const pending = this.cacheService
          ? await this.cacheService.getPendingEvent(txHash)
          : await tx.pendingEvent.findUnique({ where: { txHash } });

        if (pending) {
          await tx.pendingEvent.update({
            where: { txHash },
            data: { consumedAt: new Date() }
          });
          if (this.cacheService) {
            await this.cacheService.deletePendingEvent(txHash);
          }
          const confirmed = await tx.actionLedger.update({
            where: { id: actionId },
            data: {
              status: pending.statusHint === "reverted" ? "reverted" : "confirmed",
              txHash,
              submittedAt: new Date(),
              confirmedAt: new Date(),
              sorobanEventId: pending.sorobanEventId,
              errorCode: pending.statusHint === "reverted" ? ERROR_CODES.REVERTED_ON_CHAIN : null
            }
          });
          await tx.actionLease.delete({ where: { actionId } });
          return confirmed as unknown as ActionRecord;
        }

        const updated = await tx.actionLedger.update({
          where: { id: actionId },
          data: {
            status: "submitted",
            txHash,
            submittedAt: new Date()
          }
        });
        return updated as unknown as ActionRecord;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
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

  async cancelAction(id: string, errorCode: string, errorDetail?: string): Promise<ActionRecord> {
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
      data: { status: "failed", errorCode, errorDetail: errorDetail ?? null }
    });
    return updated as unknown as ActionRecord;
  }

  async getAction(id: string): Promise<ActionRecord | null> {
    const row = await this.prisma.actionLedger.findUnique({ where: { id } });
    return row ? (row as unknown as ActionRecord) : null;
  }

  async listActions(params: ListActionsParams): Promise<ListActionsResult> {
    const { walletAddress, status, type, limit, cursor } = params;

    const where = {
      walletAddress,
      ...(status !== undefined && { status }),
      ...(type !== undefined && { actionType: type as ActionStatus })
    };

    const rows = await this.prisma.actionLedger.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor != null && { cursor: { id: cursor }, skip: 1 })
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return { items: items as unknown as ActionRecord[], nextCursor };
  }

  async reconcileEvent(input: {
    txHash: string;
    sorobanEventId: string;
    eventPayload: unknown;
    statusHint: "confirmed" | "reverted";
  }): Promise<{ matched: boolean }> {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const row = await tx.actionLedger.findFirst({ where: { txHash: input.txHash } });

      if (!row) {
        await tx.pendingEvent.upsert({
          where: { txHash: input.txHash },
          create: {
            txHash: input.txHash,
            sorobanEventId: input.sorobanEventId,
            eventPayload: input.eventPayload as object,
            statusHint: input.statusHint
          },
          update: {}
        });
        if (this.cacheService) {
          await this.cacheService.setPendingEvent({
            txHash: input.txHash,
            sorobanEventId: input.sorobanEventId,
            eventPayload: input.eventPayload,
            statusHint: input.statusHint,
            receivedAt: new Date(),
            consumedAt: null
          });
        }
        return { matched: false };
      }

      if (row.status === "confirmed" || row.status === "reverted") {
        return { matched: true };
      }

      await tx.actionLedger.update({
        where: { id: row.id },
        data: {
          status: input.statusHint === "reverted" ? "reverted" : "confirmed",
          sorobanEventId: input.sorobanEventId,
          confirmedAt: new Date(),
          errorCode: input.statusHint === "reverted" ? ERROR_CODES.REVERTED_ON_CHAIN : null
        }
      });

      if (input.statusHint === "confirmed" && row.actionType === "select_winner") {
        try {
          this.onActionConfirmedCallback?.(row.id, row.actionType);
        } catch {
          // callback errors should not break reconciliation
        }
      }

      await tx.actionLease.deleteMany({ where: { actionId: row.id } });
      return { matched: true };
    });
  }

  /**
   * Records a malformed or unrecognized event for operator triage instead of
   * silently dropping it or letting it corrupt a projection. Idempotent on
   * sorobanEventId so retried ticks against the same poison event don't pile up.
   */
  async quarantineEvent(input: {
    sorobanEventId: string;
    ledger: number;
    contractId: string;
    txHash: string;
    rawEvent: unknown;
    reason: string;
  }): Promise<void> {
    await this.prisma.poisonEvent.upsert({
      where: { sorobanEventId: input.sorobanEventId },
      create: {
        sorobanEventId: input.sorobanEventId,
        ledger: input.ledger,
        contractId: input.contractId,
        txHash: input.txHash,
        rawEvent: input.rawEvent as object,
        reason: input.reason
      },
      update: {
        reason: input.reason
      }
    });
  }

  /**
   * Upserts a `PoolRegistry` row from a decoded vault-factory `pool`/
   * `deployed` event (#507). Keyed on `poolAddress` (unique, and derived
   * deterministically from (factoryAddress, salt) on-chain, so a replayed
   * or re-fetched event for the same pool is a no-op update rather than a
   * duplicate row) — the same idempotency guarantee `reconcileEvent` gives
   * action-ledger rows, applied here for registry entries instead.
   */
  async upsertPoolRegistryEntry(input: {
    salt: string;
    poolAddress: string;
    factoryAddress: string;
    admin: string;
    asset: string;
    wasmHash: string;
    deployedLedger: number;
  }): Promise<void> {
    await this.prisma.poolRegistry.upsert({
      where: { poolAddress: input.poolAddress },
      create: {
        salt: input.salt,
        poolAddress: input.poolAddress,
        factoryAddress: input.factoryAddress,
        admin: input.admin,
        asset: input.asset,
        wasmHash: input.wasmHash,
        deployedLedger: input.deployedLedger
      },
      update: {
        admin: input.admin,
        asset: input.asset,
        wasmHash: input.wasmHash
      }
    });
  }

  /**
   * Marks a registry entry inactive (mirrors the factory's own
   * `deactivate_pool` — never touches the deployed pool contract itself,
   * see vault-factory/src/lib.rs's doc comment on that method).
   */
  async deactivatePoolRegistryEntry(salt: string): Promise<void> {
    await this.prisma.poolRegistry.updateMany({
      where: { salt },
      data: { active: false }
    });
  }

  /**
   * Active pool contract addresses known to the registry — an additional
   * indexer contract-id source layered on top of the static
   * `INDEXER_CONTRACT_IDS` env var (kept as a fallback so existing
   * single-pool deployments keep working unchanged; see the #507 design
   * proposal).
   */
  async getActivePoolAddresses(): Promise<string[]> {
    const rows = await this.prisma.poolRegistry.findMany({
      where: { active: true },
      select: { poolAddress: true }
    });
    return rows.map((r: { poolAddress: string }) => r.poolAddress);
  }

  async findByIdempotencyKey(key: string): Promise<ActionRecord | null> {
    const row = await this.prisma.actionLedger.findUnique({ where: { idempotencyKey: key } });
    return (row as unknown as ActionRecord) ?? null;
  }

  async getDashboardSummary(
    walletAddress: string,
    options: { staleAfterMs?: number; now?: Date } = {}
  ): Promise<DashboardSummary> {
    const staleAfterMs = options.staleAfterMs ?? 5 * 60 * 1000;
    const now = options.now ?? new Date();

    const grouped = await this.prisma.actionLedger.groupBy({
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

    const pendingRows = await this.prisma.actionLedger.findMany({
      where: { walletAddress, status: "submitted", txHash: { not: null } },
      select: { txHash: true },
      orderBy: { submittedAt: "desc" },
      take: 25
    });
    const pendingTxHashes = pendingRows
      .map((r: { txHash: string | null }) => r.txHash)
      .filter((h: string | null): h is string => typeof h === "string" && h.length > 0);

    const latestRows = await this.prisma.actionLedger.findMany({
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

    return {
      walletAddress,
      totalActions,
      byStatus,
      pendingTxHashes,
      isStale,
      latestActivityAt,
      latestConfirmedAt
    };
  }

  async exportActivity(params: {
    walletAddress: string;
    from?: Date;
    to?: Date;
    limit: number;
  }): Promise<ActionRecord[]> {
    const { walletAddress, from, to, limit } = params;
    const rows = await this.prisma.actionLedger.findMany({
      where: {
        walletAddress,
        redactedAt: null,
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

      let amount: Amount;
      try {
        amount = Amount.fromPayload(payload, token, DEFAULT_POOL_ASSET_DECIMALS);
      } catch (err) {
        if (err instanceof InvalidAmountError) {
          invalidActionCount++;
          continue;
        }
        throw err;
      }

      if (token !== canonicalToken) {
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
      } else if (action.actionType === "claim") {
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
  }): Promise<any> {
    const now = new Date();
    const needsExisting =
      input.lastProcessedEventId === undefined || (!input.success && input.lastError === undefined);
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
    if (this.cacheService) {
      const lastSuccessSyncTime = input.success ? now : (existing?.lastSuccessSyncTime ?? now);
      await this.cacheService.setCheckpoint({
        latestLedger: input.latestLedger,
        lastProcessedEventId,
        lastSyncTime: now,
        lastSuccessSyncTime,
        lastError
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
        lastSuccessSyncTime: input.success ? now : undefined
      },
      update: {
        latestLedger: input.latestLedger,
        lastProcessedEventId,
        lastSyncTime: now,
        lastError,
        lastSuccessSyncTime: input.success ? now : undefined
      }
    });
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

  /**
   * Recover stuck submitted actions whose leases have expired and either
   * (a) transition them to `orphaned` with a canonical error or (b) make them
   * available for a new submission attempt.
   */
  async recoverSubmittedLeases(
    workerId?: string,
    options: { ttlMs?: number; batchSize?: number; dryRun?: boolean } = {}
  ): Promise<RecoveryLeaseResult> {
    const ttlMs = options.ttlMs ?? this.defaultLeaseTtlMs;
    const batchSize = options.batchSize ?? 50;
    const dryRun = options.dryRun ?? false;

    const cutoff = new Date(Date.now() - ttlMs);

    // Submitted actions with no lease OR an expired lease.
    const candidates = await this.prisma.actionLedger.findMany({
      where: {
        status: "submitted"
      },
      orderBy: { submittedAt: "asc" },
      take: batchSize
    });

    if (candidates.length === 0) {
      return { recovered: 0, expired: 0 };
    }

    const leases = await this.prisma.actionLease.findMany({
      where: { actionId: { in: candidates.map((c) => c.id) } }
    });
    const expiredIds = new Set(
      leases
        .filter((l) => l.expiresAt.getTime() <= Date.now())
        .map((l) => l.actionId)
    );
    const noLeaseIds = new Set(
      candidates.filter((c) => !leases.some((l) => l.actionId === c.id)).map((c) => c.id)
    );
    const targetIds = [...new Set([...expiredIds, ...noLeaseIds])];

    if (targetIds.length === 0) {
      return { recovered: 0, expired: 0 };
    }

    if (dryRun) {
      return { recovered: 0, expired: targetIds.length };
    }

    await this.prisma.actionLedger.updateMany({
      where: { id: { in: targetIds }, status: "submitted" },
      data: { status: "orphaned", errorCode: ERROR_CODES.ORPHAN_TTL_EXPIRED }
    });

    // Release expired leases so recovery can re-submit.
    await this.prisma.actionLease.deleteMany({ where: { actionId: { in: targetIds } } });

    // Opportunistically drop any stale pending_events tied to these tx hashes.
    const hashes = candidates
      .filter((c) => targetIds.includes(c.id) && c.txHash)
      .map((c) => c.txHash as string);
    if (hashes.length > 0) {
      await this.prisma.pendingEvent.deleteMany({ where: { txHash: { in: hashes } } });
      if (this.cacheService) {
        for (const h of hashes) {
          await this.cacheService.deletePendingEvent(h);
        }
      }
    }

    return { recovered: targetIds.length, expired: targetIds.length };
  }

  /**
   * List submitted actions that are eligible for recovery work (no active lease).
   */
  async listRecoverableActions(limit = 25, offset = 0) {
    const candidates = await this.prisma.actionLedger.findMany({
      where: { status: "submitted" },
      orderBy: { submittedAt: "asc" },
      take: limit,
      skip: offset
    });

    const leases = await this.prisma.actionLease.findMany({
      where: { actionId: { in: candidates.map((c) => c.id) } }
    });
    const leased = new Set(leases.map((l) => l.actionId));
    return candidates.filter((c) => !leased.has(c.id));
  }
}