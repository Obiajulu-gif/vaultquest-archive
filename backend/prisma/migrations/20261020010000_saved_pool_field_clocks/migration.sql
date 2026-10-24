-- Deterministic conflict resolution for multi-client saved-pool edits (#983).
--
-- Additive only. Existing rows start at version 0 with no field clocks, which
-- the resolver treats as "never edited concurrently", so no backfill is
-- needed. ADD COLUMN with a constant DEFAULT does not rewrite the table on
-- PostgreSQL 11+. Rollback: the columns can stay (older builds ignore them)
-- or be dropped with ALTER TABLE ... DROP COLUMN.

ALTER TABLE "saved_pools" ADD COLUMN     "field_clocks" JSONB,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;
