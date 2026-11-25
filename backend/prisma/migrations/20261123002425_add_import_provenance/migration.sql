-- CreateTable: ImportProvenance (issue #1148)
-- Tracks cryptographic provenance of imported records with hash verification,
-- digital signatures, and rollback support.

CREATE TABLE "import_provenance" (
    "id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "source_hash" TEXT NOT NULL,
    "signature" TEXT,
    "operator_id" TEXT NOT NULL,
    "record_count" INTEGER NOT NULL DEFAULT 0,
    "record_ids" JSONB NOT NULL,
    "target_entity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error_code" TEXT,
    "error_detail" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "reverted_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_provenance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_provenance_source_type_created_at_idx" ON "import_provenance"("source_type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "import_provenance_operator_id_created_at_idx" ON "import_provenance"("operator_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "import_provenance_status_created_at_idx" ON "import_provenance"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "import_provenance_source_hash_idx" ON "import_provenance"("source_hash");

-- Comments
COMMENT ON TABLE "import_provenance" IS 'Cryptographic provenance tracking for imported records (issue #1148)';
COMMENT ON COLUMN "import_provenance"."source_hash" IS 'SHA-256 hash of source data for integrity verification';
COMMENT ON COLUMN "import_provenance"."signature" IS 'Optional digital signature for operator accountability';
COMMENT ON COLUMN "import_provenance"."record_ids" IS 'JSON array of imported record IDs for rollback support';
