CREATE TABLE IF NOT EXISTS artifact_scope_claims (
    claim_id TEXT PRIMARY KEY CHECK (
        length(claim_id) = 64 AND claim_id NOT GLOB '*[^0-9a-f]*'
    ),
    artifact_scope_key TEXT NOT NULL CHECK (length(artifact_scope_key) BETWEEN 3 AND 192),
    tenant_id TEXT NOT NULL,
    automation_id TEXT NOT NULL,
    task_id TEXT NOT NULL CHECK (
        length(task_id) = 64 AND task_id NOT GLOB '*[^0-9a-f]*'
    ),
    run_id TEXT NOT NULL CHECK (
        length(run_id) = 64 AND run_id NOT GLOB '*[^0-9a-f]*'
    ),
    version INTEGER NOT NULL CHECK (version >= 1),
    state TEXT NOT NULL CHECK (state IN (
        'executing', 'verification_pending', 'finalization_pending', 'released', 'abandoned'
    )),
    captured_queue_version INTEGER NOT NULL CHECK (captured_queue_version >= 1),
    acquired_at TEXT NOT NULL CHECK (unixepoch(acquired_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
    terminal_at TEXT CHECK (terminal_at IS NULL OR unixepoch(terminal_at) IS NOT NULL),
    terminal_evidence_kind TEXT,
    terminal_evidence_id TEXT,
    terminal_evidence_sha256 TEXT CHECK (
        terminal_evidence_sha256 IS NULL OR (
            length(terminal_evidence_sha256) = 64 AND
            terminal_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
        )
    ),
    UNIQUE (claim_id, tenant_id, automation_id, task_id, run_id, artifact_scope_key),
    FOREIGN KEY (tenant_id) REFERENCES client_registry(id),
    FOREIGN KEY (task_id, tenant_id) REFERENCES work_queue_tasks(id, tenant_id),
    FOREIGN KEY (run_id) REFERENCES agent_runs(id),
    CHECK (updated_at >= acquired_at),
    CHECK (
        (state IN ('executing', 'verification_pending', 'finalization_pending') AND
         terminal_at IS NULL AND terminal_evidence_kind IS NULL AND
         terminal_evidence_id IS NULL AND terminal_evidence_sha256 IS NULL) OR
        (state IN ('released', 'abandoned') AND
         terminal_at IS NOT NULL AND terminal_evidence_kind IS NOT NULL AND
         terminal_evidence_id IS NOT NULL AND terminal_evidence_sha256 IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_scope_claims_one_active_scope
    ON artifact_scope_claims (artifact_scope_key)
    WHERE state IN ('executing', 'verification_pending', 'finalization_pending');
CREATE INDEX IF NOT EXISTS idx_artifact_scope_claims_task_run
    ON artifact_scope_claims (tenant_id, task_id, run_id);

CREATE TABLE IF NOT EXISTS source_snapshot_claims (
    source_claim_id TEXT PRIMARY KEY CHECK (
        length(source_claim_id) = 64 AND source_claim_id NOT GLOB '*[^0-9a-f]*'
    ),
    artifact_claim_id TEXT NOT NULL CHECK (
        length(artifact_claim_id) = 64 AND artifact_claim_id NOT GLOB '*[^0-9a-f]*'
    ),
    task_id TEXT NOT NULL CHECK (
        length(task_id) = 64 AND task_id NOT GLOB '*[^0-9a-f]*'
    ),
    run_id TEXT NOT NULL CHECK (
        length(run_id) = 64 AND run_id NOT GLOB '*[^0-9a-f]*'
    ),
    tenant_id TEXT NOT NULL,
    automation_id TEXT NOT NULL,
    source_registration_id TEXT NOT NULL CHECK (length(source_registration_id) BETWEEN 3 AND 192),
    snapshot_relative_path TEXT NOT NULL CHECK (
        length(snapshot_relative_path) BETWEEN 1 AND 1024 AND
        snapshot_relative_path NOT LIKE '/%' AND
        snapshot_relative_path NOT LIKE '%/' AND
        snapshot_relative_path NOT LIKE '%//%' AND
        snapshot_relative_path NOT IN ('.', '..') AND
        snapshot_relative_path NOT LIKE './%' AND
        snapshot_relative_path NOT LIKE '../%' AND
        snapshot_relative_path NOT LIKE '%/./%' AND
        snapshot_relative_path NOT LIKE '%/../%' AND
        snapshot_relative_path NOT LIKE '%/.' AND
        snapshot_relative_path NOT LIKE '%/..' AND
        instr(snapshot_relative_path, char(92)) = 0 AND
        instr(snapshot_relative_path, char(0)) = 0
    ),
    size INTEGER NOT NULL CHECK (size >= 0),
    source_sha256 TEXT NOT NULL CHECK (
        length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    UNIQUE (
        source_claim_id, artifact_claim_id, task_id, run_id, tenant_id, automation_id, source_sha256
    ),
    FOREIGN KEY (artifact_claim_id) REFERENCES artifact_scope_claims(claim_id),
    FOREIGN KEY (task_id, tenant_id) REFERENCES work_queue_tasks(id, tenant_id),
    FOREIGN KEY (run_id) REFERENCES agent_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_source_snapshot_claims_artifact
    ON source_snapshot_claims (artifact_claim_id, source_claim_id);

CREATE TABLE IF NOT EXISTS run_completion_candidates (
    candidate_id TEXT PRIMARY KEY CHECK (length(candidate_id) BETWEEN 3 AND 192),
    occurrence_id TEXT CHECK (
        occurrence_id IS NULL OR (
            length(occurrence_id) = 64 AND occurrence_id NOT GLOB '*[^0-9a-f]*'
        )
    ),
    execution_request_id TEXT NOT NULL UNIQUE CHECK (
        length(execution_request_id) = 64 AND execution_request_id NOT GLOB '*[^0-9a-f]*'
    ),
    task_id TEXT NOT NULL CHECK (
        length(task_id) = 64 AND task_id NOT GLOB '*[^0-9a-f]*'
    ),
    run_id TEXT NOT NULL UNIQUE CHECK (
        length(run_id) = 64 AND run_id NOT GLOB '*[^0-9a-f]*'
    ),
    tenant_id TEXT NOT NULL,
    automation_id TEXT NOT NULL,
    worker_id TEXT NOT NULL CHECK (length(worker_id) BETWEEN 3 AND 192),
    artifact_claim_id TEXT NOT NULL CHECK (
        length(artifact_claim_id) = 64 AND artifact_claim_id NOT GLOB '*[^0-9a-f]*'
    ),
    artifact_scope_key TEXT NOT NULL,
    source_claim_id TEXT NOT NULL CHECK (
        length(source_claim_id) = 64 AND source_claim_id NOT GLOB '*[^0-9a-f]*'
    ),
    source_sha256 TEXT NOT NULL CHECK (
        length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    result_schema_version INTEGER NOT NULL CHECK (result_schema_version >= 1),
    canonical_result_json TEXT NOT NULL CHECK (
        json_valid(canonical_result_json) AND length(CAST(canonical_result_json AS BLOB)) <= 262144
    ),
    result_sha256 TEXT NOT NULL CHECK (
        length(result_sha256) = 64 AND result_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    artifact_sha256 TEXT NOT NULL CHECK (
        length(artifact_sha256) = 64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    journal_claim_id TEXT NOT NULL CHECK (length(journal_claim_id) BETWEEN 3 AND 192),
    journal_claim_sha256 TEXT NOT NULL CHECK (
        length(journal_claim_sha256) = 64 AND journal_claim_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    criteria_sha256 TEXT NOT NULL CHECK (
        length(criteria_sha256) = 64 AND criteria_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    captured_posture_version INTEGER NOT NULL CHECK (captured_posture_version >= 1),
    committed_at TEXT NOT NULL CHECK (unixepoch(committed_at) IS NOT NULL),
    UNIQUE (
        candidate_id, task_id, run_id, tenant_id, automation_id, artifact_claim_id,
        artifact_scope_key, source_claim_id, criteria_sha256
    ),
    FOREIGN KEY (task_id, tenant_id) REFERENCES work_queue_tasks(id, tenant_id),
    FOREIGN KEY (run_id) REFERENCES agent_runs(id),
    FOREIGN KEY (artifact_claim_id) REFERENCES artifact_scope_claims(claim_id),
    FOREIGN KEY (source_claim_id) REFERENCES source_snapshot_claims(source_claim_id)
);

CREATE INDEX IF NOT EXISTS idx_run_completion_candidates_task
    ON run_completion_candidates (tenant_id, task_id, run_id);

CREATE TABLE IF NOT EXISTS work_queue_verification_holds (
    hold_id TEXT PRIMARY KEY CHECK (
        length(hold_id) = 64 AND hold_id NOT GLOB '*[^0-9a-f]*'
    ),
    candidate_id TEXT NOT NULL UNIQUE,
    task_id TEXT NOT NULL CHECK (
        length(task_id) = 64 AND task_id NOT GLOB '*[^0-9a-f]*'
    ),
    run_id TEXT NOT NULL UNIQUE CHECK (
        length(run_id) = 64 AND run_id NOT GLOB '*[^0-9a-f]*'
    ),
    tenant_id TEXT NOT NULL,
    automation_id TEXT NOT NULL,
    execution_request_id TEXT NOT NULL CHECK (
        length(execution_request_id) = 64 AND execution_request_id NOT GLOB '*[^0-9a-f]*'
    ),
    occurrence_id TEXT CHECK (
        occurrence_id IS NULL OR (
            length(occurrence_id) = 64 AND occurrence_id NOT GLOB '*[^0-9a-f]*'
        )
    ),
    artifact_claim_id TEXT NOT NULL CHECK (
        length(artifact_claim_id) = 64 AND artifact_claim_id NOT GLOB '*[^0-9a-f]*'
    ),
    artifact_scope_key TEXT NOT NULL,
    source_claim_id TEXT NOT NULL CHECK (
        length(source_claim_id) = 64 AND source_claim_id NOT GLOB '*[^0-9a-f]*'
    ),
    leased_version INTEGER NOT NULL CHECK (leased_version >= 1),
    queue_attempt INTEGER NOT NULL CHECK (queue_attempt >= 1),
    lease_owner TEXT NOT NULL,
    captured_posture_version INTEGER NOT NULL CHECK (captured_posture_version >= 1),
    artifact_claim_version INTEGER NOT NULL CHECK (artifact_claim_version >= 1),
    verifier_id TEXT NOT NULL CHECK (length(verifier_id) BETWEEN 3 AND 192),
    verifier_revision TEXT NOT NULL CHECK (length(verifier_revision) BETWEEN 1 AND 128),
    criteria_sha256 TEXT NOT NULL CHECK (
        length(criteria_sha256) = 64 AND criteria_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    resolved_at TEXT CHECK (resolved_at IS NULL OR unixepoch(resolved_at) IS NOT NULL),
    UNIQUE (task_id, run_id),
    FOREIGN KEY (task_id, tenant_id) REFERENCES work_queue_tasks(id, tenant_id),
    FOREIGN KEY (run_id) REFERENCES agent_runs(id),
    FOREIGN KEY (candidate_id) REFERENCES run_completion_candidates(candidate_id),
    FOREIGN KEY (artifact_claim_id) REFERENCES artifact_scope_claims(claim_id),
    FOREIGN KEY (source_claim_id) REFERENCES source_snapshot_claims(source_claim_id),
    CHECK (resolved_at IS NULL OR resolved_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_queue_verification_holds_active_scope
    ON work_queue_verification_holds (artifact_scope_key)
    WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_work_queue_verification_holds_task
    ON work_queue_verification_holds (tenant_id, task_id, resolved_at);

CREATE TRIGGER IF NOT EXISTS artifact_scope_claims_validate_binding
BEFORE INSERT ON artifact_scope_claims
WHEN NOT EXISTS (
    SELECT 1
    FROM work_queue_tasks AS task
    JOIN agent_runs AS run ON run.id = NEW.run_id
    WHERE task.id = NEW.task_id
      AND task.tenant_id = NEW.tenant_id
      AND task.payload_kind = 'automation'
      AND json_extract(task.payload_json, '$.automationId') = NEW.automation_id
      AND task.version = NEW.captured_queue_version
      AND task.state = 'leased'
      AND run.client_id = NEW.tenant_id
      AND run.automation = NEW.automation_id
      AND run.status = 'running'
)
BEGIN
    SELECT RAISE(ABORT, 'artifact claim binding mismatch');
END;

CREATE TRIGGER IF NOT EXISTS artifact_scope_claims_immutable_ownership
BEFORE UPDATE ON artifact_scope_claims
WHEN
    OLD.claim_id IS NOT NEW.claim_id OR
    OLD.artifact_scope_key IS NOT NEW.artifact_scope_key OR
    OLD.tenant_id IS NOT NEW.tenant_id OR
    OLD.automation_id IS NOT NEW.automation_id OR
    OLD.task_id IS NOT NEW.task_id OR
    OLD.run_id IS NOT NEW.run_id OR
    OLD.captured_queue_version IS NOT NEW.captured_queue_version OR
    OLD.acquired_at IS NOT NEW.acquired_at
BEGIN
    SELECT RAISE(ABORT, 'artifact scope claim ownership is immutable');
END;

CREATE TRIGGER IF NOT EXISTS artifact_scope_claims_guard_transition
BEFORE UPDATE ON artifact_scope_claims
WHEN NOT (
    OLD.state = 'executing' AND
    NEW.state = 'verification_pending' AND
    NEW.version = OLD.version + 1 AND
    NEW.updated_at >= OLD.updated_at AND
    NEW.terminal_at IS NULL AND
    NEW.terminal_evidence_kind IS NULL AND
    NEW.terminal_evidence_id IS NULL AND
    NEW.terminal_evidence_sha256 IS NULL AND
    EXISTS (
        SELECT 1
        FROM work_queue_verification_holds AS hold
        JOIN run_completion_candidates AS candidate
          ON candidate.candidate_id = hold.candidate_id
        WHERE hold.resolved_at IS NULL
          AND hold.artifact_claim_id = OLD.claim_id
          AND hold.artifact_scope_key = OLD.artifact_scope_key
          AND hold.task_id = OLD.task_id
          AND hold.run_id = OLD.run_id
          AND hold.tenant_id = OLD.tenant_id
          AND hold.automation_id = OLD.automation_id
          AND hold.artifact_claim_version = OLD.version
          AND candidate.artifact_claim_id = OLD.claim_id
    )
)
BEGIN
    SELECT RAISE(ABORT, 'artifact scope claim transition requires an exact verification hold');
END;

CREATE TRIGGER IF NOT EXISTS artifact_scope_claims_no_delete
BEFORE DELETE ON artifact_scope_claims
BEGIN
    SELECT RAISE(ABORT, 'artifact scope claims are append-only ownership records');
END;

CREATE TRIGGER IF NOT EXISTS source_snapshot_claims_validate_binding
BEFORE INSERT ON source_snapshot_claims
WHEN NOT EXISTS (
    SELECT 1
    FROM artifact_scope_claims AS claim
    WHERE claim.claim_id = NEW.artifact_claim_id
      AND claim.task_id = NEW.task_id
      AND claim.run_id = NEW.run_id
      AND claim.tenant_id = NEW.tenant_id
      AND claim.automation_id = NEW.automation_id
      AND claim.state = 'executing'
)
BEGIN
    SELECT RAISE(ABORT, 'source snapshot binding mismatch');
END;

CREATE TRIGGER IF NOT EXISTS source_snapshot_claims_no_update
BEFORE UPDATE ON source_snapshot_claims
BEGIN
    SELECT RAISE(ABORT, 'source snapshot claims are append-only');
END;

CREATE TRIGGER IF NOT EXISTS source_snapshot_claims_no_delete
BEFORE DELETE ON source_snapshot_claims
BEGIN
    SELECT RAISE(ABORT, 'source snapshot claims are append-only');
END;

CREATE TRIGGER IF NOT EXISTS run_completion_candidates_validate_binding
BEFORE INSERT ON run_completion_candidates
WHEN NOT EXISTS (
    SELECT 1
    FROM artifact_scope_claims AS claim
    JOIN source_snapshot_claims AS source
      ON source.source_claim_id = NEW.source_claim_id
    JOIN work_queue_tasks AS task
      ON task.id = NEW.task_id AND task.tenant_id = NEW.tenant_id
    JOIN agent_runs AS run ON run.id = NEW.run_id
    WHERE claim.claim_id = NEW.artifact_claim_id
      AND claim.artifact_scope_key = NEW.artifact_scope_key
      AND claim.task_id = NEW.task_id
      AND claim.run_id = NEW.run_id
      AND claim.tenant_id = NEW.tenant_id
      AND claim.automation_id = NEW.automation_id
      AND claim.state = 'executing'
      AND source.artifact_claim_id = claim.claim_id
      AND source.task_id = NEW.task_id
      AND source.run_id = NEW.run_id
      AND source.tenant_id = NEW.tenant_id
      AND source.automation_id = NEW.automation_id
      AND source.source_sha256 = NEW.source_sha256
      AND task.payload_kind = 'automation'
      AND json_extract(task.payload_json, '$.automationId') = NEW.automation_id
      AND task.state = 'leased'
      AND (
          (task.source_kind = 'api' AND NEW.occurrence_id IS NULL) OR
          (task.source_kind = 'schedule' AND NEW.occurrence_id = task.source_id)
      )
      AND run.client_id = NEW.tenant_id
      AND run.automation = NEW.automation_id
      AND run.status = 'running'
)
BEGIN
    SELECT RAISE(ABORT, 'completion candidate binding mismatch');
END;

CREATE TRIGGER IF NOT EXISTS run_completion_candidates_no_update
BEFORE UPDATE ON run_completion_candidates
BEGIN
    SELECT RAISE(ABORT, 'run completion candidates are append-only');
END;

CREATE TRIGGER IF NOT EXISTS run_completion_candidates_no_delete
BEFORE DELETE ON run_completion_candidates
BEGIN
    SELECT RAISE(ABORT, 'run completion candidates are append-only');
END;

CREATE TRIGGER IF NOT EXISTS work_queue_verification_holds_validate_binding
BEFORE INSERT ON work_queue_verification_holds
WHEN NOT EXISTS (
    SELECT 1
    FROM run_completion_candidates AS candidate
    JOIN artifact_scope_claims AS claim
      ON claim.claim_id = NEW.artifact_claim_id
    JOIN source_snapshot_claims AS source
      ON source.source_claim_id = NEW.source_claim_id
    JOIN work_queue_tasks AS task
      ON task.id = NEW.task_id AND task.tenant_id = NEW.tenant_id
    JOIN agent_runs AS run ON run.id = NEW.run_id
    JOIN agency_execution_posture AS posture ON posture.singleton_id = 'agency'
    WHERE candidate.candidate_id = NEW.candidate_id
      AND candidate.task_id = NEW.task_id
      AND candidate.run_id = NEW.run_id
      AND candidate.tenant_id = NEW.tenant_id
      AND candidate.automation_id = NEW.automation_id
      AND candidate.execution_request_id = NEW.execution_request_id
      AND candidate.occurrence_id IS NEW.occurrence_id
      AND candidate.artifact_claim_id = NEW.artifact_claim_id
      AND candidate.artifact_scope_key = NEW.artifact_scope_key
      AND candidate.source_claim_id = NEW.source_claim_id
      AND candidate.criteria_sha256 = NEW.criteria_sha256
      AND candidate.captured_posture_version = NEW.captured_posture_version
      AND claim.artifact_scope_key = NEW.artifact_scope_key
      AND claim.task_id = NEW.task_id
      AND claim.run_id = NEW.run_id
      AND claim.tenant_id = NEW.tenant_id
      AND claim.automation_id = NEW.automation_id
      AND claim.version = NEW.artifact_claim_version
      AND claim.state = 'executing'
      AND source.artifact_claim_id = claim.claim_id
      AND task.state = 'leased'
      AND task.version = NEW.leased_version
      AND task.attempt_count = NEW.queue_attempt
      AND task.lease_owner = NEW.lease_owner
      AND task.lease_expires_at > NEW.created_at
      AND run.status = 'running'
      AND posture.version = NEW.captured_posture_version
      AND posture.posture = 'active'
)
BEGIN
    SELECT RAISE(ABORT, 'verification hold binding mismatch');
END;

CREATE TRIGGER IF NOT EXISTS work_queue_verification_holds_guard_update
BEFORE UPDATE ON work_queue_verification_holds
WHEN
    OLD.hold_id IS NOT NEW.hold_id OR
    OLD.candidate_id IS NOT NEW.candidate_id OR
    OLD.task_id IS NOT NEW.task_id OR
    OLD.run_id IS NOT NEW.run_id OR
    OLD.tenant_id IS NOT NEW.tenant_id OR
    OLD.automation_id IS NOT NEW.automation_id OR
    OLD.execution_request_id IS NOT NEW.execution_request_id OR
    OLD.occurrence_id IS NOT NEW.occurrence_id OR
    OLD.artifact_claim_id IS NOT NEW.artifact_claim_id OR
    OLD.artifact_scope_key IS NOT NEW.artifact_scope_key OR
    OLD.source_claim_id IS NOT NEW.source_claim_id OR
    OLD.leased_version IS NOT NEW.leased_version OR
    OLD.queue_attempt IS NOT NEW.queue_attempt OR
    OLD.lease_owner IS NOT NEW.lease_owner OR
    OLD.captured_posture_version IS NOT NEW.captured_posture_version OR
    OLD.artifact_claim_version IS NOT NEW.artifact_claim_version OR
    OLD.verifier_id IS NOT NEW.verifier_id OR
    OLD.verifier_revision IS NOT NEW.verifier_revision OR
    OLD.criteria_sha256 IS NOT NEW.criteria_sha256 OR
    OLD.created_at IS NOT NEW.created_at OR
    OLD.resolved_at IS NOT NULL OR
    NEW.resolved_at IS NULL
BEGIN
    SELECT RAISE(ABORT, 'verification hold bindings are immutable');
END;

CREATE TRIGGER IF NOT EXISTS work_queue_verification_holds_no_delete
BEFORE DELETE ON work_queue_verification_holds
BEGIN
    SELECT RAISE(ABORT, 'verification holds are append-only');
END;

CREATE TRIGGER IF NOT EXISTS work_queue_tasks_hold_fence
BEFORE UPDATE ON work_queue_tasks
WHEN EXISTS (
    SELECT 1
    FROM work_queue_verification_holds AS hold
    WHERE hold.task_id = OLD.id
      AND hold.tenant_id = OLD.tenant_id
      AND hold.resolved_at IS NULL
) AND (
    OLD.state IS NOT NEW.state OR
    OLD.version IS NOT NEW.version OR
    OLD.lease_owner IS NOT NEW.lease_owner OR
    OLD.lease_token IS NOT NEW.lease_token OR
    OLD.lease_expires_at IS NOT NEW.lease_expires_at OR
    OLD.attempt_count IS NOT NEW.attempt_count
)
BEGIN
    SELECT RAISE(ABORT, 'queue task has an unresolved verification hold');
END;
