-- Existing history gets membership manifests; new appends also hash content.
CREATE TABLE "chain_event_batches" (
  "id" TEXT PRIMARY KEY,
  "event_ids" TEXT[] NOT NULL CHECK (cardinality("event_ids") > 0),
  "content_hash" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT NOW()
);
INSERT INTO "chain_event_batches" ("id", "event_ids")
SELECT 'legacy:' || bucket, array_agg(id ORDER BY id)
FROM (SELECT id, (row_number() OVER (ORDER BY id) - 1) / 500 AS bucket FROM "chain_events") numbered
GROUP BY bucket;
