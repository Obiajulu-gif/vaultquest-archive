-- CreateTable
CREATE TABLE "job_leases" (
    "job_name" TEXT NOT NULL,
    "worker_id" TEXT NOT NULL,
    "fencing_token" BIGINT NOT NULL DEFAULT 1,
    "acquired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_leases_pkey" PRIMARY KEY ("job_name")
);

-- CreateIndex
CREATE INDEX "job_leases_expires_at_idx" ON "job_leases"("expires_at");
