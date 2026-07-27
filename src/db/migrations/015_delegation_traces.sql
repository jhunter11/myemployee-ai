CREATE TABLE IF NOT EXISTS delegation_runs (
    run_id TEXT PRIMARY KEY
        CHECK (length(run_id) = 68 AND run_id GLOB 'run:[a-f0-9]*'),
    root_run_id TEXT NOT NULL
        CHECK (length(root_run_id) = 68 AND root_run_id GLOB 'run:[a-f0-9]*'),
    parent_run_id TEXT,
    retry_of_run_id TEXT,
    scope_id TEXT NOT NULL CHECK (length(scope_id) BETWEEN 3 AND 160),
    trust_domain TEXT NOT NULL CHECK (trust_domain IN ('personal', 'agency', 'mcp_x402', 'system')),
    tenant_id TEXT,
    tenant_key TEXT NOT NULL CHECK (length(tenant_key) BETWEEN 1 AND 64),
    policy_version INTEGER NOT NULL CHECK (policy_version BETWEEN 1 AND 2147483647),
    principal_id TEXT NOT NULL CHECK (principal_id GLOB 'principal:*'),
    channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram', 'local')),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 17 AND 134),
    request_digest TEXT NOT NULL
        CHECK (length(request_digest) = 71 AND request_digest GLOB 'sha256:[a-f0-9]*'),
    assigned_agent_id TEXT NOT NULL
        CHECK (
            length(assigned_agent_id) BETWEEN 3 AND 64 AND
            substr(assigned_agent_id, 1, 1) GLOB '[a-z]' AND
            assigned_agent_id NOT GLOB '*[^a-z0-9-]*'
        ),
    operation_code TEXT NOT NULL
        CHECK (
            length(operation_code) BETWEEN 3 AND 64 AND
            substr(operation_code, 1, 1) GLOB '[a-z]' AND
            operation_code NOT GLOB '*[^a-z0-9_]*'
        ),
    input_digest TEXT NOT NULL
        CHECK (length(input_digest) = 71 AND input_digest GLOB 'sha256:[a-f0-9]*'),
    depth INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 32),
    attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 32),
    status TEXT NOT NULL CHECK (status IN (
        'queued', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled'
    )),
    version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 2147483647),
    max_depth INTEGER NOT NULL CHECK (max_depth BETWEEN 1 AND 32),
    max_fan_out INTEGER NOT NULL CHECK (max_fan_out BETWEEN 1 AND 64),
    max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 16),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL AND updated_at >= created_at),
    terminal_at TEXT CHECK (terminal_at IS NULL OR unixepoch(terminal_at) IS NOT NULL),
    CHECK (tenant_key = COALESCE(tenant_id, '__none__')),
    CHECK ((parent_run_id IS NULL AND depth = 0) OR (parent_run_id IS NOT NULL AND depth > 0)),
    CHECK ((retry_of_run_id IS NULL AND attempt = 1) OR (retry_of_run_id IS NOT NULL AND attempt > 1)),
    CHECK (
        (status IN ('succeeded', 'failed', 'cancelled') AND terminal_at IS NOT NULL) OR
        (status NOT IN ('succeeded', 'failed', 'cancelled') AND terminal_at IS NULL)
    ),
    UNIQUE (scope_id, tenant_key, principal_id, channel, idempotency_key),
    FOREIGN KEY (root_run_id) REFERENCES delegation_runs(run_id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (parent_run_id) REFERENCES delegation_runs(run_id),
    FOREIGN KEY (retry_of_run_id) REFERENCES delegation_runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_delegation_runs_root_projection
    ON delegation_runs (scope_id, tenant_key, root_run_id, depth, created_at, run_id);

CREATE INDEX IF NOT EXISTS idx_delegation_runs_parent
    ON delegation_runs (scope_id, tenant_key, parent_run_id, created_at, run_id);

CREATE TABLE IF NOT EXISTS delegation_edges (
    child_run_id TEXT PRIMARY KEY REFERENCES delegation_runs(run_id),
    parent_run_id TEXT NOT NULL REFERENCES delegation_runs(run_id),
    root_run_id TEXT NOT NULL REFERENCES delegation_runs(run_id),
    scope_id TEXT NOT NULL,
    tenant_key TEXT NOT NULL,
    depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 32),
    edge_kind TEXT NOT NULL CHECK (edge_kind IN ('delegation', 'retry')),
    actor_principal_id TEXT NOT NULL CHECK (actor_principal_id GLOB 'principal:*'),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    CHECK (child_run_id <> parent_run_id)
);

CREATE INDEX IF NOT EXISTS idx_delegation_edges_parent
    ON delegation_edges (scope_id, tenant_key, parent_run_id, created_at, child_run_id);

CREATE TABLE IF NOT EXISTS delegation_run_spans (
    span_id TEXT PRIMARY KEY
        CHECK (length(span_id) = 69 AND span_id GLOB 'span:[a-f0-9]*'),
    run_id TEXT NOT NULL REFERENCES delegation_runs(run_id),
    root_run_id TEXT NOT NULL REFERENCES delegation_runs(run_id),
    parent_span_id TEXT REFERENCES delegation_run_spans(span_id),
    scope_id TEXT NOT NULL,
    tenant_key TEXT NOT NULL,
    principal_id TEXT NOT NULL CHECK (principal_id GLOB 'principal:*'),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 17 AND 134),
    request_digest TEXT NOT NULL
        CHECK (length(request_digest) = 71 AND request_digest GLOB 'sha256:[a-f0-9]*'),
    span_kind TEXT NOT NULL CHECK (span_kind IN ('orchestrator', 'agent', 'review', 'system')),
    name_code TEXT NOT NULL
        CHECK (
            length(name_code) BETWEEN 3 AND 64 AND
            substr(name_code, 1, 1) GLOB '[a-z]' AND
            name_code NOT GLOB '*[^a-z0-9_]*'
        ),
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'cancelled')),
    started_at TEXT NOT NULL CHECK (unixepoch(started_at) IS NOT NULL),
    ended_at TEXT NOT NULL CHECK (unixepoch(ended_at) IS NOT NULL AND ended_at >= started_at),
    duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 0 AND 86400000),
    evidence_digest TEXT
        CHECK (evidence_digest IS NULL OR (
            length(evidence_digest) = 71 AND evidence_digest GLOB 'sha256:[a-f0-9]*'
        )),
    recorded_at TEXT NOT NULL CHECK (unixepoch(recorded_at) IS NOT NULL),
    UNIQUE (run_id, principal_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_delegation_spans_run
    ON delegation_run_spans (scope_id, tenant_key, run_id, started_at, span_id);

CREATE TABLE IF NOT EXISTS delegation_run_events (
    event_id TEXT PRIMARY KEY
        CHECK (length(event_id) = 70 AND event_id GLOB 'event:[a-f0-9]*'),
    stream_sequence INTEGER NOT NULL CHECK (stream_sequence BETWEEN 1 AND 9223372036854775807),
    run_id TEXT NOT NULL REFERENCES delegation_runs(run_id),
    root_run_id TEXT NOT NULL REFERENCES delegation_runs(run_id),
    scope_id TEXT NOT NULL,
    tenant_key TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'run_queued', 'run_started', 'run_succeeded', 'run_failed', 'run_retried',
        'cancel_requested', 'run_cancelled', 'span_recorded'
    )),
    event_code TEXT NOT NULL
        CHECK (
            length(event_code) BETWEEN 3 AND 64 AND
            substr(event_code, 1, 1) GLOB '[a-z]' AND
            event_code NOT GLOB '*[^a-z0-9_]*'
        ),
    actor_principal_id TEXT NOT NULL CHECK (actor_principal_id GLOB 'principal:*'),
    state_version INTEGER NOT NULL CHECK (state_version BETWEEN 1 AND 2147483647),
    evidence_digest TEXT
        CHECK (evidence_digest IS NULL OR (
            length(evidence_digest) = 71 AND evidence_digest GLOB 'sha256:[a-f0-9]*'
        )),
    occurred_at TEXT NOT NULL CHECK (unixepoch(occurred_at) IS NOT NULL),
    UNIQUE (scope_id, tenant_key, stream_sequence)
);

CREATE INDEX IF NOT EXISTS idx_delegation_events_stream
    ON delegation_run_events (scope_id, tenant_key, stream_sequence);

CREATE INDEX IF NOT EXISTS idx_delegation_events_run
    ON delegation_run_events (scope_id, tenant_key, run_id, stream_sequence);

CREATE TRIGGER IF NOT EXISTS delegation_runs_guard_update
BEFORE UPDATE ON delegation_runs
WHEN
    OLD.run_id IS NOT NEW.run_id OR
    OLD.root_run_id IS NOT NEW.root_run_id OR
    OLD.parent_run_id IS NOT NEW.parent_run_id OR
    OLD.retry_of_run_id IS NOT NEW.retry_of_run_id OR
    OLD.scope_id IS NOT NEW.scope_id OR
    OLD.trust_domain IS NOT NEW.trust_domain OR
    OLD.tenant_id IS NOT NEW.tenant_id OR
    OLD.tenant_key IS NOT NEW.tenant_key OR
    OLD.policy_version IS NOT NEW.policy_version OR
    OLD.principal_id IS NOT NEW.principal_id OR
    OLD.channel IS NOT NEW.channel OR
    OLD.idempotency_key IS NOT NEW.idempotency_key OR
    OLD.request_digest IS NOT NEW.request_digest OR
    OLD.assigned_agent_id IS NOT NEW.assigned_agent_id OR
    OLD.operation_code IS NOT NEW.operation_code OR
    OLD.input_digest IS NOT NEW.input_digest OR
    OLD.depth IS NOT NEW.depth OR
    OLD.attempt IS NOT NEW.attempt OR
    OLD.max_depth IS NOT NEW.max_depth OR
    OLD.max_fan_out IS NOT NEW.max_fan_out OR
    OLD.max_attempts IS NOT NEW.max_attempts OR
    OLD.created_at IS NOT NEW.created_at OR
    NEW.version <> OLD.version + 1 OR
    NEW.updated_at < OLD.updated_at OR
    NOT (
        (OLD.status = 'queued' AND NEW.status IN ('running', 'cancelled')) OR
        (OLD.status = 'running' AND NEW.status IN (
            'succeeded', 'failed', 'cancel_requested'
        )) OR
        (OLD.status = 'cancel_requested' AND NEW.status = 'cancelled')
    )
BEGIN
    SELECT RAISE(ABORT, 'delegation run immutable binding, version, or transition failed');
END;

CREATE TRIGGER IF NOT EXISTS delegation_runs_guard_delete
BEFORE DELETE ON delegation_runs
BEGIN
    SELECT RAISE(ABORT, 'delegation runs are durable');
END;

CREATE TRIGGER IF NOT EXISTS delegation_edges_guard_update
BEFORE UPDATE ON delegation_edges
BEGIN
    SELECT RAISE(ABORT, 'delegation edges are append-only');
END;

CREATE TRIGGER IF NOT EXISTS delegation_edges_guard_delete
BEFORE DELETE ON delegation_edges
BEGIN
    SELECT RAISE(ABORT, 'delegation edges are append-only');
END;

CREATE TRIGGER IF NOT EXISTS delegation_spans_guard_update
BEFORE UPDATE ON delegation_run_spans
BEGIN
    SELECT RAISE(ABORT, 'delegation run spans are append-only');
END;

CREATE TRIGGER IF NOT EXISTS delegation_spans_guard_delete
BEFORE DELETE ON delegation_run_spans
BEGIN
    SELECT RAISE(ABORT, 'delegation run spans are append-only');
END;

CREATE TRIGGER IF NOT EXISTS delegation_events_guard_update
BEFORE UPDATE ON delegation_run_events
BEGIN
    SELECT RAISE(ABORT, 'delegation run events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS delegation_events_guard_delete
BEFORE DELETE ON delegation_run_events
BEGIN
    SELECT RAISE(ABORT, 'delegation run events are append-only');
END;
