/**
 * VaultQuest Cross-Service Contract Map
 *
 * Documents all domain events, integration boundaries, producer/consumer pairs,
 * required fields, versioning rules, and allowed failure behavior.
 *
 * This is the single source of truth for domain event contracts across:
 * - Vault deposits and withdrawals
 * - Prize round cycles
 * - Quest participation
 * - Settlement and reconciliation
 * - Indexer synchronization
 */

import { z } from "zod";

/**
 * Event versioning strategy:
 * - Version is immutable: once v1 is published, it never changes.
 * - New fields are added as v2+ (breaking changes require new version).
 * - Consumers must handle older versions (backwards compatibility required).
 * - Deprecation timeline: v1 support until 3 months after v2 GA.
 */

// ─────────────────────────────────────────────────────────────────────────
// CORE DOMAIN EVENTS
// ─────────────────────────────────────────────────────────────────────────

/**
 * vault_deposit_submitted
 *
 * Producer: Ledger Service (POST /actions)
 * Consumers: Indexer, Webhook Router, Metrics
 *
 * Fired when a user intent is accepted and submitted to the chain.
 * Ledger state is now PENDING; on-chain verification is in flight.
 */
export const vaultDepositSubmittedV1Schema = z.object({
  version: z.literal("1"),
  event_id: z.string().min(1).max(256),
  event_type: z.literal("vault_deposit_submitted"),
  timestamp: z.string().datetime(),
  wallet_address: z.string().min(1),
  vault_id: z.string().min(1),
  amount: z.string(), // Amount in base units (e.g., stroops)
  asset: z.string().optional(),
  tx_hash: z.string().min(64).max(64), // Stellar tx hash (hex)
  action_id: z.string().min(1), // Local ledger action ID for idempotency
  idempotency_key: z.string().min(1), // User-provided idempotency key
});
export type VaultDepositSubmittedV1 = z.infer<typeof vaultDepositSubmittedV1Schema>;

/**
 * vault_deposit_confirmed
 *
 * Producer: Reconciliation Engine
 * Consumers: Ledger Service, Webhook Router, Metrics
 *
 * Fired when a deposit tx is confirmed on-chain and reconciled against DB state.
 * Ledger state transitions to CONFIRMED. User balance is updated.
 */
export const vaultDepositConfirmedV1Schema = z.object({
  version: z.literal("1"),
  event_id: z.string().min(1).max(256),
  event_type: z.literal("vault_deposit_confirmed"),
  timestamp: z.string().datetime(),
  wallet_address: z.string().min(1),
  vault_id: z.string().min(1),
  amount: z.string(),
  asset: z.string().optional(),
  tx_hash: z.string().min(64).max(64),
  action_id: z.string().min(1),
  confirmed_ledger: z.number().int().positive(),
  soroban_event_id: z.string().optional(), // On-chain event ID if available
});
export type VaultDepositConfirmedV1 = z.infer<typeof vaultDepositConfirmedV1Schema>;

/**
 * vault_deposit_failed
 *
 * Producer: Reconciliation Engine or Settlement Service
 * Consumers: Ledger Service, Webhook Router, User Notifications
 *
 * Fired when a deposit tx is rejected on-chain or fails to confirm within TTL.
 * Ledger state transitions to FAILED. User is refunded if funds were locked.
 * Allowed failure reasons: "reverted_on_chain", "timeout", "orphaned".
 */
export const vaultDepositFailedV1Schema = z.object({
  version: z.literal("1"),
  event_id: z.string().min(1).max(256),
  event_type: z.literal("vault_deposit_failed"),
  timestamp: z.string().datetime(),
  wallet_address: z.string().min(1),
  vault_id: z.string().min(1),
  amount: z.string(),
  tx_hash: z.string().min(64).max(64),
  action_id: z.string().min(1),
  failure_reason: z.enum(["reverted_on_chain", "timeout", "orphaned", "unknown"]),
  failure_details: z.string().optional(),
});
export type VaultDepositFailedV1 = z.infer<typeof vaultDepositFailedV1Schema>;

/**
 * prize_round_drawn
 *
 * Producer: Draw Proof Service (select_winner action)
 * Consumers: Ledger Service, Webhook Router, Indexer, Metrics
 *
 * Fired when a prize draw is executed and a winner is selected.
 * Proof of randomness is linked. Winner will receive prize via settlement.
 */
export const prizeRoundDrawnV1Schema = z.object({
  version: z.literal("1"),
  event_id: z.string().min(1).max(256),
  event_type: z.literal("prize_round_drawn"),
  timestamp: z.string().datetime(),
  pool_id: z.string().min(1),
  round_id: z.number().int().nonnegative(),
  winner_wallet: z.string().min(1),
  prize_amount: z.string(),
  randomness_tx_hash: z.string().min(64).max(64),
  draw_proof_id: z.string().optional(),
  eligible_participants: z.number().int().positive(),
});
export type PrizeRoundDrawnV1 = z.infer<typeof prizeRoundDrawnV1Schema>;

/**
 * settlement_initiated
 *
 * Producer: Settlement Service
 * Consumers: Ledger Service, Webhook Router, Indexer
 *
 * Fired when a settlement tx (prize payout, vault release, etc.) is submitted to chain.
 * No user funds change yet; tx is in flight. If tx fails, settlement_failed is fired.
 */
export const settlementInitiatedV1Schema = z.object({
  version: z.literal("1"),
  event_id: z.string().min(1).max(256),
  event_type: z.literal("settlement_initiated"),
  timestamp: z.string().datetime(),
  settlement_id: z.string().min(1),
  settlement_type: z.enum(["release", "distribute", "refund"]),
  vault_id: z.string().min(1),
  recipient_wallet: z.string().min(1),
  amount: z.string(),
  tx_hash: z.string().min(64).max(64),
  retry_count: z.number().int().nonnegative(),
});
export type SettlementInitiatedV1 = z.infer<typeof settlementInitiatedV1Schema>;

/**
 * settlement_completed
 *
 * Producer: Reconciliation Engine
 * Consumers: Ledger Service, Webhook Router, Metrics
 *
 * Fired when a settlement tx is confirmed on-chain.
 * User funds have been paid out. Vault settlement record is terminal.
 */
export const settlementCompletedV1Schema = z.object({
  version: z.literal("1"),
  event_id: z.string().min(1).max(256),
  event_type: z.literal("settlement_completed"),
  timestamp: z.string().datetime(),
  settlement_id: z.string().min(1),
  settlement_type: z.enum(["release", "distribute", "refund"]),
  vault_id: z.string().min(1),
  recipient_wallet: z.string().min(1),
  amount: z.string(),
  tx_hash: z.string().min(64).max(64),
  confirmed_ledger: z.number().int().positive(),
  soroban_event_id: z.string().optional(),
});
export type SettlementCompletedV1 = z.infer<typeof settlementCompletedV1Schema>;

/**
 * settlement_failed
 *
 * Producer: Settlement Service or Reconciliation Engine
 * Consumers: Ledger Service, Webhook Router, Admin Alerts
 *
 * Fired when a settlement tx fails after retries are exhausted.
 * Settlement record moves to FAILED. Operator intervention required.
 * Allowed failure reasons: "reverted_on_chain", "retries_exhausted", "timeout".
 */
export const settlementFailedV1Schema = z.object({
  version: z.literal("1"),
  event_id: z.string().min(1).max(256),
  event_type: z.literal("settlement_failed"),
  timestamp: z.string().datetime(),
  settlement_id: z.string().min(1),
  settlement_type: z.enum(["release", "distribute", "refund"]),
  vault_id: z.string().min(1),
  recipient_wallet: z.string().min(1),
  amount: z.string(),
  tx_hash: z.string().min(64).max(64),
  failure_reason: z.enum(["reverted_on_chain", "retries_exhausted", "timeout", "unknown"]),
  failure_details: z.string().optional(),
  retry_count: z.number().int().nonnegative(),
});
export type SettlementFailedV1 = z.infer<typeof settlementFailedV1Schema>;

/**
 * drift_detected
 *
 * Producer: Reconciliation Engine or On-Chain Drift Detector
 * Consumers: Admin Dashboard, Alert System, Manual Recovery Queue
 *
 * Fired when ledger state diverges from on-chain state.
 * Examples: missing event, stale pending action, settlement payout mismatch.
 * This is an alert event, not a user-facing domain event.
 */
export const driftDetectedV1Schema = z.object({
  version: z.literal("1"),
  event_id: z.string().min(1).max(256),
  event_type: z.literal("drift_detected"),
  timestamp: z.string().datetime(),
  drift_type: z.enum([
    "missing_event",
    "missing_action",
    "stale_pending_event",
    "settlement_payout_mismatch",
    "vault_state_mismatch",
    "participant_state_mismatch",
  ]),
  record_type: z.enum(["action_ledger", "vault_settlement", "pending_event"]),
  record_id: z.string().min(1),
  details: z.record(z.unknown()),
  severity: z.enum(["low", "medium", "high", "critical"]),
});
export type DriftDetectedV1 = z.infer<typeof driftDetectedV1Schema>;

// ─────────────────────────────────────────────────────────────────────────
// EVENT UNION TYPES
// ─────────────────────────────────────────────────────────────────────────

export const domainEventV1Schema = z.discriminatedUnion("event_type", [
  vaultDepositSubmittedV1Schema,
  vaultDepositConfirmedV1Schema,
  vaultDepositFailedV1Schema,
  prizeRoundDrawnV1Schema,
  settlementInitiatedV1Schema,
  settlementCompletedV1Schema,
  settlementFailedV1Schema,
  driftDetectedV1Schema,
]);

export type DomainEventV1 = z.infer<typeof domainEventV1Schema>;

/**
 * All domain events (across all versions).
 * Consumers must handle any version they care about.
 */
export const domainEventSchema = z.union([domainEventV1Schema]);
export type DomainEvent = z.infer<typeof domainEventSchema>;

// ─────────────────────────────────────────────────────────────────────────
// SERVICE CONTRACTS
// ─────────────────────────────────────────────────────────────────────────

/**
 * Contract: Ledger Service → Indexer
 *
 * - Event: vault_deposit_submitted, vault_deposit_confirmed, prize_round_drawn
 * - Frequency: As emitted (real-time via event sink or batch)
 * - Guaranteed delivery: At-least-once (idempotency key prevents duplicates)
 * - Failure handling: Indexer buffers and retries; ledger is unaffected
 * - Rollback: Indexer can backfill from chain if behind
 */
export interface LedgerToIndexerContract {
  produces: ["vault_deposit_submitted", "vault_deposit_confirmed", "prize_round_drawn"];
  requires: {
    vault_id: string;
    wallet_address: string;
    amount: string;
    tx_hash: string;
    timestamp: string;
  };
  idempotencyKey: string; // Same tx_hash + event_id = same effect
  failureMode: "buffer_and_retry" | "skip_and_alert";
  ttl: "never"; // Events are permanent
}

/**
 * Contract: Settlement Service → Ledger Service
 *
 * - Event: settlement_initiated, settlement_completed, settlement_failed
 * - Frequency: Per settlement operation (not repeated)
 * - Guaranteed delivery: At-least-once (via settlement ID idempotency)
 * - Failure handling: Ledger retries settlement lookup on failure event
 * - Rollback: Ledger marks settlement as unresolved; operator intervention
 */
export interface SettlementToLedgerContract {
  produces: ["settlement_initiated", "settlement_completed", "settlement_failed"];
  requires: {
    settlement_id: string;
    settlement_type: "release" | "distribute" | "refund";
    vault_id: string;
    recipient_wallet: string;
    amount: string;
    tx_hash: string;
  };
  idempotencyKey: string; // settlement_id
  failureMode: "retry_settlement" | "escalate_to_operator";
  ttl: "permanent";
}

/**
 * Contract: Reconciliation Engine → Ledger Service
 *
 * - Event: vault_deposit_confirmed, vault_deposit_failed, settlement_completed, settlement_failed, drift_detected
 * - Frequency: Per on-chain tx verification (may be delayed hours/days)
 * - Guaranteed delivery: At-least-once (via tx_hash idempotency)
 * - Failure handling: Ledger accepts late confirmations; updates balance retroactively
 * - Rollback: Drift_detected events trigger manual review
 */
export interface ReconciliationToLedgerContract {
  produces: [
    "vault_deposit_confirmed",
    "vault_deposit_failed",
    "settlement_completed",
    "settlement_failed",
    "drift_detected",
  ];
  requires: {
    tx_hash: string; // On-chain transaction ID
    confirmed_ledger: number;
    soroban_event_id: string; // On-chain event ID for verification
    failure_reason: string; // Why it failed, if applicable
  };
  idempotencyKey: string; // tx_hash + soroban_event_id
  failureMode: "idempotent_update" | "alert_drift";
  ttl: "permanent";
}

/**
 * Contract: Ledger Service → Webhook Router
 *
 * - Event: All domain events
 * - Frequency: As emitted (real-time push or async queue)
 * - Guaranteed delivery: At-least-once (webhook event store retries)
 * - Failure handling: Webhook router retries with exponential backoff; dead-letter after N failures
 * - Rollback: Webhook consumer must be idempotent; events are immutable
 */
export interface LedgerToWebhookContract {
  produces: DomainEvent["event_type"][];
  requires: {
    event_id: string; // Unique event ID for deduplication
    event_type: string;
    timestamp: string;
    version: string;
  };
  idempotencyKey: string; // event_id
  failureMode: "retry_with_backoff" | "dead_letter_queue";
  ttl: "3_days"; // Webhook events expire after 3 days
}

/**
 * Contract: Indexer → Drift Detector
 *
 * - Event: drift_detected (reported by reconciliation)
 * - Frequency: As detected (potentially high during reconciliation)
 * - Guaranteed delivery: At-least-once
 * - Failure handling: Drift detector buffers; operator notified
 * - Rollback: Drift records are archived; operator resolution is logged
 */
export interface DriftDetectorContract {
  produces: ["drift_detected"];
  requires: {
    record_type: "action_ledger" | "vault_settlement" | "pending_event";
    record_id: string;
    drift_type: string;
    severity: "low" | "medium" | "high" | "critical";
  };
  idempotencyKey: string; // drift_type + record_id
  failureMode: "operator_alert" | "auto_resolution_attempt";
  ttl: "permanent";
}

// ─────────────────────────────────────────────────────────────────────────
// SERVICE BOUNDARY MAP
// ─────────────────────────────────────────────────────────────────────────

/**
 * Maps all cross-service event flows.
 * Each entry is a producer → consumer relationship.
 */
export const SERVICE_BOUNDARY_MAP = [
  {
    producer: "LedgerService",
    consumer: "Indexer",
    events: ["vault_deposit_submitted", "vault_deposit_confirmed", "prize_round_drawn"],
    contract: "LedgerToIndexerContract" as const,
    required: true,
    failureImpact: "low", // Indexer lag is acceptable
  },
  {
    producer: "SettlementService",
    consumer: "LedgerService",
    events: ["settlement_initiated", "settlement_completed", "settlement_failed"],
    contract: "SettlementToLedgerContract" as const,
    required: true,
    failureImpact: "high", // Settlement failures must be recorded
  },
  {
    producer: "ReconciliationEngine",
    consumer: "LedgerService",
    events: ["vault_deposit_confirmed", "vault_deposit_failed", "settlement_completed", "settlement_failed"],
    contract: "ReconciliationToLedgerContract" as const,
    required: true,
    failureImpact: "critical", // Reconciliation failures break ledger truth
  },
  {
    producer: "LedgerService",
    consumer: "WebhookRouter",
    events: [
      "vault_deposit_submitted",
      "vault_deposit_confirmed",
      "vault_deposit_failed",
      "prize_round_drawn",
      "settlement_initiated",
      "settlement_completed",
      "settlement_failed",
    ],
    contract: "LedgerToWebhookContract" as const,
    required: false,
    failureImpact: "low", // Webhooks are external; non-critical
  },
  {
    producer: "ReconciliationEngine",
    consumer: "DriftDetector",
    events: ["drift_detected"],
    contract: "DriftDetectorContract" as const,
    required: false,
    failureImpact: "low", // Drift detection is alerting; non-critical
  },
] as const;

// ─────────────────────────────────────────────────────────────────────────
// VERSIONING & MIGRATION RULES
// ─────────────────────────────────────────────────────────────────────────

export const VERSION_POLICY = {
  /**
   * How long v1 events are supported after v2 is released.
   * After this period, v1 events are rejected.
   */
  supportWindowDays: 90,

  /**
   * Consumers must handle all versions within the support window.
   * New consumers must support the latest version at deployment.
   */
  consumerRequirement: "handle_current_and_prior_supported_versions",

  /**
   * Required fields are immutable; adding required fields is a breaking change.
   * Optional fields can be added in any version.
   */
  requiredFieldPolicy: "immutable_once_required",

  /**
   * If a required field is being deprecated, produce both old and new field
   * for 1 support window, then emit only new field.
   */
  deprecationStrategy: "dual_emit_then_cutover",

  /**
   * Backward compatibility is REQUIRED; no hard cutoffs.
   * Plan 3-month migrations for breaking changes.
   */
  breakingChangePolicy: "requires_migration_plan",
} as const;

// ─────────────────────────────────────────────────────────────────────────
// QUERY HELPERS
// ─────────────────────────────────────────────────────────────────────────

/**
 * Get all events produced by a service.
 */
export function getProducerEvents(producer: string): string[] {
  return SERVICE_BOUNDARY_MAP.filter((entry) => entry.producer === producer).flatMap((entry) => entry.events);
}

/**
 * Get all events consumed by a service.
 */
export function getConsumerEvents(consumer: string): string[] {
  return SERVICE_BOUNDARY_MAP.filter((entry) => entry.consumer === consumer).flatMap((entry) => entry.events);
}

/**
 * Check if an event is critical (high or critical failure impact).
 */
export function isCriticalEvent(eventType: string): boolean {
  const entry = SERVICE_BOUNDARY_MAP.find((e) => e.events.includes(eventType));
  return entry ? entry.failureImpact === "critical" || entry.failureImpact === "high" : false;
}

/**
 * Get the contract requirements for an event flow.
 */
export function getContractFor(producer: string, consumer: string): (typeof SERVICE_BOUNDARY_MAP)[0] | undefined {
  return SERVICE_BOUNDARY_MAP.find((entry) => entry.producer === producer && entry.consumer === consumer);
}
