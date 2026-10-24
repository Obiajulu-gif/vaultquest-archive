/**
 * Synthetic transaction monitor for critical user journeys (#855).
 *
 * Periodically executes lightweight synthetic transactions against the live
 * protocol to verify that critical user journeys (deposit, withdraw, claim)
 * remain functional. Alerts when a journey fails or becomes degraded.
 *
 * Designed to run as a background service in production and be manually
 * triggerable in staging/test environments.
 */

import { EventEmitter } from "events";

export type JourneyStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

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
  execute: () => Promise<void>;
  /** Timeout in milliseconds before the journey is considered failed. */
  timeoutMs: number;
  /** How often to run this journey (in milliseconds). */
  intervalMs: number;
  /** Whether this journey is enabled. */
  enabled: boolean;
}

export interface MonitorConfig {
  /** Maximum latency (ms) before a journey is marked as degraded. */
  degradedThresholdMs: number;
  /** Number of consecutive failures before alerting. */
  alertThreshold: number;
  /** Retention period for results (hours). */
  retentionHours: number;
}

const DEFAULT_CONFIG: MonitorConfig = {
  degradedThresholdMs: 5000,
  alertThreshold: 3,
  retentionHours: 24,
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
   * Execute a single journey and record the result.
   */
  async executeJourney(name: string): Promise<JourneyResult> {
    const journey = this.journeys.get(name);
    if (!journey) {
      throw new Error(`Unknown journey: ${name}`);
    }

    const start = Date.now();
    let result: JourneyResult;

    try {
      await Promise.race([
        journey.execute(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Journey timed out after ${journey.timeoutMs}ms`)), journey.timeoutMs),
        ),
      ]);

      const latencyMs = Date.now() - start;
      const status: JourneyStatus = latencyMs > this.config.degradedThresholdMs ? "degraded" : "healthy";

      result = {
        journey: name,
        status,
        latencyMs,
        timestamp: new Date().toISOString(),
      };

      this.consecutiveFailures.set(name, 0);
    } catch (err) {
      const latencyMs = Date.now() - start;
      result = {
        journey: name,
        status: "unhealthy",
        latencyMs,
        timestamp: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
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

    this.results.get(name)?.push(result);
    this.emit("journey_executed", result);
    return result;
  }

  /**
   * Execute all registered journeys.
   */
  async executeAll(): Promise<JourneyResult[]> {
    const results: JourneyResult[] = [];
    for (const [name, journey] of this.journeys) {
      if (journey.enabled) {
        results.push(await this.executeJourney(name));
      }
    }
    return results;
  }

  /**
   * Start periodic monitoring of all registered journeys.
   */
  start(): void {
    for (const [name, journey] of this.journeys) {
      if (!journey.enabled || this.timers.has(name)) continue;

      const timer = setInterval(() => {
        this.executeJourney(name).catch((err) => {
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
 * Creates default journey definitions for critical user journeys.
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
