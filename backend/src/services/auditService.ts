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
}
