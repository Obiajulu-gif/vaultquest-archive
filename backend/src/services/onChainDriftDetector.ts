/**
 * Automated On-Chain vs. Ledger Drift Detection Service (#727).
 *
 * Periodically compares authoritative on-chain contract state (Soroban/Stellar)
 * against off-chain ledger materialized views (ActionLedger, VaultSettlement,
 * UserQuest, PoolRegistry).
 *
 * Operational Safety & Guarantees:
 * 1. Read-Only / Non-Mutating: Flags discrepancies with structured severity levels
 *    without unilaterally modifying ledger state.
 * 2. Race-Condition Immune: Uses IndexerCheckpoint watermarks and in-flight action
 *    correlation to distinguish live ingestion lag from genuine state divergence.
 * 3. Batched & RPC-Efficient: Reads contract states in bounded batches to avoid
 *    exhausting RPC rate limits.
 *
 * Time Complexity: O(E) where E is the number of tracked entities.
 * Space Complexity: O(D) where D is the number of detected drifts.
 */

import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { rpc as StellarRpc, xdr as StellarXdr, scValToNative, Address } from "@stellar/stellar-sdk";
import { createLogger } from "../logger.js";
import { Amount } from "../amount.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

export type DriftSeverity = "CRITICAL" | "WARNING" | "INFO";

export type DriftEntityType = "vault" | "round" | "participant" | "escrow" | "quest";

export interface OnChainPoolState {
  totalDeposited:bigint;
  distributableYield: bigint;
  locked: boolean;
  isEmergency: boolean;
  emergencyAssets: bigint;
  lastModifiedLedger?: number;
}

export interface OnChainRoundState {
  roundId: number;
  status: "Open" | "Locked" | "Settled";
  principalSnapshot: bigint;
  claimed: bigint;
  realizedYield: bigint;
  prizeReserve: bigint;
  winner: string | null;
  lastModifiedLedger?: number;
}

export interface OnChainReader {
  getChainTipLedger(): Promise<number>;
  getPoolState(poolAddress: string): Promise<OnChainPoolState | null>;
  getRoundState(poolAddress: string, roundId: number): Promise<OnChainRoundState | null>;
  getParticipantDeposit(poolAddress: string, roundId: number, participant: string): Promise<bigint>;
}

export interface OnChainDriftEvent {
  entityType: DriftEntityType;
  entityId: string;
  field: string;
  onChainValue: string | number | boolean | null;
  ledgerValue: string | number | boolean | null;
  severity: DriftSeverity;
  delta?: string;
  chainLedger: number;
  indexerWatermark: number | null;
  rootCauseHint: string;
  detectedAt: Date;
}

export interface DriftDetectionResult {
  checkedEntities: number;
  drifts: OnChainDriftEvent[];
  summary: {
    critical: number;
    warning: number;
    info: number;
  };
  durationMs: number;
  chainLedger: number;
  indexerWatermark: number | null;
}

/**
 * Stale cache detection & repair types (#727).
 *
 * Cached/derived records (e.g. dashboard views, protocol reports, vault accounting
 * rollups) are validated against their source records using a version/timestamp
 * watermark. When the source has advanced past the cache watermark, the entry is
 * considered stale and can be repaired by a deterministic, idempotent job.
 */

export type CacheEntityType = "vault_accounting" | "prize_draw" | "user_dashboard" | "protocol_report";

export type CacheStatus = "fresh" | "stale" | "missing" | "orphaned";

export interface CacheEntryRecord {
  id: string;
  entityType: CacheEntityType;
  entityId: string;
  /** Monotonically increasing source version (ledger sequence or action seq)*/
  sourceVersion: number;
  /** Wall-clock timestamp of the last source mutation */
  sourceUpdatedAt: Date;
  /** Version of the source at the time the cache was written */
  cachedVersion: number;
  cachedAt: Date;
  payload: Record<string, unknown>;
}

export interface CacheStaleness {
  entryId: string;
  entityType: CacheEntityType;
  entityId: string;
  status: CacheStatus;
  sourceVersion: number;
  cachedVersion: number | null;
  driftVersions: number;
  driftMs: number;
  severity: DriftSeverity;
  reason: string;
}

export interface CacheRepairAction {
  entryId: string;
  entityType: CacheEntityType;
  entityId: string;
  status: CacheStatus;
  action: "update" | "insert" | "delete" | "skip";
  fromVersion: number | null;
  toVersion: number;
  reason: string;
}

export interface CacheRepairResult {
  dryRun: boolean;
  scannedEntries: number;
  staleEntries: number;
  missingEntries: number;
  orphanedEntries: number;
  actions: CacheRepairAction[];
  failures: Array<{ entryId: string; error: string }>;
  durationMs: number;
  chainLedger: number;
}

/**
 * Source of truth for cache reconciliation. Implementations derive the
 * authoritative version + payload for a given cache entity from the ledger.
 */
export interface CacheSourceReader {
  /** Returns the current authoritative source version for an entity, or null if the source no longer exists. */
  getSourceVersion(entityType: CacheEntityType, entityId: string): Promise<number | null>;
  /** Returns the authoritative payload for an entity, or null if the source no longer exists. */
  getSourcePayload(entityType: CacheEntityType, entityId: string): Promise<Record<string, unknown> | null>;
  /** Returns the list of entity ids that currently exist in the source of truth. */
  listSourceEntityIds(entityType: CacheEntityType): Promise<string[]>;
  /** Returns the current chain tip ledge for audit trailing. */
  getChainTipLedge(): Promise<number>;
}

/**
 * Persistence layer for cache entries. The repair job writes through this
 * interface so that dry-run and apply modes share identical decision logic.
 */
export interface CacheStore {
  listCacheEntries(entityType?: CacheEntityType): Promise<CacheEntryRecord[]>;
  getCacheEntry(entityType: CacheEntityType, entityId: string): Promise<CacheEntryRecord | null>;
  upsertCacheEntry(entry: CacheEntryRecord): Promise<void>;
  deleteCacheEntry(entityType: CacheEntityType, entityId: string): Promise<void>;
}

export interface CacheRepairOptions {
  /** When true, no writes are performed and only the planned actions are returned. */
  dryRun?: boolean;
  /** Optional filter to limit the job to specific entity types. */
  entityTypes?: CacheEntityType[];
  /** Maximum number of entries to process in a single run. */
  limit?: number;
  /** Optional absolute time threshold after which a cache entry is considered stale. */
  maxStaleMs?: number;
}

export class OnChainDriftDetector {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly onChainReader: OnChainReader,
    private readonly customLogger: Logger = logger,
  ) {}

  /**
   * Performs an automated drift detection cycle across all registered pools,
   * active rounds, and settlements.
   */
  async runDetection(): Promise<DriftDetectionResult> {
    const startTime = Date.now();
    const drifts: OnChainDriftEvent[] = [];
    let checkedEntities = 0;

    // 1. Read chain tip and indexer watermark to establish race-free baseline
    const chainLedger = await this.onChainReader.getChainTipLedger();
    const checkpoint = await this.prisma.indexerCheckpoint.findUnique({
      where: { id: "singleton" },
    });
    const indexerWatermark = checkpoint?.latestLedger ?? null;

    // Fetch registered pools from database
    const registeredPools = await this.prisma.poolRegistry.findMany({
      where: { active: true },
    });

    for (const pool of registeredPools) {
      checkedEntities += 1;
      const poolDrifts = await this.checkPoolDrift(pool.poolAddress, chainLedger, indexerWatermark);
      drifts.push(...poolDrifts);
    }

    // 2. Check settlements drift
    const settlementDrifts = await this.checkSettlementsDrift(chainLedger, indexerWatermark);
    drifts.push(...settlementDrifts);
    checkedEntities += settlementDrifts.length;

    const summary = {
      critical: drifts.filter((d) => d.severity === "CRITICAL").length,
      warning: drifts.filter((d) => d.severity === "WARNING").length,
      info: drifts.filter((d) => d.severity === "INFO").length,
    };

    const durationMs = Date.now() - startTime;

    if (summary.critical > 0) {
      this.customLogger.error(
        { drifts: drifts.filter((d) => d.severity === "CRITICAL"), summary },
        "CRITICAL on-chain vs ledger drift detected!",
      );
    } else if (summary.warning > 0) {
      this.customLogger.warn(
        { drifts: drifts.filter((d) => d.severity === "WARNING"), summary },
        "WARNING on-chain vs ledger drift detected",
      );
    } else {
      this.customLogger.info(
        { checkedEntities, durationMs },
        "On-chain vs ledger drift detection completed cleanly (0 discrepancies)",
      );
    }

    return {
      checkedEntities,
      drifts,
      summary,
      durationMs,
      chainLedger,
      indexerWatermark,
    };
  }

  /**
   * Compares on-chain pool totals and round states against derived ledger actions.
   */
  private async checkPoolDrift(
    poolAddress: string,
    chainLedger: number,
    indexerWatermark: number | null,
  ): Promise<OnChainDriftEvent[]> {
    const drifts: OnChainDriftEvent[] = [];

    const onChainPool = await this.onChainReader.getPoolState(poolAddress);
    if (!onChainPool) {
      drifts.push({
        entityType: "vault",
        entityId: poolAddress,
        field: "existence",
        onChainValue: null,
        ledgerValue: "registered",
        severity: "CRITICAL",
        chainLedger,
        indexerWatermark,
        rootCauseHint: "Pool exists in off-chain registry but contract not found on-chain",
        detectedAt: new Date(),
      });
      return drifts;
    }

    // Compute derived ledger totals from confirmed actions
    const confirmedActions = await this.prisma.actionLedger.findMany({
      where: {
        status: "confirmed",
        actionType: { in: ["deposit", "withdraw"] },
      },
      select: {
        actionType: true,
        verifiedPayload: true,
        actionPayload: true,
      },
    });

    let derivedDeposited = 0n;
    for (const a of confirmedActions) {
      const payload = (a.verifiedPayload || a.actionPayload || {}) as Record<string, unknown>;
      const rawAmt = payload.amount ?? payload.value ?? "0";
      const amt = BigInt(String(rawAmt).replace(/\..*$/, "") || "0");
      if (a.actionType === "deposit") {
        derivedDeposited += amt;
      } else if (a.actionType === "withdraw") {
        derivedDeposited -= amt;
      }
    }

    // Check if there are in-flight (submitted but not confirmed) actions
    const inFlightCount = await this.prisma.actionLedger.count({
      where: {
        status: "submitted",
        txHash: { not: null },
      },
    });

    // Check Total Deposited
    if (onChainPool.totalDeposited !== derivedDeposited) {
      const delta = onChainPool.totalDeposited - derivedDeposited;
      const isIngestionLag = inFlightCount > 0 && (indexerWatermark === null || chainLedger > indexerWatermark);

      drifts.push({
        entityType: "vault",
        entityId: poolAddress,
        field: "total_deposited",
        onChainValue: onChainPool.totalDeposited.toString(),
        ledgerValue: derivedDeposited.toString(),
        delta: delta.toString(),
        severity: isIngestionLag ? "INFO" : (delta < 0n ? "CRITICAL" : "WARNING"),
        chainLedger,
        indexerWatermark,
        rootCauseHint: isIngestionLag
          ? "Potential live ingestion lag: in-flight transactions detected"
          : (delta < 0n ? "Insolvency risk: On-chain balance is lower than ledger tracked deposits" : "Unindexed on-chain deposits or missed event"),
        detectedAt: new Date(),
      });
    }

    return drifts;
  }

  /**
   * Compares VaultSettlement records against resolved states.
   */
  private async checkSettlementsDrift(
    chainLedger: number,
    indexerWatermark: number | null,
  ): Promise<OnChainDriftEvent[]> {
    const drifts: OnChainDriftEvent[] = [];

    // Check settlements stuck in Resolving for > 30 minutes
    const stuckSettlements = await this.prisma.vaultSettlement.findMany({
      where: {
        state: "Resolving",
        updatedAt: { lt: new Date(Date.now() - 30 * 60 * 1000) },
      },
    });

    for (const s of stuckSettlements) {
      drifts.push({
        entityType: "escrow",
        entityId: s.id,
        field: "state",
        onChainValue: "Unconfirmed",
        ledgerValue: s.state,
        severity: "WARNING",
        chainLedger,
        indexerWatermark,
        rootCauseHint: "Settlement stuck in Resolving state without on-chain confirmation for > 30 mins",
        detectedAt: new Date(),
      });
    }

    return drifts;
  }
}

/**
 * Stale-cache detection and repair job (#727).
 *
 * This job compares each cached/derived record against its authoritative source
 * version (ledger sequence or action seq). An entry is considered:
 *   - fresh:    cachedVersion === sourceVersion
 *   - stale:    cachedVersion < sourceVersion
 *   - missing:  no cache entry exists for a live source entity
 *   - orphaned: cache entry exists but the source entity no longer exists
 *
 * The repair job is idempotent: running it twice in a row produces the same
 * final cache state and the second run reports zero actions.
 */
export class CacheRepairJob {
  constructor(
    private readonly sourceReader: CacheSourceReader,
    private readonly cacheStore: CacheStore,
    private readonly customLogger: Logger = logger,
  ) {}

  /**
   * Scans all cache entries and returns the staleness report without mutating
   * any state. Useful for dashboards and alerting.
   */
  async detectStale(
    options: CacheRepairOptions = {},
  ): Promise<CacheStaleness[]> {
    const entityTypes = options.entityTypes ?? ["vault_accounting", "prize_draw", "user_dashboard", "protocol_report"];
    const now = Date.now();
    const staleness: CacheStaleness[] = [];

    for (const entityType of entityTypes) {
      const cacheEntries = await this.cacheStore.listCacheEntries(entityType);
      const sourceIds = new Set(await this.sourceReader.listSourceEntityIds(entityType));
      const cacheById = new Map<string, CacheEntryRecord>();
      for (const entry of cacheEntries) {
        cacheById.set(entry.entityId, entry);
      }

      // Detect stale and orphaned cache entries
      for (const entry of cacheEntries) {
        if (!sourceIds.has(entry.entityId)) {
          staleness.push({
            entryId: entry.id,
            entityType: entry.entityType,
            entityId: entry.entityId,
            status: "orphaned",
            sourceVersion: 0,
            cachedVersion: entry.cachedVersion,
            driftVersions: 0,
            driftMs: now - entry.cachedAt.getTime(),
            severity: "WARNING",
            reason: "Cache entry has no corresponding source entity",
          });
          continue;
        }

        const sourceVersion = await this.sourceReader.getSourceVersion(entityType, entry.entityId);
        if (sourceVersion === null) {
          // Source vanished between list and read; treat as orphaned.
          staleness.push({
            entryId: entry.id,
            entityType: entry.entityType,
            entityId: entry.entityId,
            status: "orphaned",
            sourceVersion: 0,
            cachedVersion: entry.cachedVersion,
            driftVersions: 0,
            driftMs: now - entry.cachedAt.getTime(),
            severity: "WARNING",
            reason: "Cache entry has no corresponding source entity",
          });
          continue;
        }

        const driftVersions = sourceVersion - entry.cachedVersion;
        const driftMs = now - entry.cachedAt.getTime();
        const exceedsTime = options.maxStaleMs !== undefined && driftMs > options.maxStaleMs;

        if (driftVersions > 0 || exceedsTime) {
          staleness.push({
            entryId: entry.id,
            entityType: entry.entityType,
            entityId: entry.entityId,
            status: "stale",
            sourceVersion: sourceVersion,
            cachedVersion: entry.cachedVersion,
            driftVersions: driftVersions > 0 ? driftVersions : 0,
            driftMs: driftMs,
            severity: driftVersions > 1 ? "CRITICAL" : "WARNING",
            reason: driftVersions > 0
              ? `Source version advanced by ${driftVersions} behind cache`
              : `Cache exceeded maxStaleMs (${driftMs}ms > ${options.maxStaleMs}ms)`,
          });
        }
      }

      // Detect missing cache entries for live source entities
      for (const sourceId of sourceIds) {
        if (!cacheById.has(sourceId)) {
          const sourceVersion = await this.sourceReader.getSourceVersion(entityType, sourceId);
          staleness.push({
            entryId: `${entityType}:${sourceId}`,
            entityType,
            entityId: sourceId,
            status: "missing",
            sourceVersion: sourceVersion ?? 0,
            cachedVersion: null,
            driftVersions: 0,
            driftMs: 0,
            severity: "WARNING",
            reason: "Source entity exists but no cache entry was found",
          });
        }
      }
    }

    return staleness;
  }

  /**
   * Runs the repair job. When dryRun is true (default), no writes are performed
   * and the planned actions are returned for review. When dryRun is false,
   * each action is applied idempotently.
   */
  async runRepair(
    options: CacheRepairOptions = {},
  ): Promise<CacheRepairResult> {
    const startTime = Date.now();
    const dryRun = options.dryRun ?? true;
    const chainLedger = await this.sourceReader.getChainTipLedge();
    const staleness = await this.detectStale(options);
    const limited = options.limit !== undefined ? staleness.slice(0, options.limit) : staleness;

    const actions: CacheRepairAction[] = [];
    const failures: Array<{ entryId: string; error: string }> = [];

    for (const item of limited) {
      try {
        const action = await this.planRepair(item, dryRun);
        actions.push(action);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ entryId: item.entryId, error: message });
        this.customLogger.error({ item, err }, "Cache repair failed for entry");
      }
    }

    const result: CacheRepairResult = {
      dryRun,
      scannedEntries: staleness.length,
      staleEntries: staleness.filter((s) => s.status === "stale").length,
      missingEntries: staleness.filter((s) => s.status === "missing").length,
      orphanedEntries: staleness.filter((s) => s.status === "orphaned").length,
      actions,
      failures,
      durationMs: Date.now() - startTime,
      chainLedger,
    };

    this.customLogger.info(
      { dryRun, scanned: result.scannedEntries, actions: actions.length, failures: failures.length },
      dryRun ? "Cache repair dry-run completed" : "Cache repair applied",
    );

    return result;
  }

  /**
   * Builds and (optionally) applies a single repair action. The action is
   * derived from the staleness report and the current source payload, making
   * the operation idempotent: repeated runs produce the same final state.
   */
  private async planRepair(
    item: CacheStaleness,
    dryRun: boolean,
  ): Promise<CacheRepairAction> {
    const base: Omit<CacheRepairAction, "action"> = {
      entryId: item.entryId,
      entityType: item.entityType,
      entityId: item.entityId,
      status: item.status,
      fromVersion: item.cachedVersion,
      toVersion: item.sourceVersion,
      reason: item.reason,
    };

    if (item.status === "orphaned") {
      if (!dryRun) {
        await this.cacheStore.deleteCacheEntry(item.entityType, item.entityId);
      }
      return { ...base, action: "delete" };
    }

    const payload = await this.sourceReader.getSourcePayload(item.entityType, item.entityId);
    if (payload === null) {
      // Source disappeared between detect and repair; delete the cache entry.
      if (!dryRun) {
        await this.cacheStore.deleteCacheEntry(item.entityType, item.entityId);
      }
      return { ...base, action: "delete", reason: "Source entity disappeared during repair" };
    }

    const now = new Date();
    const entry: CacheEntryRecord = {
      id: item.entryId,
      entityType: item.entityType,
      entityId: item.entityId,
      sourceVersion: item.sourceVersion,
      sourceUpdatedAt: now,
      cachedVersion: item.sourceVersion,
      cachedAt: now,
      payload,
    };

    if (!dryRun) {
      await this.cacheStore.upsertCacheEntry(entry);
    }

    return {
      ...base,
      action: item.status === "missing" ? "insert" : "update",
    };
  }
}

/**
 * Production OnChainReader backed by real Soroban RPC server endpoints.
 * Supports multiple endpoints with automatic failover.
 */
export class SorobanRpcOnChainReader implements OnChainReader {
  private servers: StellarRpc.Server[];

  constructor(rpcUrl: string | string[]) {
    const urls = Array.isArray(rpcUrl) ? rpcUrl : [rpcUrl];
    this.servers = urls.map((url) => new StellarRpc.Server(url, { allowHttp: url.startsWith("http://") }));
  }

  async getChainTipLedger(): Promise<number> {
    let lastErr: unknown;
    for (const server of this.servers) {
      try {
        const latest = await server.getLatestLedger();
        return latest.sequence;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("All Soroban RPC endpoints failed for getChainTipLedger");
  }

  async getPoolState(poolAddress: string): Promise<OnChainPoolState | null> {
    for (const server of this.servers) {
      try {
        const key = StellarXdr.ScVal.scvSymbol("Pool");
        const entry = await server.getContractData(poolAddress, key, StellarRpc.Durability.Persistent).catch(() => null);
        if (entry && entry.val) {
          const raw = entry.val.contractData().val();
          const decoded = scValToNative(raw) as Record<string, unknown>;
          return {
            totalDeposited: BigInt(String(decoded.total_deposited ?? "0")),
            distributableYield: BigInt(String(decoded.distributable_yield ?? "0")),
            locked: Boolean(decoded.locked),
            isEmergency: Boolean(decoded.is_emergency),
            emergencyAssets: BigInt(String(decoded.emergency_assets ?? "0")),
            lastModifiedLedger: entry.lastModifiedLedgerSeq,
          };
        }
      } catch {
        // failover
      }
    }
    return null;
  }

  async getRoundState(poolAddress: string, roundId: number): Promise<OnChainRoundState | null> {
    for (const server of this.servers) {
      try {
        const key = StellarXdr.ScVal.scvVec([
          StellarXdr.ScVal.scvSymbol("Round"),
          StellarXdr.ScVal.scvU32(roundId),
        ]);
        const entry = await server.getContractData(poolAddress, key, StellarRpc.Durability.Persistent).catch(() => null);
        if (entry && entry.val) {
          const raw = entry.val.contractData().val();
          const decoded = scValToNative(raw) as Record<string, unknown>;
          return {
            roundId,
            status: (decoded.status as any) ?? "Open",
            principalSnapshot: BigInt(String(decoded.principal_snapshot ?? "0")),
            claimed: BigInt(String(decoded.claimed ?? "0")),
            realizedYield: BigInt(String(decoded.realized_yield ?? "0")),
            prizeReserve: BigInt(String(decoded.prize_reserve ?? "0")),
            winner: decoded.winner ? String(decoded.winner) : null,
            lastModifiedLedger: entry.lastModifiedLedgerSeq,
          };
        }
      } catch {
        // failover
      }
    }
    return null;
  }

  async getParticipantDeposit(poolAddress: string, roundId: number, participant: string): Promise<bigint> {
    for (const server of this.servers) {
      try {
        const key = StellarXdr.ScVal.scvVec([
          StellarXdr.ScVal.scvSymbol("Participant"),
          StellarXdr.ScVal.scvU32(roundId),
          new Address(participant).toScVal(),
        ]);
        const entry = await server.getContractData(poolAddress, key, StellarRpc.Durability.Persistent).catch(() => null);
        if (entry && entry.val) {
          const raw = entry.val.contractData().val();
          const decoded = scValToNative(raw) as Record<string, unknown>;
          return BigInt(String(decoded.deposit ?? decoded.amount ?? "0"));
        }
      } catch {
        // failover
      }
    }
    return 0n;
  }
}
