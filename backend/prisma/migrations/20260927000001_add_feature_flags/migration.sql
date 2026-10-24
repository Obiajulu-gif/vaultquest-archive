-- Feature flags for staged rollout and emergency rollback
-- Defaults are the safer behavior (disabled for new features).
-- Server-side checks ensure configuration absence falls back to safe defaults.
CREATE TABLE IF NOT EXISTS "feature_flags" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "metadata" JSONB,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "feature_flags_key_scope_key" UNIQUE ("key", "scope")
);

CREATE INDEX IF NOT EXISTS "feature_flags_key_scope_idx"
    ON "feature_flags" ("key", "scope");

CREATE INDEX IF NOT EXISTS "feature_flags_scope_idx"
    ON "feature_flags" ("scope");

-- Audit trail for all feature flag state changes
CREATE TABLE IF NOT EXISTS "feature_flag_audits" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "flag_key" TEXT NOT NULL,
    "previous_value" BOOLEAN NOT NULL,
    "new_value" BOOLEAN NOT NULL,
    "actor" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "feature_flag_audits_flag_key_created_at_idx"
    ON "feature_flag_audits" ("flag_key", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "feature_flag_audits_created_at_idx"
    ON "feature_flag_audits" ("created_at" DESC);
