-- Add ActionLease table for worker lease management (#388)
CREATE TABLE "action_leases" (
    "action_id" UUID NOT NULL,
    "worker_id" TEXT NOT NULL,
    "acquired_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "action_leases_pkey" PRIMARY KEY ("action_id")
);

CREATE INDEX "action_leases_expires_at_idx" ON "action_leases" ("expires_at");