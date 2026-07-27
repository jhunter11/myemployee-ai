CREATE TABLE IF NOT EXISTS action_proposals (
  id TEXT PRIMARY KEY CHECK (id GLOB 'proposal:*'),
  source_id TEXT NOT NULL,
  principal_id TEXT NOT NULL CHECK (principal_id GLOB 'principal:*'),
  channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram', 'local')),
  scope_id TEXT NOT NULL,
  tenant_id TEXT,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  kind TEXT NOT NULL CHECK (
    kind IN ('pause_runtime', 'create_queue_work', 'calendar_private_hold', 'memory_change')
  ),
  payload_digest TEXT NOT NULL CHECK (payload_digest GLOB 'sha256:*'),
  reversible INTEGER NOT NULL CHECK (reversible IN (0, 1)),
  external_effect INTEGER NOT NULL CHECK (external_effect IN (0, 1)),
  risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'expired')),
  version INTEGER NOT NULL CHECK (version >= 1),
  confirmation_fingerprint TEXT NOT NULL CHECK (confirmation_fingerprint GLOB 'sha256:*'),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (principal_id, channel, source_id)
);

CREATE TABLE IF NOT EXISTS action_proposal_decisions (
  id TEXT PRIMARY KEY CHECK (id GLOB 'decision:*'),
  proposal_id TEXT NOT NULL UNIQUE REFERENCES action_proposals(id) ON DELETE RESTRICT,
  principal_id TEXT NOT NULL CHECK (principal_id GLOB 'principal:*'),
  verdict TEXT NOT NULL CHECK (verdict IN ('approved', 'rejected')),
  proposal_version INTEGER NOT NULL CHECK (proposal_version >= 2),
  decided_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_action_proposals_state_expiry
  ON action_proposals(state, expires_at);
