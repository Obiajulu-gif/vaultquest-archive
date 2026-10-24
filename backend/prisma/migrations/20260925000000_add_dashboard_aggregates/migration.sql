-- #750: Transactionally consistent dashboard aggregate snapshots.
--
-- dashboard_aggregates stores a single consistent snapshot per scope
-- (e.g. "global", "vault:<id>") that is rewritten atomically alongside
-- the action_ledger detail rows it summarises. The `watermark` column
-- records the ceiling updated_at of the rows included so the frontend
-- can verify alignment before treating aggregates and detail data as
-- consistent.

CREATE TABLE "dashboard_aggregates" (
    "id"                  UUID        NOT NULL DEFAULT gen_random_uuid(),
    "scope"               TEXT        NOT NULL,
    "watermark"           TIMESTAMPTZ NOT NULL,
    "total_value_locked"  TEXT        NOT NULL,
    "total_prize_pool"    TEXT        NOT NULL,
    "win_distribution"    JSONB       NOT NULL DEFAULT '[]'::JSONB,
    "deposit_count"       INTEGER     NOT NULL DEFAULT 0,
    "deposit_total"       TEXT        NOT NULL DEFAULT '0',
    "computed_at"         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_aggregates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dashboard_aggregates_scope_key"
    ON "dashboard_aggregates" ("scope");

CREATE INDEX "dashboard_aggregates_scope_watermark_idx"
    ON "dashboard_aggregates" ("scope", "watermark");

COMMENT ON TABLE "dashboard_aggregates" IS
    '#750: Transactionally-consistent aggregate snapshots for the dashboard. '
    'Rewritten atomically with the detail rows they summarise. '
    'watermark = max(action_ledger.updated_at) of included rows.';
