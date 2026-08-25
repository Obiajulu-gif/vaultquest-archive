-- CreateTable
CREATE TABLE "protocol_audits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "parameter_name" TEXT NOT NULL,
    "previous_value" JSONB NOT NULL,
    "new_value" JSONB NOT NULL,
    "actor" TEXT NOT NULL,
    "tx_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "protocol_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "protocol_audits_parameter_name_created_at_idx" ON "protocol_audits"("parameter_name", "created_at" DESC);

-- CreateIndex
CREATE INDEX "protocol_audits_actor_created_at_idx" ON "protocol_audits"("actor", "created_at" DESC);

-- CreateIndex
CREATE INDEX "protocol_audits_created_at_idx" ON "protocol_audits"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "protocol_audits_tx_hash_key" ON "protocol_audits"("tx_hash");
