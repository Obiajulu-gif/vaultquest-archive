/**
 * Deterministic recovery for stuck pending actions (#813).
 *
 * An ActionLedger row in `pending` or `submitted` is "in flight". Once it has
 * not moved for longer than the configured threshold (PENDING_STALE_THRESHOLD_MINUTES)
 * it is *stale* and gets a recovery case. Recovery states:
 *
 *   pending        in flight, younger than the threshold (derived; no case)
 *   retryable      stale; a retry (status re-check) may still resolve it
 *   failed         retries exhausted; needs a maintainer
 *   manual_review  escalated; a maintainer owns it
 *   resolved       terminal; closed automatically or by a maintainer
 *
 * Transition table — the next state is a pure function of
 * (state, attempts, maxAttempts, retry outcome), so replaying the same inputs
 * always gives the same result:
 *
 *   pending        ──stale──────────────────────────► retryable
 *   retryable      ──retry: resolved────────────────► resolved
 *   retryable      ──retry: still pending / failed──► retryable (attempts+1 < max)
 *                                                  └► failed    (attempts+1 = max)
 *   retryable|failed ──escalate (maintainer)───────► manual_review
 *   retryable|failed|manual_review ──resolve (maintainer)──► resolved
 *   resolved       (terminal)
 *
 * Every transition, including automatic detection, is written to the audit
 * trail (category "recovery") with actor, reason and before/after state.
 * Case updates use optimistic concurrency (`version`), so two maintainers
 * acting at once cannot both apply a transition.
 *
 * Users can see their own case (with a user-safe message) and retry it while
 * it is `retryable`; escalation and manual resolution are maintainer-only.
 */

import type { AuditActor, AuditRecorder } from "./auditTrail.js";

export const RECOVERY_STATES = ["pending", "retryable", "failed", "manual_review", "resolved"] as const;
export type RecoveryState = (typeof RECOVERY_STATES)[number];

export const RECOVERY_TRANSITIONS: Readonly<Record<RecoveryState, readonly RecoveryState[]>> = {
  pending: ["retryable"],
  retryable: ["retryable", "failed", "manual_review", "resolved"],
  failed: ["manual_review", "resolved"],
  manual_review: ["resolved"],
  resolved: [],
};

/** Ledger statuses that mean the action is still in flight. */
export const IN_FLIGHT_STATUSES: readonly string[] = ["pending", "submitted"];

export const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3;

/** Shown to the action's owner for each state. */
export const RECOVERY_USER_MESSAGES: Readonly<Record<RecoveryState, string>> = {
  pending: "Your action is still being processed.",
  retryable: "This is taking longer than expected. You can retry the status check.",
  failed: "We couldn't confirm this action automatically. A maintainer will review it; no funds are lost while it is pending.",
  manual_review: "A maintainer is reviewing this action. No further steps are needed from you.",
  resolved: "This action has been resolved.",
};

export interface PendingActionSnapshot {
  id: string;
  walletAddress: string;
  actionType: string;
  status: string;
  txHash: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface PendingActionSource {
  getAction(id: string): Promise<PendingActionSnapshot | null>;
  /** In-flight actions not updated since `cutoff`, oldest first. */
  listStale(cutoff: Date, limit: number): Promise<PendingActionSnapshot[]>;
  countStale(cutoff: Date): Promise<number>;
}

export type RetryOutcome =
  | { outcome: "resolved"; finalStatus: string }
  | { outcome: "pending"; detail: string }
  | { outcome: "failed"; detail: string };

/**
 * What a retry does. The default re-reads the ledger (the indexer or a later
 * submission may have moved the action on); a deployment can plug in a
 * Horizon/RPC lookup without changing the state machine.
 */
export interface RecoveryExecutor {
  retry(action: PendingActionSnapshot): Promise<RetryOutcome>;
}

/** Used when a maintainer resolves a case as failed. */
export interface RecoveryLedger {
  markFailed(actionId: string, errorCode: string, detail: string): Promise<void>;
}

export type RecoveryResolution =
  | { kind: "auto"; finalStatus: string }
  | { kind: "manual"; outcome: ManualOutcome; reason: string };

/** `failed`: fail the ledger action. `dismissed`: close the case, leave the ledger. */
export type ManualOutcome = "failed" | "dismissed";

export interface RecoveryCase {
  id: string;
  actionId: string;
  walletAddress: string;
  actionType: string;
  state: Exclude<RecoveryState, "pending">;
  attempts: number;
  maxAttempts: number;
  /** When the action last changed (the start of the stall). */
  staleSince: string;
  detectedAt: string;
  lastAttemptAt: string | null;
  lastError: string | null;
  resolution: RecoveryResolution | null;
  version: number;
  updatedAt: string;
}

export interface RecoveryCaseStore {
  get(id: string): Promise<RecoveryCase | null>;
  getByAction(actionId: string): Promise<RecoveryCase | null>;
  /** One case per action: returns the existing case when there is one. */
  insertIfAbsent(c: RecoveryCase): Promise<{ recoveryCase: RecoveryCase; created: boolean }>;
  /** Writes `next` only if the stored version is `expectedVersion`; else null. */
  update(next: RecoveryCase, expectedVersion: number): Promise<RecoveryCase | null>;
  list(filter: { state?: RecoveryCase["state"]; limit: number }): Promise<RecoveryCase[]>;
  countByState(): Promise<Partial<Record<RecoveryCase["state"], number>>>;
}

export class InMemoryRecoveryCaseStore implements RecoveryCaseStore {
  private readonly rows = new Map<string, RecoveryCase>();

  async get(id: string) {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : null;
  }

  async getByAction(actionId: string) {
    const row = [...this.rows.values()].find((r) => r.actionId === actionId);
    return row ? structuredClone(row) : null;
  }

  async insertIfAbsent(c: RecoveryCase) {
    const existing = await this.getByAction(c.actionId);
    if (existing) return { recoveryCase: existing, created: false };
    this.rows.set(c.id, structuredClone(c));
    return { recoveryCase: structuredClone(c), created: true };
  }

  async update(next: RecoveryCase, expectedVersion: number) {
    const row = this.rows.get(next.id);
    if (!row || row.version !== expectedVersion) return null;
    this.rows.set(next.id, structuredClone(next));
    return structuredClone(next);
  }

  async list(filter: { state?: RecoveryCase["state"]; limit: number }) {
    return [...this.rows.values()]
      .filter((r) => !filter.state || r.state === filter.state)
      .sort((a, b) => a.staleSince.localeCompare(b.staleSince))
      .slice(0, filter.limit)
      .map((r) => structuredClone(r));
  }

  async countByState() {
    const counts: Partial<Record<RecoveryCase["state"], number>> = {};
    for (const r of this.rows.values()) counts[r.state] = (counts[r.state] ?? 0) + 1;
    return counts;
  }
}

export type RecoveryErrorCode = "NOT_FOUND" | "ILLEGAL_TRANSITION" | "FORBIDDEN" | "CONFLICT" | "INVALID_REQUEST";

export class RecoveryError extends Error {
  constructor(
    readonly code: RecoveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RecoveryError";
  }
}

export const SYSTEM_ACTOR: AuditActor = { subject: "system:recovery-scan", role: "system" };

/** The default executor: a status re-check against the ledger. */
export function ledgerRecheckExecutor(source: Pick<PendingActionSource, "getAction">): RecoveryExecutor {
  return {
    async retry(action) {
      const current = await source.getAction(action.id);
      if (!current) return { outcome: "failed", detail: "action no longer exists" };
      if (!IN_FLIGHT_STATUSES.includes(current.status)) {
        return { outcome: "resolved", finalStatus: current.status };
      }
      return { outcome: "pending", detail: `still ${current.status}` };
    },
  };
}

export interface PendingRecoveryOptions {
  store: RecoveryCaseStore;
  actions: PendingActionSource;
  executor?: RecoveryExecutor;
  ledger?: RecoveryLedger;
  audit: AuditRecorder;
  staleAfterMs?: number;
  maxAttempts?: number;
  now?: () => Date;
}

export interface RecoveryDiagnostics {
  generatedAt: string;
  staleAfterMs: number;
  maxAttempts: number;
  stale: {
    count: number;
    oldestAgeMs: number | null;
    byStatus: Record<string, number>;
    byActionType: Record<string, number>;
    sample: Array<{
      actionId: string;
      actionType: string;
      status: string;
      ageMs: number;
      hasTxHash: boolean;
      caseState: RecoveryCase["state"] | null;
    }>;
  };
  cases: Partial<Record<RecoveryCase["state"], number>>;
}

export class PendingRecoveryService {
  private readonly staleAfterMs: number;
  private readonly maxAttempts: number;
  private readonly executor: RecoveryExecutor;

  constructor(private readonly options: PendingRecoveryOptions) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS;
    if (this.staleAfterMs <= 0) throw new Error("staleAfterMs must be positive");
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) throw new Error("maxAttempts must be >= 1");
    this.executor = options.executor ?? ledgerRecheckExecutor(options.actions);
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private cutoff(): Date {
    return new Date(this.now().getTime() - this.staleAfterMs);
  }

  isStale(action: PendingActionSnapshot): boolean {
    return (
      IN_FLIGHT_STATUSES.includes(action.status) &&
      new Date(action.updatedAt).getTime() <= this.cutoff().getTime()
    );
  }

  /** Opens cases for stale actions. Safe to run repeatedly (one case per action). */
  async scan(limit = 100, actor: AuditActor = SYSTEM_ACTOR): Promise<{ opened: RecoveryCase[]; existing: number }> {
    const stale = await this.options.actions.listStale(this.cutoff(), limit);
    const opened: RecoveryCase[] = [];
    let existing = 0;
    for (const action of stale) {
      const result = await this.openCase(action, actor);
      if (result.created) opened.push(result.recoveryCase);
      else existing += 1;
    }
    return { opened, existing };
  }

  private async openCase(action: PendingActionSnapshot, actor: AuditActor) {
    const now = this.now().toISOString();
    const result = await this.options.store.insertIfAbsent({
      id: `rec_${action.id}`,
      actionId: action.id,
      walletAddress: action.walletAddress,
      actionType: action.actionType,
      state: "retryable",
      attempts: 0,
      maxAttempts: this.maxAttempts,
      staleSince: new Date(action.updatedAt).toISOString(),
      detectedAt: now,
      lastAttemptAt: null,
      lastError: null,
      resolution: null,
      version: 1,
      updatedAt: now,
    });
    if (result.created) {
      await this.audit(actor, "recovery.detect", result.recoveryCase, { state: "pending" }, null, {
        actionStatus: action.status,
        staleAfterMs: this.staleAfterMs,
      });
    }
    return result;
  }

  /**
   * Re-checks the action. `owner` restricts the call to that wallet's case
   * (user-initiated retries); maintainers pass no owner.
   */
  async retry(caseId: string, actor: AuditActor, owner?: string): Promise<RecoveryCase> {
    const current = await this.load(caseId, owner);
    if (current.state !== "retryable") {
      throw new RecoveryError("ILLEGAL_TRANSITION", `cannot retry a case in state ${current.state}`);
    }

    const action = await this.options.actions.getAction(current.actionId);
    let outcome: RetryOutcome;
    try {
      outcome = action
        ? await this.executor.retry(action)
        : { outcome: "failed", detail: "action no longer exists" };
    } catch (err) {
      // An executor crash counts as a failed attempt, never as success.
      outcome = { outcome: "failed", detail: err instanceof Error ? err.message.slice(0, 200) : "retry error" };
    }

    const now = this.now().toISOString();
    const attempts = current.attempts + 1;
    const next: RecoveryCase =
      outcome.outcome === "resolved"
        ? {
            ...current,
            state: "resolved",
            attempts,
            lastAttemptAt: now,
            lastError: null,
            resolution: { kind: "auto", finalStatus: outcome.finalStatus },
          }
        : {
            ...current,
            state: attempts >= current.maxAttempts ? "failed" : "retryable",
            attempts,
            lastAttemptAt: now,
            lastError: outcome.detail,
          };

    return this.transition(current, next, actor, "recovery.retry", null, { outcome: outcome.outcome });
  }

  async escalate(caseId: string, actor: AuditActor, reason: string): Promise<RecoveryCase> {
    if (!reason?.trim()) throw new RecoveryError("INVALID_REQUEST", "a reason is required to escalate");
    const current = await this.load(caseId);
    return this.transition(current, { ...current, state: "manual_review" }, actor, "recovery.escalate", reason);
  }

  async resolve(
    caseId: string,
    actor: AuditActor,
    input: { outcome: ManualOutcome; reason: string },
  ): Promise<RecoveryCase> {
    if (!input.reason?.trim()) throw new RecoveryError("INVALID_REQUEST", "a reason is required to resolve");
    if (input.outcome !== "failed" && input.outcome !== "dismissed") {
      throw new RecoveryError("INVALID_REQUEST", "outcome must be failed or dismissed");
    }
    const current = await this.load(caseId);
    if (!RECOVERY_TRANSITIONS[current.state].includes("resolved") || current.state === "resolved") {
      throw new RecoveryError("ILLEGAL_TRANSITION", `cannot resolve a case in state ${current.state}`);
    }

    // Fail the ledger action *before* closing the case: if the ledger update
    // throws, nothing has changed and the maintainer can simply retry. The
    // reverse order could leave a resolved case over a still-stuck action.
    if (input.outcome === "failed") {
      const action = await this.options.actions.getAction(current.actionId);
      if (action && IN_FLIGHT_STATUSES.includes(action.status)) {
        if (!this.options.ledger) throw new RecoveryError("INVALID_REQUEST", "ledger updates are not configured");
        await this.options.ledger.markFailed(current.actionId, "RECOVERY_MANUAL_FAILED", input.reason.trim());
      }
    }

    const next: RecoveryCase = {
      ...current,
      state: "resolved",
      resolution: { kind: "manual", outcome: input.outcome, reason: input.reason.trim() },
    };
    return this.transition(current, next, actor, "recovery.resolve", input.reason, {
      outcome: input.outcome,
    });
  }

  async listCases(filter: { state?: RecoveryCase["state"]; limit: number }): Promise<RecoveryCase[]> {
    return this.options.store.list({ ...filter, limit: Math.min(Math.max(filter.limit, 1), 100) });
  }

  /**
   * The owner's view of an action's recovery. Opens the case on demand when the
   * action has gone stale since the last scan, so users never wait for a sweep.
   */
  async viewForOwner(actionId: string, walletAddress: string) {
    const action = await this.options.actions.getAction(actionId);
    if (!action) throw new RecoveryError("NOT_FOUND", "action not found");
    if (action.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new RecoveryError("FORBIDDEN", "action belongs to another wallet");
    }

    let recoveryCase = await this.options.store.getByAction(actionId);
    if (!recoveryCase && this.isStale(action)) {
      recoveryCase = (await this.openCase(action, SYSTEM_ACTOR)).recoveryCase;
    }

    const state: RecoveryState | null = recoveryCase
      ? recoveryCase.state
      : IN_FLIGHT_STATUSES.includes(action.status)
        ? "pending"
        : null;

    return {
      actionId,
      actionStatus: action.status,
      state,
      message: state ? RECOVERY_USER_MESSAGES[state] : null,
      caseId: recoveryCase?.id ?? null,
      attempts: recoveryCase?.attempts ?? 0,
      maxAttempts: recoveryCase?.maxAttempts ?? this.maxAttempts,
      canRetry: recoveryCase?.state === "retryable",
    };
  }

  /** Maintainer diagnostics: stale actions straight from the ledger, plus case counts. */
  async diagnostics(sampleSize = 25): Promise<RecoveryDiagnostics> {
    const now = this.now();
    const cutoff = this.cutoff();
    const [count, sample, cases] = await Promise.all([
      this.options.actions.countStale(cutoff),
      this.options.actions.listStale(cutoff, Math.min(Math.max(sampleSize, 1), 100)),
      this.options.store.countByState(),
    ]);

    const byStatus: Record<string, number> = {};
    const byActionType: Record<string, number> = {};
    const rows: RecoveryDiagnostics["stale"]["sample"] = [];
    for (const action of sample) {
      byStatus[action.status] = (byStatus[action.status] ?? 0) + 1;
      byActionType[action.actionType] = (byActionType[action.actionType] ?? 0) + 1;
      const c = await this.options.store.getByAction(action.id);
      rows.push({
        actionId: action.id,
        actionType: action.actionType,
        status: action.status,
        ageMs: now.getTime() - new Date(action.updatedAt).getTime(),
        hasTxHash: !!action.txHash,
        caseState: c?.state ?? null,
      });
    }

    return {
      generatedAt: now.toISOString(),
      staleAfterMs: this.staleAfterMs,
      maxAttempts: this.maxAttempts,
      stale: {
        count,
        oldestAgeMs: rows.length ? Math.max(...rows.map((r) => r.ageMs)) : null,
        // byStatus/byActionType describe the sample (oldest first).
        byStatus,
        byActionType,
        sample: rows,
      },
      cases,
    };
  }

  private async load(caseId: string, owner?: string): Promise<RecoveryCase> {
    const c = await this.options.store.get(caseId);
    if (!c) throw new RecoveryError("NOT_FOUND", "recovery case not found");
    if (owner !== undefined && c.walletAddress.toLowerCase() !== owner.toLowerCase()) {
      throw new RecoveryError("FORBIDDEN", "recovery case belongs to another wallet");
    }
    return c;
  }

  private async transition(
    current: RecoveryCase,
    next: RecoveryCase,
    actor: AuditActor,
    action: string,
    reason: string | null,
    metadata?: Record<string, unknown>,
  ): Promise<RecoveryCase> {
    if (!RECOVERY_TRANSITIONS[current.state].includes(next.state)) {
      throw new RecoveryError("ILLEGAL_TRANSITION", `cannot move from ${current.state} to ${next.state}`);
    }
    const stamped: RecoveryCase = { ...next, version: current.version + 1, updatedAt: this.now().toISOString() };
    const saved = await this.options.store.update(stamped, current.version);
    if (!saved) throw new RecoveryError("CONFLICT", "recovery case was changed concurrently; reload and retry");
    await this.audit(actor, action, saved, { state: current.state, attempts: current.attempts }, reason, metadata);
    return saved;
  }

  private async audit(
    actor: AuditActor,
    action: string,
    c: RecoveryCase,
    before: Record<string, unknown> | null,
    reason: string | null,
    metadata?: Record<string, unknown> | null,
  ): Promise<void> {
    await this.options.audit.record({
      category: "recovery",
      action,
      actor,
      target: { type: "recovery_case", id: c.id },
      reason,
      before,
      after: { state: c.state, attempts: c.attempts, lastError: c.lastError, resolution: c.resolution },
      metadata: { actionId: c.actionId, actionType: c.actionType, ...(metadata ?? {}) },
    });
  }
}
