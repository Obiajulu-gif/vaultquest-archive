-- CreateTable
CREATE TABLE "reward_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "wallet_address" TEXT NOT NULL,
    "quest_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "granted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reward_grants_idempotency_key_key" ON "reward_grants"("idempotency_key");

-- CreateIndex
CREATE INDEX "reward_grants_status_created_at_idx" ON "reward_grants"("status", "created_at");

-- CreateIndex
CREATE INDEX "reward_grants_wallet_address_idx" ON "reward_grants"("wallet_address");
