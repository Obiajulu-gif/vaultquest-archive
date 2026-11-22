-- Add finality tracking fields for reorg handling
ALTER TABLE "action_ledger" ADD COLUMN "finality_status" TEXT NOT NULL DEFAULT 'provisional';
ALTER TABLE "action_ledger" ADD COLUMN "observed_ledger" INTEGER;
ALTER TABLE "action_ledger" ADD COLUMN "finalized_ledger" INTEGER;
ALTER TABLE "action_ledger" ADD COLUMN "confirmation_depth" INTEGER;
ALTER TABLE "action_ledger" ADD COLUMN "compensates_id" UUID;

-- Add index for finality status queries
CREATE INDEX "action_ledger_finality_status_observed_ledger_idx" ON "action_ledger" ("finality_status", "observed_ledger");

-- Update existing rows to be finalized (they were created before finality tracking)
UPDATE "action_ledger" SET "finality_status" = 'finalized' WHERE "finality_status" = 'provisional';

-- Add compensating action type
ALTER TYPE "ActionType" ADD VALUE 'compensating';