/**
 * Cross-Service Event Schema Drift Detection (#1090)
 *
 * Verifies contract and domain event schemas across boundaries (Soroban smart
 * contracts, Fastify backend ledger, Indexer, and Reconciliation Engine).
 * Detects missing required fields, type mismatches, unsupported versions,
 * unauthorized fields, and envelope topic drift.
 *
 * Design & Architecture:
 * - Pure, dependency-free core with deterministic evaluation.
 * - Adheres to VaultQuest Version Policy (3-month migration window, backward compatibility).
 * - Full coverage of normal, failure, retry, and authorization execution paths.
 * - Time complexity: O(N * F) where N = event count, F = fields count per event.
 * - Space complexity: O(D) where D = number of detected drift entries.
 */

export type DriftSeverity = "critical" | "high" | "medium" | "low";

export type DriftType =
  | "MISSING_REQUIRED_FIELD"
  | "TYPE_MISMATCH"
  | "UNSUPPORTED_VERSION"
  | "UNAUTHORIZED_FIELD"
  | "ENVELOPE_TOPIC_MISMATCH"
  | "MALFORMED_PAYLOAD";

export interface EventSchemaField {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array" | "numeric_string" | "stellar_address" | "iso_datetime" | "hex64";
  required: boolean;
  deprecated?: boolean;
}

export interface CanonicalEventSchema {
  eventName: string;
  source: "soroban_contract" | "backend_domain";
  supportedVersions: string[];
  fields: EventSchemaField[];
  critical: boolean;
}

export interface EventEnvelope {
  topics?: string[];
  version?: string;
  event_type?: string;
  name?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SchemaDriftEntry {
  eventName: string;
  source: string;
  driftType: DriftType;
  field?: string;
  expected?: string;
  actual?: string;
  severity: DriftSeverity;
  message: string;
}

export interface DriftDetectionResult {
  passed: boolean;
  totalEventsChecked: number;
  driftCount: number;
  drifts: SchemaDriftEntry[];
  summary: string;
  timestamp: string;
}

export interface DriftAuthContext {
  caller: string;
  role: "admin" | "service" | "auditor" | "unauthorized";
  token?: string;
}

export class SchemaDriftAuthError extends Error {
  readonly code = "SCHEMA_DRIFT_UNAUTHORIZED";
  constructor(message: string) {
    super(message);
    this.name = "SchemaDriftAuthError";
  }
}

/**
 * Canonical event schemas for Soroban smart contracts per contracts/docs/EVENT_SCHEMA.md
 */
export const CANONICAL_SOROBAN_SCHEMAS: Record<string, CanonicalEventSchema> = {
  pool_created: {
    eventName: "pool_created",
    source: "soroban_contract",
    supportedVersions: ["v1"],
    critical: true,
    fields: [
      { name: "pool_id", type: "string", required: true },
      { name: "creator", type: "stellar_address", required: true },
      { name: "asset", type: "string", required: true },
      { name: "target_amount", type: "numeric_string", required: true },
      { name: "opens_at", type: "number", required: true },
      { name: "locks_at", type: "number", required: true },
      { name: "draws_at", type: "number", required: true },
      { name: "admin", type: "stellar_address", required: true },
      { name: "idempotency_key", type: "string", required: false },
    ],
  },
  pool_joined: {
    eventName: "pool_joined",
    source: "soroban_contract",
    supportedVersions: ["v1"],
    critical: true,
    fields: [
      { name: "pool_id", type: "string", required: true },
      { name: "wallet", type: "stellar_address", required: true },
      { name: "amount", type: "numeric_string", required: true },
      { name: "shares", type: "numeric_string", required: true },
      { name: "participant_count", type: "number", required: true },
      { name: "idempotency_key", type: "string", required: false },
    ],
  },
  drip_deposited: {
    eventName: "drip_deposited",
    source: "soroban_contract",
    supportedVersions: ["v1"],
    critical: true,
    fields: [
      { name: "pool_id", type: "string", required: true },
      { name: "wallet", type: "stellar_address", required: true },
      { name: "amount", type: "numeric_string", required: true },
      { name: "shares_delta", type: "numeric_string", required: true },
      { name: "total_deposited", type: "numeric_string", required: true },
      { name: "tvl", type: "numeric_string", required: true },
      { name: "idempotency_key", type: "string", required: false },
    ],
  },
  reward_claimed: {
    eventName: "reward_claimed",
    source: "soroban_contract",
    supportedVersions: ["v1"],
    critical: true,
    fields: [
      { name: "pool_id", type: "string", required: true },
      { name: "wallet", type: "stellar_address", required: true },
      { name: "amount", type: "numeric_string", required: true },
      { name: "asset", type: "string", required: true },
      { name: "cycle", type: "number", required: true },
      { name: "idempotency_key", type: "string", required: false },
    ],
  },
  withdrawn: {
    eventName: "withdrawn",
    source: "soroban_contract",
    supportedVersions: ["v1"],
    critical: true,
    fields: [
      { name: "pool_id", type: "string", required: true },
      { name: "wallet", type: "stellar_address", required: true },
      { name: "amount", type: "numeric_string", required: true },
      { name: "shares_burned", type: "numeric_string", required: true },
      { name: "remaining_shares", type: "numeric_string", required: true },
      { name: "idempotency_key", type: "string", required: false },
    ],
  },
  payout_selected: {
    eventName: "payout_selected",
    source: "soroban_contract",
    supportedVersions: ["v1"],
    critical: true,
    fields: [
      { name: "pool_id", type: "string", required: true },
      { name: "winner", type: "stellar_address", required: true },
      { name: "round_id", type: "number", required: true },
      { name: "amount", type: "numeric_string", required: true },
      { name: "asset", type: "string", required: true },
      { name: "cycle", type: "number", required: true },
      { name: "randomness_ref", type: "string", required: false },
    ],
  },
  paused: {
    eventName: "paused",
    source: "soroban_contract",
    supportedVersions: ["v1"],
    critical: false,
    fields: [
      { name: "scope", type: "string", required: true },
      { name: "admin", type: "stellar_address", required: true },
      { name: "reason", type: "string", required: true },
      { name: "paused_at", type: "number", required: true },
    ],
  },
  recovered: {
    eventName: "recovered",
    source: "soroban_contract",
    supportedVersions: ["v1"],
    critical: false,
    fields: [
      { name: "scope", type: "string", required: true },
      { name: "admin", type: "stellar_address", required: true },
      { name: "recovered_at", type: "number", required: true },
    ],
  },
};

/**
 * Canonical event schemas for Backend cross-service domain events per backend/src/schemas/contractMap.ts
 */
export const CANONICAL_BACKEND_SCHEMAS: Record<string, CanonicalEventSchema> = {
  vault_deposit_submitted: {
    eventName: "vault_deposit_submitted",
    source: "backend_domain",
    supportedVersions: ["1", "v1"],
    critical: true,
    fields: [
      { name: "version", type: "string", required: true },
      { name: "event_id", type: "string", required: true },
      { name: "event_type", type: "string", required: true },
      { name: "timestamp", type: "iso_datetime", required: true },
      { name: "wallet_address", type: "stellar_address", required: true },
      { name: "vault_id", type: "string", required: true },
      { name: "amount", type: "numeric_string", required: true },
      { name: "tx_hash", type: "hex64", required: true },
      { name: "action_id", type: "string", required: true },
      { name: "idempotency_key", type: "string", required: true },
      { name: "asset", type: "string", required: false },
    ],
  },
  vault_deposit_confirmed: {
    eventName: "vault_deposit_confirmed",
    source: "backend_domain",
    supportedVersions: ["1", "v1"],
    critical: true,
    fields: [
      { name: "version", type: "string", required: true },
      { name: "event_id", type: "string", required: true },
      { name: "event_type", type: "string", required: true },
      { name: "timestamp", type: "iso_datetime", required: true },
      { name: "wallet_address", type: "stellar_address", required: true },
      { name: "vault_id", type: "string", required: true },
      { name: "amount", type: "numeric_string", required: true },
      { name: "tx_hash", type: "hex64", required: true },
      { name: "action_id", type: "string", required: true },
      { name: "confirmed_ledger", type: "number", required: true },
      { name: "soroban_event_id", type: "string", required: false },
    ],
  },
  vault_deposit_failed: {
    eventName: "vault_deposit_failed",
    source: "backend_domain",
    supportedVersions: ["1", "v1"],
    critical: true,
    fields: [
      { name: "version", type: "string", required: true },
      { name: "event_id", type: "string", required: true },
      { name: "event_type", type: "string", required: true },
      { name: "timestamp", type: "iso_datetime", required: true },
      { name: "wallet_address", type: "stellar_address", required: true },
      { name: "vault_id", type: "string", required: true },
      { name: "amount", type: "numeric_string", required: true },
      { name: "tx_hash", type: "hex64", required: true },
      { name: "action_id", type: "string", required: true },
      { name: "failure_reason", type: "string", required: true },
      { name: "failure_details", type: "string", required: false },
    ],
  },
  prize_round_drawn: {
    eventName: "prize_round_drawn",
    source: "backend_domain",
    supportedVersions: ["1", "v1"],
    critical: true,
    fields: [
      { name: "version", type: "string", required: true },
      { name: "event_id", type: "string", required: true },
      { name: "event_type", type: "string", required: true },
      { name: "timestamp", type: "iso_datetime", required: true },
      { name: "pool_id", type: "string", required: true },
      { name: "round_id", type: "number", required: true },
      { name: "winner_wallet", type: "stellar_address", required: true },
      { name: "prize_amount", type: "numeric_string", required: true },
      { name: "randomness_tx_hash", type: "hex64", required: true },
      { name: "eligible_participants", type: "number", required: true },
      { name: "draw_proof_id", type: "string", required: false },
    ],
  },
  drift_detected: {
    eventName: "drift_detected",
    source: "backend_domain",
    supportedVersions: ["1", "v1"],
    critical: false,
    fields: [
      { name: "version", type: "string", required: true },
      { name: "event_id", type: "string", required: true },
      { name: "event_type", type: "string", required: true },
      { name: "timestamp", type: "iso_datetime", required: true },
      { name: "drift_type", type: "string", required: true },
      { name: "record_type", type: "string", required: true },
      { name: "record_id", type: "string", required: true },
      { name: "details", type: "object", required: true },
      { name: "severity", type: "string", required: true },
    ],
  },
};

/**
 * Type validation helper.
 */
function isValidType(value: unknown, expectedType: EventSchemaField["type"]): boolean {
  if (value === null || value === undefined) return false;

  switch (expectedType) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && !isNaN(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "numeric_string":
      return typeof value === "string" && /^\d+(\.\d+)?$/.test(value);
    case "stellar_address":
      return typeof value === "string" && /^[GC][A-Z2-7]{55}$/.test(value.trim());
    case "iso_datetime":
      if (typeof value !== "string") return false;
      return !isNaN(Date.parse(value));
    case "hex64":
      return typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value);
    default:
      return true;
  }
}

/**
 * Authorizes a caller before running drift detection operations.
 */
export function authorizeDriftInspection(auth?: DriftAuthContext): void {
  if (!auth) {
    throw new SchemaDriftAuthError("Authentication context is required for schema drift inspection.");
  }
  const allowedRoles = ["admin", "service", "auditor"];
  if (!allowedRoles.includes(auth.role)) {
    throw new SchemaDriftAuthError(
      `Role '${auth.role}' is not authorized to inspect or manage schema drift. Required: ${allowedRoles.join(
        ", ",
      )}`,
    );
  }
}

export interface DriftDetectionOptions {
  auth?: DriftAuthContext;
  strict?: boolean;
  maxRetries?: number;
  retryDelayMs?: number;
}

/**
 * Validates a single event against canonical schemas and reports any schema drift.
 */
export function validateEventSchema(
  event: EventEnvelope,
  schema: CanonicalEventSchema,
  strict = false,
): SchemaDriftEntry[] {
  const drifts: SchemaDriftEntry[] = [];
  const eventName = schema.eventName;
  const isSoroban = schema.source === "soroban_contract";

  // 1. Envelope topic verification for Soroban events
  if (isSoroban && event.topics) {
    if (!Array.isArray(event.topics) || event.topics.length < 3) {
      drifts.push({
        eventName,
        source: schema.source,
        driftType: "ENVELOPE_TOPIC_MISMATCH",
        severity: "critical",
        message: "Soroban event topics must have at least 3 elements [prefix, version, event_name]",
      });
    } else {
      if (event.topics[0] !== "vaultquest") {
        drifts.push({
          eventName,
          source: schema.source,
          driftType: "ENVELOPE_TOPIC_MISMATCH",
          expected: "vaultquest",
          actual: event.topics[0],
          severity: "critical",
          message: `Topic[0] mismatch: expected 'vaultquest', got '${event.topics[0]}'`,
        });
      }
      if (!schema.supportedVersions.includes(event.topics[1])) {
        drifts.push({
          eventName,
          source: schema.source,
          driftType: "UNSUPPORTED_VERSION",
          expected: schema.supportedVersions.join(" | "),
          actual: event.topics[1],
          severity: "high",
          message: `Unsupported version '${event.topics[1]}' in topic[1]`,
        });
      }
      if (event.topics[2] !== eventName) {
        drifts.push({
          eventName,
          source: schema.source,
          driftType: "ENVELOPE_TOPIC_MISMATCH",
          expected: eventName,
          actual: event.topics[2],
          severity: "critical",
          message: `Topic[2] mismatch: expected '${eventName}', got '${event.topics[2]}'`,
        });
      }
    }
  }

  // 2. Extract payload
  let payload: Record<string, unknown> | null = null;
  if (isSoroban) {
    if ("payload" in event) {
      payload = event.payload as Record<string, unknown> | null;
    } else {
      payload = event as Record<string, unknown>;
    }
  } else {
    payload = event as Record<string, unknown>;
  }

  if (!payload || typeof payload !== "object") {
    drifts.push({
      eventName,
      source: schema.source,
      driftType: "MALFORMED_PAYLOAD",
      severity: "critical",
      message: "Event payload must be a non-null object",
    });
    return drifts;
  }

  // 3. Field validation
  const fieldMap = new Map(schema.fields.map((f) => [f.name, f]));

  for (const field of schema.fields) {
    const val = payload[field.name];

    if (field.required) {
      if (val === undefined || val === null || val === "") {
        drifts.push({
          eventName,
          source: schema.source,
          driftType: "MISSING_REQUIRED_FIELD",
          field: field.name,
          expected: field.type,
          severity: schema.critical ? "critical" : "high",
          message: `Missing required field '${field.name}' on event '${eventName}'`,
        });
        continue;
      }
    }

    if (val !== undefined && val !== null) {
      if (!isValidType(val, field.type)) {
        drifts.push({
          eventName,
          source: schema.source,
          driftType: "TYPE_MISMATCH",
          field: field.name,
          expected: field.type,
          actual: typeof val,
          severity: schema.critical ? "critical" : "high",
          message: `Field '${field.name}' expected type '${field.type}', got '${typeof val}'`,
        });
      }
    }
  }

  // 4. Strict unexpected field check
  if (strict) {
    for (const key of Object.keys(payload)) {
      if (key === "topics" || key === "payload" || key === "event_id") continue;
      if (!fieldMap.has(key)) {
        drifts.push({
          eventName,
          source: schema.source,
          driftType: "UNAUTHORIZED_FIELD",
          field: key,
          severity: "low",
          message: `Unexpected unversioned field '${key}' found in payload`,
        });
      }
    }
  }

  return drifts;
}

/**
 * Detects cross-service schema drift across multiple events.
 * Supports retry with backoff on batch evaluation errors.
 */
export async function detectCrossServiceEventDrift(
  events: Array<{ event: EventEnvelope; schemaKey?: string }>,
  options: DriftDetectionOptions = {},
): Promise<DriftDetectionResult> {
  const t0 = Date.now();

  // Authorization Path
  if (options.auth) {
    authorizeDriftInspection(options.auth);
  }

  const maxRetries = options.maxRetries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 50;

  const allDrifts: SchemaDriftEntry[] = [];
  let checkedCount = 0;

  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      for (const item of events) {
        const ev = item.event;
        const eventName =
          item.schemaKey ||
          (ev.event_type as string) ||
          (ev.name as string) ||
          (ev.topics?.[2] as string);

        if (!eventName) {
          allDrifts.push({
            eventName: "unknown",
            source: "unidentified",
            driftType: "MALFORMED_PAYLOAD",
            severity: "critical",
            message: "Cannot determine event name or type from payload",
          });
          continue;
        }

        const schema = CANONICAL_SOROBAN_SCHEMAS[eventName] || CANONICAL_BACKEND_SCHEMAS[eventName];
        if (!schema) {
          allDrifts.push({
            eventName,
            source: "unregistered",
            driftType: "UNSUPPORTED_VERSION",
            severity: "medium",
            message: `Event '${eventName}' is not registered in the canonical contract map`,
          });
          continue;
        }

        const itemDrifts = validateEventSchema(ev, schema, options.strict);
        allDrifts.push(...itemDrifts);
        checkedCount++;
      }
      break; // Success
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, retryDelayMs * Math.pow(1.5, attempt - 1)));
    }
  }

  const criticalOrHigh = allDrifts.filter(
    (d) => d.severity === "critical" || d.severity === "high",
  );

  const passed = criticalOrHigh.length === 0;
  const summary = passed
    ? `All ${checkedCount} events conform to canonical cross-service schemas (${allDrifts.length} warnings/low drift)`
    : `Detected ${criticalOrHigh.length} breaking schema drift(s) across ${checkedCount} events`;

  return {
    passed,
    totalEventsChecked: checkedCount,
    driftCount: allDrifts.length,
    drifts: allDrifts,
    summary,
    timestamp: new Date().toISOString(),
  };
}
