-- Add RepairAudit and RepairQuarantine tables for reconciliation engine (#389)
CREATE TABLE "repair_audits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "plan_json" JSONB NOT NULL,
    "applied_json" JSONB,
    "operator_id" TEXT,
    "applied_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repair_audits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "repair_quarantine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "record_type" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "drift_type" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "repair_quarantine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "repair_quarantine_record_type_record_id_idx" ON "repair_quarantine" ("record_type", "record_id");
CREATE INDEX "repair_quarantine_drift_type_detected_at_idx" ON "repair_quarantine" ("drift_type", "detected_at");