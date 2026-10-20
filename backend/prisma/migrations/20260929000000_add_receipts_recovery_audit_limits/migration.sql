-- #812 signed activity receipts, #813 stuck-pending recovery cases,
-- #814 immutable audit trail, #815 operation-limit overrides.
-- Additive only: four new tables, no changes to existing tables or rows.

-- #814 — append-only, hash-chained audit trail.
CREATE TABLE IF NOT EXISTS "audit_trail" (
    "id" UUID PRIMARY KEY,
    "sequence" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor_subject" TEXT NOT NULL,
    "actor_role" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "redacted_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "prev_hash" TEXT NOT NULL,
    "record_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
    CONSTRAINT "audit_trail_sequence_key" UNIQUE ("sequence")
);

CREATE INDEX IF NOT EXISTS "audit_trail_category_sequence_idx"
    ON "audit_trail" ("category", "sequence" DESC);

CREATE INDEX IF NOT EXISTS "audit_trail_actor_subject_sequence_idx"
    ON "audit_trail" ("actor_subject", "sequence" DESC);

CREATE INDEX IF NOT EXISTS "audit_trail_target_sequence_idx"
    ON "audit_trail" ("target_type", "target_id", "sequence" DESC);

-- Immutability is enforced by the database, not just the API: any UPDATE,
-- DELETE or TRUNCATE on audit_trail raises. Tampering by a superuser who
-- drops the trigger is still detected by the hash chain (GET /admin/audit-trail/verify).
CREATE OR REPLACE FUNCTION audit_trail_block_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_trail is append-only (#814)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "audit_trail_no_update_delete" ON "audit_trail";
CREATE TRIGGER "audit_trail_no_update_delete"
    BEFORE UPDATE OR DELETE ON "audit_trail"
    FOR EACH ROW EXECUTE FUNCTION audit_trail_block_mutation();

DROP TRIGGER IF EXISTS "audit_trail_no_truncate" ON "audit_trail";
CREATE TRIGGER "audit_trail_no_truncate"
    BEFORE TRUNCATE ON "audit_trail"
    FOR EACH STATEMENT EXECUTE FUNCTION audit_trail_block_mutation();

-- #812 — one signed receipt per (action, stage).
CREATE TABLE IF NOT EXISTS "action_receipts" (
    "receipt_id" TEXT PRIMARY KEY,
    "action_id" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "algorithm" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
    CONSTRAINT "action_receipts_action_id_stage_key" UNIQUE ("action_id", "stage")
);

CREATE INDEX IF NOT EXISTS "action_receipts_action_id_idx"
    ON "action_receipts" ("action_id");

-- #813 — one recovery case per stuck action, optimistic `version`.
CREATE TABLE IF NOT EXISTS "recovery_cases" (
    "id" TEXT PRIMARY KEY,
    "action_id" UUID NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "stale_since" TIMESTAMPTZ(3) NOT NULL,
    "detected_at" TIMESTAMPTZ(3) NOT NULL,
    "last_attempt_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "resolution" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "recovery_cases_action_id_key" UNIQUE ("action_id")
);

CREATE INDEX IF NOT EXISTS "recovery_cases_state_stale_since_idx"
    ON "recovery_cases" ("state", "stale_since");

CREATE INDEX IF NOT EXISTS "recovery_cases_wallet_address_idx"
    ON "recovery_cases" ("wallet_address");

-- Speeds up the stale-pending scan (status IN (pending, submitted) AND updated_at <= cutoff).
CREATE INDEX IF NOT EXISTS "action_ledger_status_updated_at_stale_idx"
    ON "action_ledger" ("updated_at")
    WHERE "status" IN ('pending', 'submitted');

-- #815 — scoped, expiring limit overrides.
CREATE TABLE IF NOT EXISTS "limit_overrides" (
    "id" UUID PRIMARY KEY,
    "operation" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "limit_value" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "granted_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" TEXT
);

CREATE INDEX IF NOT EXISTS "limit_overrides_operation_scope_key_expires_at_idx"
    ON "limit_overrides" ("operation", "scope_key", "expires_at");
