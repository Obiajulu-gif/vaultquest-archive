-- Saved pools watchlist (#89, #90)
CREATE TABLE "saved_pools" (
    "id" UUID NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "pool_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "tvl" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "participant_count" INTEGER NOT NULL,
    "expected_yield" TEXT NOT NULL,
    "prize" TEXT,
    "opens_at" TIMESTAMP(3),
    "locks_at" TIMESTAMP(3),
    "draws_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_pools_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "saved_pools_wallet_address_pool_id_key" ON "saved_pools"("wallet_address", "pool_id");
CREATE INDEX "saved_pools_wallet_address_created_at_idx" ON "saved_pools"("wallet_address", "created_at" DESC);
