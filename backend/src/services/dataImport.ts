import { AppError } from "../errors.js";
import { savedPoolRecord } from "../schemas/savedPools.js";
import type { SavedPoolInput, SavedPoolRecord } from "./savedPools.js";

/** Supported import format version (matches the `saved_pools` export section). */
export const IMPORT_FORMAT_VERSION = "1.0.0";
export const IMPORT_MAX_ROWS = 1_000;

/** Narrow port over SavedPoolsService so dry runs can be proven write-free. */
export interface ImportTarget {
  findByPoolIds(walletAddress: string, poolIds: string[]): Promise<SavedPoolRecord[]>;
  savePool(input: SavedPoolInput): Promise<{ record: SavedPoolRecord; created: boolean }>;
}

export type ImportRowAction = "create" | "update" | "skip" | "error";

export type ImportRowResult = {
  /** Zero-based index into the submitted `records` array. */
  index: number;
  pool_id: string | null;
  action: ImportRowAction;
  reason?: "unchanged" | "duplicate_in_file" | "invalid" | "write_failed";
  errors?: string[];
};

export type ImportReport = {
  format_version: string;
  dry_run: boolean;
  wallet: string;
  summary: { total: number; create: number; update: number; skip: number; error: number };
  rows: ImportRowResult[];
  /** Present after a committed run: exactly how to undo it. */
  rollback?: {
    /** Pools this run created; remove them (DELETE /saved-pools/:poolId). */
    delete_pool_ids: string[];
    /** Pools this run overwrote; re-import these previous values to restore them. */
    restore_records: unknown[];
  };
};

type Parsed = ReturnType<typeof savedPoolRecord.parse>;

const toDate = (v: string | null | undefined) => (v ? new Date(v) : null);

function toInput(wallet: string, p: Parsed): SavedPoolInput {
  return {
    walletAddress: wallet,
    pool: {
      poolId: p.pool_id,
      poolName: p.pool_name,
      status: p.status,
      tvl: p.tvl,
      asset: p.asset,
      participantCount: p.participant_count,
      expectedYield: p.expected_yield,
      prize: p.prize ?? null,
      opensAt: toDate(p.opens_at),
      locksAt: toDate(p.locks_at),
      drawsAt: toDate(p.draws_at),
    },
  };
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

function unchanged(existing: SavedPoolRecord, p: Parsed): boolean {
  return (
    existing.poolName === p.pool_name &&
    existing.status === p.status &&
    existing.tvl === p.tvl &&
    existing.asset === p.asset &&
    existing.participantCount === p.participant_count &&
    existing.expectedYield === p.expected_yield &&
    (existing.prize ?? null) === (p.prize ?? null) &&
    iso(existing.opensAt) === iso(toDate(p.opens_at)) &&
    iso(existing.locksAt) === iso(toDate(p.locks_at)) &&
    iso(existing.drawsAt) === iso(toDate(p.draws_at))
  );
}

function projectRecord(r: SavedPoolRecord) {
  return {
    pool_id: r.poolId,
    pool_name: r.poolName,
    status: r.status,
    tvl: r.tvl,
    asset: r.asset,
    participant_count: r.participantCount,
    expected_yield: r.expectedYield,
    prize: r.prize,
    opens_at: iso(r.opensAt),
    locks_at: iso(r.locksAt),
    draws_at: iso(r.drawsAt),
  };
}

/**
 * Bulk import of a wallet's saved pools (#773).
 *
 * - `pool_id` is the external id: re-running the same import is idempotent
 *   (identical rows are `skip`ped, changed rows `update`d, new rows `create`d).
 * - A dry run classifies every row but performs no writes.
 * - Rows are validated and applied independently; one bad row never blocks or
 *   rolls back the others. The report says exactly what was applied and how
 *   to undo it, so partial imports are recoverable.
 * - Ledger actions are deliberately NOT importable: they are derived from
 *   on-chain events and imported rows could forge history.
 */
export class DataImportService {
  constructor(private readonly target: ImportTarget) {}

  async run(input: { wallet: string; records: unknown[]; dryRun: boolean }): Promise<ImportReport> {
    const { wallet, records, dryRun } = input;
    if (records.length > IMPORT_MAX_ROWS) {
      throw AppError.validation(`too many records (max ${IMPORT_MAX_ROWS})`);
    }

    const rows: ImportRowResult[] = new Array(records.length);
    const valid: { index: number; parsed: Parsed }[] = [];
    const seen = new Set<string>();

    records.forEach((raw, index) => {
      const result = savedPoolRecord.safeParse(raw);
      if (!result.success) {
        const poolId = (raw as { pool_id?: unknown } | null)?.pool_id;
        rows[index] = {
          index,
          pool_id: typeof poolId === "string" ? poolId : null,
          action: "error",
          reason: "invalid",
          errors: result.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`),
        };
        return;
      }
      const poolId = result.data.pool_id;
      if (seen.has(poolId)) {
        rows[index] = { index, pool_id: poolId, action: "skip", reason: "duplicate_in_file" };
        return;
      }
      seen.add(poolId);
      valid.push({ index, parsed: result.data });
    });

    const existing = new Map(
      (await this.target.findByPoolIds(wallet, valid.map((v) => v.parsed.pool_id))).map((r) => [r.poolId, r]),
    );

    const created: string[] = [];
    const restore: unknown[] = [];

    for (const { index, parsed } of valid) {
      const prior = existing.get(parsed.pool_id);
      if (prior && unchanged(prior, parsed)) {
        rows[index] = { index, pool_id: parsed.pool_id, action: "skip", reason: "unchanged" };
        continue;
      }
      const action: ImportRowAction = prior ? "update" : "create";
      if (dryRun) {
        rows[index] = { index, pool_id: parsed.pool_id, action };
        continue;
      }
      try {
        await this.target.savePool(toInput(wallet, parsed));
        rows[index] = { index, pool_id: parsed.pool_id, action };
        if (prior) restore.push(projectRecord(prior));
        else created.push(parsed.pool_id);
      } catch {
        rows[index] = {
          index,
          pool_id: parsed.pool_id,
          action: "error",
          reason: "write_failed",
          errors: ["A database error occurred"],
        };
      }
    }

    const summary = { total: records.length, create: 0, update: 0, skip: 0, error: 0 };
    for (const r of rows) summary[r.action] += 1;

    return {
      format_version: IMPORT_FORMAT_VERSION,
      dry_run: dryRun,
      wallet,
      summary,
      rows,
      ...(dryRun ? {} : { rollback: { delete_pool_ids: created, restore_records: restore } }),
    };
  }
}
