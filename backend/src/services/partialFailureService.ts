/**
 * Partial failure tracking service (#793).
 *
 * A "partial failure" is an operation that succeeded on one side but failed
 * on another — e.g. an action confirmed on-chain but never reflected in the
 * backend, a background job that completed locally but whose external call
 * (email, webhook, write to Stellar) failed, or a wallet flow that paid but
 * whose receipt was never issued.
 *
 * This service lets maintainers:
 *   - Record new partial failures as they are detected.
 *   - List / filter them by type, severity, age, and retryability.
 *   - Mark them retried, resolved, or manually ignored.
 *
 * Every state transition is audited. Secrets are never stored in `metadata`.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { sanitizeAuditState, type AuditActor, type AuditRecorder } from "./auditTrail.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export const PARTIAL_FAILURE_OPERATION_TYPES = [
  "background_job",
  "external_call",
  "on_chain",
  "wallet_flow",
] as const;
export type PartialFailureOperationType = (typeof PARTIAL_FAILURE_OPERATION_TYPES)[number];

export const PARTIAL_FAILURE_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type PartialFailureSeverity = (typeof PARTIAL_FAILURE_SEVERITIES)[number];

export const PARTIAL_FAILURE_STATES = ["unresolved", "retryable", "resolved", "ignored"] as const;
export type PartialFailureState = (typeof PARTIAL_FAILURE_STATES)[number];

export interface PartialFailureRecord {
  id: string;
  operationType: PartialFailureOperationType;
  operationId: string;
  externalRef: string | null;
  severity: PartialFailureSeverity;
  state: PartialFailureState;
  retryable: boolean;
  description: string;
  /** Sanitized metadata — no secrets. */
  metadata: Record<string, unknown> | null;
  detectedAt: Date;
  staleSinceAt: Date | null;
  lastRetriedAt: Date | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  ignoredAt: Date | null;
  ignoredBy: string | null;
  updatedAt: Date;
}

export interface RecordPartialFailureInput {
  operationType: PartialFailureOperationType;
  operationId: string;
  externalRef?: string | null;
  severity?: PartialFailureSeverity;
  retryable?: boolean;
  description: string;
  /** Must not contain secrets. Use sanitizeAuditState before passing. */
  metadata?: Record<string, unknown> | null;
  staleSinceAt?: Date | null;
}

export interface ListPartialFailuresQuery {
  operationType?: PartialFailureOperationType;
  severity?: PartialFailureSeverity;
  state?: PartialFailureState;
  retryable?: boolean;
  /** ISO lower bound on detectedAt (inclusive). */
  since?: string;
  limit?: number;
  cursor?: string | null;
}

export class PartialFailureError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "ILLEGAL_TRANSITION",
    message: string,
  ) {
    super(message);
    this.name = "PartialFailureError";
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class PartialFailureService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditRecorder,
  ) {}

  /** Records a failure once per operation, even when concurrent detectors report it. */
  async record(input: RecordPartialFailureInput): Promise<PartialFailureRecord> {
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtext(${input.operationType}), hashtext(${input.operationId}))::text AS locked
      `;
      const existing = await tx.partialFailure.findFirst({
        where: {
          operationType: input.operationType,
          operationId: input.operationId,
        },
        orderBy: [{ detectedAt: "asc" }, { id: "asc" }],
      });
      if (existing) return existing;
      return tx.partialFailure.create({ data: this.createData(input) });
    });
    return this.toRecord(row);
  }

  /** Creates a distinct failure record without operation-level deduplication. */
  async create(input: RecordPartialFailureInput): Promise<PartialFailureRecord> {
    const row = await this.prisma.partialFailure.create({
      data: this.createData(input),
    });
    return this.toRecord(row);
  }

  private createData(input: RecordPartialFailureInput): Prisma.PartialFailureCreateInput {
    const metadata =
      input.metadata == null
        ? undefined
        : sanitizeAuditState(input.metadata, "partial_failure.metadata").value;
    return {
      operationType: input.operationType,
      operationId: input.operationId,
      externalRef: input.externalRef ?? null,
      severity: input.severity ?? "medium",
      state: "unresolved",
      retryable: input.retryable ?? false,
      description: input.description,
      metadata: metadata as Prisma.InputJsonValue | undefined,
      staleSinceAt: input.staleSinceAt ?? null,
    };
  }

  /** List partial failures with cursor-based pagination (newest first). */
  async list(query: ListPartialFailuresQuery): Promise<{
    items: PartialFailureRecord[];
    nextCursor: string | null;
  }> {
    const limit = Math.min(query.limit ?? 50, 200);

    const where: Prisma.PartialFailureWhereInput = {};
    if (query.operationType) where["operationType"] = query.operationType;
    if (query.severity) where["severity"] = query.severity;
    if (query.state) where["state"] = query.state;
    if (typeof query.retryable === "boolean") where["retryable"] = query.retryable;
    if (query.since) where["detectedAt"] = { gte: new Date(query.since) };

    const rows = await this.prisma.partialFailure.findMany({
      where,
      orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(query.cursor != null ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return { items: items.map((r) => this.toRecord(r)), nextCursor };
  }

  /** Get a single partial failure by id. */
  async getById(id: string): Promise<PartialFailureRecord> {
    const row = await this.prisma.partialFailure.findUnique({ where: { id } });
    if (!row) throw new PartialFailureError("NOT_FOUND", `partial failure ${id} not found`);
    return this.toRecord(row);
  }

  /** Mark as retried (updates lastRetriedAt; state stays retryable or moves to resolved). */
  async markRetried(
    id: string,
    actor: AuditActor,
    outcome: "resolved" | "still_failing",
  ): Promise<PartialFailureRecord> {
    const existing = await this.getById(id);
    if (!["unresolved", "retryable"].includes(existing.state)) {
      throw new PartialFailureError(
        "ILLEGAL_TRANSITION",
        `cannot retry a failure in state '${existing.state}'`,
      );
    }

    const newState: PartialFailureState = outcome === "resolved" ? "resolved" : "retryable";
    const now = new Date();
    const row = await this.prisma.partialFailure.update({
      where: { id },
      data: {
        state: newState,
        lastRetriedAt: now,
        resolvedAt: newState === "resolved" ? now : undefined,
        resolvedBy: newState === "resolved" ? actor.subject : undefined,
      },
    });

    await this.audit.record({
      category: "recovery",
      action: `recovery.${outcome === "resolved" ? "resolve" : "retry"}`,
      actor,
      target: { type: "partial_failure", id },
      before: { state: existing.state },
      after: { state: newState, last_retried_at: now.toISOString() },
      reason: `Retry outcome: ${outcome}`,
    });

    return this.toRecord(row);
  }

  /** Manually resolve a partial failure. */
  async resolve(
    id: string,
    actor: AuditActor,
    resolutionNote: string,
  ): Promise<PartialFailureRecord> {
    const existing = await this.getById(id);
    if (existing.state === "resolved") {
      throw new PartialFailureError("ILLEGAL_TRANSITION", "already resolved");
    }

    const now = new Date();
    const row = await this.prisma.partialFailure.update({
      where: { id },
      data: {
        state: "resolved",
        resolvedAt: now,
        resolvedBy: actor.subject,
        resolutionNote,
      },
    });

    await this.audit.record({
      category: "recovery",
      action: "recovery.resolve",
      actor,
      target: { type: "partial_failure", id },
      reason: resolutionNote,
      before: { state: existing.state },
      after: { state: "resolved", resolved_at: now.toISOString() },
    });

    return this.toRecord(row);
  }

  /** Mark a partial failure as manually ignored (won't appear in the dashboard by default). */
  async ignore(
    id: string,
    actor: AuditActor,
    reason: string,
  ): Promise<PartialFailureRecord> {
    const existing = await this.getById(id);
    if (["resolved", "ignored"].includes(existing.state)) {
      throw new PartialFailureError(
        "ILLEGAL_TRANSITION",
        `cannot ignore a failure in state '${existing.state}'`,
      );
    }

    const now = new Date();
    const row = await this.prisma.partialFailure.update({
      where: { id },
      data: { state: "ignored", ignoredAt: now, ignoredBy: actor.subject },
    });

    await this.audit.record({
      category: "recovery",
      action: "recovery.escalate",
      actor,
      target: { type: "partial_failure", id },
      reason,
      before: { state: existing.state },
      after: { state: "ignored" },
    });

    return this.toRecord(row);
  }

  /** Aggregated summary counts grouped by severity and operation type. */
  async summary(): Promise<{
    total: number;
    by_severity: Record<string, number>;
    by_operation_type: Record<string, number>;
    stale_count: number;
    retryable_count: number;
  }> {
    const [bySeverity, byOperationType, stale, retryable] = await Promise.all([
      this.prisma.partialFailure.groupBy({
        by: ["severity"],
        where: { state: { in: ["unresolved", "retryable"] } },
        _count: { _all: true },
      }),
      this.prisma.partialFailure.groupBy({
        by: ["operationType"],
        where: { state: { in: ["unresolved", "retryable"] } },
        _count: { _all: true },
      }),
      this.prisma.partialFailure.count({
        where: {
          state: { in: ["unresolved", "retryable"] },
          staleSinceAt: { not: null },
        },
      }),
      this.prisma.partialFailure.count({
        where: { state: "retryable", retryable: true },
      }),
    ]);

    const by_severity = Object.fromEntries(bySeverity.map((row) => [row.severity, row._count._all]));
    const by_operation_type = Object.fromEntries(
      byOperationType.map((row) => [row.operationType, row._count._all]),
    );

    return {
      total: bySeverity.reduce((count, row) => count + row._count._all, 0),
      by_severity,
      by_operation_type,
      stale_count: stale,
      retryable_count: retryable,
    };
  }

  private toRecord(row: {
    id: string;
    operationType: string;
    operationId: string;
    externalRef: string | null;
    severity: string;
    state: string;
    retryable: boolean;
    description: string;
    metadata: unknown;
    detectedAt: Date;
    staleSinceAt: Date | null;
    lastRetriedAt: Date | null;
    resolvedAt: Date | null;
    resolvedBy: string | null;
    resolutionNote: string | null;
    ignoredAt: Date | null;
    ignoredBy: string | null;
    updatedAt: Date;
  }): PartialFailureRecord {
    return {
      id: row.id,
      operationType: row.operationType as PartialFailureOperationType,
      operationId: row.operationId,
      externalRef: row.externalRef,
      severity: row.severity as PartialFailureSeverity,
      state: row.state as PartialFailureState,
      retryable: row.retryable,
      description: row.description,
      metadata: (row.metadata as Record<string, unknown>) ?? null,
      detectedAt: row.detectedAt,
      staleSinceAt: row.staleSinceAt,
      lastRetriedAt: row.lastRetriedAt,
      resolvedAt: row.resolvedAt,
      resolvedBy: row.resolvedBy,
      resolutionNote: row.resolutionNote,
      ignoredAt: row.ignoredAt,
      ignoredBy: row.ignoredBy,
      updatedAt: row.updatedAt,
    };
  }
}
