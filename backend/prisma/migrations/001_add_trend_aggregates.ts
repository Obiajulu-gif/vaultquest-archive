/**
 * Migration: Add trend aggregation tables
 *
 * Adds:
 * - DashboardAggregate table for transactionally-consistent dashboard views
 * - TrendAggregate table for historical trend aggregation
 */

import type { Prisma } from "@prisma/client";

export async function up(prisma: Prisma) {
  // Create DashboardAggregate table
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "dashboard_aggregates" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "scope" TEXT NOT NULL UNIQUE,
      "watermark" TIMESTAMP NOT NULL,
      "total_value_locked" TEXT NOT NULL,
      "total_prize_pool" TEXT NOT NULL,
      "win_distribution" JSONB NOT NULL,
      "deposit_count" INTEGER NOT NULL,
      "deposit_total" TEXT NOT NULL,
      "computed_at" TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `;

  // Create TrendAggregate table
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "trend_aggregates" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "metric_name" TEXT NOT NULL,
      "window" TEXT NOT NULL,
      "window_start" TIMESTAMP NOT NULL,
      "window_end" TIMESTAMP NOT NULL,
      "value" DOUBLE PRECISION NOT NULL,
      "count" INTEGER NOT NULL DEFAULT 0,
      "metadata" JSONB,
      "schema_version" INTEGER NOT NULL DEFAULT 1,
      "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
      "updated_at" TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE ("metric_name", "window", "window_start")
    );
  `;

  // Create indexes for TrendAggregate
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "trend_aggregates_metric_name_window_start_idx" 
    ON "trend_aggregates" ("metric_name", "window_start" DESC);
  `;

  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "trend_aggregates_window_start_end_idx" 
    ON "trend_aggregates" ("window_start", "window_end");
  `;
}

export async function down(prisma: Prisma) {
  await prisma.$executeRaw`DROP TABLE IF EXISTS "trend_aggregates" CASCADE;`;
  await prisma.$executeRaw`DROP TABLE IF EXISTS "dashboard_aggregates" CASCADE;`;
}
