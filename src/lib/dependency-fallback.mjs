// SPDX-License-Identifier: MIT

/**
 * Dependency Outage Fallback and Recovery Engine (#1102).
 *
 * Implements circuit-breaking, multi-tier dependency degradation, cached fallback
 * UX payloads, probe-based recovery, and operator overrides.
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
      fallbackProvider,
    });
  }

  getStatus(name) {
    const dep = this.dependencies.get(name);
    if (!dep) throw new Error(`Dependency ${name} not registered`);
    return { ...dep };
  }

  recordSuccess(name) {
    const dep = this.dependencies.get(name);
    if (!dep) return;
    dep.consecutiveFailures = 0;
    dep.status = "HEALTHY";
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
