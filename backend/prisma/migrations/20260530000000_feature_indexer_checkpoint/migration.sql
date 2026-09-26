-- CreateTable
CREATE TABLE "indexer_checkpoints" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "latest_ledger" INTEGER NOT NULL,
    "last_sync_time" TIMESTAMP(3) NOT NULL,
    "last_error" TEXT,
    "last_success_sync_time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "indexer_checkpoints_pkey" PRIMARY KEY ("id")
);
