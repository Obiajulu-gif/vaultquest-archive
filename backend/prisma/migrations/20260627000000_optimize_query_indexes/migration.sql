-- Migration: optimize_query_indexes
-- Adds indexes for frequently-filtered columns that lack coverage

-- ActionLedger: filter by actionType (e.g. 'DEPOSIT') within a wallet range
CREATE INDEX IF NOT EXISTS "action_ledger_wallet_action_type_idx"
  ON "action_ledger"("wallet_address", "action_type");

-- ActionLedger: status filter for pending/confirmed sweeps
CREATE INDEX IF NOT EXISTS "action_ledger_status_created_at_idx"
  ON "action_ledger"("status", "created_at" DESC);

-- VaultSettlement: recipient lookup (vault release queries)
CREATE INDEX IF NOT EXISTS "vault_settlements_recipient_state_idx"
  ON "vault_settlements"("recipient", "state")
  WHERE "recipient" IS NOT NULL;

-- PendingEvent: statusHint filter for event processing sweeps
CREATE INDEX IF NOT EXISTS "pending_events_status_hint_received_at_idx"
  ON "pending_events"("status_hint", "received_at");

-- SavedPool: poolId lookup (find all wallets saving into a pool)
CREATE INDEX IF NOT EXISTS "saved_pools_pool_id_idx"
  ON "saved_pools"("pool_id");
