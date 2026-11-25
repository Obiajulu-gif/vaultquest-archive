// SPDX-License-Identifier: MIT

/**
 * Dependency Outage Fallback and Recovery Engine (#1102, #1150).
 *
 * Implements circuit-breaking, multi-tier dependency degradation, cached fallback
 * UX payloads, probe-based recovery, and operator overrides.
 *
 * Recovery UX contract:
 *   - `getRecoveryUx` never mutates state and is safe to call from read paths.
 *   - `probeRecovery` only runs once the circuit's recovery window has elapsed,
 *     so repeated render cycles cannot hammer a failing dependency.
 *   - A successful probe resets the circuit and re-enables writes; a failed
 *     probe keeps the dependency `DOWN` and restarts the recovery window.
 *   - Unauthorized operator overrides throw `DependencyAuthError` before any
 *     state changes, preserving the previous status for rollback.
 */

export class DependencyOutageError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DependencyOutageError";
    this.details = details;
  }
}

export class DependencyAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "DependencyAuthError";
  }
}

export class DependencyFallbackManager {
  constructor(options = {}) {
    this.dependencies = new Map();
    this.cache = new Map();
    this.failureThreshold = options.failureThreshold || 3;
    this.recoveryTimeoutMs = options.recoveryTimeoutMs || 300;
    this.allowedRoles = options.allowedRoles || ["admin", "operator", "system"];
  }

  _authorize(role) {
    if (!this.allowedRoles.includes(role)) {
      throw new DependencyAuthError(`Role "${role}" unauthorized for dependency management`);
    }
  }

  registerDependency(name, fallbackProvider = null) {
    this.dependencies.set(name, {
      name,
      status: "HEALTHY", // HEALTHY | DEGRADED | DOWN
      consecutiveFailures: 0,
      lastFailureTime: null,
      lastSuccessTime: null,
      fallbackProvider,
    });
  }

  listStatuses() {
    return Array.from(this.dependencies.values()).map((dep) => ({ ...dep }));
  }

  getStatus(name) {
    const dep = this.dependencies.get(name);
    if (!dep) throw new Error(`Dependency ${name} not registered`);
    return { ...dep };
  }

  getRecoveryUx(name) {
    const dep = this.dependencies.get(name);
    if (!dep) throw new Error(`Dependency ${name} not registered`);

    const degraded = dep.status !== "HEALTHY";
    const retryAfterMs =
      dep.status === "DOWN"
        ? Math.max(0, this.recoveryTimeoutMs - (Date.now() - (dep.lastFailureTime || 0)))
        : 0;

    let action = null;
    if (dep.status === "DOWN") {
      action = retryAfterMs > 0 ? "wait" : "retry";
    } else if (dep.status === "DEGRADED") {
      action = "retry";
    }

    return {
      dependency: name,
      status: dep.status,
      degraded,
      canWrite: !degraded,
      canRetry: dep.status === "DOWN" && retryAfterMs === 0,
      action,
      retryAfterMs,
      banner: degraded
        ? dep.status === "DOWN"
          ? "This dependency is unavailable. Actions are paused until it recovers."
          : "This dependency is responding slowly. Some actions may be delayed."
        : null,
      consecutiveFailures: dep.consecutiveFailures,
      lastFailureTime: dep.lastFailureTime,
      lastSuccessTime: dep.lastSuccessTime,
    };
  }

  async probeRecovery(name, probeFn) {
    const dep = this.dependencies.get(name);
    if (!dep) throw new Error(`Dependency ${name} not registered`);

    if (dep.status !== "DOWN") {
      return { recovered: dep.status === "HEALTHY", probed: false, status: dep.status };
    }

    const retryAfterMs = Math.max(
      0,
      this.recoveryTimeoutMs - (Date.now() - (dep.lastFailureTime || 0))
    );
    if (retryAfterMs > 0) {
      return { recovered: false, probed: false, status: dep.status, retryAfterMs };
    }

    try {
      const result = await probeFn();
      this.recordSuccess(name);
      return { recovered: true, probed: true, status: dep.status, result };
    } catch (err) {
      this.recordFailure(name);
      return {
        recovered: false,
        probed: true,
        status: dep.status,
        error: err instanceof Error ? err.message : String(err),
        retryAfterMs: this.recoveryTimeoutMs,
      };
    }
  }

  recordSuccess(name) {
    const dep = this.dependencies.get(name);
    if (!dep) return;
    dep.consecutiveFailures = 0;
    dep.status = "HEALTHY";
    dep.lastSuccessTime = Date.now();
  }

  recordFailure(name) {
    const dep = this.dependencies.get(name);
    if (!dep) return;
    dep.consecutiveFailures++;
    dep.lastFailureTime = Date.now();

    if (dep.consecutiveFailures >= this.failureThreshold) {
      dep.status = "DOWN";
    } else {
      dep.status = "DEGRADED";
    }
  }

  setCachedData(key, data) {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  async executeWithFallback(depName, primaryFn, cacheKey = null) {
    const dep = this.dependencies.get(depName);
    if (!dep) throw new Error(`Dependency ${depName} not registered`);

    // Check if down and whether probe recovery is applicable
    if (dep.status === "DOWN") {
      const timeSinceFailure = Date.now() - (dep.lastFailureTime || 0);
      if (timeSinceFailure < this.recoveryTimeoutMs) {
        // Circuit open: return cached fallback or fallback provider
        return this._handleFallback(dep, cacheKey, "Circuit open: dependency unavailable");
      }
    }

    try {
      const result = await primaryFn();
      this.recordSuccess(depName);
      if (cacheKey) this.setCachedData(cacheKey, result);
      return { source: "PRIMARY", data: result, degraded: false };
    } catch (err) {
      this.recordFailure(depName);
      return this._handleFallback(dep, cacheKey, err.message);
    }
  }

  _handleFallback(dep, cacheKey, reason) {
    if (cacheKey && this.cache.has(cacheKey)) {
      return {
        source: "CACHE_FALLBACK",
        data: this.cache.get(cacheKey).data,
        degraded: true,
        reason,
        uxState: {
          banner: "Showing cached data while network dependency recovers",
          canWrite: false,
        },
      };
    }

    if (dep.fallbackProvider) {
      const data = dep.fallbackProvider();
      return {
        source: "PROVIDER_FALLBACK",
        data,
        degraded: true,
        reason,
        uxState: {
          banner: "Operating in degraded mode with mock/secondary provider",
          canWrite: false,
        },
      };
    }

    throw new DependencyOutageError(`Dependency "${dep.name}" failed and no fallback available: ${reason}`, {
      status: dep.status,
      consecutiveFailures: dep.consecutiveFailures,
    });
  }

  overrideStatus(name, newStatus, callerRole = "operator") {
    this._authorize(callerRole);
    const dep = this.dependencies.get(name);
    if (!dep) throw new Error(`Dependency ${name} not registered`);
    dep.status = newStatus;
    if (newStatus === "HEALTHY") {
      dep.consecutiveFailures = 0;
    }
  }
}
