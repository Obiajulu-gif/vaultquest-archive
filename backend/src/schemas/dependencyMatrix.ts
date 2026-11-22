/**
 * VaultQuest External Dependency Degradation Matrix
 *
 * Documents all critical third-party dependencies, their failure modes,
 * fallback UX/API behavior, and user-safe operational guidance.
 */

export interface DependencyFailureMode {
  scenario: string;
  trigger: string;
  userImpact: string;
  fallbackBehavior: string;
  retryStrategy: string;
  timeToRecover: string;
}

export interface DependencyDefinition {
  /** Unique identifier for this dependency. */
  id: string;
  /** Display name (e.g., "Stellar Soroban RPC"). */
  name: string;
  /** Whether this dependency blocks vault deposits, transfers, or other mutations. */
  requiredForMutations: boolean;
  /** Whether this dependency is used for critical reads (user balance, account state). */
  requiredForReads: boolean;
  /** External service URL or connection string (sanitized). */
  configEnvVar: string;
  /** What this dependency does in the system. */
  purpose: string;
  /** Primary fallback strategy when dependency is unavailable. */
  primaryFallback: string;
  /** Failure modes and recovery steps. */
  failureModes: DependencyFailureMode[];
}

export interface DependencyDegradationMatrix {
  version: string;
  lastUpdated: string;
  dependencies: DependencyDefinition[];
}

/**
 * VaultQuest Critical Dependency Matrix
 *
 * Each dependency is classified by impact and provided with documented
 * fallback behavior to ensure user-safe degradation.
 */
export const VAULTQUEST_DEPENDENCY_MATRIX: DependencyDegradationMatrix = {
  version: "1.0.0",
  lastUpdated: "2025-10-17",
  dependencies: [
    {
      id: "database",
      name: "PostgreSQL Database",
      requiredForMutations: true,
      requiredForReads: true,
      configEnvVar: "DATABASE_URL",
      purpose:
        "Primary data store for user accounts, vault state, deposits, redemptions, and audit logs. Single source of truth for all persistent state.",
      primaryFallback:
        "None. Database unavailability blocks all mutations and most reads. Emergency: fail-closed with user-safe error message and retry-after header.",
      failureModes: [
        {
          scenario: "Connection timeout",
          trigger: "Network partition or backend resource exhaustion",
          userImpact: "Cannot deposit, transfer funds, or claim prizes. Read-only access may be available via snapshot.",
          fallbackBehavior:
            "Return 503 Service Unavailable with Retry-After header. Serve read-only cached snapshots to authenticated users.",
          retryStrategy: "Exponential backoff with jitter. Retry after 30 seconds.",
          timeToRecover: "Depends on infrastructure; typically <5 minutes.",
        },
        {
          scenario: "Connection pool exhaustion",
          trigger: "Spike in concurrent requests or slow queries blocking connections",
          userImpact: "Requests queue; mutations and reads timeout.",
          fallbackBehavior:
            "Circuit breaker engages after 3 consecutive failures. New requests immediately fail with 503. Cached reads degrade gracefully.",
          retryStrategy: "Halt new queries until connection pool recovers; monitor query duration.",
          timeToRecover: "<2 minutes if queries complete; may require manual intervention if long-running queries block.",
        },
        {
          scenario: "Data inconsistency detected",
          trigger: "Foreign key violation, constraint violation, or schema mismatch",
          userImpact: "Mutation fails (e.g., deposit rejected). User sees error but no funds are debited.",
          fallbackBehavior:
            "Idempotency keys ensure no duplicate effects. Transaction rolls back. User is informed and can retry.",
          retryStrategy: "Retry with exponential backoff. Investigate root cause in logs.",
          timeToRecover: "Operator intervention required; data validation and potential manual correction.",
        },
      ],
    },
    {
      id: "soroban_rpc",
      name: "Stellar Soroban RPC",
      requiredForMutations: true,
      requiredForReads: true,
      configEnvVar: "SOROBAN_RPC_URL",
      purpose:
        "Queries smart contract state (vault pools, prize round settings, user participation). Required to validate deposit eligibility, compute yields, and settle transactions on-chain.",
      primaryFallback:
        "Failover to secondary RPC endpoint if configured. Fallback to cached pool snapshots for read-heavy operations (e.g., UI queries). Fail-closed for mutations.",
      failureModes: [
        {
          scenario: "RPC endpoint latency spike (>10s)",
          trigger: "Soroban RPC provider degradation or network congestion",
          userImpact: "Deposit and query operations slow. UI may timeout. User experiences poor UX.",
          fallbackBehavior:
            "Timeout after 5 seconds. Retry with fallback endpoint if available. Cache-first for reads; degrade to last-known state.",
          retryStrategy:
            "Timeout + circuit breaker. After 3 consecutive failures on all endpoints, mark RPC as degraded and serve cached data.",
          timeToRecover: "Depends on Soroban RPC provider; typically auto-recovery within 2-5 minutes.",
        },
        {
          scenario: "RPC endpoint returns 5xx error",
          trigger: "Soroban RPC internal error, maintenance, or transient issue",
          userImpact: "Deposit validation fails. User is blocked from proceeding.",
          fallbackBehavior:
            "Retry with next endpoint in pool. If all fail, serve cached contract state snapshot for reads. Pause mutations.",
          retryStrategy: "Exponential backoff across endpoint pool. Max 3 attempts total.",
          timeToRecover: "<1 minute if transient. May require provider intervention if persistent.",
        },
        {
          scenario: "Stale data from RPC (ledger lag >10 blocks)",
          trigger: "RPC endpoint behind in syncing the ledger",
          userImpact:
            "User sees outdated pool state or participant list. May attempt invalid transactions (e.g., deposit to closed round).",
          fallbackBehavior:
            "Compare timestamps: if RPC data is >2 blocks old, mark as stale and warn user. Do not allow mutations on stale state.",
          retryStrategy: "Retry after 10 seconds. Query multiple RPC endpoints and take the most recent state.",
          timeToRecover: "Automatic once RPC catches up (typically <30 seconds).",
        },
        {
          scenario: "RPC endpoint misconfigured or unreachable",
          trigger: "Invalid URL, incorrect credentials, or DNS failure",
          userImpact: "All RPC calls fail immediately. App cannot operate.",
          fallbackBehavior:
            "During startup, validate RPC URL and fail loudly in logs. At runtime, serve cached data and pause mutations.",
          retryStrategy: "No automatic retry; requires operator fix to SOROBAN_RPC_URL config.",
          timeToRecover: "Operator intervention required; typically <5 minutes once config is corrected.",
        },
      ],
    },
    {
      id: "redis_cache",
      name: "Redis Cache",
      requiredForMutations: false,
      requiredForReads: false,
      configEnvVar: "REDIS_URL",
      purpose:
        "Speeds up pool queries, user balance reads, and category lookups. Reduces load on database and RPC. Not required for correctness.",
      primaryFallback:
        "Bypass cache entirely. All queries fall through to database and RPC. Performance degrades but correctness is maintained.",
      failureModes: [
        {
          scenario: "Redis connection refused",
          trigger: "Redis service down or network partition",
          userImpact: "No user-facing impact if REDIS_URL is optional. Queries are slower.",
          fallbackBehavior:
            "Log warning. Continue operating without cache. Every read hits database or RPC directly.",
          retryStrategy: "Lazy reconnection on next cache operation. Exponential backoff.",
          timeToRecover: "<1 minute if Redis restarts. Automatic once connection is restored.",
        },
        {
          scenario: "Cache key eviction under load",
          trigger: "Redis memory pressure or TTL expiration",
          userImpact: "Slightly increased latency for cache misses. No correctness impact.",
          fallbackBehavior:
            "Hit database or RPC on cache miss. Refresh cache on next write.",
          retryStrategy: "Automatic; no retry needed. Cache is best-effort.",
          timeToRecover: "Immediate on next access; populate cache from primary source.",
        },
        {
          scenario: "Cache data inconsistency with database",
          trigger: "Race condition during write or cache not invalidated after mutation",
          userImpact: "User may see stale pool state or incorrect user balance briefly.",
          fallbackBehavior:
            "Invalidate cache on write. Use versioning to detect stale cache entries. Default to database on mismatch.",
          retryStrategy: "Refresh cache immediately after mutation.",
          timeToRecover: "Immediate (<1 second) on next read.",
        },
      ],
    },
    {
      id: "indexer",
      name: "Stellar Indexer (Soroban Event Stream)",
      requiredForMutations: false,
      requiredForReads: false,
      configEnvVar: "INDEXER_CONTRACT_IDS + SOROBAN_RPC_URL",
      purpose:
        "Background worker polls Soroban RPC for smart contract events. Reconciles on-chain state with database. Powers audit trails and drift detection.",
      primaryFallback:
        "Indexer pauses but does not block user operations. Drift detection is skipped. Manual reconciliation operator task available.",
      failureModes: [
        {
          scenario: "Indexer falls behind (cursor lag >100 ledgers)",
          trigger: "Soroban RPC rate limit, network jitter, or indexer worker bottleneck",
          userImpact:
            "Drift detection is delayed. Audit trail lags. No impact on real-time user deposits or withdrawals.",
          fallbackBehavior:
            "Log warning. Indexer continues consuming events. Admin dashboard shows lag. Manual drift detection can be triggered.",
          retryStrategy: "Automatic backfill mode. Increase batch size if rate limits allow.",
          timeToRecover: "Depends on lag; typically <1 hour for 1000-ledger lag.",
        },
        {
          scenario: "Indexer event fetch fails (RPC error or cursor invalid)",
          trigger: "RPC temporary failure or cursor corruption",
          userImpact:
            "Indexer pauses. Audit trail halts. Drift detection stops. No immediate user impact.",
          fallbackBehavior:
            "Log error with cursor value. Pause indexer. Admin notified via alert. Manual cursor reset available.",
          retryStrategy: "Exponential backoff. If cursor is confirmed invalid, operator resets cursor and restarts indexer.",
          timeToRecover: "Manual operator intervention required; typically <10 minutes.",
        },
        {
          scenario: "Contract event schema mismatch (unexpected event structure)",
          trigger: "Smart contract code upgrade or malformed event",
          userImpact:
            "Indexer crashes or skips events. Drift detection becomes unreliable.",
          fallbackBehavior:
            "Index er catches decode errors and logs them. Unknown events are skipped with warning. Indexer resumes on next event.",
          retryStrategy: "Manual review and update of event decoder if contract code changes.",
          timeToRecover: "Operator intervention required to update decoder; typically <30 minutes.",
        },
      ],
    },
    {
      id: "sendgrid_email",
      name: "SendGrid Email Service",
      requiredForMutations: false,
      requiredForReads: false,
      configEnvVar: "SENDGRID_API_KEY, EMAIL_FROM",
      purpose:
        "Sends transactional emails (password reset, welcome emails). Non-critical for core vault operations.",
      primaryFallback:
        "Email service is optional. If SendGrid fails, emails are queued in database for manual retry or async re-send.",
      failureModes: [
        {
          scenario: "SendGrid API rate limit exceeded",
          trigger: "Burst of emails (e.g., mass reset event) or misconfiguration",
          userImpact:
            "Email delivery is delayed. User may not receive password reset link immediately.",
          fallbackBehavior:
            "Queue failed emails in database with backoff. Retry on interval (5min, 15min, 1hr, 1day).",
          retryStrategy: "Exponential backoff. Log failed attempts. Admin notified after 3 retries.",
          timeToRecover: "Automatic retry within configured interval; typically <1 hour.",
        },
        {
          scenario: "SendGrid API key invalid or expired",
          trigger: "Credential rotation or misconfiguration",
          userImpact:
            "All emails fail to send. Password resets and invites do not reach users.",
          fallbackBehavior:
            "Log authentication error. Disable SendGrid service. Queue emails in database. Alert operator.",
          retryStrategy: "No automatic retry. Operator must rotate and update SENDGRID_API_KEY.",
          timeToRecover: "Manual fix required; typically <5 minutes once credentials are renewed.",
        },
        {
          scenario: "SendGrid service down (5xx error)",
          trigger: "SendGrid infrastructure issue or maintenance",
          userImpact:
            "Transactional emails do not send for duration of outage.",
          fallbackBehavior:
            "Return 503 error on email send attempt. Queue in database. Retry on exponential backoff.",
          retryStrategy: "Automatic retry. No action required.",
          timeToRecover: "Automatic once SendGrid recovers; typically <10 minutes.",
        },
      ],
    },
    {
      id: "prisma_migration",
      name: "Prisma Database Schema",
      requiredForMutations: true,
      requiredForReads: true,
      configEnvVar: "DATABASE_URL",
      purpose:
        "Database schema management. Schema mismatch blocks application startup or causes runtime errors.",
      primaryFallback:
        "Graceful schema version mismatch detection. App warns operator and enters read-only mode.",
      failureModes: [
        {
          scenario: "Schema version mismatch (app older than database)",
          trigger: "Database deployed with new migrations; app not updated",
          userImpact:
            "App crashes or returns errors on unknown columns/tables. Users cannot access service.",
          fallbackBehavior:
            "Startup check validates schema version. If mismatch detected, log error and exit with helpful message.",
          retryStrategy: "Operator must deploy matching app version or rollback migrations.",
          timeToRecover: "Manual deployment; typically <5 minutes.",
        },
        {
          scenario: "Migration fails during deployment",
          trigger: "Migration syntax error, constraint violation, or data loss scenario",
          userImpact: "Database state is inconsistent. App may not start.",
          fallbackBehavior:
            "Migration rolls back automatically if transactional. Manual intervention may be needed for non-transactional migrations.",
          retryStrategy: "Fix migration code and re-run deployment.",
          timeToRecover: "Operator intervention; typically <30 minutes.",
        },
      ],
    },
  ],
};

/**
 * Get a dependency definition by ID.
 */
export function getDependencyDefinition(id: string): DependencyDefinition | undefined {
  return VAULTQUEST_DEPENDENCY_MATRIX.dependencies.find((dep) => dep.id === id);
}

/**
 * Get all mutations-critical dependencies.
 */
export function getMutationCriticalDependencies(): DependencyDefinition[] {
  return VAULTQUEST_DEPENDENCY_MATRIX.dependencies.filter((dep) => dep.requiredForMutations);
}

/**
 * Get all read-critical dependencies.
 */
export function getReadCriticalDependencies(): DependencyDefinition[] {
  return VAULTQUEST_DEPENDENCY_MATRIX.dependencies.filter((dep) => dep.requiredForReads);
}
