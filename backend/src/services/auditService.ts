import type { PrismaClient, ProtocolAudit } from "@prisma/client";

export type CreateAuditInput = {
  parameterName: string;
  previousValue: unknown;
  newValue: unknown;
  actor: string;
  txHash?: string;
};

export type ListAuditsParams = {
  parameterName?: string;
  actor?: string;
  cursor?: string | null;
  limit: number;
};

export type ListAuditsResult = {
  items: ProtocolAudit[];
  nextCursor: string | null;
};

/**
 * Manual repair audit types.
 *
 * Repair audit records are stored in the existing ProtocolAudit table using a
 * dedicated namespace prefix so they are queryable without a schema migration.
 * The payload is a structured JSON object that includes the repair class, the
 * target identifier, and the applied changes.
 */
export const REPAIR_AUDIT_PREFIX = "repair:";

export type RepairClass =
  | "vault_balance_mismatch"
  | "prize_draw_state_mismatch"
  | "wallet_balance_mismatch";

export type RepairAuditPayload = {
  repairClass: RepairClass;
  targetId: string;
  applied: boolean;
  changes: Array<{
    field: string;
    previousValue: unknown;
    newValue: unknown;
  }>;
};

export type RepairAuditInput = {
  repairClass: RepairClass;
  targetId: string;
  applied: boolean;
  changes: RepairAuditPayload["changes"];
  actor: string;
  txHash?: string;
};

export class AuditService {
  constructor(private readonly prisma: PrismaClient) {}

  async record(input: CreateAuditInput): Promise<ProtocolAudit> {
    const record = await this.prisma.protocolAudit.create({
      data: {
        parameterName: input.parameterName,
        previousValue: input.previousValue as object,
        newValue: input.newValue as object,
        actor: input.actor,
        txHash: input.txHash ?? null,
      },
    });
    return record;
  }

  /**
   * Record a manual repair audit entry. Dry-run attempts are recorded with
   * `applied: false` so operators can inspect the intended changes later.
   */
  async recordRepair(input: RepairAuditInput): Promise<ProtocolAudit> {
    const payload: RepairAuditPayload = {
      repairClass: input.repairClass,
      targetId: input.targetId,
      applied: input.applied,
      changes: input.changes,
    };

    const record = await this.prisma.protocolAudit.create({
      data: {
        parameterName: `${REPAIR_AUDIT_PREFIX}${input.repairClass}`,
        previousValue: payload as unknown as object,
        newValue: payload as unknown as object,
        actor: input.actor,
        txHash: input.txHash ?? null,
      },
    });
    return record;
  }

  async list(params: ListAuditsParams): Promise<ListAuditsResult> {
    const { parameterName, actor, cursor, limit } = params;

    const where = {
      ...(parameterName !== undefined ? { parameterName } : {}),
      ...(actor !== undefined ? { actor } : {}),
    };

    const rows = await this.prisma.protocolAudit.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor != null ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return { items, nextCursor };
  }

  /**
   * List repair audit records only, optionally filtered by repair class.
   */
  async listRepairs(params: {
    repairClass?: RepairClass;
    cursor?: string | null;
    limit: number;
  }): Promise<ListAuditsResult> {
    const { repairClass, cursor, limit } = params;

    const where = repairClass
      ? { parameterName: `${REPAIR_AUDIT_PREFIX}${repairClass}` }
      : { parameterName: { startsWith: REPAIR_AUDIT_PREFIX } };

    const rows = await this.prisma.protocolAudit.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor != null ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return { items, nextCursor };
  }
}
