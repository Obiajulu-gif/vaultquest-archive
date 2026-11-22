/**
 * Disaster-recovery classification of every stored table (#754).
 *
 * Keyed by `Prisma.ModelName`, so adding a model to schema.prisma without
 * classifying it here is a compile error — the recovery runbook
 * (docs/DISASTER_RECOVERY.md) cannot silently fall behind the schema.
 *
 *  - chain-derived: fully rebuilt from on-chain history by replaying the
 *    chain event log; safe to truncate and rebuild.
 *  - mixed: off-chain rows whose chain-derived columns are reset and then
 *    rebuilt by replay (the off-chain part must come from backup).
 *  - off-chain: exists only in this database; lost without a backup.
 *  - ephemeral: operational state that must be dropped on recovery.
 */

import type { Prisma } from "@prisma/client";

export type DataClass = "chain-derived" | "mixed" | "off-chain" | "ephemeral";

export interface TableClassification {
  table: string;
  kind: DataClass;
  rationale: string;
}

export const DATA_CLASSIFICATION: Record<Prisma.ModelName, TableClassification> = {
  ChainEvent: {
    table: "chain_events",
    kind: "chain-derived",
    rationale: "Raw contract events; re-fetchable from Soroban RPC (retention window) or an archive (Galexie/Hubble)."
  },
  PendingEvent: {
    table: "pending_events",
    kind: "chain-derived",
    rationale: "Events with no matching intent yet; reproduced by replay."
  },
  PoolRegistry: {
    table: "pool_registry",
    kind: "chain-derived",
    rationale: "Mirror of vault-factory fpooldep events."
  },
  IndexerCheckpoint: {
    table: "indexer_checkpoints",
    kind: "chain-derived",
    rationale: "Cursor over the event log; re-established by replay."
  },
  ActionLedger: {
    table: "action_ledger",
    kind: "mixed",
    rationale:
      "Intent (wallet, type, payload, idompotency key, tx_hash, submitted_at) is off-chain; status/soroban_event_id/verified_payload/confirmed_at/error_code of on-chain outcomes are rebuilt by replay."
  },
  PoisonEvent: {
    table: "poison_events",
    kind: "mixed",
    rationale: "Quarantine is reproduced by replay; operator resolution (resolved_at) is off-chain."
  },
  User: { table: "users", kind: "off-chain", rationale: "Profile data." },
  VaultSettlement: {
    table: "vault_settlements",
    kind: "off-chain",
    rationale: "Admin settlement pipeline state (attempts, result codes)."
  },
  UserQuest: {
    table: "user_quests",
    kind: "off-chain",
    rationale: "Progress is derivable from confirmed actions, but completed_at (reward timing) is wall-clock."
  },
  RewardGrant: { table: "reward_grants", kind: "off-chain", rationale: "Exactly-once reward payout records." },
  ProtocolAudit: { table: "protocol_audits", kind: "off-chain", rationale: "Admin parameter-change audit trail." },
  RepairAudit: { table: "repair_audits", kind: "off-chain", rationale: "Operator repair audit trail." },
  RepairProposal: { table: "repair_proposals", kind: "off-chain", rationale: "Dual-control repair proposals." },
  RepairApproval: { table: "repair_approvals", kind: "off-chain", rationale: "Dual-control approvals." },
  RepairQuarantine: { table: "repair_quarantine", kind: "off-chain", rationale: "Operator drift triage." },
  SavedPool: { table: "saved_pools", kind: "off-chain", rationale: "User watchlists." },
  FeatureFlag: { table: "feature_flags", kind: "off-chain", rationale: "Runtime toggles." },
  FeatureFlagAudit: { table: "feature_flag_audits", kind: "off-chain", rationale: "Feature flag audit trail." },
  OutboundAction: { table: "outbound_actions", kind: "off-chain", rationale: "Queued outbound actions and sync." },
  DashboardAggregate: { table: "dashboard_aggregates", kind: "off-chain", rationale: "Cached dashboard aggregates." },
  TrendAggregate: { table: "trend_aggregates", kind: "off-chain", rationale: "Historical trend rollups." },
  PartialFailure: { table: "partial_failures", kind: "off-chain", rationale: "Partial failure investigation records." },
  MaintainerNote: { table: "maintainer_notes", kind: "off-chain", rationale: "Scoped support notes with bounded retention." },
  MaintainerNoteAudit: { table: "maintainer_note_audit", kind: "off-chain", rationale: "Immutable note access references survive content redaction." },
  AuditTrailRecord: { table: "audit_trail", kind: "off-chain", rationale: "Existing immutable recovery and projection rebuild audit trail." },
  FailureEscalationPolicy: { table: "failure_escalation_policies", kind: "off-chain", rationale: "Configured failure escalation thresholds." },
  FailureEscalationAttempt: { table: "failure_escalation_attempts", kind: "off-chain", rationale: "Durable maintainer inbox and acknowledgment history." },
  ChainEventBatch: { table: "chain_event_batches", kind: "chain-derived", rationale: "Integrity manifests for the archived event log; recover with chain_events." },
  ActionLease: { table: "action_leases", kind: "ephemeral", rationale: "Worker leases; stale after restore." },
  JobLease: { table: "job_leases", kind: "ephemeral", rationale: "Cron leases; stale after restore." },
  ProjectionRebuild: {
    table: "projection_rebuilds",
    kind: "ephemeral",
    rationale: "Projection rebuild runs (#989); a restored database must not inherit a stale indexer fence."
  },
  BackgroundJob: { table: "background_jobs", kind: "ephemeral", rationale: "Background worker queue." },
  IdempotencyKey: { table: "idempotency_keys", kind: "ephemeral", rationale: "Idempotency keys and cached results; safe to expire." },
  ImpersonationSession: { table: "impersonation_sessions", kind: "ephemeral", rationale: "Short-lived maintainer impersonation sessions." },
  WalletChallenge: { table: "wallet_challenges", kind: "ephemeral", rationale: "Short-lived auth nonces." },
  WalletSession: {
    table: "wallet_sessions",
    kind: "ephemeral",
    rationale: "Restoring would resurrect sessions revoked after the backup; users re-authenticate."
  },
  ProcessedWebhookEvent: {
    table: "processed_webhook_events",
    kind: "ephemeral",
    rationale: "Processed webhook event IDs and cached responses for replay window and deduplication; safe to drop or expire."
  }
};

/** Physical table names of one class, in declaration order. */
export function tablesOfKind(kind: DataClass): string[] {
  return Object.values(DATA_CLASSIFICATION)
    .filter((c) => c.kind === kind)
    .map((c) => c.table);
}

/**
 * Privacy-safe export metadata for user-owned records and history (#VaultQuest).
 *
 * The export schema is versioned and timestamped so consumers can detect
 * compatibility and staleness. Only tables classified as user-owned are
 * included; chain-derived and ephemeral tables are excluded because they
 * either contain no user-private data or are operational state.
 */

export const EXPORT_SCHEMA_VERSION = 1 as const;

export interface ExportTableSpec {
  /** Prisma model name. */
  model: Prisma.ModelName;
  /** Physical table name. */
  table: string;
  /** Column used to scope rows to the requesting user. */
  ownerColumn: string;
  /** Columns that must never be exported (secrets, hashes, internal ids). */
  excludedColumns: readonly string[];
  /** Human-readable description of the record type. */
  description: string;
}

/**
 * Tables that may be included in a user export. Every entry must be
 * `off-chain` or `mixed` in DATA_CLASSIFICATION and must have a column
 * that scopes rows to the requesting user.
 */
export const EXPORT_TABLES: readonly ExportTableSpec[] = [
  {
    model: "User",
    table: "users",
    ownerColumn: "id",
    excludedColumns: [],
    description: "Profile and wallet address."
  },
  {
    model: "SavedPool",
    table: "saved_pools",
    ownerColumn: "userId",
    excludedColumns: [],
    description: "User watchlist of vaults."
  },
  {
    model: "UserQuest",
    table: "user_quests",
    ownerColumn: "userId",
    excludedColumns: [],
    description: "Quest progress and completion times."
  },
  {
    model: "RewardGrant",
    table: "reward_grants",
    ownerColumn: "userId",
    excludedColumns: [],
    description: "Reward payout records."
  },
  {
    model: "Notification",
    table: "notifications",
    ownerColumn: "userId",
    excludedColumns: [],
    description: "Reminders and user dismissals."
  },
  {
    model: "NotificationPreference",
    table: "notification_preferences",
    ownerColumn: "userId",
    excludedColumns: [],
    description: "User notification preferences."
  },
  {
    model: "ActionLedger",
    table: "action_ledger",
    ownerColumn: "wallet",
    excludedColumns: ["idompotencyKey"],
    description: "User action history (submitted and confirmed)."
  },
  {
    model: "TransactionMetric",
    table: "transaction_metrics",
    ownerColumn: "wallet",
    excludedColumns: [],
    description: "Client-reported confirmation timing telemetry."
  }
] as const;

export interface ExportMetadata {
  /** Schema version of the export payload. */
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  /** ISO 8601 timestamp of when the export was generated. */
  generatedAt: string;
  /** Wallet address the export is scoped to. */
  wallet: string;
  /** Tables included in this export. */
  includedTables: string[];
  /** Time after which the export must be deleted (ISO 8601). */
  expiresAt: string;
  /** Retention window in seconds. */
  retentionSeconds: number;
  /** Rountrip identifier for auditing export generation. */
  exportId: string;
}

export interface ExportRecord {
  table: string;
  model: Prisma.ModelName;
  rows: Record<string, unknown>[];
  count: number;
}

export interface UserExportPayload {
  metadata: ExportMetadata;
  records: ExportRecord[];
}

/** Default retention window for generated exports (7 days). */
export const EXPORT_RETENTION_SECONDS = 7 * 24 * 60 * 60 as const;

export class ExportAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportAuthorizationError";
  }
}

/**
 * Return the export table spec for a Prisma model, or undefined if the
 * model is not user-exportable.
 */
export function exportSpecForModel(model: Prisma.ModelName): ExportTableSpec | undefined {
  return EXPORT_TABLES.find((s) => s.model === model);
}

/**
 * Assert that a wallet is authorized to export the requested tables.
 * Rejects unknown tables and tables that are not user-owned.
 */
export function assertExportAuthorized(
  requestingWallet: string,
  ownerWallet: string,
  requestedTables: readonly string[]
): void {
  if (!requestingWallet || !ownerWallet) {
    throw new ExportAuthorizationError("Export requires an authenticated wallet.");
  }
  if (requestingWallet !== ownerWallet) {
    throw new ExportAuthorizationError("Cannot export records owned by another wallet.");
  }
  const allowed = new Set(EXPORT_TABLES.map((s) => s.table));
  for (const table of requestedTables) {
    if (!allowed.has(table)) {
      throw new ExportAuthorizationError(`Table '${table}' is not user-exportable.`);
    }
  }
}

/**
 * Build export metadata for a wallet. The expiration is derived from
 * the retention window so callers can schedule cleanup.
 */
export function buildExportMetadata(
  wallet: string,
  includedTables: readonly string[],
  now: Date = new Date(),
  retentionSeconds: number = EXPORT_RETENTION_SECONDS,
  exportId: string = crypto.randomUUID()
): ExportMetadata {
  const expiresAt = new Date(now.getTime() + retentionSeconds * 1000);
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    wallet,
    includedTables: [...includedTables],
    expiresAt: expiresAt.toISOString(),
    retentionSeconds,
    exportId
  };
}
