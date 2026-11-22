-- Optional: Create drill_history table for tracking drill executions
-- Enable with STORE_DRILL_HISTORY=true environment variable

CREATE TABLE IF NOT EXISTS drill_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drill TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'sandbox')),
  passed BOOLEAN NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_ms INTEGER NOT NULL,
  executed_by TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_drill_history_executed_at ON drill_history(executed_at DESC);
CREATE INDEX idx_drill_history_drill ON drill_history(drill);
CREATE INDEX idx_drill_history_passed ON drill_history(passed);

COMMENT ON TABLE drill_history IS 'Audit log of incident drill executions (optional feature)';
COMMENT ON COLUMN drill_history.result IS 'Full DrillResult JSON including steps and verifications';
