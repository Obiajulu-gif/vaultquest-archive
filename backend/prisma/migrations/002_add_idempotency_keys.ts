/**
 * Migration: Add idempotency keys table
 *
 * Adds:
 * - IdempotencyKey table for replay protection on high-risk write operations
 */

import type { Prisma } from "@prisma/client";

export async function up(prisma: Prisma) {
  // Create IdempotencyKey table
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "idempotency_keys" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "key" TEXT NOT NULL UNIQUE,
      "operation_type" TEXT NOT NULL,
      "wallet_address" TEXT,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "response" JSONB,
      "error_code" TEXT,
      "error_detail" TEXT,
      "expires_at" TIMESTAMP NOT NULL,
      "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
      "updated_at" TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `;

  // Create indexes for IdempotencyKey
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "idempotency_keys_wallet_expires_at_idx" 
    ON "idempotency_keys" ("wallet_address", "expires_at");
  `;

  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_at_idx" 
    ON "idempotency_keys" ("expires_at");
  `;

  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "idempotency_keys_operation_type_expires_at_idx" 
    ON "idempotency_keys" ("operation_type", "expires_at");
  `;
}

export async function down(prisma: Prisma) {
  await prisma.$executeRaw`DROP TABLE IF EXISTS "idempotency_keys" CASCADE;`;
}
