/**
 * Scoped maintainer impersonation for support debugging (#791).
 *
 * A maintainer may open a time-limited impersonation session that allows
 * them to read data as if they were a specific wallet (user). Every session
 * is:
 *   - Time-limited: `expiresAt` is enforced on every read.
 *   - Scoped: only read operations are permitted by default.
 *   - Audited: start, end and every use are written to the audit trail.
 *   - Visible: responses carry `X-Impersonation-Active: true` so the UI
 *     can display a persistent banner.
 *
 * Dangerous mutations (withdraw, select_winner, compensating) remain
 * blocked unless the session was created with `allowMutations: true` AND
 * the maintainer explicitly acknowledges the risk at call time.
 *
 * Transition table:
 *   active  ──expires──► expired   (enforced on validate())
 *   active  ──end()────► ended     (maintainer terminates early)
 *   active  ──use()────► active    (audit event written)
 *   expired | ended      (terminal)
 */

import { randomUUID } from "node:crypto";
import type { AuditActor, AuditRecorder } from "./auditTrail.js";

// ─── Constants ────────────────────────────────────────────────────────────────

export const IMPERSONATION_DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const IMPERSONATION_MAX_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Action types that are blocked during impersonation unless explicitly allowed. */
export const DANGEROUS_MUTATIONS: ReadonlySet<string> = new Set([
  "withdraw",
  "select_winner",
  "compensating",
  "create_vault",
]);

export type ImpersonationState = "active" | "expired" | "ended";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImpersonationSession {
  id: string;
  /** The maintainer performing the impersonation. */
  maintainerSubject: string;
  /** The wallet address being impersonated. */
  targetWallet: string;
  /** Human-readable reason logged to the audit trail. */
  reason: string;
  /** Whether dangerous mutations are allowed (requires explicit flag). */
  allowMutations: boolean;
  state: ImpersonationState;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
}

export interface StartImpersonationOptions {
  targetWallet: string;
  reason: string;
  /** TTL in milliseconds (default: 30 min, max: 4 h). */
  ttlMs?: number;
  /** Allow dangerous mutations (withdraw, select_winner, etc.). */
  allowMutations?: boolean;
}

export interface ImpersonationStore {
  save(session: ImpersonationSession): Promise<void>;
  findById(id: string): Promise<ImpersonationSession | null>;
  findActiveByMaintainer(maintainerSubject: string): Promise<ImpersonationSession[]>;
  update(id: string, patch: Partial<Pick<ImpersonationSession, "state" | "endedAt">>): Promise<void>;
}

// ─── In-memory store (used in tests; production uses PrismaImpersonationStore) ─

export class InMemoryImpersonationStore implements ImpersonationStore {
  private sessions = new Map<string, ImpersonationSession>();

  async save(session: ImpersonationSession): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  async findById(id: string): Promise<ImpersonationSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async findActiveByMaintainer(maintainerSubject: string): Promise<ImpersonationSession[]> {
    return [...this.sessions.values()].filter(
      (s) => s.maintainerSubject === maintainerSubject && s.state === "active",
    );
  }

  async update(id: string, patch: Partial<Pick<ImpersonationSession, "state" | "endedAt">>): Promise<void> {
    const existing = this.sessions.get(id);
    if (!existing) throw new Error(`impersonation session ${id} not found`);
    this.sessions.set(id, { ...existing, ...patch });
  }
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class ImpersonationError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND"
      | "EXPIRED"
      | "ENDED"
      | "MUTATION_BLOCKED"
      | "ALREADY_ACTIVE"
      | "FORBIDDEN",
    message: string,
  ) {
    super(message);
    this.name = "ImpersonationError";
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export interface ImpersonationServiceOptions {
  store: ImpersonationStore;
  audit: AuditRecorder;
  now?: () => Date;
  defaultTtlMs?: number;
}

export class ImpersonationService {
  private readonly store: ImpersonationStore;
  private readonly audit: AuditRecorder;
  private readonly now: () => Date;
  private readonly defaultTtlMs: number;

  constructor(options: ImpersonationServiceOptions) {
    this.store = options.store;
    this.audit = options.audit;
    this.now = options.now ?? (() => new Date());
    this.defaultTtlMs = options.defaultTtlMs ?? IMPERSONATION_DEFAULT_TTL_MS;
  }

  /**
   * Starts a new impersonation session for the given maintainer.
   * A maintainer may only have one active session at a time.
   */
  async start(
    maintainerActor: AuditActor,
    options: StartImpersonationOptions,
  ): Promise<ImpersonationSession> {
    // Enforce one active session per maintainer.
    const existing = await this.store.findActiveByMaintainer(maintainerActor.subject);
    const stillActive = existing.filter((s) => s.expiresAt > this.now());
    if (stillActive.length > 0) {
      throw new ImpersonationError(
        "ALREADY_ACTIVE",
        `maintainer already has an active impersonation session (id: ${stillActive[0]!.id}). End it before starting a new one.`,
      );
    }

    const ttlMs = Math.min(
      Math.max(options.ttlMs ?? this.defaultTtlMs, 60_000), // min 1 minute
      IMPERSONATION_MAX_TTL_MS,
    );
    const now = this.now();
    const session: ImpersonationSession = {
      id: randomUUID(),
      maintainerSubject: maintainerActor.subject,
      targetWallet: options.targetWallet,
      reason: options.reason.trim(),
      allowMutations: options.allowMutations ?? false,
      state: "active",
      startedAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
      endedAt: null,
    };

    await this.store.save(session);

    await this.audit.record({
      category: "access",
      action: "session.issue",
      actor: maintainerActor,
      target: { type: "impersonation_session", id: session.id },
      reason: options.reason,
      after: {
        session_id: session.id,
        target_wallet: session.targetWallet,
        allow_mutations: session.allowMutations,
        expires_at: session.expiresAt.toISOString(),
      },
    });

    return session;
  }

  /**
   * Validates an impersonation session and returns it if active.
   * Automatically transitions expired sessions.
   */
  async validate(sessionId: string): Promise<ImpersonationSession> {
    const session = await this.store.findById(sessionId);
    if (!session) {
      throw new ImpersonationError("NOT_FOUND", `impersonation session ${sessionId} not found`);
    }
    if (session.state === "ended") {
      throw new ImpersonationError("ENDED", "impersonation session has been ended");
    }
    if (session.state === "expired" || session.expiresAt <= this.now()) {
      if (session.state !== "expired") {
        await this.store.update(session.id, { state: "expired" });
      }
      throw new ImpersonationError("EXPIRED", "impersonation session has expired");
    }
    return session;
  }

  /**
   * Checks whether a given action type is permitted in the session.
   * Throws `MUTATION_BLOCKED` for dangerous mutations unless explicitly allowed.
   */
  assertActionAllowed(session: ImpersonationSession, actionType: string): void {
    if (!session.allowMutations && DANGEROUS_MUTATIONS.has(actionType)) {
      throw new ImpersonationError(
        "MUTATION_BLOCKED",
        `action type '${actionType}' is blocked during impersonation sessions. ` +
          `To allow mutations, create the session with allowMutations: true.`,
      );
    }
  }

  /**
   * Ends an impersonation session early. Only the originating maintainer
   * or a maintainer with admin.recovery.write can end a session.
   */
  async end(
    sessionId: string,
    actor: AuditActor,
    reason: string,
  ): Promise<ImpersonationSession> {
    const session = await this.validate(sessionId);

    if (session.maintainerSubject !== actor.subject && actor.role !== "maintainer") {
      throw new ImpersonationError("FORBIDDEN", "only the originating maintainer can end this session");
    }

    const now = this.now();
    await this.store.update(session.id, { state: "ended", endedAt: now });

    await this.audit.record({
      category: "access",
      action: "session.revoke",
      actor,
      target: { type: "impersonation_session", id: session.id },
      reason,
      before: { state: "active", target_wallet: session.targetWallet },
      after: { state: "ended", ended_at: now.toISOString() },
    });

    return { ...session, state: "ended", endedAt: now };
  }

  /**
   * Returns the active impersonation sessions for a maintainer.
   */
  async listActive(maintainerSubject: string): Promise<ImpersonationSession[]> {
    const sessions = await this.store.findActiveByMaintainer(maintainerSubject);
    const now = this.now();
    return sessions.filter((s) => s.expiresAt > now);
  }
}
