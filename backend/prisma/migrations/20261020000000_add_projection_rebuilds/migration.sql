-- Versioned projection rebuild runs (#989).
--
-- Additive only: one new table, no change to existing tables, so the
-- migration is safe to deploy before the code that uses it and to leave in
-- place on rollback (an older build simply never reads it).

CREATE TABLE "projection_rebuilds" (
    "id" UUID NOT NULL,
    "projection_version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "to_event_id" TEXT,
    "cursor" TEXT,
    "events_replayed" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "error_code" TEXT,
    "last_error" TEXT,
    "heartbeat_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "projection_rebuilds_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "projection_rebuilds_status_created_at_idx" ON "projection_rebuilds"("status", "created_at");
