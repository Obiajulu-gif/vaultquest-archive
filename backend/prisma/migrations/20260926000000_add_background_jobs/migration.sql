-- #771: durable background jobs with retry + dead-letter state.
CREATE TABLE "background_jobs" (
    "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
    "type"            TEXT         NOT NULL,
    "payload"         JSONB        NOT NULL,
    "idempotency_key" TEXT         NOT NULL,
    "status"          TEXT         NOT NULL DEFAULT 'queued',
    "attempts"        INTEGER      NOT NULL DEFAULT 0,
    "max_attempts"    INTEGER      NOT NULL,
    "run_at"          TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_by"       TEXT,
    "locked_at"       TIMESTAMPTZ,
    "correlation_id"  TEXT,
    "last_error"      JSONB,
    "failures"        JSONB        NOT NULL DEFAULT '[]'::JSONB,
    "created_at"      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at"    TIMESTAMPTZ,

    CONSTRAINT "background_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "background_jobs_status_check"
        CHECK ("status" IN ('queued', 'running', 'succeeded', 'dead'))
);

CREATE UNIQUE INDEX "background_jobs_idempotency_key_key" ON "background_jobs" ("idempotency_key");
CREATE INDEX "background_jobs_status_run_at_idx" ON "background_jobs" ("status", "run_at");
CREATE INDEX "background_jobs_type_status_idx" ON "background_jobs" ("type", "status");
