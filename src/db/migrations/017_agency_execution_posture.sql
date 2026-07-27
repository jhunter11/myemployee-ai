CREATE TABLE IF NOT EXISTS agency_execution_posture (
  singleton_id TEXT PRIMARY KEY CHECK (singleton_id = 'agency'),
  posture TEXT NOT NULL CHECK (posture IN ('active', 'paused')),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_proposal_id TEXT REFERENCES action_proposals(id) ON DELETE RESTRICT,
  source_proposal_version INTEGER CHECK (
    source_proposal_version IS NULL OR source_proposal_version >= 2
  ),
  source_confirmation_fingerprint TEXT CHECK (
    source_confirmation_fingerprint IS NULL OR
    source_confirmation_fingerprint GLOB 'sha256:*'
  ),
  source_decision_id TEXT REFERENCES action_proposal_decisions(id) ON DELETE RESTRICT,
  CHECK (
    (source_proposal_id IS NULL AND source_proposal_version IS NULL AND
     source_confirmation_fingerprint IS NULL AND source_decision_id IS NULL) OR
    (source_proposal_id IS NOT NULL AND source_proposal_version IS NOT NULL AND
     source_confirmation_fingerprint IS NOT NULL AND source_decision_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS agency_execution_posture_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE CHECK (event_id GLOB 'posture-event:*'),
  from_posture TEXT CHECK (from_posture IS NULL OR from_posture IN ('active', 'paused')),
  to_posture TEXT NOT NULL CHECK (to_posture IN ('active', 'paused')),
  resulting_version INTEGER NOT NULL CHECK (resulting_version >= 1),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_proposal_id TEXT REFERENCES action_proposals(id) ON DELETE RESTRICT,
  source_proposal_version INTEGER CHECK (
    source_proposal_version IS NULL OR source_proposal_version >= 2
  ),
  source_confirmation_fingerprint TEXT CHECK (
    source_confirmation_fingerprint IS NULL OR
    source_confirmation_fingerprint GLOB 'sha256:*'
  ),
  source_decision_id TEXT REFERENCES action_proposal_decisions(id) ON DELETE RESTRICT,
  occurred_at TEXT NOT NULL,
  CHECK (
    (source_proposal_id IS NULL AND source_proposal_version IS NULL AND
     source_confirmation_fingerprint IS NULL AND source_decision_id IS NULL) OR
    (source_proposal_id IS NOT NULL AND source_proposal_version IS NOT NULL AND
     source_confirmation_fingerprint IS NOT NULL AND source_decision_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_agency_execution_posture_events_version
  ON agency_execution_posture_events(resulting_version, sequence);
