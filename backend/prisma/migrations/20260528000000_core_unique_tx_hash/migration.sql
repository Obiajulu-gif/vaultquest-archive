-- Enforce one action per on-chain tx hash (#72). Postgres unique indexes allow
-- multiple NULLs, so pending rows (tx_hash IS NULL) are unaffected.
DROP INDEX "action_ledger_tx_hash_idx";
CREATE UNIQUE INDEX "action_ledger_tx_hash_key" ON "action_ledger"("tx_hash");
