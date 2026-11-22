/**
 * Issue #996 — Stale session and token revocation after security events.
 *
 * This service handles bulk revocation of wallet sessions in response to
 * security events such as:
 *  - Key rotation (wallet changes its public key)
 *  - Suspicious activity detection
 *  - Admin-initiated forced logout
 *  - Account compromise reports
 *
 * It extends the existing per-session revocation in `WalletAuthService` with:
 *  - Event-triggered bulk revocation with an audit trail entry per event
 *  - Configurable revocation scope (single wallet, network, or all active sessions)
 *  - Stale-session pruning (sessions idle longer than `maxIdleMs`)
 *  - Retry-safe (runs in a transaction; safe to call twice for the same event)
 *
 * Edge cases / rollback:
 *  - Revocations are stamped with `revokedAt = now()` and are irreversible.
 *    Sessions that are already revoked (revokedAt != null) are skipped.
 *  - If the audit write fails, the whole operation rolls back (Prisma transaction).
 *  - The `reason` string is stored in the audit `before` field so operators
 *    can reconstruct why a revocation happened.
 *  - Tokens and signatures are never included in the audit record (they are
 *    already redacted by `AuditTrailService.sanitizeAuditState`).
 *
 * Normal path:
 *   1. Call `revokeForSecurityEvent` with a `SecurityRevocationInput`.
 *   2. The service bulk-revokes matching sessions.
 *   3. An audit record is written under the `access` category.
 *   4. The number of revoked sessions is returned.
 *
 * Failure path:
 *   - Database down: throws and rolls back; no sessions are revoked.
 *   - No matching sessions: returns 0 (no-op, no audit record written).
 *
 * Authorization:
 *   - Callers are responsible for authorization. The route layer enforces
 *     `admin.recovery.write` before calling this service.
 */

import type { PrismaClient } from "@prisma/client";
import type { AuditRecorder } from "./auditTrail.js";

export type SecurityEventType =
  | "key_rotation"
  | "suspicious_activity"
  | "admin_forced_logout"
  | "account_compromise"
  | "password_change"
  | "mfa_reset";

export interface SecurityRevocationInput {
  /** The wallet address whose sessions should be revoked. */
  walletAddress: string;
  /** The network scope; if omitted, all networks for the wallet are revoked. */
  network?: string;
  /** Human-readable description of why the revocation was triggered. */
  reason: SecurityEventType;
  /** Free-form detail appended to the audit entry (max 512 chars). */
  detail?: string;
  /**
   * If provided, only sessions that have been idle (lastUsedAt) for longer
   * than this many milliseconds are revoked.  Omit to revoke all active
   * sessions regardless of age.
   */
  maxIdleMs?: number;
  /**
   * The actor initiating the revocation (for the audit record).
   * Defaults to the `walletAddress` (self-revocation).
   */
  actor?: string;
}

export interface SecurityRevocationResult {
  /** Number of sessions that were revoked. */
  revokedCount: number;
  /** ISO timestamp of the revocation. */
  revokedAt: string;
  /** Whether this was a no-op (nothing to revoke). */
  noOp: boolean;
}

export class SecurityRevocationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit?: AuditRecorder
  ) {}

  /**
   * Revokes all active sessions for a wallet after a security event.
   *
   * The operation is wrapped in a database transaction: either the sessions
   * are revoked AND the audit record is written, or neither happens.
   */
  async revokeForSecurityEvent(
    input: SecurityRevocationInput
  ): Promise<SecurityRevocationResult> {
    const revokedAt = new Date();
    const actor = input.actor ?? input.walletAddress;

    const where: Parameters<PrismaClient["walletSession"]["updateMany"]>[0]["where"] = {
      walletAddress: input.walletAddress,
      revokedAt: null, // only active sessions
      expiresAt: { gt: revokedAt }, // only non-expired sessions
    };

    // Scope to a specific network when provided
    if (input.network) {
      where.network = input.network;
    }

    // Apply idle-time filter: only revoke sessions idle longer than maxIdleMs
    if (input.maxIdleMs != null && input.maxIdleMs > 0) {
      const idleCutoff = new Date(revokedAt.getTime() - input.maxIdleMs);
      where.lastUsedAt = { lt: idleCutoff };
    }

    // Count matching sessions before the update (for no-op detection)
    const matching = await this.prisma.walletSession.count({ where });

    if (matching === 0) {
      return { revokedCount: 0, revokedAt: revokedAt.toISOString(), noOp: true };
    }

    // Execute revocation + audit in a transaction
    await this.prisma.$transaction(async (tx) => {
      await tx.walletSession.updateMany({
        where,
        data: { revokedAt },
      });

      if (this.audit) {
        const detail = input.detail
          ? input.detail.slice(0, 512)
          : undefined;

        await this.audit.record({
          category: "access",
          action: "session.revoke_all",
          actor: { subject: actor, role: "maintainer" },
          target: {
            type: "wallet",
            id: input.walletAddress,
          },
          before: {
            activeSessions: matching,
            reason: input.reason,
            ...(detail ? { detail } : {}),
            ...(input.network ? { network: input.network } : {}),
            ...(input.maxIdleMs != null ? { maxIdleMs: input.maxIdleMs } : {}),
          },
          after: {
            activeSessions: 0,
            revokedAt: revokedAt.toISOString(),
          },
        });
      }
    });

    return {
      revokedCount: matching,
      revokedAt: revokedAt.toISOString(),
      noOp: false,
    };
  }

  /**
   * Revokes all sessions that have not been used in longer than `maxIdleMs`
   * across all wallets. This is a maintenance operation for stale-session
   * cleanup and runs without a wallet-level audit entry.
   *
   * Returns the number of sessions revoked.
   */
  async pruneStaleSessionsGlobally(maxIdleMs: number): Promise<number> {
    if (maxIdleMs <= 0) {
      throw new Error("maxIdleMs must be a positive number");
    }
    const now = new Date();
    const idleCutoff = new Date(now.getTime() - maxIdleMs);

    const result = await this.prisma.walletSession.updateMany({
      where: {
        revokedAt: null,
        lastUsedAt: { lt: idleCutoff },
      },
      data: { revokedAt: now },
    });

    return result.count;
  }
}
