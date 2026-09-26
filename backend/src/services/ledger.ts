import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { ERROR_CODES, FINALITY_POLICY } from "../constants.js";
import { AppError } from "../errors.js";
import type { IntentInput, ActionRecord } from "../types.js";
import type { ActionStatus } from "../constants.js";
import type { CacheService } from "./cacheService.js";

export type ListActionsParams = {
  walletAddress: string;
  status?: ActionStatus;
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
  /**
   * `true` when the most recent ledger update is older than `staleAfterMs`,
   * giving the frontend a deterministic way to render a "data may be stale"
   * banner without polling the indexer directly (#14).
   */
  isStale: boolean;
  /** Newest createdAt across the wallet's actions, or null if none exist. */
  latestActivityAt: Date | null;
  /** Newest confirmedAt across the wallet's actions, or null. */
  latestConfirmedAt: Date | null;
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

export class LedgerService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cacheService?: CacheService
  ) {}

  async createAction(input: IntentInput & { observedLedger?: number; confirmationDepth?: number }): Promise<ActionRecord> {
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

    const confirmationDepth = input.confirmationDepth ?? FINALITY_POLICY.defaultConfirmationDepth;
    const observedLedger = input.observedLedger ?? 0;
    const finalizedLedger = observedLedger > 0 ? observedLedger + confirmationDepth : null;

    const created = await this.prisma.actionLedger.create({
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
  }

  async attachTxHash(id: string, txHash: string, observedLedger?: number): Promise<ActionRecord> {
    try {
      return await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const row = await tx.actionLedger.findUnique({ where: { id } });
      if (!row) throw AppError.notFound(`action ${id} not found`);

      // Retry-safe: re-attaching the same tx_hash to the same action is a
      // no-op. A client whose request succeeded but whose response was lost can
      // safely resubmit without tripping the status guard below.
      if (row.txHash === txHash) {
        return row as unknown as ActionRecord;
      }

      if (row.status !== "pending") {
        throw AppError.conflict(
          ERROR_CODES.ILLEGAL_TRANSITION,
          `cannot attach tx_hash to action in status ${row.status}`
        );
      }

      // A given on-chain tx hash maps to exactly one action. If another action
      // already owns it, reject rather than creating a duplicate tx-hash record
      // (also enforced by a unique index as a backstop against races).
      const owner = await tx.actionLedger.findFirst({
        where: { txHash, NOT: { id } }
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
        const ledger = pending.eventPayload && typeof pending.eventPayload === "object" && "ledger" in pending.eventPayload
          ? Number((pending.eventPayload as Record<string, unknown>).ledger)
          : observedLedger;

        const confirmationDepth = row.confirmationDepth ?? FINALITY_POLICY.defaultConfirmationDepth;
        const finalizedLedger = ledger && ledger > 0 ? ledger + confirmationDepth : null;
        const finalityStatus = ledger && ledger > 0 ? "provisional" : "finalized";

        const confirmed = await tx.actionLedger.update({
          where: { id },
          data: {
            status: pending.statusHint === "reverted" ? "reverted" : "confirmed",
            txHash,
            submittedAt: new Date(),
            confirmedAt: new Date(),
            sorobanEventId: pending.sorobanEventId,
            errorCode: pending.statusHint === "reverted" ? ERROR_CODES.REVERTED_ON_CHAIN : null,
            observedLedger: ledger ?? row.observedLedger,
            finalizedLedger,
            finalityStatus
          }
        });
        return confirmed as unknown as ActionRecord;
      }

      const confirmationDepth = row.confirmationDepth ?? FINALITY_POLICY.defaultConfirmationDepth;
      const finalizedLedger = observedLedger && observedLedger > 0 ? observedLedger + confirmationDepth : null;
      const finalityStatus = observedLedger && observedLedger > 0 ? "provisional" : "finalized";

      const updated = await tx.actionLedger.update({
        where: { id },
        data: {
          status: "submitted",
          txHash,
          submittedAt: new Date(),
          observedLedger: observedLedger ?? row.observedLedger,
          finalizedLedger,
          finalityStatus
        }
      });
      return updated as unknown as ActionRecord;
      });
    } catch (err) {
      // Backstop for a race that slips past the owner check above: the unique
      // index on tx_hash rejects the second writer with P2002.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw AppError.conflict(
          ERROR_CODES.TX_HASH_ALREADY_ATTACHED,
          "tx_hash already attached to another action"
        );
      }
      throw err;
    }
  }

  async cancelAction(id: string, errorCode: string, errorDetail?: string): Promise<ActionRecord> {
    const row = await this.prisma.actionLedger.findUnique({ where: { id } });
    if (!row) throw AppError.notFound(`action ${id} not found`);

    if (row.status !== "pending") {
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
    const { walletAddress, status, limit, cursor } = params;

    const rows = await this.prisma.actionLedger.findMany({
      where: { walletAddress, ...(status !== undefined && { status }) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor != null && { cursor: { id: cursor }, skip: 1 })
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return { items: items as unknown as ActionRecord[], nextCursor };
  }

  async getHistoryPaginated(params: {
    walletAddress: string;
    status?: ActionStatus;
    type?: string;
    skip: number;
    limit: number;
  }): Promise<{ items: ActionRecord[]; total: number }> {
    const { walletAddress, status, type, skip, limit } = params;
    
    const whereClause: any = { walletAddress };
    if (status) whereClause.status = status;
    if (type) whereClause.actionType = type;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.actionLedger.count({ where: whereClause }),
      this.prisma.actionLedger.findMany({
        where: whereClause,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: limit,
      }),
    ]);

    return { items: rows as unknown as ActionRecord[], total };
  }


  async reconcileEvent(input: {
    txHash: string;
    sorobanEventId: string;
    eventPayload: unknown;
    statusHint: "confirmed" | "reverted";
    ledger?: number;
  }): Promise<{ matched: boolean }> {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const row = await tx.actionLedger.findFirst({ where: { txHash: input.txHash } });

      if (!row) {
        const eventPayloadWithLedger = input.ledger
          ? { ...(input.eventPayload as object), ledger: input.ledger }
          : input.eventPayload;
        await tx.pendingEvent.upsert({
          where: { txHash: input.txHash },
          create: {
            txHash: input.txHash,
            sorobanEventId: input.sorobanEventId,
            eventPayload: eventPayloadWithLedger as object,
            statusHint: input.statusHint
          },
          update: {}
        });
        if (this.cacheService) {
          await this.cacheService.setPendingEvent({
            txHash: input.txHash,
            sorobanEventId: input.sorobanEventId,
            eventPayload: eventPayloadWithLedger,
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

      const ledger = input.ledger ?? row.observedLedger;
      const confirmationDepth = row.confirmationDepth ?? FINALITY_POLICY.defaultConfirmationDepth;
      const finalizedLedger = ledger && ledger > 0 ? ledger + confirmationDepth : null;
      const finalityStatus = ledger && ledger > 0 ? "provisional" : "finalized";

      await tx.actionLedger.update({
        where: { id: row.id },
        data: {
          status: input.statusHint === "reverted" ? "reverted" : "confirmed",
          sorobanEventId: input.sorobanEventId,
          confirmedAt: new Date(),
          errorCode: input.statusHint === "reverted" ? ERROR_CODES.REVERTED_ON_CHAIN : null,
          observedLedger: ledger ?? row.observedLedger,
          finalizedLedger,
          finalityStatus
        }
      });
      return { matched: true };
    });
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
   * Aggregated read used by the frontend dashboard (#14).
   *
   * Computes per-status counts, pending tx hashes (so the wallet can resume
   * polling on reload), and a `isStale` flag that lets the UI render partial
   * data without ad-hoc joins on the client.
   */
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

    const poolBalances: Record<string, { balance: number; token: string }> = {};
    let totalClaimed = 0;

    const confirmedActions = actions.filter((a) => a.status === "confirmed");
    for (const action of confirmedActions) {
      const payload = action.actionPayload as Record<string, any> | null;
      if (!payload) continue;

      const vaultId = String(payload.vault_id || payload.pool_id || "default");
      const amount = Number(payload.amount || 0);
      const token = String(payload.token || payload.asset || "USDC");

      if (!poolBalances[vaultId]) {
        poolBalances[vaultId] = { balance: 0, token };
      }

      if (action.actionType === "deposit") {
        poolBalances[vaultId].balance += amount;
      } else if (action.actionType === "withdraw") {
        poolBalances[vaultId].balance -= amount;
      } else if (action.actionType === "claim") {
        totalClaimed += amount;
      }
    }

    let totalDeposits = 0;
    const activePositions = Object.entries(poolBalances)
      .filter(([_, data]) => data.balance > 0)
      .map(([vaultId, data]) => {
        totalDeposits += data.balance;
        return {
          vault_id: vaultId,
          balance: data.balance,
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
      total_deposits: totalDeposits,
      active_positions: activePositions,
      pending_rewards: 0,
      claimable_amount: totalClaimed,
      recent_activity: recentActivity
    };
  }

  async updateIndexerCheckpoint(input: {
    latestLedger: number;
    lastError?: string | null;
    success: boolean;
  }): Promise<any> {
    const now = new Date();
    if (this.cacheService) {
      const existing = await this.cacheService.getCheckpoint();
      const lastSuccessSyncTime = input.success ? now : (existing?.lastSuccessSyncTime ?? now);
      const lastError = input.lastError !== undefined ? input.lastError : (existing?.lastError ?? null);
      await this.cacheService.setCheckpoint({
        latestLedger: input.latestLedger,
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
        lastSyncTime: now,
        lastError: input.lastError || null,
        lastSuccessSyncTime: input.success ? now : undefined
      },
      update: {
        latestLedger: input.latestLedger,
        lastSyncTime: now,
        lastError: input.lastError !== undefined ? input.lastError : undefined,
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
      last_sync_time: checkpoint.lastSyncTime || now,
      last_success_sync_time: lastSuccessSyncTime,
      last_error: checkpoint.lastError,
      sync_lag: estimatedLedgerLag,
      message
    };
  }
}
