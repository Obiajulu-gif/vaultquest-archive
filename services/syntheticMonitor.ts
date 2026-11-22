/**
 * Synthetic transaction monitor for critical user journeys (#855, #1092).
 *
 * Periodically executes lightweight synthetic transactions against the live
 * protocol to verify that high-value user journeys (deposit, withdraw, claim, quest completion)
 * remain functional. Alerts when a journey fails or becomes degraded.
 *
 * Designed to run as a background service in production and be manually
 * triggerable in staging/test environments.
 *
 * Architecture & Quality Guarantees:
 * - Covers normal, failure, retry, and authorization paths.
 * - Enforces bounded memory for telemetry and results (O(K) space complexity).
 * - Implements exponential backoff on retries with configurable limits (O(R) time complexity).
 * - Full backward compatibility with existing journey definitions.
 */

import { EventEmitter } from "events";

export type JourneyStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface JourneyAuthContext {
  caller?: string;
  token?: string;
  role?: string;
  roles?: string[];
}

export interface JourneyResult {
  journey: string;
  status: JourneyStatus;
  latencyMs: number;
  timestamp: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface JourneyDefinition {
  name: string;
  description: string;
  /** Executes the synthetic journey. Returns void on success, throws on failure. */
  execute: (auth?: JourneyAuthContext) => Promise<void>;
  /** Timeout in milliseconds before the journey is considered failed. */
  timeoutMs: number;
  /** How often to run this journey (in milliseconds). */
  intervalMs: number;
  /** Whether this journey is enabled. */
  enabled: boolean;
  /** Maximum number of retries before journey is declared failed. Defaults to 0. */
  maxRetries?: number;
  /** Delay between retries in milliseconds. Defaults to 100ms. */
  retryDelayMs?: number;
  /** Backoff multiplier applied to retry delay. Defaults to 1.5. */
  backoffMultiplier?: number;
  /** Whether this journey requires caller authorization. */
  requireAuth?: boolean;
  /** Required roles to execute this journey. */
  authorizedRoles?: string[];
  /** Custom authorizer function. Returns boolean or throws. */
  authorize?: (auth?: JourneyAuthContext) => boolean | Promise<boolean>;
}

export interface MonitorConfig {
  /** Maximum latency (ms) before a journey is marked as degraded. */
  degradedThresholdMs: number;
  /** Number of consecutive failures before alerting. */
  alertThreshold: number;
  /** Retention period for results (hours). */
  retentionHours: number;
  /** Maximum number of historical results stored per journey (prevents memory leak). */
  maxStoredResultsPerJourney: number;
  /** Optional global authorizer for all journeys. */
  globalAuthorizer?: (auth?: JourneyAuthContext, journeyName?: string) => boolean | Promise<boolean>;
}

const DEFAULT_CONFIG: MonitorConfig = {
  degradedThresholdMs: 5000,
  alertThreshold: 3,
  retentionHours: 24,
  maxStoredResultsPerJourney: 500,
};

export class SyntheticMonitor extends EventEmitter {
  private journeys: Map<string, JourneyDefinition>;
  private results: Map<string, JourneyResult[]>;
  private consecutiveFailures: Map<string, number>;
  private timers: Map<string, NodeJS.Timeout>;
  private config: MonitorConfig;

  constructor(config: Partial<MonitorConfig> = {}) {
    super();
    this.journeys = new Map();
    this.results = new Map();
    this.consecutiveFailures = new Map();
    this.timers = new Map();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a synthetic journey to monitor.
   */
  registerJourney(journey: JourneyDefinition): void {
    this.journeys.set(journey.name, journey);
    this.results.set(journey.name, []);
    this.consecutiveFailures.set(journey.name, 0);
    this.emit("journey_registered", { name: journey.name });
  }

  /**
   * Evaluates authorization for a journey.
   */
  private async checkAuthorization(
    journey: JourneyDefinition,
    auth?: JourneyAuthContext,
  ): Promise<{ authorized: boolean; reason?: string }> {
    if (this.config.globalAuthorizer) {
      const allowed = await this.config.globalAuthorizer(auth, journey.name);
      if (!allowed) {
        return { authorized: false, reason: "Forbidden by global monitor authorizer" };
      }
    }

    if (journey.requireAuth) {
      if (!auth || (!auth.token && !auth.role && !auth.caller)) {
        return { authorized: false, reason: "Authentication credentials required" };
      }

      if (journey.authorizedRoles && journey.authorizedRoles.length > 0) {
        const callerRoles = [
          ...(auth.role ? [auth.role] : []),
          ...(auth.roles ? auth.roles : []),
        ];
        const hasRole = journey.authorizedRoles.some((r) => callerRoles.includes(r));
        if (!hasRole) {
          return {
            authorized: false,
            reason: `Role unauthorized. Required one of: ${journey.authorizedRoles.join(", ")}`,
          };
        }
      }

      if (journey.authorize) {
        try {
          const customAllowed = await journey.authorize(auth);
          if (!customAllowed) {
            return { authorized: false, reason: "Journey custom authorization check failed" };
          }
        } catch (err) {
          return {
            authorized: false,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }

    return { authorized: true };
  }

  /**
   * Execute a single journey and record the result.
   * Supports normal, failure, retry, and authorization execution paths.
   */
  async executeJourney(name: string, auth?: JourneyAuthContext): Promise<JourneyResult> {
    const journey = this.journeys.get(name);
    if (!journey) {
      throw new Error(`Unknown journey: ${name}`);
    }

    const start = Date.now();
    let result: JourneyResult;

    // Authorization Path Check
    const authCheck = await this.checkAuthorization(journey, auth);
    if (!authCheck.authorized) {
      const latencyMs = Date.now() - start;
      const errorMsg = `UNAUTHORIZED: ${authCheck.reason ?? "Access denied"}`;
      result = {
        journey: name,
        status: "unhealthy",
        latencyMs,
        timestamp: new Date().toISOString(),
        error: errorMsg,
        metadata: { authorizationDenied: true },
      };

      const failures = (this.consecutiveFailures.get(name) ?? 0) + 1;
      this.consecutiveFailures.set(name, failures);

      this.emit("auth_failure", {
        journey: name,
        caller: auth?.caller,
        reason: authCheck.reason,
      });

      if (failures >= this.config.alertThreshold) {
        this.emit("alert", {
          journey: name,
          consecutiveFailures: failures,
          lastError: result.error,
        });
      }

      this.recordResult(name, result);
      this.emit("journey_executed", result);
      return result;
    }

    // Normal and Retry Execution Path
    const maxRetries = journey.maxRetries ?? 0;
    const initialDelay = journey.retryDelayMs ?? 100;
    const multiplier = journey.backoffMultiplier ?? 1.5;

    let attempt = 0;
    let lastError: Error | null = null;
    let succeeded = false;

    while (attempt <= maxRetries && !succeeded) {
      try {
        await Promise.race([
          journey.execute(auth),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`Journey timed out after ${journey.timeoutMs}ms`)),
              journey.timeoutMs,
            ),
          ),
        ]);
        succeeded = true;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        attempt++;
        if (attempt <= maxRetries) {
          const delay = Math.round(initialDelay * Math.pow(multiplier, attempt - 1));
          this.emit("journey_retry", {
            journey: name,
            attempt,
            maxRetries,
            delayMs: delay,
            error: lastError.message,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    const latencyMs = Date.now() - start;

    if (succeeded) {
      const status: JourneyStatus =
        latencyMs > this.config.degradedThresholdMs ? "degraded" : "healthy";

      const previousFailures = this.consecutiveFailures.get(name) ?? 0;
      this.consecutiveFailures.set(name, 0);

      result = {
        journey: name,
        status,
        latencyMs,
        timestamp: new Date().toISOString(),
        metadata: {
          retriesUsed: attempt,
          recoveredOnRetry: attempt > 0,
        },
      };

      if (previousFailures > 0) {
        this.emit("journey_recovered", {
          journey: name,
          previousFailures,
          latencyMs,
        });
      }
    } else {
      result = {
        journey: name,
        status: "unhealthy",
        latencyMs,
        timestamp: new Date().toISOString(),
        error: lastError?.message ?? "Unknown error",
        metadata: {
          retriesExhausted: true,
          attemptsMade: attempt,
        },
      };

      const failures = (this.consecutiveFailures.get(name) ?? 0) + 1;
      this.consecutiveFailures.set(name, failures);

      if (failures >= this.config.alertThreshold) {
        this.emit("alert", {
          journey: name,
          consecutiveFailures: failures,
          lastError: result.error,
        });
      }
    }

    this.recordResult(name, result);
    this.emit("journey_executed", result);
    return result;
  }

  /**
   * Stores a result with bounded capacity to guarantee O(K) memory footprint.
   */
  private recordResult(name: string, result: JourneyResult): void {
    const list = this.results.get(name);
    if (!list) return;

    list.push(result);
    if (list.length > this.config.maxStoredResultsPerJourney) {
      list.shift();
    }
  }

  /**
   * Execute all registered journeys.
   */
  async executeAll(auth?: JourneyAuthContext): Promise<JourneyResult[]> {
    const results: JourneyResult[] = [];
    for (const [name, journey] of this.journeys) {
      if (journey.enabled) {
        results.push(await this.executeJourney(name, auth));
      }
    }
    return results;
  }

  /**
   * Start periodic monitoring of all registered journeys.
   */
  start(auth?: JourneyAuthContext): void {
    for (const [name, journey] of this.journeys) {
      if (!journey.enabled || this.timers.has(name)) continue;

      const timer = setInterval(() => {
        this.executeJourney(name, auth).catch((err) => {
          this.emit("error", { journey: name, error: err.message });
        });
      }, journey.intervalMs);

      this.timers.set(name, timer);
    }
    this.emit("monitor_started");
  }

  /**
   * Stop all periodic monitoring.
   */
  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.emit("monitor_stopped");
  }

  /**
   * Get the current status of all journeys.
   */
  getStatus(): Record<string, JourneyStatus> {
    const status: Record<string, JourneyStatus> = {};
    for (const [name] of this.journeys) {
      const results = this.results.get(name) ?? [];
      status[name] = results.length > 0 ? results[results.length - 1].status : "unknown";
    }
    return status;
  }

  /**
   * Get recent results for a journey.
   */
  getResults(name: string, limit: number = 100): JourneyResult[] {
    return (this.results.get(name) ?? []).slice(-limit);
  }
}

/**
 * Creates journey definitions for high-value user journeys:
 * 1. deposit: Funds deposited into pooled vault
 * 2. withdraw: Principal or shares withdrawn
 * 3. claim: Winnings or yield claimed
 * 4. quest_complete: Savings quest completed and reward claimed
 */
export function createHighValueJourneys(handlers: {
  executeDeposit: (auth?: JourneyAuthContext) => Promise<void>;
  executeWithdraw: (auth?: JourneyAuthContext) => Promise<void>;
  executeClaim: (auth?: JourneyAuthContext) => Promise<void>;
  executeQuestComplete: (auth?: JourneyAuthContext) => Promise<void>;
}): JourneyDefinition[] {
  return [
    {
      name: "deposit",
      description: "High-value synthetic deposit journey (intent -> ledger -> pool)",
      execute: handlers.executeDeposit,
      timeoutMs: 10000,
      intervalMs: 60000,
      enabled: true,
      maxRetries: 2,
      retryDelayMs: 150,
      requireAuth: true,
      authorizedRoles: ["admin", "service", "monitor"],
    },
    {
      name: "withdraw",
      description: "High-value synthetic withdraw journey (queue -> verify -> redeem)",
      execute: handlers.executeWithdraw,
      timeoutMs: 10000,
      intervalMs: 60000,
      enabled: true,
      maxRetries: 2,
      retryDelayMs: 150,
      requireAuth: true,
      authorizedRoles: ["admin", "service", "monitor"],
    },
    {
      name: "claim",
      description: "High-value synthetic prize / yield claim journey (proof -> claim -> settle)",
      execute: handlers.executeClaim,
      timeoutMs: 15000,
      intervalMs: 120000,
      enabled: true,
      maxRetries: 2,
      retryDelayMs: 200,
      requireAuth: true,
      authorizedRoles: ["admin", "service", "monitor"],
    },
    {
      name: "quest_complete",
      description: "High-value synthetic quest completion journey (progress -> verify -> reward)",
      execute: handlers.executeQuestComplete,
      timeoutMs: 10000,
      intervalMs: 180000,
      enabled: true,
      maxRetries: 1,
      retryDelayMs: 150,
      requireAuth: true,
      authorizedRoles: ["admin", "service", "monitor"],
    },
  ];
}

/**
 * Creates default journey definitions for critical user journeys (backward compatibility).
 */
export function createDefaultJourneys(
  executeDeposit: () => Promise<void>,
  executeWithdraw: () => Promise<void>,
  executeClaim: () => Promise<void>,
): JourneyDefinition[] {
  return [
    {
      name: "deposit",
      description: "Synthetic deposit journey",
      execute: executeDeposit,
      timeoutMs: 10000,
      intervalMs: 60000,
      enabled: true,
    },
    {
      name: "withdraw",
      description: "Synthetic withdraw journey",
      execute: executeWithdraw,
      timeoutMs: 10000,
      intervalMs: 60000,
      enabled: true,
    },
    {
      name: "claim",
      description: "Synthetic claim journey",
      execute: executeClaim,
      timeoutMs: 15000,
      intervalMs: 120000,
      enabled: true,
    },
  ];
}
