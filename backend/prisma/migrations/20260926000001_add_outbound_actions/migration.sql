-- Add outbound_actions table for reconciliation service
CREATE TABLE "outbound_actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "action_key" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "tx_hash" TEXT,
    "error_code" TEXT,
    "error_detail" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "last_attempt_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "outbound_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outbound_actions_action_key_key" ON "outbound_actions"("action_key");
CREATE UNIQUE INDEX "outbound_actions_tx_hash_key" ON "outbound_actions"("tx_hash");
CREATE INDEX "outbound_actions_status_updated_at_idx" ON "outbound_actions"("status", "updated_at");