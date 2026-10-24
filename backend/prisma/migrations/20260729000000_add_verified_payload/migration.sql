-- #509: store the payload decoded from the finalized on-chain event that
-- confirmed an action, separate from the client-supplied action_payload.
ALTER TABLE "action_ledger" ADD COLUMN "verified_payload" JSONB;
