-- Add version column for optimistic locking
ALTER TABLE "outbound_actions" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;