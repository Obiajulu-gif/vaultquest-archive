-- #787 — tamper-evident change history for critical domain records.
--
-- Each row commits to the previous entry for the same record via `prev_hash`,
-- so verification can detect altered, missing and out-of-order entries. See
-- backend/src/services/changeHistoryService.ts and docs/CHANGE_HISTORY.md.
CREATE TABLE IF NOT EXISTS "record_change_history" (
    "id" TEXT NOT NULL,
    "record_type" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "before_state" JSONB,
    "after_state" JSONB,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "prev_hash" TEXT NOT NULL,
    "entry_hash" TEXT NOT NULL,

    CONSTRAINT "record_change_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "record_change_history_record_seq_key" UNIQUE ("record_type", "record_id", "sequence")
);

-- Verification reads a record's chain in order; the writer appends to the tail.
CREATE INDEX IF NOT EXISTS "record_change_history_record_idx"
    ON "record_change_history" ("record_type", "record_id", "sequence");

-- "Which records changed recently?" for investigation views.
CREATE INDEX IF NOT EXISTS "record_change_history_actor_timestamp_idx"
    ON "record_change_history" ("actor", "timestamp" DESC);
