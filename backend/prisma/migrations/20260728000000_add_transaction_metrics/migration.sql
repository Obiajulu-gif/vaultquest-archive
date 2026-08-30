-- CreateTable
CREATE TABLE "transaction_metrics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "action_id" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "indexed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transaction_metrics_action_type_network_idx" ON "transaction_metrics"("action_type", "network");

-- CreateIndex
CREATE INDEX "transaction_metrics_submitted_at_idx" ON "transaction_metrics"("submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_metrics_action_id_key" ON "transaction_metrics"("action_id");
