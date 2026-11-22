-- User is already part of schema.prisma, but had no migration in the archive.
-- Include its source table so a freshly migrated database can be snapshotted.
CREATE TABLE IF NOT EXISTS "users" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "wallet_address" TEXT UNIQUE,
  "email" TEXT UNIQUE,
  "name" TEXT,
  "bio" TEXT,
  "password_hash" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
