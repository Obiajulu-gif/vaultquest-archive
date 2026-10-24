CREATE TABLE "retention_holds" (
  "id" UUID NOT NULL,
  "record_type" TEXT NOT NULL,
  "record_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "case_reference" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3),
  "released_at" TIMESTAMP(3),
  "released_by" TEXT,
  "release_reason" TEXT,
  CONSTRAINT "retention_holds_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "retention_holds_record_type_record_id_released_at_idx" ON "retention_holds"("record_type", "record_id", "released_at");
CREATE INDEX "retention_holds_expires_at_idx" ON "retention_holds"("expires_at");

CREATE TABLE "external_identities" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'linked',
  "verified_at" TIMESTAMP(3) NOT NULL,
  "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unlinked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "external_identities_provider_subject_key" ON "external_identities"("provider", "subject");
CREATE INDEX "external_identities_user_id_status_idx" ON "external_identities"("user_id", "status");
