-- Add wallet authentication tables (#391)
CREATE TABLE "wallet_challenges" (
    "challenge_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "wallet_address" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_challenges_pkey" PRIMARY KEY ("challenge_id")
);

CREATE INDEX "wallet_challenges_wallet_address_consumed_at_idx" ON "wallet_challenges" ("wallet_address", "consumed_at");
CREATE INDEX "wallet_challenges_expires_at_idx" ON "wallet_challenges" ("expires_at");

CREATE TABLE "wallet_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "wallet_address" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "last_used_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,
    "prev_session_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallet_sessions_token_key" ON "wallet_sessions" ("token");
CREATE INDEX "wallet_sessions_wallet_address_revoked_at_idx" ON "wallet_sessions" ("wallet_address", "revoked_at");
CREATE INDEX "wallet_sessions_token_idx" ON "wallet_sessions" ("token");