CREATE TABLE IF NOT EXISTS agent_blueprints (
    blueprint_id TEXT NOT NULL
        CHECK (
            length(blueprint_id) BETWEEN 3 AND 64 AND
            substr(blueprint_id, 1, 1) GLOB '[a-z]' AND
            blueprint_id NOT GLOB '*[^a-z0-9_-]*'
        ),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
    previous_revision INTEGER,
    config_json TEXT NOT NULL CHECK (json_valid(config_json) AND json_type(config_json) = 'object'),
    config_sha256 TEXT NOT NULL
        CHECK (length(config_sha256) = 64 AND config_sha256 NOT GLOB '*[^a-f0-9]*'),
    implementation_id TEXT NOT NULL
        CHECK (
            length(implementation_id) BETWEEN 3 AND 64 AND
            substr(implementation_id, 1, 1) GLOB '[a-z]' AND
            implementation_id NOT GLOB '*[^a-z0-9_-]*'
        ),
    implementation_digest TEXT NOT NULL
        CHECK (
            length(implementation_digest) = 64 AND
            implementation_digest NOT GLOB '*[^a-f0-9]*'
        ),
    proposer_id TEXT NOT NULL CHECK (length(proposer_id) BETWEEN 3 AND 128),
    proposer_kind TEXT NOT NULL CHECK (proposer_kind IN ('human', 'agent', 'research_feed')),
    state TEXT NOT NULL CHECK (state IN (
        'proposed', 'sandboxed', 'evaluated', 'awaiting_approval', 'shadow', 'canary',
        'active', 'rejected', 'rolled_back', 'retired'
    )),
    state_version INTEGER NOT NULL CHECK (state_version >= 1),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
    PRIMARY KEY (blueprint_id, revision),
    UNIQUE (blueprint_id, revision, state_version),
    FOREIGN KEY (blueprint_id, previous_revision)
        REFERENCES agent_blueprints(blueprint_id, revision),
    CHECK (json_extract(config_json, '$.blueprintId') = blueprint_id),
    CHECK (json_extract(config_json, '$.revision') = revision),
    CHECK (json_extract(config_json, '$.previousRevision') IS previous_revision),
    CHECK (json_extract(config_json, '$.implementationDigest') = implementation_digest),
    CHECK (
        (revision = 1 AND previous_revision IS NULL) OR
        (revision > 1 AND previous_revision = revision - 1)
    )
);

CREATE TABLE IF NOT EXISTS agent_blueprint_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    blueprint_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    from_state TEXT CHECK (from_state IS NULL OR from_state IN (
        'proposed', 'sandboxed', 'evaluated', 'awaiting_approval', 'shadow', 'canary',
        'active', 'rejected', 'rolled_back', 'retired'
    )),
    to_state TEXT NOT NULL CHECK (to_state IN (
        'proposed', 'sandboxed', 'evaluated', 'awaiting_approval', 'shadow', 'canary',
        'active', 'rejected', 'rolled_back', 'retired'
    )),
    state_version INTEGER NOT NULL CHECK (state_version >= 1),
    actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 3 AND 128),
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system', 'research_feed')),
    decision_code TEXT NOT NULL CHECK (decision_code IN (
        'proposal_recorded', 'stage_evidence_recorded', 'gate_passed', 'operator_approved',
        'operator_rejected', 'operator_rollback', 'operator_retired',
        'automatic_gate_rollback'
    )),
    reason_code TEXT CHECK (reason_code IS NULL OR reason_code IN (
        'operator_rejected', 'operator_rollback', 'operator_retired', 'automatic_gate_failure',
        'policy_violation', 'scope_violation', 'budget_breach', 'quality_regression',
        'economics_regression'
    )),
    evidence_digest TEXT NOT NULL
        CHECK (length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^a-f0-9]*'),
    gate_decision_json TEXT
        CHECK (
            gate_decision_json IS NULL OR
            (json_valid(gate_decision_json) AND json_type(gate_decision_json) = 'object')
        ),
    policy_gate_json TEXT
        CHECK (
            policy_gate_json IS NULL OR
            (json_valid(policy_gate_json) AND json_type(policy_gate_json) = 'object')
        ),
    economics_gate_json TEXT
        CHECK (
            economics_gate_json IS NULL OR
            (json_valid(economics_gate_json) AND json_type(economics_gate_json) = 'object')
        ),
    observed_at TEXT NOT NULL CHECK (unixepoch(observed_at) IS NOT NULL),
    UNIQUE (blueprint_id, revision, state_version),
    FOREIGN KEY (blueprint_id, revision)
        REFERENCES agent_blueprints(blueprint_id, revision),
    CHECK (
        (decision_code IN (
            'proposal_recorded', 'stage_evidence_recorded', 'gate_passed', 'operator_approved'
        ) AND reason_code IS NULL) OR
        (decision_code NOT IN (
            'proposal_recorded', 'stage_evidence_recorded', 'gate_passed', 'operator_approved'
        ) AND reason_code IS NOT NULL)
    ),
    CHECK (
        (to_state = 'proposed' AND decision_code = 'proposal_recorded') OR
        (to_state = 'sandboxed' AND decision_code = 'stage_evidence_recorded') OR
        (to_state IN ('evaluated', 'awaiting_approval', 'canary', 'active') AND
            decision_code = 'gate_passed') OR
        (to_state = 'shadow' AND decision_code = 'operator_approved') OR
        (to_state = 'rejected' AND decision_code = 'operator_rejected') OR
        (to_state = 'rolled_back' AND decision_code IN (
            'operator_rollback', 'automatic_gate_rollback'
        )) OR
        (to_state = 'retired' AND decision_code = 'operator_retired')
    )
);

CREATE INDEX IF NOT EXISTS idx_agent_blueprints_state
    ON agent_blueprints (state, updated_at DESC, blueprint_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_agent_blueprint_events_revision
    ON agent_blueprint_events (blueprint_id, revision, sequence);

CREATE TRIGGER IF NOT EXISTS agent_blueprint_configuration_immutable
BEFORE UPDATE ON agent_blueprints
WHEN
    OLD.blueprint_id IS NOT NEW.blueprint_id OR
    OLD.revision IS NOT NEW.revision OR
    OLD.previous_revision IS NOT NEW.previous_revision OR
    OLD.config_json IS NOT NEW.config_json OR
    OLD.config_sha256 IS NOT NEW.config_sha256 OR
    OLD.implementation_id IS NOT NEW.implementation_id OR
    OLD.implementation_digest IS NOT NEW.implementation_digest OR
    OLD.proposer_id IS NOT NEW.proposer_id OR
    OLD.proposer_kind IS NOT NEW.proposer_kind OR
    OLD.created_at IS NOT NEW.created_at
BEGIN
    SELECT RAISE(ABORT, 'agent blueprint configuration is immutable');
END;

CREATE TRIGGER IF NOT EXISTS agent_blueprint_state_transition
BEFORE UPDATE ON agent_blueprints
WHEN
    (
        OLD.state IS NOT NEW.state OR
        OLD.state_version IS NOT NEW.state_version OR
        OLD.updated_at IS NOT NEW.updated_at
    ) AND (
        NEW.state_version <> OLD.state_version + 1 OR
        julianday(NEW.updated_at) < julianday(OLD.updated_at) OR
        NOT (
            (OLD.state = 'proposed' AND NEW.state IN ('sandboxed', 'rejected')) OR
            (OLD.state = 'sandboxed' AND NEW.state IN ('evaluated', 'rejected', 'rolled_back')) OR
            (OLD.state = 'evaluated' AND NEW.state IN ('awaiting_approval', 'rejected', 'rolled_back')) OR
            (OLD.state = 'awaiting_approval' AND NEW.state IN ('shadow', 'rejected', 'rolled_back')) OR
            (OLD.state = 'shadow' AND NEW.state IN ('canary', 'rolled_back')) OR
            (OLD.state = 'canary' AND NEW.state IN ('active', 'rolled_back')) OR
            (OLD.state = 'active' AND NEW.state IN ('rolled_back', 'retired'))
        )
    )
BEGIN
    SELECT RAISE(ABORT, 'invalid agent blueprint state transition');
END;

CREATE TRIGGER IF NOT EXISTS agent_blueprint_event_matches_checkpoint
BEFORE INSERT ON agent_blueprint_events
WHEN
    (
        NEW.from_state IS NULL AND NOT (
            NEW.to_state = 'proposed' AND
            NEW.state_version = 1 AND
            NEW.decision_code = 'proposal_recorded' AND
            EXISTS (
                SELECT 1
                FROM agent_blueprints AS blueprint
                WHERE
                    blueprint.blueprint_id = NEW.blueprint_id AND
                    blueprint.revision = NEW.revision AND
                    blueprint.state = 'proposed' AND
                    blueprint.state_version = 1
            )
        )
    ) OR (
        NEW.from_state IS NOT NULL AND NOT (
            EXISTS (
                SELECT 1
                FROM agent_blueprints AS blueprint
                WHERE
                    blueprint.blueprint_id = NEW.blueprint_id AND
                    blueprint.revision = NEW.revision AND
                    blueprint.state = NEW.from_state AND
                    blueprint.state_version = NEW.state_version - 1
            ) AND (
                (NEW.from_state = 'proposed' AND NEW.to_state IN ('sandboxed', 'rejected')) OR
                (NEW.from_state = 'sandboxed' AND NEW.to_state IN ('evaluated', 'rejected', 'rolled_back')) OR
                (NEW.from_state = 'evaluated' AND NEW.to_state IN ('awaiting_approval', 'rejected', 'rolled_back')) OR
                (NEW.from_state = 'awaiting_approval' AND NEW.to_state IN ('shadow', 'rejected', 'rolled_back')) OR
                (NEW.from_state = 'shadow' AND NEW.to_state IN ('canary', 'rolled_back')) OR
                (NEW.from_state = 'canary' AND NEW.to_state IN ('active', 'rolled_back')) OR
                (NEW.from_state = 'active' AND NEW.to_state IN ('rolled_back', 'retired'))
            )
        )
    )
BEGIN
    SELECT RAISE(ABORT, 'agent blueprint event does not match current checkpoint');
END;

CREATE TRIGGER IF NOT EXISTS agent_blueprint_event_authority
BEFORE INSERT ON agent_blueprint_events
WHEN
    (NEW.from_state IS NOT NULL AND NEW.actor_kind NOT IN ('human', 'system')) OR
    (NEW.decision_code IN (
        'operator_approved', 'operator_rejected', 'operator_rollback', 'operator_retired'
    ) AND NEW.actor_kind <> 'human') OR
    (NEW.decision_code = 'gate_passed' AND NEW.actor_kind <> 'system') OR
    (NEW.decision_code = 'automatic_gate_rollback' AND NEW.actor_kind <> 'system') OR
    (
        NEW.to_state = 'shadow' AND EXISTS (
            SELECT 1
            FROM agent_blueprints AS blueprint
            WHERE
                blueprint.blueprint_id = NEW.blueprint_id AND
                blueprint.revision = NEW.revision AND
                blueprint.proposer_id = NEW.actor_id
        )
    )
BEGIN
    SELECT RAISE(ABORT, 'agent blueprint event authority denied');
END;

CREATE TRIGGER IF NOT EXISTS agent_blueprint_transition_requires_event
BEFORE UPDATE ON agent_blueprints
WHEN
    (
        OLD.state IS NOT NEW.state OR
        OLD.state_version IS NOT NEW.state_version OR
        OLD.updated_at IS NOT NEW.updated_at
    ) AND NOT EXISTS (
        SELECT 1
        FROM agent_blueprint_events AS event
        WHERE
            event.blueprint_id = NEW.blueprint_id AND
            event.revision = NEW.revision AND
            event.from_state = OLD.state AND
            event.to_state = NEW.state AND
            event.state_version = NEW.state_version AND
            event.observed_at = NEW.updated_at
    )
BEGIN
    SELECT RAISE(ABORT, 'agent blueprint transition requires matching audit evidence');
END;

CREATE TRIGGER IF NOT EXISTS agent_blueprint_delete_forbidden
BEFORE DELETE ON agent_blueprints
BEGIN
    SELECT RAISE(ABORT, 'agent blueprint configuration is immutable');
END;

CREATE TRIGGER IF NOT EXISTS agent_blueprint_events_update_forbidden
BEFORE UPDATE ON agent_blueprint_events
BEGIN
    SELECT RAISE(ABORT, 'agent blueprint events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS agent_blueprint_events_delete_forbidden
BEFORE DELETE ON agent_blueprint_events
BEGIN
    SELECT RAISE(ABORT, 'agent blueprint events are append-only');
END;
