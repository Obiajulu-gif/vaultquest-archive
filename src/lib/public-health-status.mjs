// SPDX-License-Identifier: MIT

/**
 * Dependency-aware public health status (#1164).
 *
 * Aggregates independently probed components into a sanitized, public-safe
 * status document. A component's effective status accounts for the components
 * it depends on, and the overall status accounts for whether a failing
 * component is required for reads and/or mutations.
 *
 * Edge cases & recovery:
 *  - Unconfigured probes are reported but excluded from the severity roll-up,
 *    so adding an optional integration cannot make the service look down.
 *  - Failed probes are retried a bounded number of times, then fall back to a
 *    fresh last-known-good result as `degraded`; without one they are
 *    reported `unavailable` with `retryAfterSeconds`.
 *  - Raw errors (URLs, credentials, stack traces) never reach the response.
 *  - Operator overrides are authorized and reversible with `clearOverride()`;
 *    clearing the cache makes the next request re-probe immediately.
 *
 * Existing public health routes and their response contracts are unchanged:
 * this module is additive and can be adopted by a route without changing its
 * callers.
 */

export const PUBLIC_HEALTH_STATUSES = Object.freeze([
  "healthy",
  "degraded",
  "unavailable",
  "unconfigured",
]);

export const DEFAULT_PUBLIC_HEALTH_DEPENDENCIES = Object.freeze({
  api: {
    requiredForMutations: true,
    requiredForReads: true,
    dependsOn: [],
    userSafeMessage: "The API is temporarily unavailable. Please retry shortly.",
  },
  database: {
    requiredForMutations: true,
    requiredForReads: true,
    dependsOn: [],
    userSafeMessage: "Persistent storage is temporarily unavailable. Please retry shortly.",
  },
  soroban_rpc: {
    requiredForMutations: true,
    requiredForReads: false,
    dependsOn: [],
    userSafeMessage: "Blockchain submission is temporarily unavailable. Read views remain available.",
  },
  indexer: {
    requiredForMutations: false,
    requiredForReads: false,
    dependsOn: ["database"],
    userSafeMessage: "Recent on-chain activity may be delayed while indexing catches up.",
  },
  redis_cache: {
    requiredForMutations: false,
    requiredForReads: false,
    dependsOn: [],
    userSafeMessage: "The cache is unavailable; requests use the primary store.",
  },
});

const SENSITIVE_TEXT =
  /(password|passwd|secret|token|signature|private[-_]?key|seed|api[-_]?key|authorization|bearer|credential|cookie|https?:\/\/[^\s/]*:[^\s/]*@|postgres(ql)?:\/\/)/i;
const DEFAULT_ALLOWED_ROLES = ["admin", "operator", "system"];

export class PublicHealthAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PublicHealthAuthorizationError";
    this.code = "PUBLIC_HEALTH_UNAUTHORIZED";
    this.statusCode = 403;
  }
}

export class PublicHealthValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PublicHealthValidationError";
    this.code = "PUBLIC_HEALTH_INVALID";
    this.statusCode = 400;
  }
}

/** Remove credentials/URLs/stack markers from any operator-supplied detail. */
export function sanitizeHealthDetail(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, 240);
  if (!trimmed) return undefined;
  return SENSITIVE_TEXT.test(trimmed) ? "[REDACTED]" : trimmed;
}

function clone(value) {
  return structuredClone(value);
}

function isStatus(value) {
  return typeof value === "string" && PUBLIC_HEALTH_STATUSES.includes(value);
}

/**
 * Authorized actor check for forced refreshes and manual overrides.
 * Public, cached reads require no actor.
 */
function authorize(actor, allowedRoles) {
  if (!actor || typeof actor.id !== "string" || !actor.id.trim()) {
    throw new PublicHealthAuthorizationError("An authenticated actor is required for this health operation.");
  }
  const role = typeof actor.role === "string" ? actor.role.toLowerCase() : "";
  const scopes = new Set(Array.isArray(actor.scopes) ? actor.scopes : []);
  if (!allowedRoles.includes(role) && !scopes.has("health:override")) {
    throw new PublicHealthAuthorizationError(
      `Actor ${actor.id} with role '${role || "none"}' cannot override health status.`,
    );
  }
  return true;
}

const SEVERITY = { healthy: 0, unconfigured: 0, degraded: 1, unavailable: 2 };

function worst(statusA, statusB) {
  return (SEVERITY[statusB] ?? 0) > (SEVERITY[statusA] ?? 0) ? statusB : statusA;
}

/** A dependency being down can only degrade its dependents, never improve them. */
function applyDependencyImpact(status, dependencyStatus) {
  if (dependencyStatus === "unavailable") return worst(status, "degraded");
  if (dependencyStatus === "degraded" && status === "healthy") return "degraded";
  return status;
}

export class PublicHealthStatusService {
  constructor({
    nowFn = () => new Date(),
    cacheTtlMs = 5_000,
    staleTtlMs = 60_000,
    timeoutMs = 2_000,
    maxRetries = 1,
    retryAfterSeconds = 30,
    allowedRoles = DEFAULT_ALLOWED_ROLES,
    dependencies = DEFAULT_PUBLIC_HEALTH_DEPENDENCIES,
  } = {}) {
    this.nowFn = nowFn;
    this.cacheTtlMs = Math.max(0, cacheTtlMs);
    this.staleTtlMs = Math.max(0, staleTtlMs);
    this.timeoutMs = Math.max(1, timeoutMs);
    this.maxRetries = Math.max(0, maxRetries);
    this.retryAfterSeconds = Math.max(1, retryAfterSeconds);
    this.allowedRoles = allowedRoles;
    this.dependencies = clone(dependencies);
    this.probes = new Map();
    this.overrides = new Map();
    this.lastGood = new Map();
    this.cache = null;
  }

  registerProbe(name, probeFn, definition = {}) {
    if (typeof probeFn !== "function") {
      throw new PublicHealthValidationError(`Probe for '${name}' must be a function.`);
    }
    if (!this.dependencies[name]) {
      this.dependencies[name] = {
        requiredForMutations: false,
        requiredForReads: false,
        dependsOn: [],
        userSafeMessage: `${name} is temporarily unavailable.`,
      };
    }
    this.dependencies[name] = { ...this.dependencies[name], ...definition };
    this.probes.set(name, probeFn);
    this.clearCache();
    return true;
  }

  clearCache() {
    this.cache = null;
  }

  /** Build the public status document. Cached reads are unauthenticated. */
  async getStatus({ actor, forceRefresh = false, operationType = "read" } = {}) {
    if (forceRefresh) authorize(actor, this.allowedRoles);
    if (operationType !== "read" && operationType !== "mutation") {
      throw new PublicHealthValidationError("operationType must be 'read' or 'mutation'.");
    }

    const now = this.nowFn();
    if (
      !forceRefresh &&
      this.cache &&
      now.getTime() - this.cache.at < this.cacheTtlMs
    ) {
      return { ...clone(this.cache.snapshot), cached: true };
    }

    const names = Object.keys(this.dependencies);
    const results = await Promise.all(
      names.map(async (name) => [name, await this.#probeComponent(name, now)]),
    );
    const components = Object.fromEntries(results);

    // Resolve effective (dependency-aware) statuses in definition order.
    const effective = {};
    for (const name of names) {
      const definition = this.dependencies[name];
      let status = components[name].status;
      for (const dependency of definition.dependsOn ?? []) {
        if (!components[dependency]) continue;
        status = applyDependencyImpact(status, effective[dependency] ?? components[dependency].status);
      }
      effective[name] = status;
      components[name].effectiveStatus = status;
    }

    const isRequired = (definition) =>
      operationType === "mutation" ? definition.requiredForMutations : definition.requiredForReads;
    const blocking = names.filter(
      (name) => effective[name] === "unavailable" && isRequired(this.dependencies[name]),
    );
    const anyDown = names.some((name) => effective[name] === "unavailable" || effective[name] === "degraded");

    const status = blocking.length > 0 ? "unavailable" : anyDown ? "degraded" : "healthy";
    const checkedAt = now.toISOString();
    const snapshot = {
      status,
      checkedAt,
      operationType,
      components,
      dependencies: names.map((name) => ({
        name,
        status: components[name].status,
        effectiveStatus: effective[name],
        requiredForMutations: Boolean(this.dependencies[name].requiredForMutations),
        requiredForReads: Boolean(this.dependencies[name].requiredForReads),
        dependsOn: [...(this.dependencies[name].dependsOn ?? [])],
      })),
      blockingDependencies: blocking,
      retryAfterSeconds: blocking.length > 0 ? this.retryAfterSeconds : null,
      cached: false,
      cacheExpiresAt: new Date(now.getTime() + this.cacheTtlMs).toISOString(),
    };
    this.cache = { at: now.getTime(), snapshot: clone(snapshot) };
    return clone(snapshot);
  }

  async #probeComponent(name, now) {
    const definition = this.dependencies[name];
    const base = {
      status: "unconfigured",
      requiredForMutations: Boolean(definition.requiredForMutations),
      requiredForReads: Boolean(definition.requiredForReads),
      dependsOn: [...(definition.dependsOn ?? [])],
    };

    if (this.overrides.has(name)) {
      const override = this.overrides.get(name);
      return {
        ...base,
        status: override.status,
        effectiveStatus: override.status,
        detail: sanitizeHealthDetail(override.reason) ?? "Manual status override active.",
        overridden: true,
      };
    }

    const probeFn = this.probes.get(name);
    if (!probeFn) return { ...base, effectiveStatus: "unconfigured" };

    let lastError = null;
    const startedAt = Date.now();
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const raw = await this.#invokeProbe(probeFn, attempt);
        const status = typeof raw === "string" ? raw : raw?.status;
        if (!isStatus(status)) {
          throw new PublicHealthValidationError(`Probe '${name}' returned an invalid status.`);
        }
        const result = {
          ...base,
          status,
          effectiveStatus: status,
          latencyMs: Math.max(0, Date.now() - startedAt),
          detail: sanitizeHealthDetail(typeof raw === "string" ? undefined : raw?.detail),
        };
        if (typeof raw === "object" && raw !== null && Number.isFinite(raw.latencyMs)) {
          result.latencyMs = Math.max(0, Math.round(raw.latencyMs));
        }
        this.lastGood.set(name, { at: now.getTime(), status });
        return result;
      } catch (error) {
        lastError = error;
      }
    }

    const cached = this.lastGood.get(name);
    if (cached && now.getTime() - cached.at <= this.staleTtlMs) {
      return {
        ...base,
        status: "degraded",
        effectiveStatus: "degraded",
        stale: true,
        detail: "Serving the last known good state while the dependency recovers.",
      };
    }

    return {
      ...base,
      status: "unavailable",
      effectiveStatus: "unavailable",
      detail: definition.userSafeMessage,
      // lastError is intentionally not exposed.
      probeAttempts: this.maxRetries + 1,
      ...(lastError ? { failureKind: "PROBE_FAILED" } : {}),
    };
  }

  async #invokeProbe(probeFn, attempt) {
    const signal =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(this.timeoutMs)
        : undefined;
    return signal ? probeFn({ attempt, signal }) : probeFn({ attempt });
  }

  /**
   * Authorized, reversible operator override for incident response.
   * Overrides are policy state only — they never mutate the underlying system.
   */
  overrideComponentStatus(name, status, actor, reason = "manual_override") {
    authorize(actor, this.allowedRoles);
    if (!this.dependencies[name]) {
      throw new PublicHealthValidationError(`Unknown health component '${name}'.`);
    }
    if (!["healthy", "degraded", "unavailable"].includes(status)) {
      throw new PublicHealthValidationError(`Invalid override status '${status}'.`);
    }
    const override = { status, reason: sanitizeHealthDetail(reason) ?? "manual_override", by: actor.id };
    this.overrides.set(name, override);
    this.clearCache();
    return clone(override);
  }

  clearOverride(name, actor) {
    authorize(actor, this.allowedRoles);
    const existed = this.overrides.delete(name);
    this.clearCache();
    return existed;
  }
}
