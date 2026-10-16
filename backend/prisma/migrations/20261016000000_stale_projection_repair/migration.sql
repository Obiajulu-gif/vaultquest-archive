-- Persisted projection cache and cache-repair run audit tables.
CREATE TABLE "derived_cache" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cache_key" TEXT NOT NULL,
    "cache_type" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_version" BIGINT NOT NULL,
    "source_updated_at" TIMESTAMPTZ NOT NULL,
    "payload" JSONB NOT NULL,
    "computed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ,
    "stale_at" TIMESTAMPTZ,
    "stale_reason" TEXT,
    "repair_job_id" UUID,
    "repair_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_repair_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "derived_cache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "derived_cache_cache_key_key" ON "derived_cache" ("cache_key");
CREATE INDEX "derived_cache_cache_type_stale_at_idx" ON "derived_cache" ("cache_type", "stale_at");
CREATE INDEX "derived_cache_source_type_source_id_idx" ON "derived_cache" ("source_type", "source_id");
CREATE INDEX "derived_cache_expires_at_idx" ON "derived_cache" ("expires_at");

CREATE TABLE "cache_repair_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_name" TEXT NOT NULL,
    "dry_run" BOOLEAN NOT NULL DEFAULT true,
    "detected_count" INTEGER NOT NULL DEFAULT 0,
    "repaired_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "plan_json" JSONB NOT NULL,
    "applied_json" JSONB,
    "error_detail" TEXT,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "cache_repair_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cache_repair_runs_job_name_started_at_idx"
    ON "cache_repair_runs" ("job_name", "started_at" DESC);
CREATE INDEX "cache_repair_runs_dry_run_started_at_idx"
    ON "cache_repair_runs" ("dry_run", "started_at" DESC);
