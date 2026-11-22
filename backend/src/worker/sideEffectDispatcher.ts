import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { AppError } from "../errors.js";
import { withTelemetry } from "../services/telemetry.js";
import type { EffectLedger, EffectRecord } from "./effectLedger.js";
import { NonRetryableJobError, type JobHandler, type JobRecord } from "./types.js";

/**
 * #923 - idempotent side-effect dispatcher.
 *
 * Wraps a user-visible side effect (email, notification, webhook call) so that
 * running it twice for the same key does the real work once:
 *
 *   - `executed`  - this call ran the effect and recorded it as completed.
 *   - `duplicate` - the effect already completed; nothing ran.
 *   - `in_flight` - another worker holds the claim; nothing ran.
 *
 * A failure is recorded, the claim is released, and the error is rethrown
 * unchanged, so the job queue's retry / dead-letter handling still applies and a
 * later replay (including an operator requeue from the dead-letter state)
 * re-runs only the effects that did not complete.
 *
 * Residual window: if a worker crashes after the effect succeeded but before
 * the ledger records it, the claim expires after `leaseMs` and the effect runs
 * again. Where the provider supports idempotency keys, pass the effect key
 * through to it so that window is closed end to end.
 */
export type DispatchResult<T> =
  | { status: "executed"; result: T; attempt: number }
  | { status: "duplicate"; result: unknown }
  | { status: "in_flight" };

export interface SideEffectSpec {
  /** Stable, unique identity of this effect, e.g. `notify.winner:<jobIdempotencyKey>`. */
  key: string;
  /** Short constant category such as `email` or `webhook`; used for grouping and telemetry. */
  type: string;
}

export interface SideEffectDispatcherOptions {
  ledger: EffectLedger;
  owner?: string;
  /** How long a claim is honoured before another worker may take over. */
  leaseMs?: number;
  now?: () => Date;
  logger?: Logger;
}

export const DEFAULT_EFFECT_LEASE_MS = 5 * 60_000;
const MAX_KEY_LENGTH = 200;

/** Thrown to the job queue when another worker owns the effect, so the job is retried later. */
export class SideEffectInFlightError extends Error {
  constructor(key: string) {
    super(`side effect ${key} is in flight on another worker`);
    this.name = "SideEffectInFlightError";
  }
}

function errorCode(err: unknown): string {
  if (err instanceof AppError || err instanceof NonRetryableJobError) return err.code;
  return "INTERNAL";
}

export class SideEffectDispatcher {
  readonly owner: string;
  private readonly ledger: EffectLedger;
  private readonly leaseMs: number;
  private readonly now: () => Date;
  private readonly logger?: Logger;

  constructor(opts: SideEffectDispatcherOptions) {
    this.ledger = opts.ledger;
    this.owner = opts.owner ?? `effect-dispatcher-${randomUUID().slice(0, 8)}`;
    this.leaseMs = opts.leaseMs ?? DEFAULT_EFFECT_LEASE_MS;
    this.now = opts.now ?? (() => new Date());
    this.logger = opts.logger;
  }

  async dispatch<T>(spec: SideEffectSpec, effect: () => Promise<T>): Promise<DispatchResult<T>> {
    if (!spec.key || spec.key.length > MAX_KEY_LENGTH || !spec.type) {
      throw new NonRetryableJobError("invalid side effect key or type", "INVALID_PAYLOAD");
    }
    return withTelemetry({ operation: "side_effect.dispatch", actorType: "worker", detail: spec.type }, async () => {
      const { claimed, record } = await this.ledger.begin({
        key: spec.key,
        type: spec.type,
        owner: this.owner,
        now: this.now(),
        leaseMs: this.leaseMs
      });
      if (!claimed) {
        if (record.status === "completed") return { status: "duplicate" as const, result: record.result };
        this.logger?.info({ effect_type: spec.type, attempts: record.attempts }, "side effect in flight elsewhere; skipped");
        return { status: "in_flight" as const };
      }

      let result: T;
      try {
        result = await effect();
      } catch (err) {
        if (!(await this.ledger.fail(spec.key, this.owner, errorCode(err), this.now()))) {
          this.logger?.warn({ effect_type: spec.type }, "side effect failed but its claim was lost; another worker owns it now");
        }
        throw err;
      }
      if (!(await this.ledger.complete(spec.key, this.owner, result, this.now()))) {
        this.logger?.warn({ effect_type: spec.type }, "side effect ran but its claim was lost; the new owner may repeat it");
      }
      return { status: "executed" as const, result, attempt: record.attempts };
    });
  }
}

/**
 * Adapts a side effect into a job handler. The default key is derived from the
 * job's idempotency key, which is stable across retries and dead-letter
 * requeues, so every replay of the job maps to the same effect.
 */
export function sideEffectHandler<P = unknown>(
  dispatcher: SideEffectDispatcher,
  opts: {
    type: string;
    run: (job: JobRecord<P>) => Promise<unknown>;
    keyFor?: (job: JobRecord<P>) => string;
  }
): JobHandler<P> {
  return async (job) => {
    const key = opts.keyFor?.(job) ?? `${opts.type}:${job.idempotencyKey}`;
    const outcome = await dispatcher.dispatch({ key, type: opts.type }, () => opts.run(job));
    if (outcome.status === "in_flight") throw new SideEffectInFlightError(key);
  };
}

export interface EffectLedgerSummary {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  /** `in_progress` claims past their lease: a crashed worker, or an effect that is hanging. */
  staleInProgress: number;
  /** `failed` effects waiting for a replay. */
  awaitingReplay: number;
  oldestStaleAt: string | null;
}

/** Aggregates the ledger for an operator dashboard or CLI. */
export function summarizeEffectLedger(
  records: readonly EffectRecord[],
  { now, leaseMs = DEFAULT_EFFECT_LEASE_MS }: { now: Date; leaseMs?: number }
): EffectLedgerSummary {
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let staleInProgress = 0;
  let oldestStale: number | null = null;
  for (const r of records) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    byType[r.type] = (byType[r.type] ?? 0) + 1;
    if (r.status === "in_progress" && r.lockedAt && r.lockedAt.getTime() < now.getTime() - leaseMs) {
      staleInProgress += 1;
      const t = r.lockedAt.getTime();
      if (oldestStale === null || t < oldestStale) oldestStale = t;
    }
  }
  return {
    total: records.length,
    byStatus,
    byType,
    staleInProgress,
    awaitingReplay: byStatus.failed ?? 0,
    oldestStaleAt: oldestStale === null ? null : new Date(oldestStale).toISOString()
  };
}
