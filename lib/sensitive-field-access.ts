/**
 * Sensitive Field Access Logging & Anomaly Detection (#868).
 *
 * This module identifies sensitive protocol & user fields in VaultQuest, logs
 * authorized and unauthorized access attempts without storing sensitive field
 * values, and provides hooks and report generators for anomaly detection.
 */

export const SENSITIVE_FIELDS = [
  "ssn",
  "tax_id",
  "private_key",
  "secret",
  "email",
  "phone_number",
  "wallet_seed",
  "auth_token",
  "vault_pin",
  "account_secret",
  "user_identity",
  "encryption_key",
  "billing_address",
  "wallet_address",
  "password_hash",
  "amount",
  "balance",
  "action_payload",
] as const;

export type SensitiveFieldName = (typeof SENSITIVE_FIELDS)[number] | string;

export interface SensitiveFieldAccessInput {
  actor: string;
  purpose: string;
  resourceType: string;
  resourceId: string;
  fieldNames: SensitiveFieldName[];
  authorized: boolean;
  /** Number of records requested; marks multi-record access as bulk. */
  resourceCount?: number;
  ipAddress?: string;
  userAgent?: string;
  /** Raw field values must NEVER be stored. Any raw values passed are stripped immediately. */
  rawValues?: Record<string, unknown>;
}

export interface SensitiveFieldAccessLogEntry {
  id: string;
  timestamp: string;
  actor: string;
  purpose: string;
  resourceType: string;
  resourceId: string;
  fields: string[];
  authorized: boolean;
  bulk: boolean;
  resourceCount: number;
  ipAddress?: string;
  userAgent?: string;
  /** Always true — confirms field values were not retained. */
  redacted: boolean;
}

export type AnomalySeverity = "low" | "medium" | "high" | "critical";

export interface AnomalyEvent {
  id: string;
  rule: string;
  severity: AnomalySeverity;
  actor: string;
  description: string;
  timestamp: string;
  logIds: string[];
  metadata?: Record<string, unknown>;
}

export type AnomalyHook = (anomaly: AnomalyEvent) => void;

/** Standard threshold limits for anomaly detection. */
export const DEFAULT_ANOMALY_THRESHOLDS = {
  maxDeniedAttemptsInWindow: 3,
  maxRapidResourcesInWindow: 5,
  bulkFieldThreshold: 5,
  windowMs: 5 * 60 * 1000, // 5 minutes
  maxRetainedLogs: 10_000,
};

export class SensitiveFieldAccessLogger {
  private logs: SensitiveFieldAccessLogEntry[] = [];
  private anomalyHooks: AnomalyHook[] = [];
  private thresholds = { ...DEFAULT_ANOMALY_THRESHOLDS };

  constructor(customThresholds?: Partial<typeof DEFAULT_ANOMALY_THRESHOLDS>, private readonly accessSink?: (entry: SensitiveFieldAccessLogEntry) => void) {
    if (customThresholds) {
      this.thresholds = { ...this.thresholds, ...customThresholds };
    }
    if (Object.values(this.thresholds).some((v) => !Number.isSafeInteger(v) || v < 1)) {
      throw new Error("Anomaly thresholds must be positive integers.");
    }
  }

  /**
   * Check if a field name is classified as sensitive.
   */
  public isSensitiveField(fieldName: string): boolean {
    const normalized = this.normalizeField(fieldName);
    return (SENSITIVE_FIELDS as readonly string[]).includes(normalized) ||
      normalized.includes("secret") ||
      normalized.includes("token") ||
      normalized.includes("password") ||
      normalized.includes("key") ||
      normalized.includes("pin");
  }

  private normalizeField(field: string): string {
    return field.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  }

  /**
   * Log an access attempt to sensitive fields. The raw values are strictly discarded
   * and never retained in the log entry.
   */
  public logAccess(input: SensitiveFieldAccessInput): SensitiveFieldAccessLogEntry {
    const fields = [...new Set(input.fieldNames.map((f) => this.normalizeField(f)).filter((f) => this.isSensitiveField(f)))];
    const resourceCount = input.resourceCount ?? 1;
    if (!Number.isSafeInteger(resourceCount) || resourceCount < 1) throw new Error("Invalid resource count.");
    const isBulk = fields.length >= this.thresholds.bulkFieldThreshold || resourceCount > 1;

    const entry: SensitiveFieldAccessLogEntry = {
      id: `log-${globalThis.crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      actor: input.actor,
      purpose: input.purpose,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      fields,
      authorized: input.authorized,
      bulk: isBulk,
      resourceCount,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      redacted: true,
    };

    this.logs.push(entry);
    if (this.logs.length > this.thresholds.maxRetainedLogs) this.logs.shift();
    // Forward only the allowlisted, value-free entry; sink failures fail closed.
    this.accessSink?.(structuredClone(entry));

    // Evaluate anomaly hooks on new access
    this.evaluateAnomaliesForEntry(entry);

    return structuredClone(entry);
  }

  /**
   * Register a callback hook for anomaly alerts.
   */
  public onAnomaly(hook: AnomalyHook): () => void {
    this.anomalyHooks.push(hook);
    return () => {
      this.anomalyHooks = this.anomalyHooks.filter((h) => h !== hook);
    };
  }

  /**
   * Evaluate recent logs against anomaly rules and notify registered hooks.
   */
  public evaluateAnomalies(windowMs: number = this.thresholds.windowMs): AnomalyEvent[] {
    const now = Date.now();
    const cutoff = new Date(now - windowMs).toISOString();
    const recentLogs = this.logs.filter((l) => l.timestamp >= cutoff);

    const anomalies: AnomalyEvent[] = [];

    // Group logs by actor
    const logsByActor = new Map<string, SensitiveFieldAccessLogEntry[]>();
    for (const log of recentLogs) {
      const existing = logsByActor.get(log.actor) || [];
      existing.push(log);
      logsByActor.set(log.actor, existing);
    }

    for (const [actor, actorLogs] of logsByActor.entries()) {
      // Rule 1: Unauthorized burst (multiple denied accesses)
      const deniedLogs = actorLogs.filter((l) => !l.authorized);
      if (deniedLogs.length >= this.thresholds.maxDeniedAttemptsInWindow) {
        const anomaly: AnomalyEvent = {
          id: `anom-${now}-${Math.random().toString(36).substring(2, 7)}`,
          rule: "UNAUTHORIZED_BURST",
          severity: "high",
          actor,
          description: `Actor ${actor} had ${deniedLogs.length} unauthorized sensitive access attempts in window.`,
          timestamp: new Date().toISOString(),
          logIds: deniedLogs.map((l) => l.id),
          metadata: { deniedCount: deniedLogs.length },
        };
        anomalies.push(anomaly);
        this.notifyHooks(anomaly);
      }

      // Rule 2: Rapid multi-resource access
      const resourceIds = new Set(actorLogs.map((l) => JSON.stringify([l.resourceType, l.resourceId])));
      if (resourceIds.size >= this.thresholds.maxRapidResourcesInWindow) {
        const anomaly: AnomalyEvent = {
          id: `anom-${now}-${Math.random().toString(36).substring(2, 7)}`,
          rule: "RAPID_MULTI_RESOURCE_ACCESS",
          severity: "medium",
          actor,
          description: `Actor ${actor} accessed ${resourceIds.size} distinct resources within time window.`,
          timestamp: new Date().toISOString(),
          logIds: actorLogs.map((l) => l.id),
          metadata: { resourceCount: resourceIds.size },
        };
        anomalies.push(anomaly);
        this.notifyHooks(anomaly);
      }

      // Rule 3: Bulk sensitive field query
      const bulkLogs = actorLogs.filter((l) => l.bulk);
      if (bulkLogs.length > 0) {
        for (const log of bulkLogs) {
          const anomaly: AnomalyEvent = {
            id: `anom-${now}-${Math.random().toString(36).substring(2, 7)}`,
            rule: "BULK_SENSITIVE_ACCESS",
            severity: log.authorized ? "low" : "high",
            actor,
            description: `Actor ${actor} performed bulk access (${log.fields.length} sensitive fields) on ${log.resourceType}:${log.resourceId}.`,
            timestamp: new Date().toISOString(),
            logIds: [log.id],
            metadata: { fieldCount: log.fields.length, authorized: log.authorized },
          };
          anomalies.push(anomaly);
          this.notifyHooks(anomaly);
        }
      }
    }

    return anomalies;
  }

  private evaluateAnomaliesForEntry(entry: SensitiveFieldAccessLogEntry): void {
    if (!entry.authorized && entry.bulk) {
      const anomaly: AnomalyEvent = {
        id: `anom-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        rule: "UNAUTHORIZED_BULK_ACCESS",
        severity: "critical",
        actor: entry.actor,
        description: `Unauthorized bulk sensitive field access attempt by ${entry.actor} on ${entry.resourceType}:${entry.resourceId}.`,
        timestamp: new Date().toISOString(),
        logIds: [entry.id],
        metadata: { fieldCount: entry.fields.length },
      };
      this.notifyHooks(anomaly);
    }
  }

  private notifyHooks(anomaly: AnomalyEvent): void {
    for (const hook of this.anomalyHooks) {
      try {
        hook(structuredClone(anomaly));
      } catch {
        // Hook errors can contain credentials; never print their contents.
        console.error("Sensitive access anomaly hook failed.");
      }
    }
  }

  /**
   * Query recorded logs with optional filters.
   */
  public queryLogs(filter?: {
    actor?: string;
    resourceType?: string;
    authorized?: boolean;
    bulk?: boolean;
    since?: string;
  }): SensitiveFieldAccessLogEntry[] {
    let result = [...this.logs];
    if (!filter) return structuredClone(result);

    if (filter.actor) {
      result = result.filter((l) => l.actor === filter.actor);
    }
    if (filter.resourceType) {
      result = result.filter((l) => l.resourceType === filter.resourceType);
    }
    if (filter.authorized !== undefined) {
      result = result.filter((l) => l.authorized === filter.authorized);
    }
    if (filter.bulk !== undefined) {
      result = result.filter((l) => l.bulk === filter.bulk);
    }
    if (filter.since) {
      result = result.filter((l) => l.timestamp >= filter.since!);
    }

    return structuredClone(result);
  }

  /** Clear stored logs (primarily for testing). */
  public clear(): void {
    this.logs = [];
  }
}

/** Global singleton instance for app-wide sensitive access logging. */
export const sensitiveAccessLogger = new SensitiveFieldAccessLogger();
