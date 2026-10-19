-- Support access (#support-access) and secure import pipeline (#imports).
--
-- Adds:
--   1. support_access_grants — time-bounded, scoped maintainer access grants.
--   2. support_access_audit  — append-only, hash-chained audit trail. UPDATE
--      and DELETE are blocked by a trigger so the trail is immutable at the
--      database layer, not just by application convention.
--   3. import_batches / import_rows — previewed, quarantined, traceable and
--      rollback-able imports.

CREATE TABLE "support_access_grants" (
    "id" UUID NOT NULL,
    "requester_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ticket_ref" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_access_grants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_access_grants_scope_type_scope_expires_at_idx"
    ON "support_access_grants"("scope_type", "scope", "expires_at");

CREATE TABLE "support_access_audit" (
    "id" UUID NOT NULL,
    "grant_id" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "detail" JSONB,
    "prev_hash" TEXT,
    "entry_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_access_audit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_access_audit_grant_id_created_at_idx"
    ON "support_access_audit"("grant_id", "created_at");

CREATE OR REPLACE FUNCTION support_access_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'support_access_audit is append-only; UPDATE/DELETE rejected';
END;
$$;

CREATE TRIGGER support_access_audit_no_mutation
    BEFORE UPDATE OR DELETE ON "support_access_audit"
    FOR EACH ROW
    EXECUTE FUNCTION support_access_audit_immutable();

CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preview',
    "source_name" TEXT,
    "content_hash" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "total_rows" INTEGER NOT NULL,
    "accepted_rows" INTEGER NOT NULL,
    "quarantined_rows" INTEGER NOT NULL,
    "applied_rows" INTEGER NOT NULL DEFAULT 0,
    "rolled_back_rows" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committed_at" TIMESTAMP(3),
    "rolled_back_at" TIMESTAMP(3),

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "import_batches_idempotency_key_key"
    ON "import_batches"("idempotency_key");

CREATE INDEX "import_batches_kind_created_at_idx"
    ON "import_batches"("kind", "created_at" DESC);

CREATE TABLE "import_rows" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "quarantine_reason" TEXT,
    "quarantine_detail" TEXT,
    "payload" JSONB,
    "applied_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "import_rows_batch_id_row_number_key"
    ON "import_rows"("batch_id", "row_number");

CREATE INDEX "import_rows_batch_id_status_idx"
    ON "import_rows"("batch_id", "status");

ALTER TABLE "import_rows"
    ADD CONSTRAINT "import_rows_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
