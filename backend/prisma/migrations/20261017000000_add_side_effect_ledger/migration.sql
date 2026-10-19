-- Side-effect ledger (#923): one row per user-visible side effect so a replayed
-- or dead-letter-requeued job skips effects that already happened.
--
-- Rollback: DROP TABLE "side_effect_ledger". Nothing else references it; the
-- only loss is the record of which effects already ran, so replaying jobs after
-- a drop may repeat effects whose providers do not deduplicate.

CREATE TABLE IF NOT EXISTS "side_effect_ledger" (
    "effect_key" TEXT NOT NULL,
    "effect_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_by" TEXT,
    "locked_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "result" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "side_effect_ledger_pkey" PRIMARY KEY ("effect_key"),
    CONSTRAINT "side_effect_ledger_status_check"
        CHECK ("status" IN ('in_progress', 'failed', 'completed'))
);

CREATE INDEX IF NOT EXISTS "side_effect_ledger_effect_type_status_idx" ON "side_effect_ledger"("effect_type", "status");
CREATE INDEX IF NOT EXISTS "side_effect_ledger_status_locked_at_idx" ON "side_effect_ledger"("status", "locked_at");
