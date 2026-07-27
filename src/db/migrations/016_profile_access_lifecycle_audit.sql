CREATE TABLE IF NOT EXISTS access_lifecycle_events (
    event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE
        CHECK (
            length(event_id) = 77 AND
            substr(event_id, 1, 13) = 'access-event:' AND
            substr(event_id, 14) NOT GLOB '*[^a-f0-9]*'
        ),
    resource_kind TEXT NOT NULL CHECK (resource_kind IN (
        'sleeve_grant', 'tool_grant', 'shared_bundle'
    )),
    resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 8 AND 160),
    action TEXT NOT NULL CHECK (action IN ('revoked', 'replaced')),
    replacement_resource_id TEXT CHECK (
        replacement_resource_id IS NULL OR length(replacement_resource_id) BETWEEN 8 AND 160
    ),
    prior_version INTEGER NOT NULL
        CHECK (typeof(prior_version) = 'integer' AND prior_version BETWEEN 1 AND 2147483646),
    resulting_version INTEGER NOT NULL
        CHECK (typeof(resulting_version) = 'integer' AND resulting_version = prior_version + 1),
    actor_id TEXT NOT NULL
        CHECK (
            length(actor_id) BETWEEN 12 AND 128 AND
            substr(actor_id, 1, 9) = 'operator:' AND
            actor_id NOT GLOB '*[^a-z0-9_:-]*'
        ),
    reason TEXT NOT NULL
        CHECK (
            length(reason) BETWEEN 3 AND 96 AND
            substr(reason, 1, 1) GLOB '[a-z]' AND
            reason NOT GLOB '*[^a-z0-9_]*'
        ),
    evidence_sha256 TEXT NOT NULL
        CHECK (
            length(evidence_sha256) = 64 AND
            evidence_sha256 NOT GLOB '*[^a-f0-9]*'
        ),
    occurred_at TEXT NOT NULL CHECK (unixepoch(occurred_at) IS NOT NULL),
    CHECK (
        (action = 'revoked' AND replacement_resource_id IS NULL) OR
        (action = 'replaced' AND replacement_resource_id IS NOT NULL)
    ),
    CHECK (replacement_resource_id IS NULL OR replacement_resource_id <> resource_id),
    UNIQUE (resource_kind, resource_id, resulting_version)
);

CREATE INDEX IF NOT EXISTS idx_access_lifecycle_events_projection
    ON access_lifecycle_events (resource_kind, resource_id, event_sequence DESC);

CREATE TRIGGER IF NOT EXISTS access_lifecycle_events_no_update
BEFORE UPDATE ON access_lifecycle_events
BEGIN
    SELECT RAISE(ABORT, 'access lifecycle evidence is append-only');
END;

CREATE TRIGGER IF NOT EXISTS access_lifecycle_events_no_delete
BEFORE DELETE ON access_lifecycle_events
BEGIN
    SELECT RAISE(ABORT, 'access lifecycle evidence is append-only');
END;
