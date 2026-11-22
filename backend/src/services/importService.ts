/**
 * Secure import pipeline (#imports)
 *
 * A two-phase pipeline for operator-supplied data (currently prize-round
 * winners):
 *
 *   preview  → parse, validate, quarantine unsafe rows, write nothing else
 *   commit   → apply accepted rows as traceable ledger intents
 *   rollback → cancel not-yet-broadcast intents and report blocked rows
 *
 * Guarantees:
 * - preview never mutates business data; it only records the batch and rows;
 * - every row is either `accepted` (and later `applied`) or `quarantined`
 *   with a machine-readable reason — quarantined rows are never applied;
 * - applied rows carry the created action id (`applied_ref`) plus
 *   `import_batch_id` provenance in the action payload, so an auditor can
 *   walk from CSV row → action → on-chain event;
 * - commit is idempotent per row (stable `import:{batch}:{row}` idempotency
 *   keys), so retrying a partially-failed commit can never duplicate work;
 * - rollback is retry-safe and never claims more than it did — actions that
 *   already reached the chain are reported as `rollback_blocked` instead.
 *
 * Operational guidance lives in `docs/IMPORT_PIPELINE.md`.
 */

import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import { parseCsv } from "./csv.js";
import type { LedgerService } from "./ledger.js";

export const IMPORT_KINDS = ["prize_winners"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const IMPORT_LIMITS = {
  maxRows: 1000,
  maxContentBytes: 512 * 1024,
  maxSampleRows: 20,
  maxCellChars: 200
} as const;

export type ImportQuarantineReason =
  | "missing_column"
  | "unexpected_cell"
  | "empty_field"
  | "invalid_vault_id"
  | "invalid_wallet"
  | "invalid_amount"
  | "invalid_token"
  | "invalid_round"
  | "duplicate_row"
  | "unsafe_content"
  | "commit_failed";

export type ImportRowView = {
  row_number: number;
  status: string;
  quarantine_reason: string | null;
  quarantine_detail: string | null;
  payload: unknown;
  applied_ref: string | null;
};

export type ImportBatchView = {
  id: string;
  kind: string;
  status: string;
  source_name: string | null;
  content_hash: string;
  created_by: string;
  created_at: Date;
  committed_at: Date | null;
  rolled_back_at: Date | null;
  total_rows: number;
  accepted_rows: number;
  quarantined_rows: number;
  applied_rows: number;
  rolled_back_rows: number;
  rows?: ImportRowView[];
  rows_truncated?: boolean;
  next_actions?: string[];
};

const PRIZE_WINNERS_COLUMNS = [
  "vault_id",
  "wallet_address",
  "winner_wallet",
  "amount",
  "token",
  "round"
] as const;

const VAULT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STELLAR_WALLET_RE = /^G[A-Z0-9]{55}$/;
const UNSIGNED_INT_RE = /^[0-9]{1,18}$/;
const TOKEN_RE = /^[A-Z0-9]{1,12}$/;
const ROUND_RE = /^[1-9][0-9]{0,8}$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
const UNSAFE_CONTENT_RE = /[\u0000-\u001F\u007F]|^[=+\-@]/;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function columnsForKind(kind: ImportKind): readonly string[] {
  switch (kind) {
    case "prize_winners":
      return PRIZE_WINNERS_COLUMNS;
  }
}

type RowValidation =
  | { ok: true; payload: Record<string, string> }
  | { ok: false; reason: ImportQuarantineReason; detail: string };

function validatePrizeWinnerRow(
  cells: string[],
  headerIndex: Map<string, number>,
  seenKeys: Set<string>
): RowValidation {
  if (cells.length > headerIndex.size) {
    return {
      ok: false,
      reason: "unexpected_cell",
      detail: `row has ${cells.length} cells but the header defines ${headerIndex.size} columns`
    };
  }
  if (cells.length < headerIndex.size) {
    return {
      ok: false,
      reason: "missing_column",
      detail: `row has ${cells.length} cells but the header defines ${headerIndex.size} columns`
    };
  }

  const value = (column: string): string => {
    const position = headerIndex.get(column);
    return position === undefined ? "" : (cells[position] ?? "").trim();
  };

  const values: Record<string, string> = {};
  for (const column of PRIZE_WINNERS_COLUMNS) {
    const raw = value(column);
    if (raw.length === 0) {
      return { ok: false, reason: "empty_field", detail: `${column} is empty` };
    }
    if (raw.length > IMPORT_LIMITS.maxCellChars) {
      return {
        ok: false,
        reason: "unsafe_content",
        detail: `${column} exceeds ${IMPORT_LIMITS.maxCellChars} characters`
      };
    }
    if (UNSAFE_CONTENT_RE.test(raw)) {
      return {
        ok: false,
        reason: "unsafe_content",
        detail: `${column} contains control characters or spreadsheet formula syntax`
      };
    }
    values[column] = raw;
  }

  const vaultId = values["vault_id"] as string;
  const wallet = values["wallet_address"] as string;
  const winner = values["winner_wallet"] as string;
  const amount = values["amount"] as string;
  const token = values["token"] as string;
  const round = values["round"] as string;

  if (!VAULT_ID_RE.test(vaultId)) {
    return { ok: false, reason: "invalid_vault_id", detail: `vault_id "${truncate(vaultId, 40)}" is invalid` };
  }
  if (!STELLAR_WALLET_RE.test(wallet)) {
    return { ok: false, reason: "invalid_wallet", detail: "wallet_address must be a Stellar address (G...)" };
  }
  if (!STELLAR_WALLET_RE.test(winner)) {
    return { ok: false, reason: "invalid_wallet", detail: "winner_wallet must be a Stellar address (G...)" };
  }
  if (!UNSIGNED_INT_RE.test(amount) || BigInt(amount) <= 0n) {
    return { ok: false, reason: "invalid_amount", detail: "amount must be a positive integer string" };
  }
  if (!TOKEN_RE.test(token)) {
    return { ok: false, reason: "invalid_token", detail: "token must match [A-Z0-9]{1,12}" };
  }
  if (!ROUND_RE.test(round)) {
    return { ok: false, reason: "invalid_round", detail: "round must be a positive integer" };
  }

  const dedupeKey = `${vaultId}:${round}:${winner}`;
  if (seenKeys.has(dedupeKey)) {
    return { ok: false, reason: "duplicate_row", detail: `duplicate of an earlier ${dedupeKey} row` };
  }
  seenKeys.add(dedupeKey);

  return { ok: true, payload: values };
}

export class ImportService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ledger: LedgerService
  ) {}

  async preview(input: {
    kind: ImportKind;
    content: string;
    sourceName?: string;
    createdBy: string;
    idempotencyKey?: string;
  }): Promise<{ batch: ImportBatchView; created: boolean }> {
    const bytes = Buffer.byteLength(input.content, "utf8");
    if (bytes === 0) throw AppError.validation("content must not be empty");
    if (bytes > IMPORT_LIMITS.maxContentBytes) {
      throw AppError.validation(`content exceeds ${IMPORT_LIMITS.maxContentBytes} bytes`);
    }

    const contentHash = sha256(input.content);
    const idempotencyKey = input.idempotencyKey ?? randomUUID();

    const existing = await this.prisma.importBatch.findUnique({ where: { idempotencyKey } });
    if (existing) {
      if (existing.contentHash !== contentHash || existing.kind !== input.kind) {
        throw AppError.conflict(
          ERROR_CODES.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
          "import idempotency key reused with different content"
        );
      }
      const batch = await this.view(existing.id);
      if (!batch) throw AppError.notFound(`import batch ${existing.id} not found`);
      return { batch, created: false };
    }

    const parsed = parseCsv(input.content, { maxRows: IMPORT_LIMITS.maxRows });
    if (parsed.error) {
      throw AppError.validation(`invalid CSV: ${parsed.error}`);
    }
    if (parsed.rows.length > IMPORT_LIMITS.maxRows) {
      throw AppError.validation(`import exceeds ${IMPORT_LIMITS.maxRows} rows`);
    }

    const expected = columnsForKind(input.kind);
    const missing = expected.filter((column) => !parsed.headers.includes(column));
    const unknown = parsed.headers.filter((header) => !expected.includes(header));
    if (missing.length > 0 || unknown.length > 0) {
      throw AppError.validation(
        `invalid header; expected columns: ${expected.join(", ")}` +
          (missing.length > 0 ? `; missing: ${missing.join(", ")}` : "") +
          (unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : "")
      );
    }

    const headerIndex = new Map(parsed.headers.map((header, index) => [header, index] as const));
    const seenKeys = new Set<string>();
    const rowResults = parsed.rows.map((row) => ({
      row_number: row.row_number,
      validation: validatePrizeWinnerRow(row.cells, headerIndex, seenKeys)
    }));

    const acceptedCount = rowResults.filter((r) => r.validation.ok).length;
    const quarantinedCount = rowResults.length - acceptedCount;

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const batch = await tx.importBatch.create({
          data: {
            kind: input.kind,
            status: "preview",
            sourceName: input.sourceName ?? null,
            contentHash,
            idempotencyKey,
            createdBy: input.createdBy,
            totalRows: rowResults.length,
            acceptedRows: acceptedCount,
            quarantinedRows: quarantinedCount
          }
        });
        for (const result of rowResults) {
          await tx.importRow.create({
            data: {
              batchId: batch.id,
              rowNumber: result.row_number,
              status: result.validation.ok ? "accepted" : "quarantined",
              quarantineReason: result.validation.ok ? null : result.validation.reason,
              quarantineDetail: result.validation.ok ? null : result.validation.detail,
              payload: result.validation.ok
                ? (result.validation.payload as Prisma.InputJsonValue)
                : Prisma.JsonNull
            }
          });
        }
        return batch;
      });

      const batch = await this.view(created.id);
      if (!batch) throw AppError.notFound(`import batch ${created.id} not found`);
      return { batch, created: true };
    } catch (err) {
      // Idempotency race: another request created the same batch first.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const winner = await this.prisma.importBatch.findUnique({ where: { idempotencyKey } });
        if (winner && winner.contentHash === contentHash && winner.kind === input.kind) {
          const batch = await this.view(winner.id);
          if (!batch) throw AppError.notFound(`import batch ${winner.id} not found`);
          return { batch, created: false };
        }
      }
      throw err;
    }
  }

  async commit(batchId: string): Promise<{ batch: ImportBatchView; alreadyCommitted: boolean }> {
    const batch = await this.prisma.importBatch.findUnique({
      where: { id: batchId },
      include: { rows: { orderBy: { rowNumber: "asc" } } }
    });
    if (!batch) throw AppError.notFound(`import batch ${batchId} not found`);

    if (batch.status === "committed") {
      const view = await this.view(batchId);
      if (!view) throw AppError.notFound(`import batch ${batchId} not found`);
      return { batch: view, alreadyCommitted: true };
    }
    if (batch.status !== "preview") {
      throw AppError.conflict(
        ERROR_CODES.ILLEGAL_TRANSITION,
        `cannot commit import batch in status ${batch.status}`
      );
    }

    for (const row of batch.rows) {
      if (row.status !== "accepted") continue;
      const payload = (row.payload ?? {}) as Record<string, string>;
      try {
        const action = await this.ledger.createAction({
          walletAddress: payload["wallet_address"] ?? "",
          actionType: "select_winner",
          actionPayload: {
            vault_id: payload["vault_id"],
            winner_wallet: payload["winner_wallet"],
            amount: payload["amount"],
            token: payload["token"],
            round: payload["round"],
            origin: "import",
            import_batch_id: batch.id,
            import_row: row.rowNumber,
            ...(batch.sourceName ? { import_source: batch.sourceName } : {})
          },
          idempotencyKey: `import:${batch.id}:${row.rowNumber}`
        });
        await this.prisma.importRow.update({
          where: { id: row.id },
          data: {
            status: "applied",
            appliedRef: action.id,
            quarantineReason: null,
            quarantineDetail: null
          }
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Traceable failure: the row is quarantined with the commit error,
        // never silently dropped. A retried commit skips applied rows and
        // will not re-attempt quarantined ones.
        await this.prisma.importRow.update({
          where: { id: row.id },
          data: {
            status: "quarantined",
            quarantineReason: "commit_failed",
            quarantineDetail: truncate(message)
          }
        });
      }
    }

    const applied = await this.prisma.importRow.count({
      where: { batchId, status: "applied" }
    });
    const quarantined = await this.prisma.importRow.count({
      where: { batchId, status: "quarantined" }
    });

    await this.prisma.importBatch.update({
      where: { id: batchId },
      data: {
        status: "committed",
        committedAt: new Date(),
        appliedRows: applied,
        quarantinedRows: quarantined
      }
    });

    const view = await this.view(batchId);
    if (!view) throw AppError.notFound(`import batch ${batchId} not found`);
    return { batch: view, alreadyCommitted: false };
  }

  async rollback(batchId: string): Promise<{ batch: ImportBatchView; alreadyRolledBack: boolean }> {
    const batch = await this.prisma.importBatch.findUnique({
      where: { id: batchId },
      include: { rows: { orderBy: { rowNumber: "asc" } } }
    });
    if (!batch) throw AppError.notFound(`import batch ${batchId} not found`);

    if (batch.status === "rolled_back") {
      const view = await this.view(batchId);
      if (!view) throw AppError.notFound(`import batch ${batchId} not found`);
      return { batch: view, alreadyRolledBack: true };
    }
    if (batch.status !== "committed" && batch.status !== "partially_rolled_back") {
      throw AppError.conflict(
        ERROR_CODES.ILLEGAL_TRANSITION,
        `cannot roll back import batch in status ${batch.status}`
      );
    }

    for (const row of batch.rows) {
      if (row.status !== "applied") continue;
      const actionId = row.appliedRef;
      const action = actionId ? await this.ledger.getAction(actionId) : null;

      if (!action) {
        await this.prisma.importRow.update({
          where: { id: row.id },
          data: {
            status: "rolled_back",
            quarantineDetail: "action_missing_from_ledger"
          }
        });
        continue;
      }

      if (action.status !== "pending") {
        // Never pretend a broadcast/confirmed action was rolled back.
        await this.prisma.importRow.update({
          where: { id: row.id },
          data: {
            status: "rollback_blocked",
            quarantineDetail: `action already ${action.status}; reverse on-chain state manually`
          }
        });
        continue;
      }

      await this.ledger.cancelAction(
        action.id,
        ERROR_CODES.IMPORT_ROLLBACK,
        `import batch ${batch.id} rolled back`
      );
      await this.prisma.importRow.update({
        where: { id: row.id },
        data: { status: "rolled_back" }
      });
    }

    const rolledBack = await this.prisma.importRow.count({
      where: { batchId, status: "rolled_back" }
    });
    const blocked = await this.prisma.importRow.count({
      where: { batchId, status: "rollback_blocked" }
    });

    await this.prisma.importBatch.update({
      where: { id: batchId },
      data: {
        status: blocked > 0 ? "partially_rolled_back" : "rolled_back",
        rolledBackAt: new Date(),
        rolledBackRows: rolledBack
      }
    });

    const view = await this.view(batchId);
    if (!view) throw AppError.notFound(`import batch ${batchId} not found`);
    return { batch: view, alreadyRolledBack: false };
  }

  async cancel(
    batchId: string,
    caller?: { walletAddress?: string; role?: string }
  ): Promise<{ batch: ImportBatchView; alreadyCancelled: boolean }> {
    const batch = await this.prisma.importBatch.findUnique({
      where: { id: batchId },
      include: { rows: { orderBy: { rowNumber: "asc" } } }
    });
    if (!batch) throw AppError.notFound(`import batch ${batchId} not found`);

    if (caller && caller.role !== "maintainer" && caller.walletAddress && caller.walletAddress !== batch.createdBy) {
      throw AppError.forbidden("not authorized to cancel this import batch");
    }

    if (batch.status === "cancelled") {
      const view = await this.view(batchId);
      if (!view) throw AppError.notFound(`import batch ${batchId} not found`);
      return { batch: view, alreadyCancelled: true };
    }

    if (batch.status === "committed" || batch.status === "rolled_back" || batch.status === "partially_rolled_back") {
      throw AppError.conflict(
        ERROR_CODES.ILLEGAL_TRANSITION,
        `cannot cancel import batch in terminal or committed status ${batch.status}`
      );
    }

    // Cancel unapplied rows
    await this.prisma.importRow.updateMany({
      where: {
        batchId,
        status: { in: ["preview", "accepted"] }
      },
      data: {
        status: "quarantined",
        quarantineReason: "commit_failed",
        quarantineDetail: "import cancelled by client request before commit"
      }
    });

    await this.prisma.importBatch.update({
      where: { id: batchId },
      data: {
        status: "cancelled",
        rolledBackAt: new Date()
      }
    });

    const view = await this.view(batchId);
    if (!view) throw AppError.notFound(`import batch ${batchId} not found`);
    return { batch: view, alreadyCancelled: false };
  }

  async getBatch(batchId: string): Promise<ImportBatchView | null> {
    return this.view(batchId);
  }

  private async view(batchId: string): Promise<ImportBatchView | null> {
    const batch = await this.prisma.importBatch.findUnique({
      where: { id: batchId },
      include: { rows: { orderBy: { rowNumber: "asc" } } }
    });
    if (!batch) return null;

    const rows: ImportRowView[] = batch.rows.map((row) => ({
      row_number: row.rowNumber,
      status: row.status,
      quarantine_reason: row.quarantineReason,
      quarantine_detail: row.quarantineDetail,
      payload: row.payload,
      applied_ref: row.appliedRef
    }));

    return {
      id: batch.id,
      kind: batch.kind,
      status: batch.status,
      source_name: batch.sourceName,
      content_hash: batch.contentHash,
      created_by: batch.createdBy,
      created_at: batch.createdAt,
      committed_at: batch.committedAt,
      rolled_back_at: batch.rolledBackAt,
      total_rows: batch.totalRows,
      accepted_rows: batch.acceptedRows,
      quarantined_rows: batch.quarantinedRows,
      applied_rows: batch.appliedRows,
      rolled_back_rows: batch.rolledBackRows,
      rows,
      rows_truncated: false,
      next_actions: nextActionsForStatus(batch.status)
    };
  }
}

export function nextActionsForStatus(status: string): string[] {
  switch (status) {
    case "preview":
      return [
        "Review quarantined rows and re-upload a corrected file if needed.",
        "Commit the accepted rows: POST /internal/imports/:id/commit"
      ];
    case "committed":
      return [
        "Broadcast each select_winner action from the wallet UI, then PATCH /actions/:id/submitted.",
        "Roll back not-yet-broadcast rows: POST /internal/imports/:id/rollback"
      ];
    case "partially_rolled_back":
      return [
        "Some actions already reached the chain; reverse them on-chain manually and reconcile via the indexer.",
        "Re-run rollback after the indexer confirms the reversal."
      ];
    case "rolled_back":
      return ["No further action; re-upload a corrected file to start a new batch."];
    case "cancelled":
      return ["Import batch was cancelled. No actions were applied. Start a new batch if needed."];
    default:
      return [];
  }
}
