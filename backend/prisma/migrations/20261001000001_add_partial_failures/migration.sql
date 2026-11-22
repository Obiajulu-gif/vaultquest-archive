-- #793: partial failure tracking for background and external integrations.
-- Additive only: one new table, no changes to existing tables or rows.

CREATE TABLE IF NOT EXISTS "partial_failures" (
    "id"               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "operation_type"   TEXT         NOT NULL,
    "operation_id"     TEXT         NOT NULL,
    "external_ref"     TEXT,
    "severity"         TEXT         NOT NULL DEFAULT 'medium',
    "state"            TEXT         NOT NULL DEFAULT 'unresolved',
    "retryable"        BOOLEAN      NOT NULL DEFAULT FALSE,
    "description"      TEXT         NOT NULL,
    "metadata"         JSONB,
    "detected_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
    "stale_since_at"   TIMESTAMPTZ(3),
    "last_retried_at"  TIMESTAMPTZ(3),
    "resolved_at"      TIMESTAMPTZ(3),
    "resolved_by"      TEXT,
    "resolution_note"  TEXT,
    "ignored_at"       TIMESTAMPTZ(3),
    "ignored_by"       TEXT,
    "updated_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT NOW()
);

-- Pagination / dashboard queries.
CREATE INDEX IF NOT EXISTS "partial_failures_state_detected_at_idx"
    ON "partial_failures" ("state", "detected_at" DESC);

CREATE INDEX IF NOT EXISTS "partial_failures_operation_type_state_idx"
    ON "partial_failures" ("operation_type", "state");

CREATE INDEX IF NOT EXISTS "partial_failures_severity_state_idx"
    ON "partial_failures" ("severity", "state");

-- Fast lookup of retryable failures for the dashboard summary.
CREATE INDEX IF NOT EXISTS "partial_failures_retryable_state_idx"
    ON "partial_failures" ("retryable", "state")
    WHERE "state" IN ('unresolved', 'retryable');
