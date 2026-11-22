import { Prisma, type PrismaClient, type SavedPool } from "@prisma/client";
import { IdempotencyService } from "./idempotencyService.js";
import { provenanceManager, type RecordProvenance } from "../../../lib/record-provenance.js";
import {
  resolveEdit,
  type EditResolution,
  type EditStamp,
  type FieldClocks,
  type FieldEdit
} from "../../../lib/conflict-resolver.js";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";

/**
 * Persists user-saved vault/pool references for quick access and watchlists.
 *
 * ## Wallet-scoping invariant
 *
 * Every record in the `SavedPool` table is keyed on `(walletAddress, poolId)`.
 * This composite unique key (enforced by the DB schema) guarantees:
 *
 * 1. **List isolation** — `listSavedPools(wallet)` only returns rows matching
 *    that exact wallet address. No cross-wallet leakage is possible at the
 *    query level.
 *
 * 2. **Delete isolation** — `unsavePool(wallet, poolId)` filters on both
 *    columns. A caller cannot remove another wallet's record by supplying a
 *    poolId that happens to match; the wallet address must also match.
 *
 * 3. **Shared pools** — Two wallets may independently save the same `poolId`.
 *    These are separate rows with independent lifecycles. Deleting one wallet's
 *    copy has no effect on the other wallet's copy.
 *
 * 4. **Cache / invalidation scope** — Any future in-memory or Redis cache
 *    MUST include the wallet address in the cache key
 *    (e.g. `saved-pools:<walletAddress>`). Flushing or evicting one wallet's
 *    cache entry MUST NOT flush entries for other wallets.
 *
 * These invariants are regression-tested in `tests/saved-pools-auth.spec.ts`.
 */

export interface SavedPoolInput {
  walletAddress: string;
  pool: {
    poolId: string;
    poolName: string;
    status: string;
    tvl: string;
    asset: string;
    participantCount: number;
    expectedYield: string;
    prize: string | null;
    opensAt: Date | null;
    locksAt: Date | null;
    drawsAt: Date | null;
  };
  idempotencyKey?: string;
  /** Trusted server-generated import metadata, never accepted from request rows. */
  provenance?: RecordProvenance;
}

export interface SavedPoolRecord {
  provenance?: RecordProvenance | null;
  id: string;
  walletAddress: string;
  poolId: string;
  poolName: string;
  status: string;
  tvl: string;
  asset: string;
  participantCount: number;
  expectedYield: string;
  prize: string | null;
  opensAt: Date | null;
  locksAt: Date | null;
  drawsAt: Date | null;
  /** #983: increments on every write that changes a field. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Client-editable fields; identity (wallet, poolId) and bookkeeping are not. */
export type EditablePoolFields = Omit<SavedPoolInput["pool"], "poolId">;

export interface SavedPoolEdit {
  walletAddress: string;
  poolId: string;
  baseVersion: number;
  stamp: EditStamp;
  changes: Partial<EditablePoolFields>;
}

export interface SavedPoolEditResult {
  record: SavedPoolRecord;
  resolution: EditResolution<EditablePoolFields>;
}

/** Stamp client id for `savePool`, which keeps its overwrite-everything contract. */
const UPSERT_CLIENT_ID = "server:upsert";

/** Compare-and-swap attempts before contention is reported to the caller. */
const MAX_WRITE_ATTEMPTS = 5;

function editableFields(pool: SavedPoolInput["pool"]): EditablePoolFields {
  const { poolId: _poolId, ...fields } = pool;
  return fields;
}

function versionedRecord(row: SavedPool) {
  return {
    values: {
      poolName: row.poolName,
      status: row.status,
      tvl: row.tvl,
      asset: row.asset,
      participantCount: row.participantCount,
      expectedYield: row.expectedYield,
      prize: row.prize,
      opensAt: row.opensAt,
      locksAt: row.locksAt,
      drawsAt: row.drawsAt
    },
    version: row.version,
    clocks: (row.fieldClocks ?? {}) as FieldClocks<EditablePoolFields>
  };
}

function isStaleVersionWrite(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

export type ListSavedPoolsResult = {
  items: SavedPoolRecord[];
  nextCursor: string | null;
};

/**
 * Manages saved pool records linked to user wallets.
 */
export class SavedPoolsService {
  /**
   * @param prisma - Prisma client for database access
   * @param cacheService - Optional cache service
   * @param categoriesCacheTtlSeconds - Optional cache TTL
   * @param idempotencyService - Idempotency service for replay protection
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cacheService?: unknown,
    private readonly categoriesCacheTtlSeconds?: number,
    private readonly idempotencyService?: IdempotencyService
  ) {}

  /**
   * Saves a pool reference for a wallet if not already saved.
   * If the pool already exists, it updates the pool details.
   *
   * @param input - Wallet and pool identifiers with full pool details
   * @returns The saved record and whether it was newly created
   */
  async savePool(input: SavedPoolInput): Promise<{ record: SavedPoolRecord; created: boolean }> {
    // Use idempotency if key is provided
    if (input.idempotencyKey && this.idempotencyService) {
      return this.idempotencyService.executeWithIdempotency(
        {
          key: input.idempotencyKey,
          operationType: "saved_pool",
          walletAddress: input.walletAddress,
        },
        () => this.savePoolImpl(input)
      );
    }

    return this.savePoolImpl(input);
  }

  /**
   * Internal implementation of savePool without idempotency
   */
  private async savePoolImpl(input: SavedPoolInput): Promise<{ record: SavedPoolRecord; created: boolean }> {
    const existing = await this.prisma.savedPool.findUnique({
      where: {
        walletAddress_poolId: {
          walletAddress: input.walletAddress,
          poolId: input.pool.poolId,
        },
      },
    });

    if (existing) {
      // Update existing pool with latest details. The upsert stays an
      // unconditional overwrite (its edit is based on the version it read),
      // but it is versioned and stamped (server time) like any edit, so a
      // concurrent PATCH /saved-pools/:poolId stamped earlier cannot undo it (#983).
      const written = await this.writeVersioned(
        input.walletAddress,
        input.pool.poolId,
        (row) => ({
          baseVersion: row.version,
          stamp: { at: Date.now(), clientId: UPSERT_CLIENT_ID },
          changes: editableFields(input.pool)
        }),
        (row) => {
          const prior = row.provenance as unknown as RecordProvenance | null;
          const provenance = prior
            ? provenanceManager.updateRecordPreservingProvenance(
                { id: row.id, provenance: prior }, {}, input.walletAddress,
              ).provenance
            : input.provenance;
          return provenance ? { provenance: provenance as unknown as Prisma.InputJsonValue } : {};
        },
      );
      if (written) return { record: written.record, created: false };
      // Deleted between the read and the write: fall through and re-create it.
    }

    const created = await this.prisma.savedPool.create({
      data: {
        ...(input.provenance ? { provenance: input.provenance as unknown as Prisma.InputJsonValue } : {}),
        walletAddress: input.walletAddress,
        poolId: input.pool.poolId,
        poolName: input.pool.poolName,
        status: input.pool.status,
        tvl: input.pool.tvl,
        asset: input.pool.asset,
        participantCount: input.pool.participantCount,
        expectedYield: input.pool.expectedYield,
        prize: input.pool.prize,
        opensAt: input.pool.opensAt,
        locksAt: input.pool.locksAt,
        drawsAt: input.pool.drawsAt,
      },
    });

    return { record: created as unknown as SavedPoolRecord, created: true };
  }

  /**
   * Applies a field-level edit from one of several clients (#983). Fields
   * the editor saw are overwritten; fields another client changed after
   * `baseVersion` are kept or replaced by the deterministic stamp order
   * (`lib/conflict-resolver.ts`). Returns null when the wallet has no such
   * saved pool. Re-sending the same edit is a no-op.
   */
  editPool(edit: SavedPoolEdit): Promise<SavedPoolEditResult | null> {
    return this.writeVersioned(edit.walletAddress, edit.poolId, () => ({
      baseVersion: edit.baseVersion,
      stamp: edit.stamp,
      changes: edit.changes
    }));
  }

  /**
   * Read → resolve → compare-and-swap on `version`. A concurrent writer
   * makes the conditional update miss (P2025); the edit is then resolved
   * again against the fresh row, so the outcome never depends on which
   * request reached the database first. O(k log k) per attempt for k
   * changed fields, at most MAX_WRITE_ATTEMPTS attempts.
   *
   * `extraData` marks an unconditional write (the upsert): it always writes,
   * even when no field changed, as `savePool` always has.
   */
  private async writeVersioned(
    walletAddress: string,
    poolId: string,
    buildEdit: (row: SavedPool) => FieldEdit<EditablePoolFields>,
    extraData?: (row: SavedPool) => Prisma.SavedPoolUpdateInput,
  ): Promise<SavedPoolEditResult | null> {
    for (let attempt = 1; ; attempt++) {
      const row = await this.prisma.savedPool.findUnique({
        where: { walletAddress_poolId: { walletAddress, poolId } },
      });
      if (!row) return null;

      const resolution = resolveEdit(versionedRecord(row), buildEdit(row));
      if (resolution.applied.length === 0 && !extraData) {
        return { record: row as unknown as SavedPoolRecord, resolution };
      }

      const changed: Partial<EditablePoolFields> = {};
      for (const field of resolution.applied) {
        (changed as Record<string, unknown>)[field] = resolution.values[field];
      }
      try {
        const updated = await this.prisma.savedPool.update({
          where: { walletAddress_poolId: { walletAddress, poolId }, version: row.version },
          data: {
            ...extraData?.(row),
            ...changed,
            version: resolution.version,
            fieldClocks: resolution.clocks as unknown as Prisma.InputJsonValue,
          },
        });
        return { record: updated as unknown as SavedPoolRecord, resolution };
      } catch (err) {
        if (!isStaleVersionWrite(err)) throw err;
        if (attempt === MAX_WRITE_ATTEMPTS) {
          throw AppError.conflict(
            ERROR_CODES.CONFLICT,
            "the saved pool kept changing while this edit was applied; refresh and retry",
          );
        }
      }
    }
  }

  /**
   * Looks up existing saved pools for a wallet by external pool id.
   * Read-only; used by the import pipeline's dry run.
   */
  async findByPoolIds(walletAddress: string, poolIds: string[]): Promise<SavedPoolRecord[]> {
    if (poolIds.length === 0) return [];
    const rows = await this.prisma.savedPool.findMany({
      where: { walletAddress, poolId: { in: poolIds } },
    });
    return rows as unknown as SavedPoolRecord[];
  }

  /**
   * Removes a saved pool reference for a wallet.
   *
   * @param walletAddress - Wallet identifier
   * @param poolId - Pool identifier
   * @returns Number of records removed
   */
  async unsavePool(walletAddress: string, poolId: string): Promise<number> {
    const result = await this.prisma.savedPool.deleteMany({
      where: { walletAddress, poolId },
    });
    return result.count;
  }

  /**
   * Lists saved pools for a wallet with cursor-based pagination.
   *
   * @param walletAddress - Wallet identifier
   * @param cursor - Optional cursor for pagination
   * @param limit - Maximum number of records to return
   * @returns Saved pool records with next cursor
   */
  async listSavedPools(
    walletAddress: string,
    cursor?: string | null,
    limit: number = 25
  ): Promise<ListSavedPoolsResult> {
    const rows = await this.prisma.savedPool.findMany({
      where: { walletAddress },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor != null ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return { items: items as unknown as SavedPoolRecord[], nextCursor };
  }
}
