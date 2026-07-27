-- Operator-owned, durable model-execution enablement switch. Default OFF.
-- Mirrors the agency execution posture pattern: a version-checked singleton row
-- with an append-only audit trail. Turning this on is the ONLY thing that lets
-- routeModelWork() permit a real model call; nothing here stores a secret,
-- prompt, completion, or provider credential.
CREATE TABLE IF NOT EXISTS model_execution_enablement (
  singleton_id TEXT PRIMARY KEY CHECK (singleton_id = 'jarvis'),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 3 AND 160),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 160),
  approver TEXT CHECK (approver IS NULL OR length(approver) BETWEEN 3 AND 160),
  approved_at TEXT CHECK (approved_at IS NULL OR length(approved_at) BETWEEN 20 AND 40),
  allowed_tiers TEXT NOT NULL CHECK (json_valid(allowed_tiers) AND json_type(allowed_tiers) = 'array'),
  allowed_surfaces TEXT NOT NULL CHECK (json_valid(allowed_surfaces) AND json_type(allowed_surfaces) = 'array'),
  allowed_providers TEXT NOT NULL CHECK (json_valid(allowed_providers) AND json_type(allowed_providers) = 'array'),
  CHECK (
    (enabled = 0 AND approver IS NULL AND approved_at IS NULL) OR
    (enabled = 1 AND approver IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS model_execution_enablement_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE CHECK (event_id GLOB 'model-enablement-event:*'),
  from_enabled INTEGER CHECK (from_enabled IS NULL OR from_enabled IN (0, 1)),
  to_enabled INTEGER NOT NULL CHECK (to_enabled IN (0, 1)),
  resulting_version INTEGER NOT NULL CHECK (resulting_version >= 1),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 3 AND 160),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 160),
  approver TEXT CHECK (approver IS NULL OR length(approver) BETWEEN 3 AND 160),
  allowed_tiers TEXT NOT NULL CHECK (json_valid(allowed_tiers)),
  allowed_surfaces TEXT NOT NULL CHECK (json_valid(allowed_surfaces)),
  allowed_providers TEXT NOT NULL CHECK (json_valid(allowed_providers)),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40)
);

CREATE INDEX IF NOT EXISTS idx_model_execution_enablement_events_version
  ON model_execution_enablement_events (resulting_version, sequence);
