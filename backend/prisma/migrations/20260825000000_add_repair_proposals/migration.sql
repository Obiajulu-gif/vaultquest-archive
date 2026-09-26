-- Dual-controlled, bounded, auditable reconciliation repairs (#597)
CREATE TABLE "repair_proposals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "plan_json" JSONB NOT NULL,
    "diff_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "proposer_id" TEXT NOT NULL,
    "step_count" INTEGER NOT NULL,
    "value_total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "required_approvals" INTEGER NOT NULL DEFAULT 1,
    "executed_by" TEXT,
    "executed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "repair_proposals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "repair_approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "proposal_id" UUID NOT NULL,
    "approver_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repair_approvals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "repair_proposals_status_expires_at_idx" ON "repair_proposals" ("status", "expires_at");
CREATE INDEX "repair_proposals_diff_hash_idx" ON "repair_proposals" ("diff_hash");
CREATE UNIQUE INDEX "repair_approvals_proposal_id_approver_id_key" ON "repair_approvals" ("proposal_id", "approver_id");

ALTER TABLE "repair_approvals" ADD CONSTRAINT "repair_approvals_proposal_id_fkey"
    FOREIGN KEY ("proposal_id") REFERENCES "repair_proposals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
