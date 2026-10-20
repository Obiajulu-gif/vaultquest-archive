ALTER TABLE "action_ledger"
  ADD COLUMN "recovery_checkpoint" JSONB;

UPDATE "action_ledger"
SET "recovery_checkpoint" = jsonb_build_object(
  'stage', CASE
    WHEN "status" = 'pending' THEN 'intent_recorded'
    WHEN "status" = 'submitted' THEN 'transaction_submitted'
    WHEN "status" = 'orphaned' THEN 'recovery_required'
    WHEN "status" = 'confirmed' THEN 'confirmed'
    WHEN "status" = 'reverted' THEN 'reverted'
    ELSE 'failed'
  END,
  'checkpointed_at', "updated_at"
);