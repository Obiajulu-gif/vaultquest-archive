-- Escrow settlement pipeline (#settlement)
CREATE TABLE "vault_settlements" (
    "id" UUID NOT NULL,
    "vault_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'Unresolved',
    "settlement_type" TEXT NOT NULL,
    "recipient" TEXT,
    "amount" TEXT,
    "tx_hash" TEXT,
    "result_code" TEXT,
    "error_code" TEXT,
    "error_detail" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vault_settlements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vault_settlements_vault_id_key" ON "vault_settlements"("vault_id");
CREATE UNIQUE INDEX "vault_settlements_tx_hash_key" ON "vault_settlements"("tx_hash");
CREATE INDEX "vault_settlements_state_updated_at_idx" ON "vault_settlements"("state", "updated_at");
