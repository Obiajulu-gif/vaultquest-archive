-- Issue #3: Intent approval schema for high-impact maintainer actions

CREATE TABLE intent_proposals (
  id UUID PRIMARY KEY,
  action_type TEXT NOT NULL,
  action_payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  requester_address TEXT NOT NULL,
  requester_public_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  approver_address TEXT,
  approver_public_key TEXT,
  approval_signature TEXT,
  approval_notes TEXT,
  denial_reason TEXT,
  executor_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  denied_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX intent_proposals_status_expires_idx ON intent_proposals(status, expires_at);
CREATE INDEX intent_proposals_payload_hash_idx ON intent_proposals(payload_hash);
CREATE INDEX intent_proposals_requester_idx ON intent_proposals(requester_address, created_at DESC);

CREATE TABLE intent_approval_audit (
  id UUID PRIMARY KEY,
  intent_id UUID REFERENCES intent_proposals(id),
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX intent_approval_audit_intent_idx ON intent_approval_audit(intent_id, created_at);
CREATE INDEX intent_approval_audit_actor_idx ON intent_approval_audit(actor, created_at DESC);
