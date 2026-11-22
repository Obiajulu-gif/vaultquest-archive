/**
 * #923 - ledger of user-visible side effects (notifications, webhooks, emails).
 *
 * The job queue is at-least-once: a retried or dead-letter-requeued job runs
 * its handler again. For idempotent database work that is harmless, but
 * re-running "send the winner email" twice is a duplicate user-visible action.
 * The ledger records, per effect key, whether the effect already happened, so
 * a replay skips completed effects and only re-runs the ones that did not.
 *
 * An effect is claimed with a lease. A worker that crashes mid-effect leaves an
 * `in_progress` row that becomes claimable again once the lease expires; a
 * `failed` row is claimable immediately. `complete` and `fail` are fenced by
 * the claiming owner, so a worker that lost its lease cannot overwrite the
 * outcome recorded by whoever took over.
 */
export const EFFECT_STATUSES = ["in_progress", "failed", "completed"] as const;
export type EffectStatus = (typeof EFFECT_STATUSES)[number];

export interface EffectRecord<R = unknown> {
  key: string;
  type: string;
  status: EffectStatus;
  /** Number of times the effect has been claimed for execution. */
  attempts: number;
  lockedBy: string | null;
  lockedAt: Date | null;
  /** Stable error code of the last failure (never a message), or null. */
  lastError: string | null;
  result: R | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface BeginInput {
  key: string;
  type: string;
  owner: string;
  now: Date;
  /** An `in_progress` claim older than this is presumed orphaned and reclaimable. */
  leaseMs: number;
}

export type BeginOutcome = { claimed: boolean; record: EffectRecord };

export interface ListEffectsParams {
  status?: EffectStatus;
  type?: string;
  limit?: number;
}

export interface EffectLedger {
  /** Claims the effect unless it is completed or leased by someone else. */
  begin(input: BeginInput): Promise<BeginOutcome>;
  /** Records success. False when `owner` no longer holds the claim. */
  complete(key: string, owner: string, result: unknown, now: Date): Promise<boolean>;
  /** Records failure and releases the claim for replay. False when `owner` no longer holds it. */
  fail(key: string, owner: string, errorCode: string, now: Date): Promise<boolean>;
  get(key: string): Promise<EffectRecord | null>;
  list(params?: ListEffectsParams): Promise<EffectRecord[]>;
}

/** Reference implementation; used by tests and single-process development. */
export class InMemoryEffectLedger implements EffectLedger {
  private readonly records = new Map<string, EffectRecord>();

  async begin({ key, type, owner, now, leaseMs }: BeginInput): Promise<BeginOutcome> {
    const existing = this.records.get(key);
    if (!existing) {
      const record: EffectRecord = {
        key, type, status: "in_progress", attempts: 1, lockedBy: owner, lockedAt: now,
        lastError: null, result: null, createdAt: now, updatedAt: now, completedAt: null,
      };
      this.records.set(key, record);
      return { claimed: true, record: { ...record } };
    }
    const leaseExpired = existing.lockedAt !== null && existing.lockedAt.getTime() < now.getTime() - leaseMs;
    if (existing.status === "completed" || (existing.status === "in_progress" && !leaseExpired)) {
      return { claimed: false, record: { ...existing } };
    }
    existing.status = "in_progress";
    existing.attempts += 1;
    existing.lockedBy = owner;
    existing.lockedAt = now;
    existing.updatedAt = now;
    return { claimed: true, record: { ...existing } };
  }

  async complete(key: string, owner: string, result: unknown, now: Date) {
    const r = this.records.get(key);
    if (!r || r.status !== "in_progress" || r.lockedBy !== owner) return false;
    r.status = "completed";
    r.result = result === undefined ? null : result;
    r.lastError = null;
    r.lockedBy = null;
    r.lockedAt = null;
    r.completedAt = now;
    r.updatedAt = now;
    return true;
  }

  async fail(key: string, owner: string, errorCode: string, now: Date) {
    const r = this.records.get(key);
    if (!r || r.status !== "in_progress" || r.lockedBy !== owner) return false;
    r.status = "failed";
    r.lastError = errorCode;
    r.lockedBy = null;
    r.lockedAt = null;
    r.updatedAt = now;
    return true;
  }

  async get(key: string) {
    const r = this.records.get(key);
    return r ? { ...r } : null;
  }

  async list({ status, type, limit = 50 }: ListEffectsParams = {}) {
    return [...this.records.values()]
      .filter((r) => (!status || r.status === status) && (!type || r.type === type))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}
