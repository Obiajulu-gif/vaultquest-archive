/**
 * Quorum, freshness, and ledger-identity policy for balance-critical Stellar
 * RPC reads (#596).
 *
 * Failover (see `stellar-wallet-connect/src/core/horizonPool.ts` and
 * `stellarRpcPool.ts`) only guarantees a request eventually reaches *some*
 * healthy node — it says nothing about whether that node's data is fresh,
 * or whether it agrees with other independent providers. Deposits,
 * withdrawals, prize settlement, and reconciliation all read balances or
 * ledger state before authorizing a mutation; this module gives those call
 * sites a way to require several independent samples to agree, be recent,
 * and reference a consistent ledger before the read is trusted.
 *
 * Read-only degraded behaviour (e.g. showing a "may be stale" balance in a
 * dashboard) is deliberately kept separate from `assertAuthorizable`, which
 * is the only function that should gate a fund-moving transaction.
 */

export interface CriticalReadSample<T> {
  /** Stable identifier for the independent provider that produced this sample. */
  provider: string;
  value: T;
  /** Ledger sequence the value was read against. */
  ledgerSequence: number;
  /** Ledger close time, epoch ms. */
  ledgerCloseTime: number;
  /** Network passphrase the provider believes it is connected to. */
  networkPassphrase?: string;
  /** Round-trip latency in ms, used to flag slow providers. */
  latencyMs?: number;
  /** Set when the provider failed to respond at all. */
  error?: Error;
}

export interface CriticalReadPolicyOptions {
  /** Minimum number of independent, agreeing, in-policy providers required. */
  minQuorum: number;
  /** Maximum age (ms) between now and a sample's ledger close time. */
  maxFreshnessMs: number;
  /** Maximum allowed ledger-sequence spread between agreeing providers. */
  maxLedgerDivergence: number;
  /** Samples slower than this are quarantined as "slow" and excluded from quorum. */
  maxLatencyMs?: number;
  /** Expected network passphrase; mismatches are always quarantined. */
  expectedNetworkPassphrase?: string;
  now?: () => number;
}

export type QuarantineReason =
  | "error"
  | "stale"
  | "slow"
  | "wrong_network"
  | "diverges_from_majority"
  | "flapping";

export interface QuarantinedSample {
  provider: string;
  reason: QuarantineReason;
  detail?: string;
}

export interface CriticalReadDecision<T> {
  /** True when quorum, freshness, and ledger-identity policy are all satisfied. */
  ok: boolean;
  /**
   * True when a value could be produced (e.g. for read-only display) even
   * though `ok` is false. Degraded reads must never be used to authorize a
   * transaction — see `assertAuthorizable`.
   */
  degraded: boolean;
  value: T | null;
  agreeingProviders: string[];
  quarantined: QuarantinedSample[];
  minLedgerSequence: number | null;
  maxLedgerSequence: number | null;
  reasons: string[];
}

export type CriticalReadFailureKind =
  | "quorum_not_met"
  | "stale"
  | "conflicting"
  | "flapping_providers";

export class CriticalReadPolicyError extends Error {
  readonly kind: CriticalReadFailureKind;
  readonly decision: CriticalReadDecision<unknown>;

  constructor(kind: CriticalReadFailureKind, decision: CriticalReadDecision<unknown>) {
    super(`critical read policy violation (${kind}): ${decision.reasons.join("; ")}`);
    this.name = "CriticalReadPolicyError";
    this.kind = kind;
    this.decision = decision;
  }
}

interface FlapState {
  agreedLastTime: boolean | null;
  flips: number;
}

/**
 * Tracks per-provider agree/disagree flips across repeated evaluations so a
 * provider that alternates between agreeing and diverging (rather than
 * failing consistently) can be identified and quarantined, instead of
 * silently averaging out over time.
 */
export class ProviderStabilityTracker {
  private readonly state = new Map<string, FlapState>();

  constructor(private readonly flapThreshold = 3) {}

  record(provider: string, agreed: boolean): void {
    const entry = this.state.get(provider) ?? { agreedLastTime: null, flips: 0 };
    if (entry.agreedLastTime !== null && entry.agreedLastTime !== agreed) {
      entry.flips += 1;
    }
    entry.agreedLastTime = agreed;
    this.state.set(provider, entry);
  }

  isFlapping(provider: string): boolean {
    return (this.state.get(provider)?.flips ?? 0) >= this.flapThreshold;
  }

  reset(provider?: string): void {
    if (provider) {
      this.state.delete(provider);
    } else {
      this.state.clear();
    }
  }
}

export class CriticalReadPolicy {
  constructor(private readonly opts: CriticalReadPolicyOptions) {}

  /**
   * Evaluate a set of independent samples for the same logical read.
   * `equals` decides whether two providers' values agree (e.g. balances
   * within an allowed dust tolerance, or strict equality for exact reads).
   */
  evaluate<T>(
    samples: CriticalReadSample<T>[],
    equals: (a: T, b: T) => boolean,
    stability?: ProviderStabilityTracker
  ): CriticalReadDecision<T> {
    const now = this.opts.now?.() ?? Date.now();
    const quarantined: QuarantinedSample[] = [];
    const reasons: string[] = [];
    const live: CriticalReadSample<T>[] = [];

    for (const sample of samples) {
      if (sample.error) {
        quarantined.push({ provider: sample.provider, reason: "error", detail: sample.error.message });
        continue;
      }
      if (
        this.opts.expectedNetworkPassphrase &&
        sample.networkPassphrase &&
        sample.networkPassphrase !== this.opts.expectedNetworkPassphrase
      ) {
        quarantined.push({ provider: sample.provider, reason: "wrong_network" });
        continue;
      }
      const age = now - sample.ledgerCloseTime;
      if (age > this.opts.maxFreshnessMs) {
        quarantined.push({
          provider: sample.provider,
          reason: "stale",
          detail: `ledger age ${age}ms exceeds ${this.opts.maxFreshnessMs}ms`
        });
        continue;
      }
      if (this.opts.maxLatencyMs && (sample.latencyMs ?? 0) > this.opts.maxLatencyMs) {
        quarantined.push({
          provider: sample.provider,
          reason: "slow",
          detail: `latency ${sample.latencyMs}ms exceeds ${this.opts.maxLatencyMs}ms`
        });
        continue;
      }
      if (stability?.isFlapping(sample.provider)) {
        quarantined.push({ provider: sample.provider, reason: "flapping" });
        continue;
      }
      live.push(sample);
    }

    // Group surviving samples by agreement (majority clustering).
    const groups: Array<{ value: T; samples: CriticalReadSample<T>[] }> = [];
    for (const sample of live) {
      const group = groups.find((g) => equals(g.value, sample.value));
      if (group) {
        group.samples.push(sample);
      } else {
        groups.push({ value: sample.value, samples: [sample] });
      }
    }
    groups.sort((a, b) => b.samples.length - a.samples.length);
    const majority = groups[0];

    for (const group of groups.slice(1)) {
      for (const sample of group.samples) {
        quarantined.push({ provider: sample.provider, reason: "diverges_from_majority" });
      }
    }

    if (stability) {
      for (const sample of live) {
        stability.record(sample.provider, majority ? equals(sample.value, majority.value) : false);
      }
    }

    if (!majority) {
      reasons.push("no in-policy samples available");
      return {
        ok: false,
        degraded: false,
        value: null,
        agreeingProviders: [],
        quarantined,
        minLedgerSequence: null,
        maxLedgerSequence: null,
        reasons
      };
    }

    const ledgerSeqs = majority.samples.map((s) => s.ledgerSequence);
    const minLedgerSequence = Math.min(...ledgerSeqs);
    const maxLedgerSequence = Math.max(...ledgerSeqs);
    const divergence = maxLedgerSequence - minLedgerSequence;

    if (divergence > this.opts.maxLedgerDivergence) {
      reasons.push(
        `agreeing providers reference ledgers ${minLedgerSequence}-${maxLedgerSequence}, ` +
          `exceeding max divergence ${this.opts.maxLedgerDivergence}`
      );
    }

    const quorumMet = majority.samples.length >= this.opts.minQuorum;
    if (!quorumMet) {
      reasons.push(
        `only ${majority.samples.length} of required ${this.opts.minQuorum} providers agree`
      );
    }

    const ok = quorumMet && divergence <= this.opts.maxLedgerDivergence;

    return {
      ok,
      // A degraded, non-authorizable value is still returned for read-only
      // display when at least one live sample exists.
      degraded: !ok && majority.samples.length > 0,
      value: majority.value,
      agreeingProviders: majority.samples.map((s) => s.provider),
      quarantined,
      minLedgerSequence,
      maxLedgerSequence,
      reasons
    };
  }

  /**
   * Throws unless the decision fully satisfies policy. Never returns a
   * degraded value — callers authorizing withdrawals, admin repairs, or
   * other fund-moving actions must use this instead of reading
   * `decision.value` directly.
   */
  assertAuthorizable<T>(decision: CriticalReadDecision<T>): T {
    if (decision.ok && decision.value !== null) {
      return decision.value;
    }

    let kind: CriticalReadFailureKind = "quorum_not_met";
    if (decision.reasons.some((r) => r.includes("ledgers"))) {
      kind = "conflicting";
    } else if (decision.quarantined.some((q) => q.reason === "stale") && decision.agreeingProviders.length === 0) {
      kind = "stale";
    } else if (decision.quarantined.some((q) => q.reason === "flapping")) {
      kind = "flapping_providers";
    }

    throw new CriticalReadPolicyError(kind, decision as CriticalReadDecision<unknown>);
  }
}

/**
 * Runs independent read functions in parallel with a per-provider timeout,
 * turning rejections/timeouts into `error` samples rather than letting one
 * slow/failed provider block the others.
 */
export async function collectCriticalReadSamples<T>(
  readers: Array<{
    provider: string;
    read: () => Promise<Omit<CriticalReadSample<T>, "provider" | "latencyMs" | "error">>;
  }>,
  opts: { timeoutMs?: number; now?: () => number } = {}
): Promise<CriticalReadSample<T>[]> {
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? 8000;

  return Promise.all(
    readers.map(async ({ provider, read }): Promise<CriticalReadSample<T>> => {
      const start = now();
      try {
        const result = await Promise.race([
          read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`provider ${provider} timed out after ${timeoutMs}ms`)), timeoutMs)
          )
        ]);
        return { ...result, provider, latencyMs: now() - start };
      } catch (err) {
        return {
          provider,
          value: null as unknown as T,
          ledgerSequence: 0,
          ledgerCloseTime: 0,
          latencyMs: now() - start,
          error: err instanceof Error ? err : new Error(String(err))
        };
      }
    })
  );
}
