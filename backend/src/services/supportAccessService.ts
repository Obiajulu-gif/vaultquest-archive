/**
 * Time-bounded maintainer support access (#support-access)
 *
 * Support access is modelled as an explicit **grant** the maintainer must
 * possess before touching a scoped resource:
 *
 * - grants are created with a reason, a ticket reference, a single scope and
 *   a TTL capped at {@link SUPPORT_ACCESS_LIMITS.maxTtlMinutes};
 * - grants expire automatically — `authorize()` compares `expiresAt` against
 *   the injected clock on every use, so a grant can never be "kept alive" by
 *   the holder;
 * - every outcome — including denied attempts — is appended to an immutable,
 *   hash-chained audit trail. Appends are serialized with a Postgres advisory
 *   lock so concurrent requests cannot fork the chain;
 * - authorization is **fail closed**: if the audit append fails, the access
 *   is denied (the caller gets an error and no data).
 *
 * The database trigger on `support_access_audit` rejects UPDATE/DELETE, so
 * even direct SQL cannot rewrite history. See `docs/SUPPORT_ACCESS.md`.
 */

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../errors.js";
import { sanitizeRenderedText } from "./contentBoundary.js";

export const SUPPORT_SCOPE_TYPES = ["wallet", "indexer", "quests"] as const;
export type SupportScopeType = (typeof SUPPORT_SCOPE_TYPES)[number];

export const SUPPORT_ACCESS_ACTIONS = [
  "grant_created",
  "grant_used",
  "access_denied",
  "grant_revoked"
] as const;
export type SupportAccessAction = (typeof SUPPORT_ACCESS_ACTIONS)[number];

export const SUPPORT_ACCESS_LIMITS = {
  minTtlMinutes: 1,
  defaultTtlMinutes: 30,
  maxTtlMinutes: 240
} as const;

const WALLET_SCOPE_RE = /^G[A-Z0-9]{55}$/;
const GENERIC_SCOPE_RE = /^[A-Za-z0-9:_-]{1,120}$/;
const MAX_REASON_CHARS = 500;
const MAX_TICKET_CHARS = 120;
const MAX_ACTOR_CHARS = 200;

export type SupportAccessGrantRecord = {
  id: string;
  requesterId: string;
  reason: string;
  ticketRef: string;
  scopeType: string;
  scope: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  createdAt: Date;
};

export type SupportAccessAuditRecord = {
  id: string;
  grantId: string | null;
  actor: string;
  action: string;
  scope: string;
  detail: unknown;
  prevHash: string | null;
  entryHash: string;
  createdAt: Date;
};

export type SupportAccessDenialReason =
  | "grant_not_found"
  | "grant_revoked"
  | "grant_expired"
  | "scope_mismatch";

export type SupportAccessDecision = {
  allowed: boolean;
  grant: SupportAccessGrantRecord;
  expiresAt: Date;
  remaining_ms: number;
  denial_reason?: SupportAccessDenialReason;
  /** User-safe notice describing the access (only when allowed). */
  notice?: string;
};

export function validateScope(scopeType: string, scope: string): string | null {
  if (!(SUPPORT_SCOPE_TYPES as readonly string[]).includes(scopeType)) {
    return `scope_type must be one of: ${SUPPORT_SCOPE_TYPES.join(", ")}`;
  }
  const pattern = scopeType === "wallet" ? WALLET_SCOPE_RE : GENERIC_SCOPE_RE;
  if (!pattern.test(scope)) {
    return scopeType === "wallet"
      ? "wallet scope must be a Stellar address (G...) 56 characters long"
      : "scope must match [A-Za-z0-9:_-] and be at most 120 characters";
  }
  return null;
}

export function clampTtlMinutes(requested?: number): number {
  const { minTtlMinutes, defaultTtlMinutes, maxTtlMinutes } = SUPPORT_ACCESS_LIMITS;
  if (requested === undefined) return defaultTtlMinutes;
  if (!Number.isInteger(requested) || requested < minTtlMinutes) {
    throw AppError.validation(`ttl_minutes must be an integer >= ${minTtlMinutes}`);
  }
  if (requested > maxTtlMinutes) {
    throw AppError.validation(
      `ttl_minutes must be <= ${maxTtlMinutes} (hard cap for support access)`
    );
  }
  return requested;
}

/** Stable, non-reversible badge so notices never expose the maintainer id. */
export function supportAgentBadge(requesterId: string): string {
  return createHash("sha256").update(requesterId).digest("hex").slice(0, 8);
}

/**
 * Builds the user-safe notice for a grant. The free-text `reason` is
 * deliberately excluded — it may contain operational detail the user should
 * not see. Everything else goes through the rendered-text sanitiser so a
 * hostile ticket reference can never inject markup or control characters.
 */
export function buildSupportNotice(grant: {
  requesterId: string;
  ticketRef: string;
  scopeType: string;
  scope: string;
  expiresAt: Date;
}): string {
  const badge = supportAgentBadge(grant.requesterId);
  const scopeLabel = `${grant.scopeType} ${grant.scope.slice(0, 12)}...`;
  return sanitizeRenderedText(
    `VaultQuest support agent #${badge} used a time-limited support grant on your account ` +
      `(scope: ${scopeLabel}, ticket: ${grant.ticketRef}). The grant is audit-logged and ` +
      `expires at ${grant.expiresAt.toISOString()}.`
  );
}

export function hashSupportAuditEntry(entry: {
  grantId: string | null;
  actor: string;
  action: string;
  scope: string;
  detail: unknown;
  createdAt: Date;
  prevHash: string | null;
}): string {
  const canonical = JSON.stringify({
    grant_id: entry.grantId,
    actor: entry.actor,
    action: entry.action,
    scope: entry.scope,
    detail: entry.detail ?? null,
    created_at: entry.createdAt.toISOString(),
    prev_hash: entry.prevHash
  });
  return createHash("sha256").update(canonical).digest("hex");
}

type AppendAuditInput = {
  grantId: string | null;
  actor: string;
  action: SupportAccessAction;
  scope: string;
  detail?: unknown;
};

export class SupportAccessService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: { now?: () => Date } = {}
  ) {}

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  async createGrant(input: {
    requesterId: string;
    reason: string;
    ticketRef: string;
    scopeType: string;
    scope: string;
    ttlMinutes?: number;
  }): Promise<{ grant: SupportAccessGrantRecord; notice: string }> {
    const requesterId = input.requesterId.trim();
    const reason = input.reason.trim();
    const ticketRef = input.ticketRef.trim();

    if (requesterId.length === 0 || requesterId.length > MAX_ACTOR_CHARS) {
      throw AppError.validation(`requester_id must be 1..${MAX_ACTOR_CHARS} characters`);
    }
    if (reason.length === 0 || reason.length > MAX_REASON_CHARS) {
      throw AppError.validation(`reason must be 1..${MAX_REASON_CHARS} characters`);
    }
    if (ticketRef.length === 0 || ticketRef.length > MAX_TICKET_CHARS) {
      throw AppError.validation(`ticket_ref must be 1..${MAX_TICKET_CHARS} characters`);
    }
    const scopeError = validateScope(input.scopeType, input.scope);
    if (scopeError) throw AppError.validation(scopeError);

    const ttlMinutes = clampTtlMinutes(input.ttlMinutes);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);

    const grant = (await this.prisma.supportAccessGrant.create({
      data: {
        requesterId,
        reason,
        ticketRef,
        scopeType: input.scopeType,
        scope: input.scope,
        expiresAt,
        createdAt: now
      }
    })) as SupportAccessGrantRecord;

    // If the audit append fails here the error propagates and no usable
    // grant is returned to the caller (fail closed).
    await this.appendAudit({
      grantId: grant.id,
      actor: requesterId,
      action: "grant_created",
      scope: `${grant.scopeType}:${grant.scope}`,
      detail: { ticket_ref: ticketRef, ttl_minutes: ttlMinutes }
    });

    return { grant, notice: buildSupportNotice(grant) };
  }

  async revokeGrant(
    grantId: string,
    input: { revokedBy: string }
  ): Promise<{ grant: SupportAccessGrantRecord; alreadyRevoked: boolean }> {
    const grant = (await this.prisma.supportAccessGrant.findUnique({
      where: { id: grantId }
    })) as SupportAccessGrantRecord | null;
    if (!grant) throw AppError.notFound(`support access grant ${grantId} not found`);

    if (grant.revokedAt) {
      return { grant, alreadyRevoked: true };
    }

    const now = this.now();
    const updated = (await this.prisma.supportAccessGrant.update({
      where: { id: grantId },
      data: { revokedAt: now, revokedBy: input.revokedBy }
    })) as SupportAccessGrantRecord;

    await this.appendAudit({
      grantId,
      actor: input.revokedBy,
      action: "grant_revoked",
      scope: `${grant.scopeType}:${grant.scope}`,
      detail: { revoked_at: now.toISOString() }
    });

    return { grant: updated, alreadyRevoked: false };
  }

  /**
   * Authorises a scoped access attempt against a grant and records the
   * outcome. Every attempt — allowed or denied — appends an audit entry.
   * Fail closed: a failed audit append throws instead of returning data.
   */
  async authorize(input: {
    grantId: string;
    scopeType: string;
    scope: string;
    actor?: string;
  }): Promise<SupportAccessDecision> {
    const grant = (await this.prisma.supportAccessGrant.findUnique({
      where: { id: input.grantId }
    })) as SupportAccessGrantRecord | null;

    const now = this.now();
    const actor = input.actor ?? grant?.requesterId ?? "unknown";

    if (!grant) {
      await this.appendAudit({
        grantId: input.grantId,
        actor,
        action: "access_denied",
        scope: `${input.scopeType}:${input.scope}`,
        detail: { reason: "grant_not_found" }
      });
      throw AppError.forbidden("support access grant not found or not usable");
    }

    let denial: SupportAccessDenialReason | null = null;
    if (grant.revokedAt) {
      denial = "grant_revoked";
    } else if (grant.expiresAt.getTime() <= now.getTime()) {
      denial = "grant_expired";
    } else if (grant.scopeType !== input.scopeType || grant.scope !== input.scope) {
      denial = "scope_mismatch";
    }

    if (denial) {
      await this.appendAudit({
        grantId: grant.id,
        actor,
        action: "access_denied",
        scope: `${input.scopeType}:${input.scope}`,
        detail: { reason: denial }
      });
      return {
        allowed: false,
        grant,
        expiresAt: grant.expiresAt,
        remaining_ms: Math.max(0, grant.expiresAt.getTime() - now.getTime()),
        denial_reason: denial
      };
    }

    await this.appendAudit({
      grantId: grant.id,
      actor,
      action: "grant_used",
      scope: `${grant.scopeType}:${grant.scope}`,
      detail: { ticket_ref: grant.ticketRef }
    });

    return {
      allowed: true,
      grant,
      expiresAt: grant.expiresAt,
      remaining_ms: Math.max(0, grant.expiresAt.getTime() - now.getTime()),
      notice: buildSupportNotice(grant)
    };
  }

  async listGrantsForScope(
    scopeType: string,
    scope: string,
    options: { since?: Date } = {}
  ): Promise<SupportAccessGrantRecord[]> {
    const rows = await this.prisma.supportAccessGrant.findMany({
      where: {
        scopeType,
        scope,
        ...(options.since ? { createdAt: { gte: options.since } } : {})
      },
      orderBy: { createdAt: "desc" },
      take: 50
    });
    return rows as SupportAccessGrantRecord[];
  }

  async getAuditTrail(options: { grantId?: string; limit?: number } = {}): Promise<{
    entries: SupportAccessAuditRecord[];
    chain_valid: boolean;
  }> {
    const entries = (await this.prisma.supportAccessAuditEntry.findMany({
      where: options.grantId ? { grantId: options.grantId } : undefined,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: options.limit ?? 500
    })) as SupportAccessAuditRecord[];

    const verification = await this.verifyAuditChain();
    return { entries, chain_valid: verification.valid };
  }

  /**
   * Recomputes the hash chain over the full trail. A `false` result (with
   * `broken_at`) means rows were tampered with or spliced in.
   */
  async verifyAuditChain(): Promise<{ valid: boolean; entries: number; broken_at?: string }> {
    const all = (await this.prisma.supportAccessAuditEntry.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    })) as SupportAccessAuditRecord[];

    let prevHash: string | null = null;
    for (const entry of all) {
      const expected = hashSupportAuditEntry({
        grantId: entry.grantId,
        actor: entry.actor,
        action: entry.action,
        scope: entry.scope,
        detail: entry.detail,
        createdAt: entry.createdAt,
        prevHash
      });
      if (entry.prevHash !== prevHash || entry.entryHash !== expected) {
        return { valid: false, entries: all.length, broken_at: entry.id };
      }
      prevHash = entry.entryHash;
    }
    return { valid: true, entries: all.length };
  }

  private async appendAudit(input: AppendAuditInput): Promise<SupportAccessAuditRecord> {
    return this.prisma.$transaction(async (tx) => {
      // Serialize appends so concurrent writers cannot fork the hash chain.
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtext('vaultquest.support_access_audit'))"
      );

      const last = (await tx.supportAccessAuditEntry.findFirst({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }]
      })) as SupportAccessAuditRecord | null;

      const createdAt = this.now();
      const prevHash = last?.entryHash ?? null;
      const entryHash = hashSupportAuditEntry({
        grantId: input.grantId,
        actor: input.actor,
        action: input.action,
        scope: input.scope,
        detail: input.detail ?? null,
        createdAt,
        prevHash
      });

      return (await tx.supportAccessAuditEntry.create({
        data: {
          grantId: input.grantId,
          actor: input.actor,
          action: input.action,
          scope: input.scope,
          detail: (input.detail ?? null) as object | undefined,
          prevHash,
          entryHash,
          createdAt
        }
      })) as SupportAccessAuditRecord;
    });
  }
}
