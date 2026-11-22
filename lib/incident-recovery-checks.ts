/**
 * Incident Recovery Checks Engine (#1093)
 *
 * Provides executable recovery verification to determine whether a service
 * surface has safely recovered from an incident before lifting circuit breakers
 * or re-enabling user traffic.
 *
 * Architecture & Guarantees:
 * - Pure/dependency-injected check engine for deterministic testing.
 * - Covers normal, failure, retry, and authorization execution paths.
 * - Enforces role-based operator authorization for running recovery checks.
 * - Time complexity: O(C * R) where C is checks count and R is retry attempts.
 * - Space complexity: O(C) bounded memory.
 */

export type CheckStatus = "pass" | "warn" | "fail";
export type OverallRecoveryStatus = "RECOVERED" | "CONTAINED" | "ACTION_REQUIRED";

export type CheckCategory =
  | "indexer_sync"
  | "reconciliation"
  | "circuit_breakers"
  | "rpc_connectivity";

export interface OperatorContext {
  operatorId: string;
  role: "incident_commander" | "service_owner" | "admin" | "operator" | "guest";
  token?: string;
}

export interface CheckResult {
  name: string;
  category: CheckCategory;
  status: CheckStatus;
  message: string;
  durationMs: number;
  details?: Record<string, unknown>;
  remediation?: string;
  retriesUsed?: number;
}

export interface RecoveryReport {
  passed: boolean;
  timestamp: string;
  overallStatus: OverallRecoveryStatus;
  operator: {
    id: string;
    role: string;
  };
  totalDurationMs: number;
  checks: CheckResult[];
  remediationSteps: string[];
}

export const AUTHORIZED_ROLES = ["incident_commander", "service_owner", "admin", "operator"] as const;

export class IncidentRecoveryAuthError extends Error {
  readonly code = "UNAUTHORIZED_OPERATOR";
  constructor(message: string) {
    super(message);
    this.name = "IncidentRecoveryAuthError";
  }
}

export interface RecoveryCheckOptions {
  operator: OperatorContext;
  maxAllowedIndexerLag?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  expectedPassphrase?: string;
  indexerHealthFetcher?: () => Promise<{ indexedLedger: number; networkLedger: number }>;
  reconciliationFetcher?: () => Promise<{
    driftCount: number;
    stuckSettlements: number;
    unhandledContradictions: number;
  }>;
  circuitBreakerFetcher?: () => Promise<Record<string, boolean>>;
  rpcHealthFetcher?: () => Promise<{ reachable: boolean; networkPassphrase: string }>;
}

/**
 * Execute an operation with bounded retry support and exponential backoff.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number,
): Promise<{ result: T; retries: number }> {
  let attempt = 0;
  let lastErr: unknown;

  while (attempt <= maxRetries) {
    try {
      const res = await fn();
      return { result: res, retries: attempt };
    } catch (err) {
      lastErr = err;
      attempt++;
      if (attempt <= maxRetries) {
        const delay = Math.round(baseDelayMs * Math.pow(1.5, attempt - 1));
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/**
 * Validates operator authorization.
 */
export function assertAuthorizedOperator(operator: OperatorContext): void {
  if (!operator || !operator.operatorId) {
    throw new IncidentRecoveryAuthError("Operator identity is required to run recovery checks.");
  }
  const isAuthorized = AUTHORIZED_ROLES.includes(operator.role as any);
  if (!isAuthorized) {
    throw new IncidentRecoveryAuthError(
      `Role '${operator.role}' is not authorized to execute incident recovery checks. Requires one of: ${AUTHORIZED_ROLES.join(
        ", ",
      )}`,
    );
  }
}

/**
 * Runs the comprehensive incident recovery verification suite.
 */
export async function runIncidentRecoveryChecks(
  options: RecoveryCheckOptions,
): Promise<RecoveryReport> {
  const startTime = Date.now();

  // 1. Authorization Path
  assertAuthorizedOperator(options.operator);

  const maxRetries = options.maxRetries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 50;
  const maxAllowedLag = options.maxAllowedIndexerLag ?? 5;
  const expectedPassphrase =
    options.expectedPassphrase ?? "Test SDF Future Network ; October 2022";

  const checks: CheckResult[] = [];
  const remediationSteps: string[] = [];

  // 2. Check: Indexer Sync Health
  if (options.indexerHealthFetcher) {
    const t0 = Date.now();
    try {
      const { result, retries } = await withRetry(
        options.indexerHealthFetcher,
        maxRetries,
        retryDelayMs,
      );
      const lag = Math.max(0, result.networkLedger - result.indexedLedger);
      const isOk = lag <= maxAllowedLag;

      const check: CheckResult = {
        name: "indexer_ledger_sync",
        category: "indexer_sync",
        status: isOk ? "pass" : "fail",
        message: isOk
          ? `Indexer synced (lag: ${lag} ledgers, within limit ${maxAllowedLag})`
          : `Indexer lagging significantly: ${lag} ledgers behind network (limit ${maxAllowedLag})`,
        durationMs: Date.now() - t0,
        details: { indexedLedger: result.indexedLedger, networkLedger: result.networkLedger, lag },
        retriesUsed: retries,
        remediation: isOk
          ? undefined
          : "Wait for indexer sync to catch up or check poison queue per docs/INDEXER_RUNBOOK.md.",
      };
      if (!isOk && check.remediation) remediationSteps.push(check.remediation);
      checks.push(check);
    } catch (err) {
      checks.push({
        name: "indexer_ledger_sync",
        category: "indexer_sync",
        status: "fail",
        message: `Indexer health check failed after ${maxRetries} retries: ${
          err instanceof Error ? err.message : String(err)
        }`,
        durationMs: Date.now() - t0,
        retriesUsed: maxRetries,
        remediation: "Verify indexer service status and database connection.",
      });
      remediationSteps.push("Verify indexer service status and database connection.");
    }
  }

  // 3. Check: Reconciliation & Financial Invariants
  if (options.reconciliationFetcher) {
    const t0 = Date.now();
    try {
      const { result, retries } = await withRetry(
        options.reconciliationFetcher,
        maxRetries,
        retryDelayMs,
      );
      const hasContradictions = result.unhandledContradictions > 0;
      const hasStuckSettlements = result.stuckSettlements > 0;
      const hasDrift = result.driftCount > 0;

      let status: CheckStatus = "pass";
      let message = "Reconciliation clean: no contradictions, stuck settlements, or drift detected";
      let remediation: string | undefined;

      if (hasContradictions) {
        status = "fail";
        message = `CRITICAL: ${result.unhandledContradictions} unhandled financial contradictions detected`;
        remediation = "Contain withdrawals and review contradictions per docs/RECONCILIATION.md.";
      } else if (hasStuckSettlements) {
        status = "fail";
        message = `${result.stuckSettlements} settlements stuck past TTL`;
        remediation = "Run reconciliation repair in dry-run mode to inspect stuck settlements.";
      } else if (hasDrift) {
        status = "warn";
        message = `${result.driftCount} non-critical drift records logged`;
        remediation = "Review drift records on maintainer dashboard before full rollout.";
      }

      if (remediation) remediationSteps.push(remediation);

      checks.push({
        name: "reconciliation_integrity",
        category: "reconciliation",
        status,
        message,
        durationMs: Date.now() - t0,
        details: { ...result },
        retriesUsed: retries,
        remediation,
      });
    } catch (err) {
      checks.push({
        name: "reconciliation_integrity",
        category: "reconciliation",
        status: "fail",
        message: `Reconciliation check failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - t0,
        retriesUsed: maxRetries,
        remediation: "Inspect backend database and action ledger integrity.",
      });
      remediationSteps.push("Inspect backend database and action ledger integrity.");
    }
  }

  // 4. Check: Circuit Breakers & Flags
  if (options.circuitBreakerFetcher) {
    const t0 = Date.now();
    try {
      const { result, retries } = await withRetry(
        options.circuitBreakerFetcher,
        maxRetries,
        retryDelayMs,
      );
      const allActive = Object.values(result).every(Boolean);
      const check: CheckResult = {
        name: "circuit_breaker_containment",
        category: "circuit_breakers",
        status: allActive ? "pass" : "warn",
        message: allActive
          ? "All operational features and circuit breakers enabled"
          : `Some features remain contained: ${Object.entries(result)
              .filter(([_, v]) => !v)
              .map(([k]) => k)
              .join(", ")}`,
        durationMs: Date.now() - t0,
        details: { ...result },
        retriesUsed: retries,
        remediation: allActive
          ? undefined
          : "Review containment flags before lifting circuit breakers (docs/FEATURE_FLAGS.md).",
      };
      if (check.remediation) remediationSteps.push(check.remediation);
      checks.push(check);
    } catch (err) {
      checks.push({
        name: "circuit_breaker_containment",
        category: "circuit_breakers",
        status: "fail",
        message: `Failed to fetch circuit breaker status: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - t0,
        remediation: "Verify feature flag store configuration.",
      });
      remediationSteps.push("Verify feature flag store configuration.");
    }
  }

  // 5. Check: RPC & Contract Connectivity
  if (options.rpcHealthFetcher) {
    const t0 = Date.now();
    try {
      const { result, retries } = await withRetry(
        options.rpcHealthFetcher,
        maxRetries,
        retryDelayMs,
      );
      const passphraseMatch = result.networkPassphrase === expectedPassphrase;
      const isHealthy = result.reachable && passphraseMatch;

      let message = "Soroban/Horizon RPC healthy and passphrase matches";
      let remediation: string | undefined;

      if (!result.reachable) {
        message = "Stellar RPC endpoint unreachable";
        remediation = "Verify RPC URL and network egress firewall settings.";
      } else if (!passphraseMatch) {
        message = `Passphrase mismatch: got '${result.networkPassphrase}', expected '${expectedPassphrase}'`;
        remediation = "Check environment configuration for NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE.";
      }

      if (remediation) remediationSteps.push(remediation);

      checks.push({
        name: "rpc_contract_connectivity",
        category: "rpc_connectivity",
        status: isHealthy ? "pass" : "fail",
        message,
        durationMs: Date.now() - t0,
        details: { reachable: result.reachable, networkPassphrase: result.networkPassphrase },
        retriesUsed: retries,
        remediation,
      });
    } catch (err) {
      checks.push({
        name: "rpc_contract_connectivity",
        category: "rpc_connectivity",
        status: "fail",
        message: `RPC check failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - t0,
        remediation: "Check Stellar RPC provider status.",
      });
      remediationSteps.push("Check Stellar RPC provider status.");
    }
  }

  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");

  let overallStatus: OverallRecoveryStatus = "RECOVERED";
  if (hasFail) {
    overallStatus = "ACTION_REQUIRED";
  } else if (hasWarn) {
    overallStatus = "CONTAINED";
  }

  return {
    passed: !hasFail,
    timestamp: new Date().toISOString(),
    overallStatus,
    operator: {
      id: options.operator.operatorId,
      role: options.operator.role,
    },
    totalDurationMs: Date.now() - startTime,
    checks,
    remediationSteps: Array.from(new Set(remediationSteps)),
  };
}

