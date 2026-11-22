import type { Prisma, PrismaClient } from "@prisma/client";
import { AppError } from "../errors.js";

export const PUBLIC_ACTIVITY_TYPES = ["deposit", "withdrawal", "prize_claim"] as const;
export type PublicActivityType = (typeof PUBLIC_ACTIVITY_TYPES)[number];

export type PublicActivityEvent = {
  id: string;
  type: PublicActivityType;
  status: "pending" | "submitted" | "confirmed" | "failed" | "reverted" | "orphaned";
  occurred_at: string;
  amount: string | null;
  asset: string | null;
  href: string;
  resource_href: string | null;
};

type ActivityCursor = { wallet: string; createdAt: string; id: string };

const PUBLIC_ACTION_TYPES = ["deposit", "withdraw", "claim"] as const;
const PUBLIC_TYPE_TO_ACTION: Record<PublicActivityType, (typeof PUBLIC_ACTION_TYPES)[number]> = {
  deposit: "deposit",
  withdrawal: "withdraw",
  prize_claim: "claim"
};

function encodeCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string, walletAddress: string): ActivityCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ActivityCursor>;
    const createdAt = new Date(parsed.createdAt ?? "");
    if (
      parsed.wallet !== walletAddress ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id) ||
      !Number.isFinite(createdAt.getTime())
    ) {
      throw new Error("invalid cursor fields");
    }
    return { wallet: walletAddress, createdAt: createdAt.toISOString(), id: parsed.id };
  } catch {
    throw AppError.validation("invalid activity cursor");
  }
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function publicAmount(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const amount = String(value).trim();
  return /^\d{1,30}(?:\.\d{1,18})?$/.test(amount) ? amount : null;
}

function publicAsset(payload: Record<string, unknown>): string | null {
  const value = payload.asset ?? payload.token;
  if (typeof value !== "string" || !/^[a-z0-9]{2,12}$/i.test(value)) return null;
  return value.toUpperCase();
}

function publicResourceHref(payload: Record<string, unknown>): string | null {
  const value = payload.vault_id ?? payload.pool_id;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const id = String(value);
  if (!/^[a-z0-9_-]{1,128}$/i.test(id)) return null;
  return `/app/vaults/${encodeURIComponent(id)}`;
}

function eventType(actionType: string): PublicActivityType {
  if (actionType === "deposit") return "deposit";
  if (actionType === "withdraw") return "withdrawal";
  return "prize_claim";
}

export class PublicActivityService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(input: {
    walletAddress: string;
    type?: PublicActivityType;
    cursor?: string;
    limit: number;
  }): Promise<{ items: PublicActivityEvent[]; nextCursor: string | null }> {
    const { walletAddress, type, limit } = input;
    const cursor = input.cursor ? decodeCursor(input.cursor, walletAddress) : null;
    const where: Prisma.ActionLedgerWhereInput = {
      walletAddress,
      redactedAt: null,
      actionType: type ? PUBLIC_TYPE_TO_ACTION[type] : { in: [...PUBLIC_ACTION_TYPES] },
      ...(cursor && {
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }
        ]
      })
    };

    const rows = await this.prisma.actionLedger.findMany({
      where,
      select: {
        id: true,
        actionType: true,
        status: true,
        createdAt: true,
        actionPayload: true
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1
    });
    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    const items = visibleRows.map((row) => {
      const payload = objectPayload(row.actionPayload);
      return {
        id: row.id,
        type: eventType(row.actionType),
        status: row.status,
        occurred_at: row.createdAt.toISOString(),
        amount: publicAmount(payload.amount),
        asset: publicAsset(payload),
        href: `/app/activity#activity-${row.id}`,
        resource_href: publicResourceHref(payload)
      };
    });
    const last = visibleRows[visibleRows.length - 1];

    return {
      items,
      nextCursor: hasMore && last
        ? encodeCursor({ wallet: walletAddress, createdAt: last.createdAt.toISOString(), id: last.id })
        : null
    };
  }
}