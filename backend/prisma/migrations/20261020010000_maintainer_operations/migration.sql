-- #841: bounded content and append-only, content-free access history.
CREATE TABLE "maintainer_notes" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "scope_type" TEXT NOT NULL CHECK ("scope_type" IN ('action', 'failure', 'wallet', 'pool')),
  "scope_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('support', 'incident', 'decision')),
  "visibility" TEXT NOT NULL CHECK ("visibility" IN ('maintainers', 'private')),
  "body" TEXT,
  "author_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "archived_at" TIMESTAMPTZ(3),
  "redacted_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  CHECK ("body" IS NULL OR length("body") BETWEEN 1 AND 10000),
  CHECK ("redacted_at" IS NULL OR "body" IS NULL),
  CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + INTERVAL '365 days')
);
CREATE INDEX "maintainer_notes_scope_type_scope_id_created_at_idx" ON "maintainer_notes" ("scope_type", "scope_id", "created_at");
CREATE INDEX "maintainer_notes_expires_at_idx" ON "maintainer_notes" ("expires_at");
CREATE TABLE "maintainer_note_audit" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "note_id" UUID REFERENCES "maintainer_notes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "actor" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "allowed" BOOLEAN NOT NULL,
  "version" INTEGER,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT NOW()
);
CREATE INDEX "maintainer_note_audit_note_id_created_at_idx" ON "maintainer_note_audit" ("note_id", "created_at");
CREATE FUNCTION maintainer_note_audit_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'maintainer_note_audit is append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER maintainer_note_audit_no_mutation BEFORE UPDATE OR DELETE ON "maintainer_note_audit"
  FOR EACH ROW EXECUTE FUNCTION maintainer_note_audit_immutable();
CREATE TRIGGER maintainer_note_audit_no_truncate BEFORE TRUNCATE ON "maintainer_note_audit"
  FOR EACH STATEMENT EXECUTE FUNCTION maintainer_note_audit_immutable();

-- #842: policies and in-app notification attempts survive restarts.
CREATE TABLE "failure_escalation_policies" (
  "severity" TEXT PRIMARY KEY CHECK ("severity" IN ('low', 'medium', 'high', 'critical')),
  "after_ms" INTEGER NOT NULL CHECK ("after_ms" >= 0),
  "repeat_ms" INTEGER NOT NULL CHECK ("repeat_ms" >= 60000),
  "max_attempts" INTEGER NOT NULL CHECK ("max_attempts" BETWEEN 1 AND 100),
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_by" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT NOW()
);
INSERT INTO "failure_escalation_policies" ("severity", "after_ms", "repeat_ms", "max_attempts", "updated_by") VALUES
 ('low', 86400000, 86400000, 10, 'migration'),
 ('medium', 3600000, 3600000, 10, 'migration'),
 ('high', 900000, 1800000, 10, 'migration'),
 ('critical', 0, 300000, 20, 'migration');
CREATE TABLE "failure_escalation_attempts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "failure_id" UUID NOT NULL REFERENCES "partial_failures" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "attempt" INTEGER NOT NULL CHECK ("attempt" > 0),
  "policy_version" INTEGER NOT NULL,
  "severity" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'acknowledged')),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  "acknowledged_at" TIMESTAMPTZ(3),
  "acknowledged_by" TEXT,
  UNIQUE ("failure_id", "attempt"),
  CHECK (("status" = 'acknowledged') = ("acknowledged_at" IS NOT NULL AND "acknowledged_by" IS NOT NULL))
);
CREATE INDEX "failure_escalation_attempts_status_created_at_idx" ON "failure_escalation_attempts" ("status", "created_at");
