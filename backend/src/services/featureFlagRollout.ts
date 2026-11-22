/**
 * Feature-flag rollout guard with automatic rollback verification.
 *
 * A rollout turns a flag on for one scope ("global", "vault:{id}" or
 * "wallet:{address}") while the guard watches the outcomes reported by the
 * code path behind the flag. If the failure rate crosses the rollout's
 * guardrails the guard rolls the flag back on its own, then *verifies* that the
 * rollback actually took effect before calling it done.
 *
 * Lifecycle (stored on the flag row as `metadata.rollout`):
 *
 *   start() ─▶ active ──complete()──▶ completed            (flag stays on)
 *                │
 *                └─rollback()/guardrail breach─▶ rolling_back
 *                                                   │ verify()
 *                                     ┌─────────────┴─────────────┐
 *                                     ▼                           ▼
 *                                rolled_back  ◀──verify()── rollback_unverified
 *
 *  - The pre-rollout value is persisted with the rollout, so rollback restores
 *    what was there before (not a blind `false`) even after a process restart.
 *  - Every state change happens under a row lock, so concurrent rollbacks from
 *    several replicas collapse into one write; repeating a rollback is a no-op.
 *  - A new rollout of the same flag + scope is refused until the previous one
 *    is completed or its rollback is verified, so rollouts never stack on top
 *    of an inconsistent state.
 *  - Verification runs built-in checks (stored value restored, this process's
 *    cache agrees, other replicas' caches have expired) plus any domain checks
 *    registered for the flag. Anything pending or failing leaves the rollout in
 *    `rollback_unverified`, which is re-checked with verify().
 *
 * See docs/FEATURE_FLAGS.md ("Guarded rollouts") for the operator runbook.
 */

import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { createLogger } from "../logger.js";
import {
  FEATURE_FLAGS,
  parseScopeString,
  type FeatureFlagKey,
  type FeatureFlagService,
} from "./featureFlagService.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

export const ROLLOUT_STATES = ["active", "rolling_back", "rolled_back", "rollback_unverified", "completed"] as const;
export type RolloutState = (typeof ROLLOUT_STATES)[number];

/** States that still need operator attention; a new rollout of the same flag + scope is refused. */
const OPEN_STATES: ReadonlySet<RolloutState> = new Set(["active", "rolling_back", "rollback_unverified"]);
const ROLLED_BACK_STATES: ReadonlySet<RolloutState> = new Set(["rolling_back", "rolled_back", "rollback_unverified"]);

export interface RolloutGuardrails {
  /** Failure ratio (0–1) above which the rollout is rolled back automatically. */
  maxErrorRate: number;
  /** Outcomes required in the window before the error rate is trusted. */
  minSamples: number;
  /** Sliding window the error rate is computed over. */
  windowMs: number;
}

export const DEFAULT_GUARDRAILS: RolloutGuardrails = {
  maxErrorRate: 0.05,
  minSamples: 20,
  windowMs: 5 * 60_000,
};

export type CheckStatus = "pass" | "pending" | "fail" | "skipped";

export interface VerificationCheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface VerificationReport {
  verifiedAt: string;
  status: "verified" | "unverified";
  /** When every replica's flag cache has expired; re-verify after this if checks are pending. */
  propagatedAt: string;
  checks: VerificationCheckResult[];
}

export interface RolloutHealth {
  samples: number;
  failures: number;
  errorRate: number;
  breached: boolean;
}

export interface RolloutRecord {
  id: string;
  flag: FeatureFlagKey;
  scope: string;
  state: RolloutState;
  /** Value the flag had before the rollout; rollback restores exactly this. */
  previousEnabled: boolean;
  guardrails: RolloutGuardrails;
  startedAt: string;
  startedBy: string;
  reason: string;
  endedAt?: string;
  endedBy?: string;
  endReason?: string;
  /** True when the guard rolled back on a guardrail breach. */
  automatic?: boolean;
  /** Health snapshot that triggered an automatic rollback. */
  trigger?: RolloutHealth;
  verification?: VerificationReport;
}

// ─── Storage ─────────────────────────────────────────────────────────────────

export interface FlagRow {
  enabled: boolean;
  metadata: Record<string, unknown>;
}

export interface FlagWrite {
  enabled: boolean;
  rollout: RolloutRecord;
  /** Written to feature_flag_audits when present. */
  audit?: { actor: string; reason: string };
}

export interface FlagRolloutStore {
  read(flag: FeatureFlagKey, scope: string): Promise<FlagRow | null>;
  /**
   * Atomically read-decide-write one flag row. `decide` runs while the row is
   * locked; returning null writes nothing, throwing aborts with no changes.
   * Resolves to the row as it stands afterwards.
   */
  mutate(flag: FeatureFlagKey, scope: string, decide: (current: FlagRow | null) => FlagWrite | null): Promise<FlagRow | null>;
}

function rolloutOf(row: FlagRow | null): RolloutRecord | null {
  const r = row?.metadata.rollout as RolloutRecord | undefined;
  return r && typeof r === "object" && ROLLOUT_STATES.includes(r.state) ? r : null;
}

function auditReason(rollout: RolloutRecord, reason: string): string {
  return `[rollout ${rollout.id} ${rollout.scope}] ${reason}`;
}

export class InMemoryFlagRolloutStore implements FlagRolloutStore {
  readonly rows = new Map<string, FlagRow>();
  readonly audits: Array<{ flagKey: string; previousValue: boolean; newValue: boolean; actor: string; reason: string }> = [];

  async read(flag: FeatureFlagKey, scope: string): Promise<FlagRow | null> {
    const row = this.rows.get(`${flag}:${scope}`);
    return row ? structuredClone(row) : null;
  }

  async mutate(flag: FeatureFlagKey, scope: string, decide: (current: FlagRow | null) => FlagWrite | null) {
    const key = `${flag}:${scope}`;
    const current = this.rows.get(key) ?? null;
    // `decide` is synchronous, so nothing can interleave between read and write.
    const next = decide(current ? structuredClone(current) : null);
    if (!next) return current ? structuredClone(current) : null;
    const row: FlagRow = { enabled: next.enabled, metadata: { ...(current?.metadata ?? {}), rollout: next.rollout } };
    this.rows.set(key, row);
    if (next.audit) {
      this.audits.push({ flagKey: flag, previousValue: current?.enabled ?? false, newValue: next.enabled, ...next.audit });
    }
    return structuredClone(row);
  }
}

function toFlagRow(raw: { enabled: boolean; metadata: unknown }): FlagRow {
  const metadata = raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
    ? (raw.metadata as Record<string, unknown>)
    : {};
  return { enabled: raw.enabled, metadata };
}

export class PrismaFlagRolloutStore implements FlagRolloutStore {
  constructor(private readonly prisma: PrismaClient) {}

  async read(flag: FeatureFlagKey, scope: string): Promise<FlagRow | null> {
    const row = await this.prisma.featureFlag.findUnique({ where: { key_scope: { key: flag, scope } } });
    return row ? toFlagRow(row) : null;
  }

  async mutate(flag: FeatureFlagKey, scope: string, decide: (current: FlagRow | null) => FlagWrite | null) {
    try {
      return await this.attempt(flag, scope, decide);
    } catch (err) {
      // Two replicas raced to create the same missing row: the loser retries
      // once and now sees (and locks) the winner's row.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return this.attempt(flag, scope, decide);
      }
      throw err;
    }
  }

  private attempt(flag: FeatureFlagKey, scope: string, decide: (current: FlagRow | null) => FlagWrite | null) {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ enabled: boolean; metadata: unknown }>>`
        SELECT enabled, metadata FROM feature_flags WHERE key = ${flag} AND scope = ${scope} FOR UPDATE`;
      const current = locked[0] ? toFlagRow(locked[0]) : null;
      const next = decide(current);
      if (!next) return current;
      const metadata = { ...(current?.metadata ?? {}), rollout: next.rollout };
      const data = { enabled: next.enabled, metadata: metadata as Prisma.InputJsonValue };
      if (current) {
        await tx.featureFlag.update({ where: { key_scope: { key: flag, scope } }, data });
      } else {
        await tx.featureFlag.create({ data: { key: flag, scope, ...data } });
      }
      if (next.audit) {
        await tx.featureFlagAudit.create({
          data: {
            flagKey: flag,
            previousValue: current?.enabled ?? false,
            newValue: next.enabled,
            actor: next.audit.actor,
            reason: next.audit.reason,
          },
        });
      }
      return { enabled: next.enabled, metadata } satisfies FlagRow;
    });
  }
}

// ─── Verification checks ─────────────────────────────────────────────────────

export interface RollbackCheckContext {
  flag: FeatureFlagKey;
  scope: string;
  rollout: RolloutRecord;
  now: Date;
  /** When every replica's cache has expired since the rollback. */
  propagatedAt: Date;
}

/** A domain invariant that must hold once a rollback has taken effect. */
export interface RollbackCheck {
  name: string;
  run(ctx: RollbackCheckContext): Promise<{ status: CheckStatus; detail: string }>;
}

/**
 * For WITHDRAWAL_SUBMISSION_ENABLED: once the rollback has propagated, no
 * withdrawal may be submitted in the rolled-back scope. A non-zero count means
 * a code path ignores the flag, so the rollback is not real.
 */
export function withdrawalSubmissionsHaltedCheck(
  countSubmittedSince: (since: Date, wallet?: string) => Promise<number>,
): RollbackCheck {
  return {
    name: "withdrawal_submissions_halted",
    async run({ scope, now, propagatedAt }) {
      const parsed = parseScopeString(scope);
      if (parsed?.vault) {
        return { status: "skipped", detail: "withdrawals are not attributable to a vault in the action ledger" };
      }
      if (now < propagatedAt) {
        return { status: "pending", detail: `re-verify after ${propagatedAt.toISOString()}` };
      }
      const count = await countSubmittedSince(propagatedAt, parsed?.wallet);
      return count === 0
        ? { status: "pass", detail: "no withdrawals submitted since the rollback propagated" }
        : { status: "fail", detail: `${count} withdrawal(s) submitted after the rollback propagated; a code path is bypassing the flag` };
    },
  };
}

// ─── Guard ───────────────────────────────────────────────────────────────────

export type RolloutErrorCode = "NOT_FOUND" | "IN_PROGRESS" | "ALREADY_ENABLED" | "INVALID_STATE" | "INVALID_SCOPE";

export class RolloutError extends Error {
  constructor(readonly code: RolloutErrorCode, message: string) {
    super(message);
    this.name = "RolloutError";
  }
}

type FlagReader = Pick<FeatureFlagService, "isEnabled" | "invalidate" | "cacheTtlMs">;

export interface FeatureFlagRolloutGuardOptions {
  store: FlagRolloutStore;
  flags: FlagReader;
  checks?: Partial<Record<FeatureFlagKey, RollbackCheck[]>>;
  now?: () => number;
  /**
   * Re-run verification once caches have expired when a rollback finishes
   * with only pending checks. Off in tests that drive time by hand.
   */
  autoReverify?: boolean;
  /** Cap on outcomes kept per rollout window, so memory stays bounded. */
  maxWindowSamples?: number;
}

export const SYSTEM_ACTOR = "system:rollout-guard";

export class FeatureFlagRolloutGuard {
  private readonly now: () => number;
  private readonly windows = new Map<string, Array<{ at: number; ok: boolean }>>();
  private readonly known = new Map<string, { rollout: RolloutRecord | null; fetchedAt: number }>();
  private readonly inflight = new Map<string, Promise<RolloutRecord>>();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(private readonly options: FeatureFlagRolloutGuardOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  async get(flag: FeatureFlagKey, scope: string): Promise<{ enabled: boolean; rollout: RolloutRecord | null; health: RolloutHealth | null }> {
    const row = await this.options.store.read(flag, scope);
    const rollout = rolloutOf(row);
    const health = rollout?.state === "active" ? this.health(rollout) : null;
    return { enabled: row?.enabled ?? false, rollout, health };
  }

  async start(
    flag: FeatureFlagKey,
    scope: string,
    input: { actor: string; reason: string; guardrails?: Partial<RolloutGuardrails> },
  ): Promise<RolloutRecord> {
    if (!parseScopeString(scope)) throw new RolloutError("INVALID_SCOPE", `invalid scope "${scope}"`);
    const guardrails = { ...DEFAULT_GUARDRAILS, ...input.guardrails };
    let started: RolloutRecord | undefined;
    await this.options.store.mutate(flag, scope, (current) => {
      const existing = rolloutOf(current);
      if (existing && OPEN_STATES.has(existing.state)) {
        throw new RolloutError("IN_PROGRESS", `rollout ${existing.id} is ${existing.state}; finish or verify it first`);
      }
      if (current?.enabled) {
        throw new RolloutError("ALREADY_ENABLED", `${flag} is already enabled for ${scope}; there is nothing to guard`);
      }
      started = {
        id: randomUUID(),
        flag,
        scope,
        state: "active",
        previousEnabled: current?.enabled ?? false,
        guardrails,
        startedAt: new Date(this.now()).toISOString(),
        startedBy: input.actor,
        reason: input.reason,
      };
      return { enabled: true, rollout: started, audit: { actor: input.actor, reason: auditReason(started, input.reason) } };
    });
    this.options.flags.invalidate(flag, scope);
    this.remember(flag, scope, started!);
    logger.info({ flag, scope, rolloutId: started!.id, guardrails }, "guarded rollout started");
    return started!;
  }

  /**
   * Report the outcome of one guarded operation. Cheap when no rollout is
   * active. On a guardrail breach this rolls back and resolves to the
   * rolled-back record; otherwise it resolves to null. Never throws: if the
   * rollback could not restore the flag it is retried on the next reported
   * outcome; if it restored the flag but verification errored, the rollout
   * stays `rolling_back` (flag off, safe) until verify() is run.
   */
  async record(flag: FeatureFlagKey, scope: string, outcome: "success" | "failure"): Promise<RolloutRecord | null> {
    try {
      const rollout = await this.activeRollout(flag, scope);
      if (!rollout) return null;
      const window = this.windowFor(rollout);
      window.push({ at: this.now(), ok: outcome === "success" });
      const cap = this.options.maxWindowSamples ?? 10_000;
      if (window.length > cap) window.splice(0, window.length - cap);
      const health = this.health(rollout);
      if (!health.breached) return null;
      const pct = (health.errorRate * 100).toFixed(1);
      logger.warn({ flag, scope, rolloutId: rollout.id, health }, "rollout guardrail breached; rolling back");
      return await this.rollback(flag, scope, {
        actor: SYSTEM_ACTOR,
        reason: `automatic: ${health.failures}/${health.samples} failures (${pct}%) exceeded ${rollout.guardrails.maxErrorRate * 100}%`,
        automatic: true,
        trigger: health,
      });
    } catch (err) {
      logger.error({ err, flag, scope }, "rollout guard could not evaluate or roll back; will retry on next outcome");
      this.known.delete(`${flag}:${scope}`);
      return null;
    }
  }

  health(rollout: RolloutRecord): RolloutHealth {
    const window = this.windowFor(rollout);
    const cutoff = this.now() - rollout.guardrails.windowMs;
    while (window.length && window[0]!.at < cutoff) window.shift();
    const samples = window.length;
    const failures = window.filter((o) => !o.ok).length;
    const errorRate = samples ? failures / samples : 0;
    const breached = samples >= rollout.guardrails.minSamples && errorRate > rollout.guardrails.maxErrorRate;
    return { samples, failures, errorRate, breached };
  }

  /**
   * Restore the pre-rollout value and verify it. Idempotent: rolling back an
   * already-verified rollback returns it unchanged; rolling back an unverified
   * one re-asserts the restored value and re-verifies. Concurrent calls in one
   * process share a single attempt.
   */
  rollback(
    flag: FeatureFlagKey,
    scope: string,
    input: { actor: string; reason: string; automatic?: boolean; trigger?: RolloutHealth },
  ): Promise<RolloutRecord> {
    const key = `${flag}:${scope}`;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const attempt = this.doRollback(flag, scope, input).finally(() => this.inflight.delete(key));
    this.inflight.set(key, attempt);
    return attempt;
  }

  private async doRollback(
    flag: FeatureFlagKey,
    scope: string,
    input: { actor: string; reason: string; automatic?: boolean; trigger?: RolloutHealth },
  ): Promise<RolloutRecord> {
    const after = await this.options.store.mutate(flag, scope, (current) => {
      const r = rolloutOf(current);
      if (!r) throw new RolloutError("NOT_FOUND", `no rollout recorded for ${flag} in ${scope}`);
      if (r.state === "completed") {
        throw new RolloutError("INVALID_STATE", `rollout ${r.id} was completed; change the flag directly instead`);
      }
      if (r.state === "rolled_back") return null;
      if (r.state === "active") {
        const next: RolloutRecord = {
          ...r,
          state: "rolling_back",
          endedAt: new Date(this.now()).toISOString(),
          endedBy: input.actor,
          endReason: input.reason,
          automatic: input.automatic ?? false,
          ...(input.trigger ? { trigger: input.trigger } : {}),
        };
        return { enabled: r.previousEnabled, rollout: next, audit: { actor: input.actor, reason: auditReason(r, input.reason) } };
      }
      // rolling_back / rollback_unverified: something may have re-enabled the
      // flag since (manual SQL, a stale writer); put the restored value back.
      if (current!.enabled !== r.previousEnabled) {
        return {
          enabled: r.previousEnabled,
          rollout: r,
          audit: { actor: input.actor, reason: auditReason(r, `re-asserting rollback: ${input.reason}`) },
        };
      }
      return null;
    });
    this.options.flags.invalidate(flag, scope);
    const rolled = rolloutOf(after)!;
    this.remember(flag, scope, rolled);
    this.windows.delete(rolled.id);
    if (rolled.state === "rolled_back") return rolled;
    logger.warn({ flag, scope, rolloutId: rolled.id, automatic: rolled.automatic }, "rollout rolled back; verifying");
    return this.verify(flag, scope);
  }

  /** (Re-)run rollback verification and persist the report. */
  async verify(flag: FeatureFlagKey, scope: string): Promise<RolloutRecord> {
    const row = await this.options.store.read(flag, scope);
    const rollout = rolloutOf(row);
    if (!rollout) throw new RolloutError("NOT_FOUND", `no rollout recorded for ${flag} in ${scope}`);
    if (!ROLLED_BACK_STATES.has(rollout.state)) {
      throw new RolloutError("INVALID_STATE", `rollout ${rollout.id} is ${rollout.state}; only rollbacks are verified`);
    }

    const now = new Date(this.now());
    const propagatedAt = new Date(Date.parse(rollout.endedAt ?? now.toISOString()) + this.options.flags.cacheTtlMs);
    const checks: VerificationCheckResult[] = [];

    checks.push(
      row!.enabled === rollout.previousEnabled
        ? { name: "stored_value_restored", status: "pass", detail: `stored value is ${row!.enabled}` }
        : { name: "stored_value_restored", status: "fail", detail: `stored value is ${row!.enabled}, expected ${rollout.previousEnabled}; run rollback again` },
    );

    this.options.flags.invalidate(flag, scope);
    const parsed = parseScopeString(scope) ?? undefined;
    const served = await this.options.flags.isEnabled(flag, parsed);
    checks.push(
      served === rollout.previousEnabled
        ? { name: "local_cache_consistent", status: "pass", detail: `this process now serves ${served}` }
        : { name: "local_cache_consistent", status: "fail", detail: `this process serves ${served}, expected ${rollout.previousEnabled}` },
    );

    checks.push(
      now >= propagatedAt
        ? { name: "replica_caches_expired", status: "pass", detail: "every replica's cached value has expired" }
        : { name: "replica_caches_expired", status: "pending", detail: `other replicas may serve the old value until ${propagatedAt.toISOString()}` },
    );

    for (const check of this.options.checks?.[flag] ?? []) {
      try {
        const result = await check.run({ flag, scope, rollout, now, propagatedAt });
        checks.push({ name: check.name, ...result });
      } catch (err) {
        checks.push({ name: check.name, status: "fail", detail: `check errored: ${(err as Error).message}` });
      }
    }

    const verified = checks.every((c) => c.status === "pass" || c.status === "skipped");
    const report: VerificationReport = {
      verifiedAt: now.toISOString(),
      status: verified ? "verified" : "unverified",
      propagatedAt: propagatedAt.toISOString(),
      checks,
    };

    const after = await this.options.store.mutate(flag, scope, (current) => {
      const r = rolloutOf(current);
      // A newer rollout replaced this one while we were checking; keep it.
      if (!r || r.id !== rollout.id || !ROLLED_BACK_STATES.has(r.state)) return null;
      return {
        enabled: current!.enabled,
        rollout: { ...r, state: verified ? "rolled_back" : "rollback_unverified", verification: report },
      };
    });
    const result = rolloutOf(after) ?? rollout;
    this.remember(flag, scope, result);

    if (verified) {
      logger.info({ flag, scope, rolloutId: rollout.id }, "rollback verified");
    } else {
      const failing = checks.filter((c) => c.status === "fail");
      logger[failing.length ? "error" : "warn"]({ flag, scope, rolloutId: rollout.id, checks }, "rollback not yet verified");
      if (!failing.length && this.options.autoReverify) this.scheduleReverify(flag, scope, propagatedAt);
    }
    return result;
  }

  /** Promote an active rollout: the flag stays enabled and the guard stops watching it. */
  async complete(flag: FeatureFlagKey, scope: string, input: { actor: string; reason: string }): Promise<RolloutRecord> {
    const after = await this.options.store.mutate(flag, scope, (current) => {
      const r = rolloutOf(current);
      if (!r) throw new RolloutError("NOT_FOUND", `no rollout recorded for ${flag} in ${scope}`);
      if (r.state !== "active") throw new RolloutError("INVALID_STATE", `rollout ${r.id} is ${r.state}, not active`);
      const next: RolloutRecord = {
        ...r,
        state: "completed",
        endedAt: new Date(this.now()).toISOString(),
        endedBy: input.actor,
        endReason: input.reason,
      };
      return { enabled: current!.enabled, rollout: next, audit: { actor: input.actor, reason: auditReason(r, `completed: ${input.reason}`) } };
    });
    const done = rolloutOf(after)!;
    this.remember(flag, scope, done);
    this.windows.delete(done.id);
    return done;
  }

  /** Cancel pending re-verification timers (call on shutdown). */
  close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private scheduleReverify(flag: FeatureFlagKey, scope: string, at: Date): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.verify(flag, scope).catch((err) => logger.error({ err, flag, scope }, "scheduled rollback re-verification failed"));
    }, Math.max(0, at.getTime() - this.now()) + 1_000);
    timer.unref?.();
    this.timers.add(timer);
  }

  private windowFor(rollout: RolloutRecord) {
    let window = this.windows.get(rollout.id);
    if (!window) this.windows.set(rollout.id, (window = []));
    return window;
  }

  private remember(flag: FeatureFlagKey, scope: string, rollout: RolloutRecord | null) {
    this.known.set(`${flag}:${scope}`, { rollout, fetchedAt: this.now() });
  }

  /** The active rollout for a flag + scope, re-read at most once per flag-cache TTL. */
  private async activeRollout(flag: FeatureFlagKey, scope: string): Promise<RolloutRecord | null> {
    const key = `${flag}:${scope}`;
    const cached = this.known.get(key);
    let rollout = cached?.rollout ?? null;
    if (!cached || this.now() - cached.fetchedAt >= this.options.flags.cacheTtlMs) {
      rollout = rolloutOf(await this.options.store.read(flag, scope));
      this.remember(flag, scope, rollout);
    }
    return rollout?.state === "active" ? rollout : null;
  }
}

export const ROLLOUT_FLAG_KEYS = Object.values(FEATURE_FLAGS) as [FeatureFlagKey, ...FeatureFlagKey[]];
