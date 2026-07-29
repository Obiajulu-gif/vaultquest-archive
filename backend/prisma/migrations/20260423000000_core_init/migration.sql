CREATE TYPE "ActionType" AS ENUM ('deposit', 'withdraw', 'create_vault', 'claim', 'select_winner');
CREATE TYPE "ActionStatus" AS ENUM ('pending', 'submitted', 'confirmed', 'failed', 'reverted', 'orphaned');

CREATE TABLE "action_ledger" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "idempotency_key" TEXT NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "action_type" "ActionType" NOT NULL,
    "action_payload" JSONB NOT NULL,
    "status" "ActionStatus" NOT NULL DEFAULT 'pending',
    "tx_hash" TEXT,
    "soroban_event_id" TEXT,
    "correlation_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "error_code" TEXT,
    "error_detail" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "redacted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    CONSTRAINT "action_ledger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "action_ledger_idempotency_key_key" ON "action_ledger"("idempotency_key");
CREATE INDEX "action_ledger_wallet_address_created_at_idx" ON "action_ledger"("wallet_address", "created_at" DESC);
CREATE INDEX "action_ledger_tx_hash_idx" ON "action_ledger"("tx_hash");
CREATE INDEX "action_ledger_status_updated_at_idx" ON "action_ledger"("status", "updated_at");

CREATE TABLE "pending_events" (
    "tx_hash" TEXT NOT NULL,
    "soroban_event_id" TEXT NOT NULL,
    "event_payload" JSONB NOT NULL,
    "status_hint" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMP(3),
    CONSTRAINT "pending_events_pkey" PRIMARY KEY ("tx_hash")
);
