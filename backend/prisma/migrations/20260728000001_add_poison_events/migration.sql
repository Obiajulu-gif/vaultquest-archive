-- AlterTable
ALTER TABLE "indexer_checkpoints" ADD COLUMN "last_ledger_hash" TEXT;

-- CreateTable
CREATE TABLE "poison_events" (
    "id" UUID NOT NULL,
    "soroban_event_id" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "contract_id" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "raw_event" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "poison_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "poison_events_soroban_event_id_key" ON "poison_events"("soroban_event_id");

-- CreateIndex
CREATE INDEX "poison_events_resolved_at_detected_at_idx" ON "poison_events"("resolved_at", "detected_at");
