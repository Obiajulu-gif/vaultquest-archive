-- #791: scoped, time-limited maintainer impersonation sessions.
-- Additive only: one new table; no changes to existing tables or rows.

CREATE TABLE IF NOT EXISTS "impersonation_sessions" (
    "id"                  UUID         PRIMARY KEY,
    "maintainer_subject"  TEXT         NOT NULL,
    "target_wallet"       TEXT         NOT NULL,
    "reason"              TEXT         NOT NULL,
    "allow_mutations"     BOOLEAN      NOT NULL DEFAULT FALSE,
    "state"               TEXT         NOT NULL DEFAULT 'active',
    "started_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
    "expires_at"          TIMESTAMPTZ(3) NOT NULL,
    "ended_at"            TIMESTAMPTZ(3)
);

-- Used by: "find active sessions for maintainer" and "expire old sessions".
CREATE INDEX IF NOT EXISTS "impersonation_sessions_maintainer_state_idx"
    ON "impersonation_sessions" ("maintainer_subject", "state");

-- Used by: background TTL sweep and validation short-circuit.
CREATE INDEX IF NOT EXISTS "impersonation_sessions_expires_at_idx"
    ON "impersonation_sessions" ("expires_at")
    WHERE "state" = 'active';
