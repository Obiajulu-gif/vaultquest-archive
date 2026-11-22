/**
 * Abuse-resistant invitation and collaboration workflow (#792).
 *
 * Invitations are the one place where a user can hand another user access to a
 * vault, so the state machine is deliberately strict:
 *
 *   PENDING ──accept──► ACCEPTED   (terminal)
 *      │
 *      ├──revoke──► REVOKED       (terminal)
 *      └──expiry──► EXPIRED       (terminal)
 *
 * Guarantees enforced here, not by the caller:
 *
 *  - **Expired or revoked invitations cannot be accepted** — expiry and
 *    revocation are terminal, and an expired invite is rejected even though its
 *    row still says `PENDING`.
 *  - **Role escalation is rejected server-side** — an invite may never grant a
 *    role above the inviter's own, and `admin` can only be granted by an `admin`.
 *  - **Abuse is throttled** — per-inviter and per-target limits, so one wallet
 *    cannot spray invites or be used to spam a victim, plus a cooldown between
 *    invites to the same target.
 *
 * Storage sits behind {@link InvitationStore} so the same rules are exercised
 * in tests without a database.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuditRecorder } from "./auditTrail.js";

export const INVITATION_ROLES = ["viewer", "contributor", "admin"] as const;
export type InvitationRole = (typeof INVITATION_ROLES)[number];

export type InvitationState = "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";

/** States an invitation can no longer leave. */
export const TERMINAL_STATES: ReadonlySet<InvitationState> = new Set([
  "ACCEPTED",
  "REVOKED",
  "EXPIRED",
]);

export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const MAX_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Role ordering used to reject escalation. */
const ROLE_RANK: Record<InvitationRole, number> = {
  viewer: 0,
  contributor: 1,
  admin: 2,
};

export function roleAtLeast(role: InvitationRole, minimum: InvitationRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export interface Invitation {
  id: string;
  vaultId: string;
  /** Wallet that created the invite. */
  inviterId: string;
  /** Wallet invited to collaborate. */
  inviteeId: string;
  role: InvitationRole;
  state: InvitationState;
  /** Public token; the raw secret is only returned once, at creation. */
  token: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
  revokedAt?: string;
  /** Set when acceptance failed a role check, for audit. */
  rejectionReason?: string;
}

export interface InvitationStore {
  insert(invitation: Invitation): Promise<void>;
  get(id: string): Promise<Invitation | null>;
  getByToken(token: string): Promise<Invitation | null>;
  update(id: string, patch: Partial<Invitation>): Promise<Invitation | null>;
  /** Every invite the inviter has issued, oldest first. */
  listByInviter(inviterId: string): Promise<Invitation[]>;
  /** Every invite addressed to the invitee, oldest first. */
  listByInvitee(inviteeId: string): Promise<Invitation[]>;
}

export class InMemoryInvitationStore implements InvitationStore {
  private readonly rows = new Map<string, Invitation>();

  async insert(invitation: Invitation): Promise<void> {
    this.rows.set(invitation.id, { ...invitation });
  }

  async get(id: string): Promise<Invitation | null> {
    return this.rows.get(id) ?? null;
  }

  async getByToken(token: string): Promise<Invitation | null> {
    for (const row of this.rows.values()) {
      if (safeEqual(row.token, token)) return { ...row };
    }
    return null;
  }

  async update(id: string, patch: Partial<Invitation>): Promise<Invitation | null> {
    const current = this.rows.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.rows.set(id, next);
    return { ...next };
  }

  async listByInviter(inviterId: string): Promise<Invitation[]> {
    return [...this.rows.values()].filter((r) => r.inviterId === inviterId);
  }

  async listByInvitee(inviteeId: string): Promise<Invitation[]> {
    return [...this.rows.values()].filter((r) => r.inviteeId === inviteeId);
  }

  clear(): void {
    this.rows.clear();
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export type InvitationRejection =
  | "NOT_FOUND"
  | "ALREADY_ACCEPTED"
  | "REVOKED"
  | "EXPIRED"
  | "WRONG_INVITEE"
  | "ROLE_ESCALATION"
  | "THROTTLED";

export type InvitationErrorCode =
  | InvitationRejection
  | "INVALID_REQUEST"
  | "SELF_INVITE"
  | "DUPLICATE_INVITE";

export class InvitationError extends Error {
  constructor(
    readonly code: InvitationErrorCode,
    message: string,
    /** Throttle bookkeeping, present only for THROTTLED. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "InvitationError";
  }
}

export interface CreateInvitationInput {
  vaultId: string;
  inviterId: string;
  inviteeId: string;
  /** Role the inviter holds on the vault. */
  inviterRole: InvitationRole;
  /** Role being granted; defaults to the inviter's own role. */
  role?: InvitationRole;
  ttlMs?: number;
  reason?: string;
}

export interface CreateInvitationResult {
  invitation: Invitation;
  /** Returned once; store a hash, never the raw token. */
  token: string;
}

export interface ThrottlePolicy {
  /** Max live (non-terminal) invites one inviter may hold. */
  maxActivePerInviter: number;
  /** Max live invites a single invitee may receive. */
  maxActivePerInvitee: number;
  /** Minimum gap between two invites to the same target. */
  cooldownMs: number;
}

export const DEFAULT_THROTTLE: ThrottlePolicy = {
  maxActivePerInviter: 10,
  maxActivePerInvitee: 5,
  cooldownMs: 60 * 1000,
};

export interface InvitationServiceOptions {
  store: InvitationStore;
  throttle?: ThrottlePolicy;
  now?: () => number;
  idFactory?: () => string;
  tokenFactory?: () => string;
  /** #814: every grant/accept/revoke/expiry is written to the audit trail. */
  audit?: AuditRecorder;
}

export class InvitationService {
  private readonly store: InvitationStore;
  private readonly throttle: ThrottlePolicy;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly tokenFactory: () => string;
  private readonly audit?: AuditRecorder;

  constructor(options: InvitationServiceOptions) {
    this.store = options.store;
    this.throttle = options.throttle ?? DEFAULT_THROTTLE;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => `inv_${randomBytes(8).toString("hex")}`);
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(24).toString("base64url"));
    this.audit = options.audit;
  }

  /**
   * #814: invitations grant vault access and roles, so each state change is
   * audited. The token (even its hash) is never written; the audit trail's
   * sanitizer would redact it anyway.
   */
  private async auditChange(
    action: "invitation.create" | "invitation.accept" | "invitation.revoke" | "invitation.expire",
    actor: string,
    before: Invitation | null,
    after: Invitation,
    reason?: string,
  ): Promise<void> {
    if (!this.audit) return;
    const view = (i: Invitation | null) =>
      i && { vaultId: i.vaultId, inviterId: i.inviterId, inviteeId: i.inviteeId, role: i.role, state: i.state, expiresAt: i.expiresAt };
    await this.audit.record({
      category: "access",
      action,
      actor: { subject: actor, role: actor === "system" ? "system" : "user" },
      target: { type: "invitation", id: after.id },
      reason: reason ?? null,
      before: view(before),
      after: view(after),
      metadata: { vaultId: after.vaultId },
    });
  }

  /**
   * Issues an invitation. Rejects self-invites, role escalation, duplicates and
   * anything that trips the abuse throttle.
   */
  async create(input: CreateInvitationInput): Promise<CreateInvitationResult> {
    if (!input.vaultId?.trim()) throw new InvitationError("INVALID_REQUEST", "vaultId is required");
    if (!input.inviterId?.trim()) throw new InvitationError("INVALID_REQUEST", "inviterId is required");
    if (!input.inviteeId?.trim()) throw new InvitationError("INVALID_REQUEST", "inviteeId is required");
    if (input.inviterId === input.inviteeId) {
      throw new InvitationError("SELF_INVITE", "You cannot invite yourself");
    }

    const role = input.role ?? input.inviterRole;
    if (!INVITATION_ROLES.includes(input.inviterRole)) {
      throw new InvitationError("INVALID_REQUEST", `Unknown inviter role: ${input.inviterRole}`);
    }
    if (!INVITATION_ROLES.includes(role)) {
      throw new InvitationError("INVALID_REQUEST", `Unknown role: ${role}`);
    }

    // Server-side escalation guard: never grant above the inviter's own role.
    if (ROLE_RANK[role] > ROLE_RANK[input.inviterRole]) {
      throw new InvitationError(
        "ROLE_ESCALATION",
        `Cannot grant "${role}" with "${input.inviterRole}" authority`,
      );
    }

    await this.assertNotThrottled(input.inviterId, input.inviteeId);

    const existing = await this.store.listByInviter(input.inviterId);
    const duplicate = existing.find(
      (row) =>
        row.vaultId === input.vaultId &&
        row.inviteeId === input.inviteeId &&
        (row.state === "PENDING" || (row.state === "EXPIRED" && this.isExpired(row))),
    );
    if (duplicate) {
      throw new InvitationError(
        "DUPLICATE_INVITE",
        "An invitation for this wallet is already outstanding",
      );
    }

    const now = this.now();
    const ttl = Math.min(input.ttlMs ?? DEFAULT_INVITE_TTL_MS, MAX_INVITE_TTL_MS);
    if (ttl <= 0) throw new InvitationError("INVALID_REQUEST", "ttlMs must be positive");

    const token = this.tokenFactory();
    const invitation: Invitation = {
      id: this.idFactory(),
      vaultId: input.vaultId,
      inviterId: input.inviterId,
      inviteeId: input.inviteeId,
      role,
      state: "PENDING",
      // Only the token's digest is persisted, so a database dump cannot be
      // replayed. The caller receives the raw token once, here.
      token: hashToken(token),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
    };

    await this.store.insert(invitation);
    await this.auditChange("invitation.create", invitation.inviterId, null, invitation, input.reason);
    return { invitation, token };
  }

  /**
   * Accepts an invitation on behalf of `inviteeId`. Expired, revoked and
   * already-accepted invitations are refused, and the invitee must match.
   */
  async accept(params: { token: string; inviteeId: string; now?: number }): Promise<Invitation> {
    const inviteeId = params.inviteeId?.trim();
    if (!inviteeId) throw new InvitationError("INVALID_REQUEST", "inviteeId is required");
    if (!params.token) throw new InvitationError("INVALID_REQUEST", "token is required");

    const found = await this.store.getByToken(hashToken(params.token));
    if (!found) throw new InvitationError("NOT_FOUND", "Invitation not found");

    // Identity check before any state change.
    if (found.inviteeId !== inviteeId) {
      throw new InvitationError("WRONG_INVITEE", "This invitation was issued to another wallet");
    }

    if (found.state === "ACCEPTED") {
      throw new InvitationError("ALREADY_ACCEPTED", "Invitation was already accepted");
    }
    if (found.state === "REVOKED") {
      throw new InvitationError("REVOKED", "Invitation was revoked");
    }
    if (this.isExpired(found, params.now)) {
      // Persist the terminal state so the row stops reading as PENDING.
      const expired = await this.store.update(found.id, {
        state: "EXPIRED",
        rejectionReason: "expired before acceptance",
      });
      if (expired) await this.auditChange("invitation.expire", "system", found, expired, "expired before acceptance");
      throw new InvitationError("EXPIRED", "Invitation has expired");
    }

    const updated = await this.store.update(found.id, {
      state: "ACCEPTED",
      acceptedAt: new Date(params.now ?? this.now()).toISOString(),
    });
    if (!updated) throw new InvitationError("NOT_FOUND", "Invitation not found");
    await this.auditChange("invitation.accept", inviteeId, found, updated);
    return updated;
  }

  /** Revokes a pending invitation. Only the inviter may revoke. */
  async revoke(params: { invitationId: string; actorId: string }): Promise<Invitation> {
    const found = await params.invitationId ? await this.store.get(params.invitationId) : null;
    if (!found) throw new InvitationError("NOT_FOUND", "Invitation not found");
    if (found.inviterId !== params.actorId) {
      throw new InvitationError("WRONG_INVITEE", "Only the inviter can revoke this invitation");
    }
    if (found.state !== "PENDING") {
      throw new InvitationError(found.state === "ACCEPTED" ? "ALREADY_ACCEPTED" : found.state === "REVOKED" ? "REVOKED" : "EXPIRED", `Invitation is ${found.state.toLowerCase()}`);
    }

    const updated = await this.store.update(found.id, {
      state: "REVOKED",
      revokedAt: new Date(this.now()).toISOString(),
    });
    if (!updated) throw new InvitationError("NOT_FOUND", "Invitation not found");
    await this.auditChange("invitation.revoke", params.actorId, found, updated);
    return updated;
  }

  /**
   * Marks every elapsed pending invitation issued by `inviterId` as EXPIRED so
   * listing surfaces the real state instead of a stale PENDING row.
   */
  async expireStaleFor(inviterId: string): Promise<Invitation[]> {
    const rows = await this.store.listByInviter(inviterId);
    const expired: Invitation[] = [];
    for (const row of rows) {
      if (row.state !== "PENDING" || !this.isExpired(row)) continue;
      const updated = await this.store.update(row.id, {
        state: "EXPIRED",
        rejectionReason: "expired",
      });
      if (updated) {
        await this.auditChange("invitation.expire", "system", row, updated, "expired");
        expired.push(updated);
      }
    }
    return expired;
  }

  async listForInviter(inviterId: string): Promise<Invitation[]> {
    return this.store.listByInviter(inviterId);
  }

  async listForInvitee(inviteeId: string): Promise<Invitation[]> {
    return this.store.listByInvitee(inviteeId);
  }

  async get(invitationId: string): Promise<Invitation | null> {
    return this.store.get(invitationId);
  }

  private isExpired(invitation: Invitation, at?: number): boolean {
    return new Date(invitation.expiresAt).getTime() <= (at ?? this.now());
  }

  private async assertNotThrottled(inviterId: string, inviteeId: string): Promise<void> {
    const now = this.now();
    const mine = await this.store.listByInviter(inviterId);
    const active = mine.filter((row) => row.state === "PENDING" && !this.isExpired(row, now));

    if (active.length >= this.throttle.maxActivePerInviter) {
      throw new InvitationError(
        "THROTTLED",
        `Too many active invitations (limit ${this.throttle.maxActivePerInviter})`,
        this.throttle.cooldownMs,
      );
    }

    const addressedToThem = (await this.store.listByInvitee(inviteeId)).filter(
      (row) => row.state === "PENDING" && !this.isExpired(row, now),
    );
    if (addressedToThem.length >= this.throttle.maxActivePerInvitee) {
      // This protects the invitee from being spammed, so the retry hint is the
      // full cooldown rather than the per-inviter budget.
      throw new InvitationError(
        "THROTTLED",
        `This wallet already has ${addressedToThem.length} pending invitation(s)`,
        this.throttle.cooldownMs,
      );
    }

    const lastToSameTarget = mine
      .filter((row) => row.inviteeId === inviteeId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .pop();
    if (lastToSameTarget) {
      const elapsed = now - new Date(lastToSameTarget.createdAt).getTime();
      if (elapsed < this.throttle.cooldownMs) {
        throw new InvitationError(
          "THROTTLED",
          "Wait before re-inviting this wallet",
          this.throttle.cooldownMs - elapsed,
        );
      }
    }
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
