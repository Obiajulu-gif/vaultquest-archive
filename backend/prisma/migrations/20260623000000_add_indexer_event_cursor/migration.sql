ALTER TABLE "indexer_checkpoints"
ADD COLUMN IF NOT EXISTS "last_processed_event_id" TEXT;
