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
      "Intent (wallet, type, payload, idempotency key, tx_hash, submitted_at) is off-chain; status/soroban_event_id/verified_payload/confirmed_at/error_code of on-chain outcomes are rebuilt by replay."
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
  Product: { table: "Product", kind: "off-chain", rationale: "Catalogue data." },
  ProductImage: { table: "ProductImage", kind: "off-chain", rationale: "Catalogue data." },
  Category: { table: "categories", kind: "off-chain", rationale: "Catalogue data." },
  DrawProof: {
    table: "draw_proofs",
    kind: "off-chain",
    rationale: "Built from live contract-state RPC reads at generation time; not reproducible from events."
  },
  Notification: { table: "notifications", kind: "off-chain", rationale: "Reminders and user dismissals." },
  NotificationPreference: {
    table: "notification_preferences",
    kind: "off-chain",
    rationale: "User preferences."
  },
  TransactionMetric: {
    table: "transaction_metrics",
    kind: "off-chain",
    rationale: "Client-reported confirmation timing telemetry."
  },
  ActionLease: { table: "action_leases", kind: "ephemeral", rationale: "Worker leases; stale after restore." },
  JobLease: { table: "job_leases", kind: "ephemeral", rationale: "Cron leases; stale after restore." },
  WalletChallenge: { table: "wallet_challenges", kind: "ephemeral", rationale: "Short-lived auth nonces." },
  WalletSession: {
    table: "wallet_sessions",
    kind: "ephemeral",
    rationale: "Restoring would resurrect sessions revoked after the backup; users re-authenticate."
  }
};

/** Physical table names of one class, in declaration order. */
export function tablesOfKind(kind: DataClass): string[] {
  return Object.values(DATA_CLASSIFICATION)
    .filter((c) => c.kind === kind)
    .map((c) => c.table);
}
