CREATE TABLE IF NOT EXISTS work_queue_tasks (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    lane TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('api', 'operator', 'project', 'recovery', 'schedule')),
    source_id TEXT NOT NULL,
    source_occurred_at TEXT NOT NULL CHECK (unixepoch(source_occurred_at) IS NOT NULL),
    payload_kind TEXT NOT NULL CHECK (payload_kind IN ('automation', 'project_task', 'operator_gate')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_extract(payload_json, '$.kind') = payload_kind),
    policy_band TEXT NOT NULL CHECK (policy_band IN ('P0', 'P1', 'P2', 'P3')),
    impact INTEGER NOT NULL CHECK (impact BETWEEN 0 AND 10),
    urgency INTEGER NOT NULL CHECK (urgency BETWEEN 0 AND 10),
    effort INTEGER NOT NULL CHECK (effort BETWEEN 1 AND 10),
    base_score INTEGER NOT NULL CHECK (base_score = impact * 4 + urgency * 5 + (11 - effort)),
    state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'succeeded', 'failed')),
    version INTEGER NOT NULL CHECK (version >= 1),
    dependency_count INTEGER NOT NULL CHECK (dependency_count BETWEEN 0 AND 32),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    available_at TEXT NOT NULL CHECK (unixepoch(available_at) IS NOT NULL AND available_at >= source_occurred_at),
    updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
    lease_owner TEXT,
    lease_token TEXT,
    lease_expires_at TEXT CHECK (lease_expires_at IS NULL OR unixepoch(lease_expires_at) IS NOT NULL),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    terminal_reason_code TEXT,
    UNIQUE (tenant_id, source_kind, source_id),
    UNIQUE (id, tenant_id),
    CHECK (
        (state = 'leased' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR
        (state <> 'leased' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (
        (state IN ('queued', 'leased') AND terminal_reason_code IS NULL) OR
        (state = 'succeeded' AND terminal_reason_code = 'completed') OR
        (state = 'failed' AND terminal_reason_code IN (
            'cancelled', 'dependency_invalidated', 'policy_blocked', 'verification_failed', 'worker_error'
        ))
    )
);

CREATE TABLE IF NOT EXISTS work_queue_dependencies (
    tenant_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    dependency_task_id TEXT NOT NULL,
    PRIMARY KEY (tenant_id, task_id, dependency_task_id),
    CHECK (task_id <> dependency_task_id),
    FOREIGN KEY (task_id, tenant_id) REFERENCES work_queue_tasks(id, tenant_id),
    FOREIGN KEY (dependency_task_id, tenant_id) REFERENCES work_queue_tasks(id, tenant_id)
);

CREATE TABLE IF NOT EXISTS work_queue_lanes (
    tenant_id TEXT NOT NULL,
    lane TEXT NOT NULL,
    last_claim_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_claim_sequence >= 0),
    claim_count INTEGER NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
    PRIMARY KEY (tenant_id, lane)
);

CREATE TABLE IF NOT EXISTS work_queue_tenant_cursors (
    tenant_id TEXT PRIMARY KEY,
    last_claim_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_claim_sequence >= 0)
);

CREATE TABLE IF NOT EXISTS work_queue_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    event_at TEXT NOT NULL CHECK (unixepoch(event_at) IS NOT NULL),
    event_type TEXT NOT NULL CHECK (event_type IN ('created', 'claimed', 'reclaimed', 'succeeded', 'failed')),
    decision_code TEXT NOT NULL CHECK (decision_code IN (
        'source_accepted', 'lane_head_claimed', 'expired_lease_reclaimed', 'lease_succeeded', 'lease_failed'
    )),
    actor_id TEXT NOT NULL,
    from_state TEXT CHECK (from_state IS NULL OR from_state IN ('queued', 'leased', 'succeeded', 'failed')),
    to_state TEXT NOT NULL CHECK (to_state IN ('queued', 'leased', 'succeeded', 'failed')),
    task_version INTEGER NOT NULL CHECK (task_version >= 1),
    detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
    FOREIGN KEY (task_id, tenant_id) REFERENCES work_queue_tasks(id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_work_queue_ready
    ON work_queue_tasks (tenant_id, state, policy_band, available_at, lane, id);
CREATE INDEX IF NOT EXISTS idx_work_queue_dependencies_task
    ON work_queue_dependencies (tenant_id, task_id, dependency_task_id);
CREATE INDEX IF NOT EXISTS idx_work_queue_dependencies_blocker
    ON work_queue_dependencies (tenant_id, dependency_task_id, task_id);
CREATE INDEX IF NOT EXISTS idx_work_queue_events_tenant_sequence
    ON work_queue_events (tenant_id, sequence DESC);

CREATE TRIGGER IF NOT EXISTS work_queue_events_no_update
BEFORE UPDATE ON work_queue_events
BEGIN
    SELECT RAISE(ABORT, 'work_queue_events is append-only');
END;
CREATE TRIGGER IF NOT EXISTS work_queue_events_no_delete
BEFORE DELETE ON work_queue_events
BEGIN
    SELECT RAISE(ABORT, 'work_queue_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS work_queue_task_contract_immutable
BEFORE UPDATE ON work_queue_tasks
WHEN
    OLD.id IS NOT NEW.id OR
    OLD.tenant_id IS NOT NEW.tenant_id OR
    OLD.lane IS NOT NEW.lane OR
    OLD.source_kind IS NOT NEW.source_kind OR
    OLD.source_id IS NOT NEW.source_id OR
    OLD.source_occurred_at IS NOT NEW.source_occurred_at OR
    OLD.payload_kind IS NOT NEW.payload_kind OR
    OLD.payload_json IS NOT NEW.payload_json OR
    OLD.policy_band IS NOT NEW.policy_band OR
    OLD.impact IS NOT NEW.impact OR
    OLD.urgency IS NOT NEW.urgency OR
    OLD.effort IS NOT NEW.effort OR
    OLD.base_score IS NOT NEW.base_score OR
    OLD.dependency_count IS NOT NEW.dependency_count OR
    OLD.created_at IS NOT NEW.created_at OR
    OLD.available_at IS NOT NEW.available_at
BEGIN
    SELECT RAISE(ABORT, 'work_queue task contract is immutable');
END;
