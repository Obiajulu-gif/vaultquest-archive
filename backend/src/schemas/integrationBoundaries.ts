/**
 * VaultQuest Integration Boundaries
 *
 * Defines service-to-service contracts, failure modes, and recovery procedures.
 * Each boundary specifies what happens when integration fails and how state is recovered.
 */

// ─────────────────────────────────────────────────────────────────────────
// DEPOSIT FLOW INTEGRATION BOUNDARIES
// ─────────────────────────────────────────────────────────────────────────

/**
 * Ledger Service → Soroban RPC (submit tx)
 *
 * Boundary: User deposits PENDING state change
 * Failure: RPC returns 5xx, timeout, or network error
 * Recovery: Retry with exponential backoff; mark action as ERROR after N retries
 * User Impact: Deposit blocked; user sees "network error" with retry prompt
 * Idempotency: Stellar tx signature ensures no duplicate submission
 */
export const LEDGER_TO_RPC_SUBMIT: IntegrationBoundary = {
  id: "ledger_to_rpc_submit",
  producer: "LedgerService",
  consumer: "SorobanRPC",
  operationType: "vault_deposit",
  requiredForMutation: true,
  failureMode: {
    scenario: "RPC submission failure",
    maxRetries: 3,
    backoffMs: 1000,
    backoffMultiplier: 2,
    timeoutMs: 5000,
    idempotencyKey: "tx_hash (Stellar signature)",
    userMessage: "Could not submit your deposit. Retrying...",
  },
  recoveryProcedure: {
    automaticRetry: true,
    requiredIntervention: false,
    steps: [
      "Ledger Service retries tx submission with exponential backoff",
      "User sees retry count and estimated wait time",
      "If retries exhausted, action moves to ERROR state",
      "User can manually retry via /actions/{id}/retry",
    ],
  },
};

/**
 * Reconciliation Engine → Soroban RPC (getEvents)
 *
 * Boundary: Verify tx landed on-chain
 * Failure: RPC returns 5xx, stale data, or event missing
 * Recovery: Query multiple RPC endpoints; fallback to indexer cache
 * User Impact: Deposit confirmation delayed (may take hours)
 * Idempotency: tx_hash + soroban_event_id identifies unique event
 */
export const RECONCILER_TO_RPC_GETEVENTS: IntegrationBoundary = {
  id: "reconciler_to_rpc_getevents",
  producer: "ReconciliationEngine",
  consumer: "SorobanRPC",
  operationType: "deposit_confirmation",
  requiredForMutation: false,
  failureMode: {
    scenario: "Event lookup fails or returns stale data",
    maxRetries: 5,
    backoffMs: 2000,
    backoffMultiplier: 1.5,
    timeoutMs: 10000,
    idempotencyKey: "tx_hash",
    userMessage: "Confirming your deposit on the network...",
  },
  recoveryProcedure: {
    automaticRetry: true,
    requiredIntervention: false,
    steps: [
      "Query all configured RPC endpoints in parallel",
      "Compare timestamps; use most recent state",
      "If stale (>2 blocks), retry after delay",
      "Fall back to indexer cursor if RPC endpoints fail",
      "Drift detection alerts if event never appears",
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────
// SETTLEMENT FLOW INTEGRATION BOUNDARIES
// ─────────────────────────────────────────────────────────────────────────

/**
 * Settlement Service → Soroban RPC (submit settlement tx)
 *
 * Boundary: Payout INITIATED state change
 * Failure: RPC returns 5xx, timeout, or insufficient balance
 * Recovery: Retry with exponential backoff; escalate to operator if retries exhausted
 * User Impact: Prize/payout delayed indefinitely; requires operator intervention
 * Idempotency: settlement_id + attempt_count ensures ordering
 */
export const SETTLEMENT_TO_RPC_SUBMIT: IntegrationBoundary = {
  id: "settlement_to_rpc_submit",
  producer: "SettlementService",
  consumer: "SorobanRPC",
  operationType: "settlement",
  requiredForMutation: true,
  failureMode: {
    scenario: "Settlement submission fails",
    maxRetries: 5,
    backoffMs: 500,
    backoffMultiplier: 2,
    timeoutMs: 5000,
    idempotencyKey: "settlement_id + retry_count",
    userMessage: "Your payout is being processed. This may take a few minutes.",
  },
  recoveryProcedure: {
    automaticRetry: true,
    requiredIntervention: true, // After retries exhausted
    steps: [
      "Settlement Service retries with exponential backoff (up to 5 attempts)",
      "Each attempt is idempotent (same settlement_id + retry_count)",
      "After 5 failed attempts, settlement moves to FAILED state",
      "Admin alert is triggered with settlement details",
      "Operator manually reviews and decides: retry, refund, or escalate",
    ],
  },
};

/**
 * Reconciliation Engine → Database (update settlement state)
 *
 * Boundary: Persist settlement completion
 * Failure: Database connection lost, constraint violation, or tx rollback
 * Recovery: Retry with exponential backoff; mark settlement as UNRESOLVED if DB fails
 * User Impact: Settlement state is inconsistent; reconciliation drift detected
 * Idempotency: settlement_id + confirmed_ledger identifies unique settlement
 */
export const RECONCILER_TO_DB_SETTLEMENT_UPDATE: IntegrationBoundary = {
  id: "reconciler_to_db_settlement_update",
  producer: "ReconciliationEngine",
  consumer: "Database",
  operationType: "settlement_update",
  requiredForMutation: true,
  failureMode: {
    scenario: "Settlement state update fails in DB",
    maxRetries: 3,
    backoffMs: 250,
    backoffMultiplier: 2,
    timeoutMs: 10000,
    idempotencyKey: "settlement_id",
    userMessage: "(internal; user not directly notified)",
  },
  recoveryProcedure: {
    automaticRetry: true,
    requiredIntervention: true,
    steps: [
      "Reconciliation Engine retries settlement state update",
      "If DB is unavailable (503), mark settlement as UNRESOLVED",
      "Drift detection fires: missing_settlement_state",
      "Operator checks DB health and manually rerun reconciliation",
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────
// INDEXER INTEGRATION BOUNDARIES
// ─────────────────────────────────────────────────────────────────────────

/**
 * Indexer → Soroban RPC (getEvents)
 *
 * Boundary: Consume on-chain events
 * Failure: RPC rate limit, endpoint down, or cursor invalid
 * Recovery: Backoff and retry; cursor validation on startup
 * User Impact: Drift detection delayed; audit trail lag
 * Idempotency: cursor position prevents duplicate event processing
 */
export const INDEXER_TO_RPC_CONSUME: IntegrationBoundary = {
  id: "indexer_to_rpc_consume",
  producer: "Indexer",
  consumer: "SorobanRPC",
  operationType: "event_consumption",
  requiredForMutation: false,
  failureMode: {
    scenario: "Event consumption fails",
    maxRetries: 10,
    backoffMs: 500,
    backoffMultiplier: 1.5,
    timeoutMs: 15000,
    idempotencyKey: "cursor (ledger + event offset)",
    userMessage: "(internal; user not directly notified)",
  },
  recoveryProcedure: {
    automaticRetry: true,
    requiredIntervention: false,
    steps: [
      "Indexer retries getEvents with exponential backoff",
      "If rate limited, honor Retry-After header",
      "If cursor is invalid, emit POISON_EVENT alert",
      "Operator reviews cursor and may manually reset it",
      "Indexer resumesfrom new cursor on restart",
    ],
  },
};

/**
 * Indexer → Database (insert events and cursor)
 *
 * Boundary: Persist event and update cursor
 * Failure: Database constraint violation, connection loss, or tx timeout
 * Recovery: Rollback, retry, or manual cursor fix
 * User Impact: Event stream halts; drift detection stops
 * Idempotency: (ledger, event_id) uniqueness prevents duplicates
 */
export const INDEXER_TO_DB_PERSIST: IntegrationBoundary = {
  id: "indexer_to_db_persist",
  producer: "Indexer",
  consumer: "Database",
  operationType: "event_persistence",
  requiredForMutation: false,
  failureMode: {
    scenario: "Event insertion or cursor update fails",
    maxRetries: 3,
    backoffMs: 500,
    backoffMultiplier: 2,
    timeoutMs: 30000,
    idempotencyKey: "(ledger, event_id)",
    userMessage: "(internal; user not directly notified)",
  },
  recoveryProcedure: {
    automaticRetry: true,
    requiredIntervention: true,
    steps: [
      "Indexer tx is rolled back",
      "Cursor is NOT advanced (no duplication)",
      "Indexer sleeps and retries from same cursor",
      "If constraint violation (duplicate event), event is logged and cursor is advanced",
      "Operator checks DB logs for issues; may need to manually fix corrupt event",
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────
// WEBHOOK INTEGRATION BOUNDARIES
// ─────────────────────────────────────────────────────────────────────────

/**
 * Ledger Service → Webhook Consumer (external system)
 *
 * Boundary: Notify external system of events
 * Failure: Consumer unreachable, returns 5xx, or times out
 * Recovery: Exponential backoff + dead-letter queue
 * User Impact: External system not notified; may miss events
 * Idempotency: event_id in webhook payload prevents duplicate processing by consumer
 */
export const LEDGER_TO_WEBHOOK: IntegrationBoundary = {
  id: "ledger_to_webhook",
  producer: "LedgerService",
  consumer: "WebhookConsumer",
  operationType: "event_notification",
  requiredForMutation: false,
  failureMode: {
    scenario: "Webhook delivery fails",
    maxRetries: 10,
    backoffMs: 1000,
    backoffMultiplier: 2,
    timeoutMs: 30000,
    idempotencyKey: "event_id",
    userMessage: "(internal; webhook consumer must be idempotent)",
  },
  recoveryProcedure: {
    automaticRetry: true,
    requiredIntervention: false,
    steps: [
      "Webhook router retries with exponential backoff over 3 days",
      "Each retry includes event_id and timestamp for idempotency",
      "After 10 failed attempts, event is moved to dead-letter queue",
      "Admin can inspect and manually requeue dead-lettered events",
      "External consumer must be idempotent (handle duplicate deliveries)",
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────
// EMAIL INTEGRATION BOUNDARIES
// ─────────────────────────────────────────────────────────────────────────

/**
 * Notification Service → SendGrid (send email)
 *
 * Boundary: Send password reset or welcome email
 * Failure: SendGrid unreachable, rate limited, or API key invalid
 * Recovery: Queue email in DB; retry on background schedule
 * User Impact: Email delivery delayed (may take hours/days)
 * Idempotency: email_address + email_type + timestamp identifies unique email intent
 */
export const NOTIFICATION_TO_SENDGRID: IntegrationBoundary = {
  id: "notification_to_sendgrid",
  producer: "NotificationService",
  consumer: "SendGrid",
  operationType: "email_send",
  requiredForMutation: false,
  failureMode: {
    scenario: "Email delivery fails",
    maxRetries: 5,
    backoffMs: 300000, // 5 minutes
    backoffMultiplier: 2,
    timeoutMs: 10000,
    idempotencyKey: "email_address + email_type",
    userMessage: "(internal; email is queued for retry)",
  },
  recoveryProcedure: {
    automaticRetry: true,
    requiredIntervention: false,
    steps: [
      "Notification Service queues email in database",
      "Background job retries on schedule: 5min, 15min, 1hr, 1day, 1week",
      "Each retry uses same idempotency key to prevent duplicate emails",
      "After 1 week, email is considered permanently failed and archived",
      "Admin can manually requeue archived emails via admin API",
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────
// TYPE DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────

export interface FailureMode {
  scenario: string;
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  timeoutMs: number;
  idempotencyKey: string;
  userMessage: string;
}

export interface RecoveryProcedure {
  automaticRetry: boolean;
  requiredIntervention: boolean;
  steps: string[];
}

export interface IntegrationBoundary {
  id: string;
  producer: string;
  consumer: string;
  operationType: string;
  requiredForMutation: boolean;
  failureMode: FailureMode;
  recoveryProcedure: RecoveryProcedure;
}

// ─────────────────────────────────────────────────────────────────────────
// BOUNDARY REGISTRY
// ─────────────────────────────────────────────────────────────────────────

export const ALL_BOUNDARIES: IntegrationBoundary[] = [
  LEDGER_TO_RPC_SUBMIT,
  RECONCILER_TO_RPC_GETEVENTS,
  SETTLEMENT_TO_RPC_SUBMIT,
  RECONCILER_TO_DB_SETTLEMENT_UPDATE,
  INDEXER_TO_RPC_CONSUME,
  INDEXER_TO_DB_PERSIST,
  LEDGER_TO_WEBHOOK,
  NOTIFICATION_TO_SENDGRID,
];

/**
 * Get boundaries that are critical (requiredForMutation).
 */
export function getCriticalBoundaries(): IntegrationBoundary[] {
  return ALL_BOUNDARIES.filter((b) => b.requiredForMutation);
}

/**
 * Get boundaries for a specific producer.
 */
export function getBoundariesFor(producer: string): IntegrationBoundary[] {
  return ALL_BOUNDARIES.filter((b) => b.producer === producer);
}

/**
 * Get failure mode for a boundary.
 */
export function getFailureMode(boundaryId: string): FailureMode | undefined {
  return ALL_BOUNDARIES.find((b) => b.id === boundaryId)?.failureMode;
}
