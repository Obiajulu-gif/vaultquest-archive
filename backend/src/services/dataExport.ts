import { createHash } from "node:crypto";
import { AppError } from "../errors.js";
import { hasPermission } from "../../../lib/rbac.js";
import type { Principal } from "../middleware/rbac.js";
import type { ActionRecord } from "../types.js";
import type { SavedPoolRecord } from "./savedPools.js";

/** Bump the major version on any breaking change to the exported record shapes. */
export const EXPORT_SCHEMA_VERSION = "1.0.0";
/** Hard cap per section so a single request can't page an unbounded table. */
export const EXPORT_MAX_RECORDS = 10_000;
/** Exports are generated on demand and never stored; consumers must discard them after this window. */
export const EXPORT_RETENTION_HOURS = 24;
const PAGE_SIZE = 500;

export const EXPORT_SECTIONS = ["actions", "saved_pools"] as const;
export type ExportSection = (typeof EXPORT_SECTIONS)[number];

type Page<T> = { items: T[]; nextCursor: string | null };

/** Narrow read port so the service is testable without a database. */
export interface ExportSource {
  listActions(params: { walletAddress: string; cursor: string | null; limit: number }): Promise<Page<ActionRecord>>;
  listSavedPools(walletAddress: string, cursor: string | null, limit: number): Promise<Page<SavedPoolRecord>>;
}

export type ExportRequest = {
  principal: Principal;
  /** Wallet to export; defaults to the caller's own wallet. */
  wallet?: string;
  sections?: readonly ExportSection[];
  now?: Date;
  maxRecords?: number;
};

export type ExportBundle = {
  metadata: {
    schema_version: string;
    generated_at: string;
    expires_at: string;
    retention_hours: number;
    wallet: string;
    generated_by_role: string;
    sections: ExportSection[];
    record_counts: Record<string, number>;
    truncated: boolean;
    max_records_per_section: number;
    checksum: string;
  };
  data: Partial<Record<ExportSection, unknown[]>>;
};

/**
 * Privacy-safe projections: an explicit allowlist of fields. Internal
 * identifiers (idempotency keys, correlation ids, worker ids), free-form
 * payloads and error details are intentionally left out.
 */
function projectAction(r: ActionRecord) {
  const payload = (r.actionPayload as Record<string, unknown> | null) ?? {};
  return {
    id: r.id,
    date: r.createdAt.toISOString(),
    action_type: r.actionType,
    pool_id: String(payload["vault_id"] ?? payload["pool_id"] ?? ""),
    asset: String(payload["token"] ?? payload["asset"] ?? ""),
    amount: String(payload["amount"] ?? ""),
    status: r.status,
    tx_hash: r.txHash ?? "",
    error_code: r.errorCode ?? "",
    submitted_at: r.submittedAt?.toISOString() ?? "",
    confirmed_at: r.confirmedAt?.toISOString() ?? "",
  };
}

function projectSavedPool(r: SavedPoolRecord) {
  return {
    pool_id: r.poolId,
    pool_name: r.poolName,
    status: r.status,
    tvl: r.tvl,
    asset: r.asset,
    participant_count: r.participantCount,
    expected_yield: r.expectedYield,
    prize: r.prize,
    opens_at: r.opensAt?.toISOString() ?? null,
    locks_at: r.locksAt?.toISOString() ?? null,
    draws_at: r.drawsAt?.toISOString() ?? null,
  };
}

async function collect<T, U>(
  fetchPage: (cursor: string | null, limit: number) => Promise<Page<T>>,
  project: (row: T) => U,
  filter: (row: T) => boolean,
  max: number,
): Promise<{ rows: U[]; truncated: boolean }> {
  const rows: U[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await fetchPage(cursor, PAGE_SIZE);
    for (const item of page.items) {
      if (!filter(item)) continue;
      if (rows.length >= max) return { rows, truncated: true };
      rows.push(project(item));
    }
    if (!page.nextCursor) return { rows, truncated: false };
    cursor = page.nextCursor;
  }
}

export class DataExportService {
  constructor(private readonly source: ExportSource) {}

  /** Callers may export their own wallet; `admin.export.any` is required for anyone else's. */
  authorize(principal: Principal, wallet: string): void {
    if (principal.walletAddress && principal.walletAddress === wallet) return;
    if (hasPermission([principal.role], "admin.export.any")) return;
    throw AppError.forbidden("cannot export data outside your authorization scope");
  }

  async build(req: ExportRequest): Promise<ExportBundle> {
    const wallet = req.wallet ?? req.principal.walletAddress;
    if (!wallet) throw AppError.validation("wallet is required");
    this.authorize(req.principal, wallet);

    const sections = [...new Set(req.sections?.length ? req.sections : EXPORT_SECTIONS)];
    const max = req.maxRecords ?? EXPORT_MAX_RECORDS;
    const now = req.now ?? new Date();
    const data: ExportBundle["data"] = {};
    let truncated = false;

    if (sections.includes("actions")) {
      const r = await collect(
        (cursor, limit) => this.source.listActions({ walletAddress: wallet, cursor, limit }),
        projectAction,
        (row) => row.redactedAt === null || row.redactedAt === undefined, // scrubbed rows are never exported
        max,
      );
      data.actions = r.rows;
      truncated ||= r.truncated;
    }
    if (sections.includes("saved_pools")) {
      const r = await collect(
        (cursor, limit) => this.source.listSavedPools(wallet, cursor, limit),
        projectSavedPool,
        () => true,
        max,
      );
      data.saved_pools = r.rows;
      truncated ||= r.truncated;
    }

    const recordCounts = Object.fromEntries(sections.map((s) => [s, data[s]?.length ?? 0]));
    return {
      metadata: {
        schema_version: EXPORT_SCHEMA_VERSION,
        generated_at: now.toISOString(),
        expires_at: new Date(now.getTime() + EXPORT_RETENTION_HOURS * 3_600_000).toISOString(),
        retention_hours: EXPORT_RETENTION_HOURS,
        wallet,
        generated_by_role: req.principal.role,
        sections,
        record_counts: recordCounts,
        truncated,
        max_records_per_section: max,
        checksum: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
      },
      data,
    };
  }
}
