export const DEPENDENCY_NAMES = [
  "database",
  "soroban_rpc",
  "redis_cache",
  "indexer",
];

export const DEFAULT_DEGRADED_CONFIG = {
  failureThreshold: 3,
  recoveryThreshold: 2,
  retryAfterSeconds: 30,
  maxStaleDataTtlMs: 10 * 60 * 1000,
};

export const VAULTQUEST_DEPENDENCY_MATRIX = {
  version: "1.0.0",
  dependencies: [
    {
      id: "database",
      name: "PostgreSQL Database",
      requiredForMutations: true,
      requiredForReads: true,
      fallbackStrategy: "fail_closed_mutations_stale_snapshot_reads",
      userSafeError:
        "The service is temporarily operating in degraded mode. Please retry shortly.",
      retryStrategy: "exponential_backoff_jitter",
    },
    {
      id: "soroban_rpc",
      name: "Stellar Soroban RPC",
      requiredForMutations: true,
      requiredForReads: false,
      fallbackStrategy: "fail_closed_mutations_cached_chain_state",
      userSafeError:
        "Blockchain submission is temporarily unavailable. Read views remain available.",
      retryStrategy: "exponential_backoff_jitter",
    },
    {
      id: "redis_cache",
      name: "Redis Cache",
      requiredForMutations: false,
      requiredForReads: false,
      fallbackStrategy: "bypass_cache_query_primary_store",
      userSafeError:
        "Live cache is temporarily bypassed; responses may have higher latency.",
      retryStrategy: "bounded_single_retry",
    },
    {
      id: "indexer",
      name: "Event Indexer",
      requiredForMutations: false,
      requiredForReads: false,
      fallbackStrategy: "serve_last_indexed_watermark_with_lag_warning",
      userSafeError:
        "Recent on-chain activity may be delayed while indexing catches up.",
      retryStrategy: "background_poll_backoff",
    },
  ],
};

export class DegradedModeError extends Error {
  constructor(
    message,
    { retryAfterSeconds = 30, unavailableDependencies = [], code = "SERVICE_DEGRADED" } = {},
  ) {
    super(message);
    this.name = "DegradedModeError";
    this.code = code;
    this.statusCode = 503;
    this.retryable = true;
    this.retryAfterSeconds = retryAfterSeconds;
    this.unavailableDependencies = unavailableDependencies;
  }
}

export class DegradationAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DegradationAuthorizationError";
    this.code = "DEGRADATION_UNAUTHORIZED";
    this.statusCode = 403;
  }
}

const OVERRIDE_ROLES = new Set(["admin", "operator"]);

/**
 * Validate that every dependency in the matrix has required fields and user-safe errors.
 */
export function validateDependencyMatrix(matrix = VAULTQUEST_DEPENDENCY_MATRIX) {
  const issues = [];
  if (!matrix || !Array.isArray(matrix.dependencies)) {
    return { valid: false, issues: ["matrix.dependencies must be an array"] };
  }

  const ids = new Set();
  for (const dep of matrix.dependencies) {
    ids.add(dep.id);
    if (!dep.fallbackStrategy) {
      issues.push(`${dep.id}: missing fallbackStrategy`);
    }
    if (!dep.retryStrategy) {
      issues.push(`${dep.id}: missing retryStrategy`);
    }
    if (!dep.userSafeError || /password|postgres:\/\/|stack|sql/i.test(dep.userSafeError)) {
      issues.push(`${dep.id}: missing or unsafe userSafeError`);
    }
  }

  for (const required of ["database", "soroban_rpc"]) {
    if (!ids.has(required)) {
      issues.push(`missing mutation-critical dependency '${required}'`);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Stateful dependency health & fallback controller with hysteresis.
 */
export class DegradedModeController {
  constructor(config = {}, nowFn = () => new Date()) {
    this.config = { ...DEFAULT_DEGRADED_CONFIG, ...config };
    this.nowFn = nowFn;
    this.dependencies = new Map();

    for (const def of VAULTQUEST_DEPENDENCY_MATRIX.dependencies) {
      this.dependencies.set(def.id, {
        name: def.id,
        status: "healthy",
        requiredForMutations: def.requiredForMutations,
        requiredForReads: def.requiredForReads,
        consecutiveFailures: 0,
        consecutiveSuccesses: 1,
        lastCheckedAt: this.nowFn(),
        lastFailureAt: null,
        lastSuccessAt: this.nowFn(),
        overrideReason: null,
      });
    }
  }

  getState(depName) {
    const state = this.dependencies.get(depName);
    if (!state) {
      throw new Error(`Unknown dependency: ${depName}`);
    }
    return { ...state };
  }

  recordFailure(depName, reason = "probe_failed") {
    const state = this.dependencies.get(depName);
    if (!state) throw new Error(`Unknown dependency: ${depName}`);

    const now = this.nowFn();
    state.consecutiveFailures += 1;
    state.consecutiveSuccesses = 0;
    state.lastCheckedAt = now;
    state.lastFailureAt = now;
    state.lastFailureReason = reason;

    if (state.consecutiveFailures >= this.config.failureThreshold) {
      state.status = "unavailable";
    } else {
      state.status = "degraded";
    }

    return { ...state };
  }

  recordSuccess(depName) {
    const state = this.dependencies.get(depName);
    if (!state) throw new Error(`Unknown dependency: ${depName}`);

    const now = this.nowFn();
    state.consecutiveSuccesses += 1;
    state.lastCheckedAt = now;
    state.lastSuccessAt = now;

    if (state.status === "unavailable") {
      if (state.consecutiveSuccesses >= this.config.recoveryThreshold) {
        state.status = "healthy";
        state.consecutiveFailures = 0;
        state.overrideReason = null;
      }
    } else {
      state.status = "healthy";
      state.consecutiveFailures = 0;
      state.overrideReason = null;
    }

    return { ...state };
  }

  /**
   * Manually override a dependency's state (requires admin/operator).
   */
  overrideDependencyState(actor, depName, status, reason = "manual_override") {
    if (!actor || typeof actor.id !== "string" || !actor.id.trim()) {
      throw new DegradationAuthorizationError("Authenticated actor is required.");
    }
    const role = typeof actor.role === "string" ? actor.role.toLowerCase() : "";
    const scopes = new Set(Array.isArray(actor.scopes) ? actor.scopes : []);
    if (!OVERRIDE_ROLES.has(role) && !scopes.has("degradation:override")) {
      throw new DegradationAuthorizationError(
        `Actor ${actor.id} with role '${role || "none"}' cannot override dependency states.`,
      );
    }

    const state = this.dependencies.get(depName);
    if (!state) throw new Error(`Unknown dependency: ${depName}`);
    if (!["healthy", "degraded", "unavailable"].includes(status)) {
      throw new Error(`Invalid dependency status: ${status}`);
    }

    state.status = status;
    state.lastCheckedAt = this.nowFn();
    state.overrideReason = reason;
    if (status === "healthy") {
      state.consecutiveFailures = 0;
      state.consecutiveSuccesses = this.config.recoveryThreshold;
    } else if (status === "unavailable") {
      state.consecutiveFailures = this.config.failureThreshold;
      state.consecutiveSuccesses = 0;
    }
    return { ...state };
  }

  getUnavailableMutationDependencies() {
    const blocked = [];
    for (const state of this.dependencies.values()) {
      if (state.requiredForMutations && state.status === "unavailable") {
        blocked.push(state.name);
      }
    }
    return blocked;
  }

  assertMutationAllowed() {
    const blocked = this.getUnavailableMutationDependencies();
    if (blocked.length > 0) {
      throw new DegradedModeError(
        "The service is temporarily operating in degraded mode due to unavailable dependencies.",
        {
          retryAfterSeconds: this.config.retryAfterSeconds,
          unavailableDependencies: blocked,
        },
      );
    }
    return true;
  }

  /**
   * Execute an operation with dependency matrix fallback & retry semantics.
   */
  async executeWithFallback({
    dependency,
    operationType = "read",
    primaryFn,
    staleCacheFn = null,
    maxRetries = 1,
  }) {
    const state = this.getState(dependency);

    if (operationType === "mutation") {
      this.assertMutationAllowed();
      if (state.status === "unavailable") {
        throw new DegradedModeError(
          `Dependency '${dependency}' is unavailable for mutations.`,
          {
            retryAfterSeconds: this.config.retryAfterSeconds,
            unavailableDependencies: [dependency],
          },
        );
      }

      const data = await this.#runWithRetries(dependency, primaryFn, maxRetries);
      return { data, degraded: false, stale: false };
    }

    // Read path
    if (state.status === "unavailable") {
      return this.#serveReadFallback(dependency, primaryFn, staleCacheFn);
    }

    try {
      const data = await this.#runWithRetries(dependency, primaryFn, maxRetries);
      return { data, degraded: state.status === "degraded", stale: false };
    } catch (err) {
      return this.#serveReadFallback(dependency, null, staleCacheFn, err);
    }
  }

  async #runWithRetries(dependency, fn, maxRetries) {
    let attempt = 0;
    while (true) {
      try {
        const result = await fn(attempt);
        this.recordSuccess(dependency);
        return result;
      } catch (err) {
        this.recordFailure(dependency, err?.message ?? "execution_error");
        if (!err?.retryable || attempt >= maxRetries || this.getState(dependency).status === "unavailable") {
          throw err;
        }
        attempt += 1;
      }
    }
  }

  async #serveReadFallback(dependency, primaryFn, staleCacheFn, originalError = null) {
    // Non-critical cache bypass: if redis_cache is unavailable and primaryFn is provided, bypass cache
    if (dependency === "redis_cache" && typeof primaryFn === "function") {
      const data = await primaryFn(0);
      return {
        data,
        degraded: true,
        stale: false,
        warning: "Cache unavailable; served directly from primary store.",
      };
    }

    if (typeof staleCacheFn === "function") {
      const cached = await staleCacheFn();
      if (cached && cached.asOf) {
        const ageMs = this.nowFn().getTime() - new Date(cached.asOf).getTime();
        if (ageMs <= this.config.maxStaleDataTtlMs) {
          return {
            data: cached.data,
            degraded: true,
            stale: true,
            asOf: new Date(cached.asOf).toISOString(),
            warning: "Live updates are delayed due to service degradation; showing cached data.",
          };
        }
      }
    }

    throw new DegradedModeError(
      `Dependency '${dependency}' is unavailable and no fresh fallback snapshot is available.`,
      {
        retryAfterSeconds: this.config.retryAfterSeconds,
        unavailableDependencies: [dependency],
        code: originalError ? "DEPENDENCY_FALLBACK_EXHAUSTED" : "SERVICE_DEGRADED",
      },
    );
  }
}
