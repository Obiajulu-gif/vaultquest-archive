-- #751/#753/#754: append-only raw chain event log + event-derived time on parked events.

-- AlterTable
ALTER TABLE "pending_events" ADD COLUMN "ledger_closed_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "chain_events" (
    "id" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "ledger_closed_at" TIMESTAMP(3),
    "tx_hash" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "topic_xdr" TEXT[],
    "value_xdr" TEXT NOT NULL,
    "successful" BOOLEAN NOT NULL,
    "ingested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chain_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chain_events_tx_hash_idx" ON "chain_events"("tx_hash");

-- CreateIndex
CREATE INDEX "chain_events_ledger_idx" ON "chain_events"("ledger");

-- CreateIndex
CREATE INDEX "poison_events_tx_hash_idx" ON "poison_events"("tx_hash");
