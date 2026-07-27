-- Crash-safe, content-free dispatch for post-terminal memory maintenance.
--
-- The run terminal transition and the outbox insert occur in one transaction.
-- Jobs carry only immutable binding/version identifiers; run inputs, outputs,
-- errors, transcripts, prompts, and model reasoning never enter this table.

CREATE TABLE IF NOT EXISTS memory_maintenance_outbox (
    job_id TEXT PRIMARY KEY
        CHECK (
            length(job_id) = 75 AND
            job_id GLOB 'memory-job:[a-f0-9]*' AND
            substr(job_id, 12) NOT GLOB '*[^a-f0-9]*'
        ),
    run_id TEXT NOT NULL,
    job_kind TEXT NOT NULL
        CHECK (job_kind = 'terminal_episode_and_consolidation'),
    policy_revision TEXT NOT NULL
        CHECK (
            length(policy_revision) BETWEEN 1 AND 64 AND
            substr(policy_revision, 1, 1) GLOB '[a-z0-9]' AND
            policy_revision NOT GLOB '*[^a-z0-9._-]*'
        ),
    agent_id TEXT NOT NULL,
    expected_agent_version INTEGER NOT NULL
        CHECK (expected_agent_version BETWEEN 1 AND 2147483647),
    owner_scope_id TEXT NOT NULL,
    expected_owner_scope_version INTEGER NOT NULL
        CHECK (expected_owner_scope_version BETWEEN 1 AND 2147483647),
    sleeve_id TEXT NOT NULL,
    expected_sleeve_version INTEGER NOT NULL
        CHECK (expected_sleeve_version BETWEEN 1 AND 2147483647),
    purpose TEXT NOT NULL,
    sensitivity TEXT NOT NULL
        CHECK (sensitivity IN ('public', 'internal', 'confidential', 'private', 'restricted')),
    grant_versions_json TEXT NOT NULL
        CHECK (
            json_valid(grant_versions_json) AND
            json_type(grant_versions_json) = 'object'
        ),
    state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'completed', 'dead_letter')),
    version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 2147483647),
    attempt_count INTEGER NOT NULL
        CHECK (attempt_count BETWEEN 0 AND 100000),
    available_at TEXT NOT NULL CHECK (unixepoch(available_at) IS NOT NULL),
    lease_owner TEXT,
    lease_token TEXT,
    lease_expires_at TEXT CHECK (lease_expires_at IS NULL OR unixepoch(lease_expires_at) IS NOT NULL),
    last_error_code TEXT,
    queued_at TEXT NOT NULL CHECK (unixepoch(queued_at) IS NOT NULL),
    completed_at TEXT CHECK (completed_at IS NULL OR unixepoch(completed_at) IS NOT NULL),
    UNIQUE (run_id, job_kind, policy_revision),
    CHECK (
        (state = 'pending' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL) OR
        (state = 'leased' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND completed_at IS NULL) OR
        (state IN ('completed', 'dead_letter') AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND completed_at IS NOT NULL)
    ),
    FOREIGN KEY (run_id) REFERENCES agent_runs(id),
    FOREIGN KEY (agent_id) REFERENCES access_agents(agent_id),
    FOREIGN KEY (owner_scope_id) REFERENCES control_scopes(scope_id),
    FOREIGN KEY (sleeve_id) REFERENCES memory_sleeves(sleeve_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_maintenance_claim
    ON memory_maintenance_outbox (
        state,
        available_at,
        lease_expires_at,
        queued_at,
        job_id
    );

CREATE TABLE IF NOT EXISTS memory_maintenance_outbox_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    event_type TEXT NOT NULL
        CHECK (event_type IN ('queued', 'claimed', 'retried', 'completed', 'dead_lettered')),
    from_state TEXT,
    to_state TEXT NOT NULL,
    job_version INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    decision_code TEXT NOT NULL,
    occurred_at TEXT NOT NULL CHECK (unixepoch(occurred_at) IS NOT NULL),
    detail_json TEXT NOT NULL
        CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object'),
    FOREIGN KEY (job_id) REFERENCES memory_maintenance_outbox(job_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_maintenance_events
    ON memory_maintenance_outbox_events (job_id, sequence);

-- A job may only be inserted after its run is terminal in the same transaction.
CREATE TRIGGER IF NOT EXISTS memory_maintenance_terminal_run_insert
BEFORE INSERT ON memory_maintenance_outbox
WHEN NOT EXISTS (
    SELECT 1
    FROM agent_runs
    WHERE id = NEW.run_id AND status IN ('succeeded', 'failed')
)
BEGIN
    SELECT RAISE(ABORT, 'memory maintenance requires a terminal run');
END;

CREATE TRIGGER IF NOT EXISTS memory_maintenance_binding_insert
BEFORE INSERT ON memory_maintenance_outbox
WHEN NOT EXISTS (
    SELECT 1
    FROM memory_sleeves AS sleeve
    JOIN control_scopes AS scope ON scope.scope_id = sleeve.owner_scope_id
    JOIN access_agents AS agent ON agent.agent_id = NEW.agent_id
    WHERE
        sleeve.sleeve_id = NEW.sleeve_id AND
        sleeve.owner_scope_id = NEW.owner_scope_id AND
        sleeve.state = 'active' AND
        sleeve.version = NEW.expected_sleeve_version AND
        scope.state = 'active' AND
        scope.version = NEW.expected_owner_scope_version AND
        agent.state = 'active' AND
        agent.version = NEW.expected_agent_version
)
BEGIN
    SELECT RAISE(ABORT, 'memory maintenance binding is stale or invalid');
END;

CREATE TRIGGER IF NOT EXISTS memory_maintenance_events_no_update
BEFORE UPDATE ON memory_maintenance_outbox_events
BEGIN
    SELECT RAISE(ABORT, 'memory maintenance events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS memory_maintenance_events_no_delete
BEFORE DELETE ON memory_maintenance_outbox_events
BEGIN
    SELECT RAISE(ABORT, 'memory maintenance events cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS memory_maintenance_outbox_no_delete
BEFORE DELETE ON memory_maintenance_outbox
BEGIN
    SELECT RAISE(ABORT, 'memory maintenance jobs cannot be deleted');
END;
