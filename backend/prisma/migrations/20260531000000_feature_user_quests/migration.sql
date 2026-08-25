-- User quest progress tracking (#26 quest engine)
CREATE TABLE "user_quests" (
    "id" UUID NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "quest_id" TEXT NOT NULL,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "target" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "metadata" JSONB,
    "completed_at" TIMESTAMP(3),
    "last_evaluated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_quests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_quests_wallet_address_quest_id_key" ON "user_quests"("wallet_address", "quest_id");
CREATE INDEX "user_quests_wallet_address_status_idx" ON "user_quests"("wallet_address", "status");
CREATE INDEX "user_quests_status_completed_at_idx" ON "user_quests"("status", "completed_at" DESC);
