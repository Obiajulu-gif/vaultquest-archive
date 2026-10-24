-- Nullable metadata preserves existing rows without inventing an origin.
ALTER TABLE "saved_pools" ADD COLUMN "provenance" JSONB;
