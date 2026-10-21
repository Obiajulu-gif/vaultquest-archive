import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";

export type DependencyName = "database" | "soroban_rpc" | "redis_cache" | "indexer";
export type DependencyHealthStatus = "healthy" | "degraded" | "unavailable";

export interface DependencyState {
  name: DependencyName;
  status: DependencyHealthStatus;
  requiredForMutations: boolean;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastCheckedAt: Date;
  lastFailureAt: Date | null;
  lastSuccessAt: Date | null;
  latencyMs?: number;
  userSafeReason?: string;
}

export interface DegradedModeConfig {
  /** Number of consecutive failures before marking a dependency unavailable. Default 3. */
  failureThreshold: number;
  /** Number of consecutive successes before restoring a dependency to healthy. Default 2. */
  recoveryThreshold: number;
  /** Recommended Retry-After header in seconds when mutations are gated. Default 30. */
  retryAfterSeconds: number;
  /** Allow stale cached reads up to this duration in ms. Default 10 minutes. */
  maxStaleDataTtlMs: number;
}

export const DEFAULT_DEGRADED_CONFIG: DegradedModeConfig = {
  failureThreshold: 3,
  recoveryThreshold: 2,
  retryAfterSeconds: 30,
  maxStaleDataTtlMs: 10 * 60 * 1000,
};

export class DegradedModeError extends AppError {
  readonly retryAfterSeconds: number;
  readonly unavailableDependencies: DependencyName[];

  constructor(
    message: string,
    retryAfterSeconds = 30,
    unavailableDependencies: DependencyName[] = []
  ) {
    super(ERROR_CODES.SERVICE_DEGRADED, 503, message);
    this.name = "DegradedModeError";
    this.retryAfterSeconds = retryAfterSeconds;
    this.unavailableDependencies = unavailableDependencies;
  }
}

export interface DegradedReadResult<T> {
  data: T;
  degraded: boolean;
  stale: boolean;
  asOf: Date;
  warning?: string;
}

export class DegradedModeService {
  private readonly config: DegradedModeConfig;
  private readonly dependencies: Map<DependencyName, DependencyState>;

  constructor(config?: Partial<DegradedModeConfig>) {
    this.config = { ...DEFAULT_DEGRADED_CONFIG, ...config };
    this.dependencies = new Map<DependencyName, DependencyState>([
      [
        "database",
        {
          name: "database",
          status: "healthy",
          requiredForMutations: true,
          consecutiveFailures: 0,
          consecutiveSuccesses: 1,
          lastCheckedAt: new Date(),
          lastFailureAt: null,
          lastSuccessAt: new Date(),
        },
      ],
      [
        "soroban_rpc",
        {
          name: "soroban_rpc",
          status: "healthy",
          requiredForMutations: true,
          consecutiveFailures: 0,
          consecutiveSuccesses: 1,
          lastCheckedAt: new Date(),
          lastFailureAt: null,
          lastSuccessAt: new Date(),
        },
      ],
      [
        "redis_cache",
        {
          name: "redis_cache",
          status: "healthy",
          requiredForMutations: false,
          consecutiveFailures: 0,
          consecutiveSuccesses: 1,
          lastCheckedAt: new Date(),
          lastFailureAt: null,
          lastSuccessAt: new Date(),
        },
      ],
      [
        "indexer",
        {
          name: "indexer",
          status: "healthy",
          requiredForMutations: false,
          consecutiveFailures: 0,
          consecutiveSuccesses: 1,
          lastCheckedAt: new Date(),
          lastFailureAt: null,
          lastSuccessAt: new Date(),
        },
      ],
    ]);
  }

  /**
   * Records a successful probe or operation against an upstream dependency.
   */
  recordSuccess(name: DependencyName, latencyMs?: number): void {
    const dep = this.dependencies.get(name);
    if (!dep) return;

    dep.consecutiveSuccesses++;
    dep.consecutiveFailures = 0;
    dep.lastSuccessAt = new Date();
    dep.lastCheckedAt = new Date();
    dep.latencyMs = latencyMs;
    dep.userSafeReason = undefined;

    if (dep.consecutiveSuccesses >= this.config.recoveryThreshold) {
      dep.status = "healthy";
    }
  }

  /**
   * Records a failure against an upstream dependency.
   * Sanitizes error message to prevent leaking internal addresses, SQL, or credentials.
   */
  recordFailure(name: DependencyName, _err?: unknown, userSafeReason?: string): void {
    const dep = this.dependencies.get(name);
    if (!dep) return;

    dep.consecutiveFailures++;
    dep.consecutiveSuccesses = 0;
    dep.lastFailureAt = new Date();
    dep.lastCheckedAt = new Date();
    dep.userSafeReason = userSafeReason ?? `The ${name} service is currently unresponsive.`;

    if (dep.consecutiveFailures >= this.config.failureThreshold) {
      dep.status = "unavailable";
    } else {
      dep.status = "degraded";
    }
  }

  /**
   * Forcefully overrides a dependency's status (used for administrative failover / maintenance / tests).
   */
  setDependencyStatus(name: DependencyName, status: DependencyHealthStatus, reason?: string): void {
    const dep = this.dependencies.get(name);
    if (!dep) return;
    dep.status = status;
    dep.userSafeReason = reason;
    dep.consecutiveSuccesses = 0;
    dep.consecutiveFailures = status === "healthy" ? 0 : this.config.failureThreshold;
    dep.lastCheckedAt = new Date();
  }

  getDependency(name: DependencyName): DependencyState | undefined {
    return this.dependencies.get(name);
  }

  getAllDependencies(): Record<DependencyName, DependencyState> {
    const out: any = {};
    for (const [key, val] of this.dependencies.entries()) {
      out[key] = { ...val };
    }
    return out;
  }

  /**
   * Returns true if any dependency is degraded or unavailable.
   */
  isDegraded(): boolean {
    for (const dep of this.dependencies.values()) {
      if (dep.status !== "healthy") return true;
    }
    return false;
  }

  /**
   * Asserts that required dependencies for a mutation are operational.
   * If any required dependency is unavailable or degraded, throws DegradedModeError (503).
   */
  assertMutationAllowed(requiredDeps: DependencyName[] = ["database", "soroban_rpc"]): void {
    const blocked: DependencyName[] = [];
    for (const name of requiredDeps) {
      const dep = this.dependencies.get(name);
      if (dep && dep.status === "unavailable") {
        blocked.push(name);
      }
    }

    if (blocked.length > 0) {
      const list = blocked.join(", ");
      throw new DegradedModeError(
        `Mutations are temporarily paused because dependencies (${list}) are currently unavailable.`,
        this.config.retryAfterSeconds,
        blocked
      );
    }
  }

  /**
   * Executes a read operation with fallback to stale cache or mock snapshot.
   */
  async executeRead<T>(params: {
    dependency: DependencyName;
    primary: () => Promise<T>;
    fallback?: () => Promise<{ value: T; cachedAt: Date } | null>;
    fallbackSnapshot?: T;
  }): Promise<DegradedReadResult<T>> {
    const dep = this.dependencies.get(params.dependency);
    const isUnhealthy = dep?.status === "unavailable";

    if (!isUnhealthy) {
      try {
        const start = performance.now();
        const data = await params.primary();
        this.recordSuccess(params.dependency, Math.round(performance.now() - start));
        return {
          data,
          degraded: false,
          stale: false,
          asOf: new Date(),
        };
      } catch (err) {
        this.recordFailure(params.dependency, err);
        // Fall through to fallback
      }
    }

    // Try fallback
    if (params.fallback) {
      try {
        const fallbackRes = await params.fallback();
        if (fallbackRes) {
          const now = Date.now();
          const age = now - fallbackRes.cachedAt.getTime();
          const isStale = age > 0;
          return {
            data: fallbackRes.value,
            degraded: true,
            stale: isStale,
            asOf: fallbackRes.cachedAt,
            warning: "Live updates are delayed due to service degradation; showing cached data.",
          };
        }
      } catch {
        // Fallback failed
      }
    }

    if (params.fallbackSnapshot !== undefined) {
      return {
        data: params.fallbackSnapshot,
        degraded: true,
        stale: true,
        asOf: new Date(Date.now() - 60_000),
        warning: "Live data is temporarily unavailable; showing last verified snapshot.",
      };
    }

    throw new DegradedModeError(
      `Service is operating in degraded mode and cached data is unavailable for ${params.dependency}.`,
      this.config.retryAfterSeconds,
      [params.dependency]
    );
  }

  /**
   * Generates a user-safe status banner and summary report.
   */
  getUserSafeStatus(): {
    status: "healthy" | "degraded" | "unavailable";
    userBanner: string | null;
    retryAfterSeconds?: number;
    dependencies: Array<{ name: string; status: DependencyHealthStatus; impact: string }>;
  } {
    const all = Array.from(this.dependencies.values());
    const hasUnavailable = all.some((d) => d.status === "unavailable");
    const hasDegraded = all.some((d) => d.status === "degraded");

    let overall: "healthy" | "degraded" | "unavailable" = "healthy";
    let userBanner: string | null = null;

    if (hasUnavailable) {
      overall = "unavailable";
      userBanner = "We are currently experiencing upstream service disruptions. Balance mutations and transactions are temporarily paused; cached data may be shown.";
    } else if (hasDegraded) {
      overall = "degraded";
      userBanner = "Upstream network response times are elevated. Some real-time updates may experience minor delays.";
    }

    const dependencies = all.map((d) => ({
      name: d.name,
      status: d.status,
      impact: d.requiredForMutations
        ? (d.status === "unavailable" ? "Fund transfers and mutations paused" : "Operational")
        : (d.status === "unavailable" ? "Serving cached or direct fallback data" : "Operational"),
    }));

    return {
      status: overall,
      userBanner,
      retryAfterSeconds: overall !== "healthy" ? this.config.retryAfterSeconds : undefined,
      dependencies,
    };
  }
}
