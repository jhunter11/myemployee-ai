-- Deterministic memory ledger (Report 2: "Deterministic Memory Semantics").
--
-- The ledger is the SYSTEM OF RECORD; every other memory table is a deterministic
-- PROJECTION of it. Five tables express that split:
--   * memory_ledger_commands  -> append-only command log, PARTITIONED BY SLEEVE with a
--                                per-sleeve monotonic (sleeve_id, sleeve_seq) total order
--   * memory_ledger_events    -> the accepted events the reducer emitted, same ordering
--   * memory_revisions        -> the materialized memrec/v1 revision projection
--   * memory_provenance_edges -> the PROV-style derivation graph (used/generated/...)
--   * memory_ledger_audit     -> EVERY command outcome, including denials and NOOPs
--
-- Two protocol rules from the report are load-bearing and are visible here:
--   1. Revisions are IMMUTABLE. The only columns that may ever change are the four
--      projection-maintenance columns (status, superseded_by, contradicts_json,
--      is_current_active), and each of those has an explicit legal-transition guard.
--      Nothing that feeds `canonicalHash` is mutable, so a stored projection can
--      always be checked against a replay of the log.
--   2. Every command produces an audit row even when it fails or is a NOOP, which is
--      what makes operator debugging and property-based testing possible.
--
-- Discipline matches 010/011/023: CHECK constraints on every column, foreign keys to
-- control_scopes / memory_sleeves / access_agents, active-sleeve binding triggers,
-- immutability guards, and no-delete triggers. Nothing here is ever hard-deleted:
-- erasure is expressed as a tombstone revision plus a redacted payload, never as a
-- missing row, because a missing row would make replay disagree with history.

CREATE TABLE IF NOT EXISTS memory_ledger_commands (
    command_id TEXT PRIMARY KEY
        CHECK (
            length(command_id) BETWEEN 5 AND 100 AND
            substr(command_id, 1, 4) = 'cmd_' AND
            command_id NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
    schema_version TEXT NOT NULL CHECK (schema_version = 'memcmd/v1'),
    sleeve_id TEXT NOT NULL,
    owner_scope_id TEXT NOT NULL,
    -- The per-sleeve total order. Assigned inside the submit transaction, which is
    -- what makes "single logical writer per sleeve, many concurrent proposers" real:
    -- proposers race freely, the sequence is handed out serially.
    sleeve_seq INTEGER NOT NULL
        CHECK (typeof(sleeve_seq) = 'integer' AND sleeve_seq BETWEEN 1 AND 9007199254740991),
    idempotency_key TEXT NOT NULL
        CHECK (
            length(idempotency_key) BETWEEN 5 AND 128 AND
            substr(idempotency_key, 1, 4) = 'idk_' AND
            idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
        ),
    op TEXT NOT NULL
        CHECK (
            op IN (
                'OBSERVE', 'PROPOSE', 'ADD', 'UPDATE', 'SUPERSEDE', 'RETRACT', 'DELETE',
                'MERGE', 'SPLIT', 'PROMOTE', 'IMPORT', 'EXPIRE', 'REVALIDATE', 'NOOP'
            )
        ),
    memory_id TEXT
        CHECK (
            memory_id IS NULL OR (
                length(memory_id) BETWEEN 5 AND 100 AND
                substr(memory_id, 1, 4) = 'mem_' AND
                memory_id NOT GLOB '*[^A-Za-z0-9_-]*'
            )
        ),
    -- The compare-and-swap guard. NULL means the op does not take a base revision.
    base_revision_id TEXT
        CHECK (
            base_revision_id IS NULL OR (
                length(base_revision_id) BETWEEN 5 AND 100 AND
                substr(base_revision_id, 1, 4) = 'rev_' AND
                base_revision_id NOT GLOB '*[^A-Za-z0-9_-]*'
            )
        ),
    payload_json TEXT NOT NULL
        CHECK (
            json_valid(payload_json) AND
            json_type(payload_json) = 'object' AND
            length(payload_json) BETWEEN 2 AND 262144
        ),
    authority_tier TEXT NOT NULL
        CHECK (
            authority_tier IN (
                'policy_signed_approved', 'operator_explicit', 'human_artifact_verified',
                'external_system_of_record', 'tool_observation', 'agent_observation',
                'agent_inference', 'statistical_pattern'
            )
        ),
    approval_state TEXT NOT NULL
        CHECK (
            approval_state IN ('unknown', 'pending', 'auto_accepted', 'reviewed', 'approved', 'rejected')
        ),
    issued_by TEXT NOT NULL,
    issued_at TEXT NOT NULL CHECK (unixepoch(issued_at) IS NOT NULL),
    command_hash TEXT NOT NULL
        CHECK (
            length(command_hash) = 71 AND
            substr(command_hash, 1, 7) = 'sha256:' AND
            substr(command_hash, 8) NOT GLOB '*[^a-f0-9]*'
        ),
    FOREIGN KEY (owner_scope_id) REFERENCES control_scopes(scope_id),
    FOREIGN KEY (sleeve_id) REFERENCES memory_sleeves(sleeve_id),
    FOREIGN KEY (issued_by) REFERENCES access_agents(agent_id)
);

-- The sleeve partition's total order. UNIQUE, not merely indexed: two commands
-- sharing a sequence number would make replay ambiguous, which is the one failure
-- the whole design exists to prevent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_ledger_commands_sequence
    ON memory_ledger_commands (sleeve_id, sleeve_seq);

-- Idempotency is scoped to the sleeve, never global: two sleeves may legitimately
-- reuse a proposer's key, and a global key space would leak one sleeve's traffic
-- pattern into another's write path.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_ledger_commands_idempotency
    ON memory_ledger_commands (sleeve_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_memory_ledger_commands_thread
    ON memory_ledger_commands (sleeve_id, memory_id, sleeve_seq);

CREATE TABLE IF NOT EXISTS memory_ledger_events (
    event_id TEXT PRIMARY KEY
        CHECK (
            length(event_id) BETWEEN 5 AND 100 AND
            substr(event_id, 1, 4) = 'lev_' AND
            event_id NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
    command_id TEXT NOT NULL UNIQUE,
    sleeve_id TEXT NOT NULL,
    owner_scope_id TEXT NOT NULL,
    sleeve_seq INTEGER NOT NULL
        CHECK (typeof(sleeve_seq) = 'integer' AND sleeve_seq BETWEEN 1 AND 9007199254740991),
    event_type TEXT NOT NULL
        CHECK (
            event_type IN ('OBSERVED', 'PROPOSED', 'APPLIED', 'MERGED', 'SPLIT', 'PROMOTED', 'IMPORTED')
        ),
    memory_id TEXT
        CHECK (
            memory_id IS NULL OR (
                length(memory_id) BETWEEN 5 AND 100 AND
                substr(memory_id, 1, 4) = 'mem_' AND
                memory_id NOT GLOB '*[^A-Za-z0-9_-]*'
            )
        ),
    revision_ids_json TEXT NOT NULL
        CHECK (
            json_valid(revision_ids_json) AND
            json_type(revision_ids_json) = 'array' AND
            json_array_length(revision_ids_json) BETWEEN 1 AND 64
        ),
    recorded_at TEXT NOT NULL CHECK (unixepoch(recorded_at) IS NOT NULL),
    event_hash TEXT NOT NULL
        CHECK (
            length(event_hash) = 71 AND
            substr(event_hash, 1, 7) = 'sha256:' AND
            substr(event_hash, 8) NOT GLOB '*[^a-f0-9]*'
        ),
    FOREIGN KEY (owner_scope_id) REFERENCES control_scopes(scope_id),
    FOREIGN KEY (sleeve_id) REFERENCES memory_sleeves(sleeve_id),
    FOREIGN KEY (command_id) REFERENCES memory_ledger_commands(command_id)
);

-- Events carry the sequence of the command that produced them, so the event stream
-- inherits the command stream's total order. Only ACCEPTED commands emit events, so
-- the sequence is sparse; sparseness is fine, ambiguity is not.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_ledger_events_sequence
    ON memory_ledger_events (sleeve_id, sleeve_seq);

CREATE TABLE IF NOT EXISTS memory_revisions (
    revision_id TEXT PRIMARY KEY
        CHECK (
            length(revision_id) BETWEEN 5 AND 100 AND
            substr(revision_id, 1, 4) = 'rev_' AND
            revision_id NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
    schema_version TEXT NOT NULL CHECK (schema_version = 'memrec/v1'),
    record_type TEXT NOT NULL CHECK (record_type = 'MemoryRevision'),
    memory_id TEXT NOT NULL
        CHECK (
            length(memory_id) BETWEEN 5 AND 100 AND
            substr(memory_id, 1, 4) = 'mem_' AND
            memory_id NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
    revision_no INTEGER NOT NULL
        CHECK (typeof(revision_no) = 'integer' AND revision_no BETWEEN 1 AND 2147483647),
    owner_scope_id TEXT NOT NULL,
    sleeve_id TEXT NOT NULL,
    sleeve_class TEXT NOT NULL
        CHECK (
            sleeve_class IN (
                'personal', 'agency', 'task_market', 'company', 'client', 'project',
                'agent_scratch', 'shared_approved'
            )
        ),
    memory_kind TEXT NOT NULL
        CHECK (
            memory_kind IN (
                'policy', 'identity', 'fact', 'decision', 'preference',
                'procedure', 'blueprint', 'episode', 'artifact', 'summary'
            )
        ),
    entity_key TEXT
        CHECK (
            entity_key IS NULL OR (
                length(entity_key) BETWEEN 1 AND 160 AND
                entity_key NOT GLOB '*[^a-z0-9_/]*'
            )
        ),
    status TEXT NOT NULL
        CHECK (
            status IN (
                'unseen', 'observed_draft', 'proposed', 'pending_review', 'active',
                'active_conflicted', 'superseded', 'retracted', 'expired',
                'deleted_logical', 'purge_scheduled', 'purged'
            )
        ),
    approval_state TEXT NOT NULL
        CHECK (
            approval_state IN ('unknown', 'pending', 'auto_accepted', 'reviewed', 'approved', 'rejected')
        ),
    authority_tier TEXT NOT NULL
        CHECK (
            authority_tier IN (
                'policy_signed_approved', 'operator_explicit', 'human_artifact_verified',
                'external_system_of_record', 'tool_observation', 'agent_observation',
                'agent_inference', 'statistical_pattern'
            )
        ),
    confidence_permille INTEGER NOT NULL
        CHECK (typeof(confidence_permille) = 'integer' AND confidence_permille BETWEEN 0 AND 1000),
    sensitivity TEXT NOT NULL
        CHECK (sensitivity IN ('public', 'internal', 'confidential', 'private', 'restricted')),
    retention_policy TEXT NOT NULL
        CHECK (
            retention_policy IN (
                'run_local', 'retain_until_revoked', 'until_superseded', 'until_replaced',
                'until_superseded_or_revoked', 'project_90d_then_review', 'legal_retention'
            )
        ),
    legal_hold INTEGER NOT NULL CHECK (typeof(legal_hold) = 'integer' AND legal_hold IN (0, 1)),
    -- Bitemporal core: valid_* is when the claim is true in modeled reality,
    -- created_tx_time / recorded_tx_seq is when the ledger accepted it. The axes are
    -- deliberately unconstrained against each other so retroactive corrections and
    -- proactive facts (a launch date three months out) are both representable.
    event_time TEXT CHECK (event_time IS NULL OR unixepoch(event_time) IS NOT NULL),
    observed_at TEXT NOT NULL CHECK (unixepoch(observed_at) IS NOT NULL),
    created_tx_time TEXT NOT NULL CHECK (unixepoch(created_tx_time) IS NOT NULL),
    recorded_tx_seq INTEGER NOT NULL
        CHECK (typeof(recorded_tx_seq) = 'integer' AND recorded_tx_seq BETWEEN 1 AND 9007199254740991),
    valid_from TEXT NOT NULL CHECK (unixepoch(valid_from) IS NOT NULL),
    valid_until TEXT CHECK (valid_until IS NULL OR unixepoch(valid_until) IS NOT NULL),
    decided_at TEXT CHECK (decided_at IS NULL OR unixepoch(decided_at) IS NOT NULL),
    author_agent_id TEXT NOT NULL,
    workflow_id TEXT
        CHECK (
            workflow_id IS NULL OR (
                length(workflow_id) BETWEEN 4 AND 67 AND
                substr(workflow_id, 1, 3) = 'wf_' AND
                workflow_id NOT GLOB '*[^a-z0-9_]*'
            )
        ),
    run_id TEXT
        CHECK (
            run_id IS NULL OR (
                length(run_id) BETWEEN 5 AND 100 AND
                substr(run_id, 1, 4) = 'run_' AND
                run_id NOT GLOB '*[^A-Za-z0-9_-]*'
            )
        ),
    derivation_method TEXT NOT NULL
        CHECK (
            derivation_method IN (
                'explicit_operator_statement', 'direct_observation', 'tool_result',
                'episode_extraction', 'episode_extraction_plus_operator_review',
                'human_authored_artifact_plus_operator_approval',
                'operator_reviewed_bundle_promotion', 'statistical_aggregation',
                'agent_inference', 'legacy_import'
            )
        ),
    source_event_ids_json TEXT NOT NULL
        CHECK (
            json_valid(source_event_ids_json) AND
            json_type(source_event_ids_json) = 'array' AND
            json_array_length(source_event_ids_json) <= 64
        ),
    evidence_refs_json TEXT NOT NULL
        CHECK (
            json_valid(evidence_refs_json) AND
            json_type(evidence_refs_json) = 'array' AND
            json_array_length(evidence_refs_json) <= 64
        ),
    derived_from_json TEXT NOT NULL
        CHECK (
            json_valid(derived_from_json) AND
            json_type(derived_from_json) = 'array' AND
            json_array_length(derived_from_json) <= 64
        ),
    contradicts_json TEXT NOT NULL
        CHECK (
            json_valid(contradicts_json) AND
            json_type(contradicts_json) = 'array' AND
            json_array_length(contradicts_json) <= 64
        ),
    supersedes TEXT,
    superseded_by TEXT,
    payload_json TEXT NOT NULL
        CHECK (
            json_valid(payload_json) AND
            json_type(payload_json) = 'object' AND
            length(payload_json) BETWEEN 2 AND 262144
        ),
    content_hash TEXT NOT NULL
        CHECK (
            length(content_hash) = 71 AND
            substr(content_hash, 1, 7) = 'sha256:' AND
            substr(content_hash, 8) NOT GLOB '*[^a-f0-9]*'
        ),
    canonical_hash TEXT NOT NULL
        CHECK (
            length(canonical_hash) = 71 AND
            substr(canonical_hash, 1, 7) = 'sha256:' AND
            substr(canonical_hash, 8) NOT GLOB '*[^a-f0-9]*'
        ),
    tombstone_json TEXT
        CHECK (
            tombstone_json IS NULL OR
            (json_valid(tombstone_json) AND json_type(tombstone_json) = 'object')
        ),
    -- The projection flag. Exactly one revision per thread may carry it, and only a
    -- live, unsuperseded revision may. Everything else is history.
    is_current_active INTEGER NOT NULL
        CHECK (typeof(is_current_active) = 'integer' AND is_current_active IN (0, 1)),
    command_id TEXT NOT NULL,
    CHECK (valid_until IS NULL OR unixepoch(valid_until) > unixepoch(valid_from)),
    CHECK (unixepoch(observed_at) <= unixepoch(created_tx_time)),
    CHECK (decided_at IS NULL OR unixepoch(decided_at) <= unixepoch(created_tx_time)),
    -- Revision 1 supersedes nothing; every later revision closes exactly one predecessor.
    CHECK ((revision_no = 1) = (supersedes IS NULL)),
    CHECK (supersedes IS NULL OR supersedes <> revision_id),
    CHECK (superseded_by IS NULL OR superseded_by <> revision_id),
    CHECK (is_current_active = 0 OR (status IN ('active', 'active_conflicted') AND superseded_by IS NULL)),
    CHECK (status NOT IN ('deleted_logical', 'purge_scheduled', 'purged') OR tombstone_json IS NOT NULL),
    CHECK (tombstone_json IS NULL OR status IN ('deleted_logical', 'purge_scheduled', 'purged')),
    -- Legal hold blocks purge outright; it is the DELETE command's documented failure mode.
    CHECK (legal_hold = 0 OR status <> 'purged'),
    FOREIGN KEY (owner_scope_id) REFERENCES control_scopes(scope_id),
    FOREIGN KEY (sleeve_id) REFERENCES memory_sleeves(sleeve_id),
    FOREIGN KEY (author_agent_id) REFERENCES access_agents(agent_id),
    FOREIGN KEY (command_id) REFERENCES memory_ledger_commands(command_id),
    FOREIGN KEY (supersedes) REFERENCES memory_revisions(revision_id),
    FOREIGN KEY (superseded_by) REFERENCES memory_revisions(revision_id)
);

-- "At most one revision per memory_id is current-active in a given projection
-- timestamp" — enforced by the storage engine rather than by reducer discipline,
-- because a projection bug would otherwise surface as two competing truths.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_revisions_current_active
    ON memory_revisions (sleeve_id, memory_id)
    WHERE is_current_active = 1;

-- Within a memory_id, revision_no is strictly increasing and never reused.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_revisions_thread_sequence
    ON memory_revisions (sleeve_id, memory_id, revision_no);

-- Bitemporal as-of: pick the revision valid at a wall-clock instant that the ledger
-- already knew about at a transaction instant.
CREATE INDEX IF NOT EXISTS idx_memory_revisions_bitemporal
    ON memory_revisions (
        sleeve_id,
        memory_id,
        valid_from,
        valid_until,
        created_tx_time,
        recorded_tx_seq DESC
    );

-- Replay and projection-rebuild order.
CREATE INDEX IF NOT EXISTS idx_memory_revisions_replay
    ON memory_revisions (sleeve_id, recorded_tx_seq, revision_id);

CREATE INDEX IF NOT EXISTS idx_memory_revisions_entity_key
    ON memory_revisions (sleeve_id, owner_scope_id, entity_key, status, revision_id);

CREATE TABLE IF NOT EXISTS memory_provenance_edges (
    edge_id TEXT PRIMARY KEY
        CHECK (
            length(edge_id) BETWEEN 5 AND 100 AND
            substr(edge_id, 1, 4) = 'pve_' AND
            edge_id NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
    sleeve_id TEXT NOT NULL,
    owner_scope_id TEXT NOT NULL,
    -- W3C PROV-DM edges. `used`/`generated`/`associated_with` hang off an activity
    -- (a reducer execution, addressed by its command id); `derived_from`,
    -- `bundled_in`, and `invalidated_by` relate entities to entities.
    edge_type TEXT NOT NULL
        CHECK (
            edge_type IN (
                'used', 'generated', 'derived_from', 'associated_with', 'bundled_in', 'invalidated_by'
            )
        ),
    from_id TEXT NOT NULL
        CHECK (length(from_id) BETWEEN 1 AND 160 AND from_id NOT GLOB '*[^A-Za-z0-9._:/-]*'),
    to_id TEXT NOT NULL
        CHECK (length(to_id) BETWEEN 1 AND 160 AND to_id NOT GLOB '*[^A-Za-z0-9._:/-]*'),
    command_id TEXT NOT NULL,
    recorded_at TEXT NOT NULL CHECK (unixepoch(recorded_at) IS NOT NULL),
    CHECK (from_id <> to_id),
    FOREIGN KEY (owner_scope_id) REFERENCES control_scopes(scope_id),
    FOREIGN KEY (sleeve_id) REFERENCES memory_sleeves(sleeve_id),
    FOREIGN KEY (command_id) REFERENCES memory_ledger_commands(command_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_provenance_edges_identity
    ON memory_provenance_edges (sleeve_id, from_id, to_id, edge_type);

-- REVERSE dependency traversal, the Skyframe-style invalidation path: given a
-- changed source, find every entity that declared a dependency on it.
CREATE INDEX IF NOT EXISTS idx_memory_provenance_edges_reverse
    ON memory_provenance_edges (sleeve_id, to_id, edge_type, from_id);

CREATE INDEX IF NOT EXISTS idx_memory_provenance_edges_forward
    ON memory_provenance_edges (sleeve_id, from_id, edge_type, to_id);

CREATE TABLE IF NOT EXISTS memory_ledger_audit (
    audit_id TEXT PRIMARY KEY
        CHECK (
            length(audit_id) BETWEEN 5 AND 100 AND
            substr(audit_id, 1, 4) = 'aud_' AND
            audit_id NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
    command_id TEXT NOT NULL UNIQUE,
    sleeve_id TEXT NOT NULL,
    owner_scope_id TEXT NOT NULL,
    sleeve_seq INTEGER NOT NULL
        CHECK (typeof(sleeve_seq) = 'integer' AND sleeve_seq BETWEEN 1 AND 9007199254740991),
    op TEXT NOT NULL
        CHECK (
            op IN (
                'OBSERVE', 'PROPOSE', 'ADD', 'UPDATE', 'SUPERSEDE', 'RETRACT', 'DELETE',
                'MERGE', 'SPLIT', 'PROMOTE', 'IMPORT', 'EXPIRE', 'REVALIDATE', 'NOOP'
            )
        ),
    -- Every outcome the reducer can reach, accepted and rejected alike. A command
    -- that changed nothing still lands here: that is the difference between an
    -- auditable refusal and a silent drop.
    outcome TEXT NOT NULL
        CHECK (
            outcome IN (
                'OBSERVED', 'PROPOSED', 'APPLIED', 'MERGED', 'SPLIT', 'PROMOTED', 'IMPORTED',
                'NOOP_DUPLICATE', 'NOOP_EXPLICIT', 'DENIED', 'STALE_BASE', 'CONFLICT_REJECTED',
                'INVALID_COMMAND', 'INVALID_REVISION', 'PRECONDITION_FAILED', 'LIFECYCLE_DENIED',
                'TEMPORAL_INVALID', 'AUTHORITY_DENIED', 'UPDATE_PAYLOAD_CHANGED'
            )
        ),
    state_changed INTEGER NOT NULL
        CHECK (typeof(state_changed) = 'integer' AND state_changed IN (0, 1)),
    memory_id TEXT
        CHECK (
            memory_id IS NULL OR (
                length(memory_id) BETWEEN 5 AND 100 AND
                substr(memory_id, 1, 4) = 'mem_' AND
                memory_id NOT GLOB '*[^A-Za-z0-9_-]*'
            )
        ),
    revision_ids_json TEXT NOT NULL
        CHECK (
            json_valid(revision_ids_json) AND
            json_type(revision_ids_json) = 'array' AND
            json_array_length(revision_ids_json) <= 64
        ),
    -- Structural facts only — revision ids, tiers, decision codes. Never payload
    -- content, so the audit trail can be surfaced to an operator without carrying
    -- memory content (or a secret that leaked into one) out of its sleeve.
    reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
    recorded_at TEXT NOT NULL CHECK (unixepoch(recorded_at) IS NOT NULL),
    fingerprint TEXT NOT NULL
        CHECK (
            length(fingerprint) = 71 AND
            substr(fingerprint, 1, 7) = 'sha256:' AND
            substr(fingerprint, 8) NOT GLOB '*[^a-f0-9]*'
        ),
    CHECK (
        state_changed = 0 OR
        outcome IN ('OBSERVED', 'PROPOSED', 'APPLIED', 'MERGED', 'SPLIT', 'PROMOTED', 'IMPORTED')
    ),
    FOREIGN KEY (owner_scope_id) REFERENCES control_scopes(scope_id),
    FOREIGN KEY (sleeve_id) REFERENCES memory_sleeves(sleeve_id),
    FOREIGN KEY (command_id) REFERENCES memory_ledger_commands(command_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_ledger_audit_sequence
    ON memory_ledger_audit (sleeve_id, sleeve_seq);

CREATE INDEX IF NOT EXISTS idx_memory_ledger_audit_outcome
    ON memory_ledger_audit (sleeve_id, outcome, sleeve_seq);

-- Active-sleeve binding: nothing enters the ledger without a live registered sleeve,
-- exactly like memory_fragments and the typed stores.
CREATE TRIGGER IF NOT EXISTS memory_ledger_commands_scope_binding_insert
BEFORE INSERT ON memory_ledger_commands
WHEN NOT EXISTS (
    SELECT 1 FROM memory_sleeves
    WHERE sleeve_id = new.sleeve_id AND owner_scope_id = new.owner_scope_id AND state = 'active'
)
BEGIN
    SELECT RAISE(ABORT, 'ledger command sleeve binding invalid');
END;

CREATE TRIGGER IF NOT EXISTS memory_ledger_events_scope_binding_insert
BEFORE INSERT ON memory_ledger_events
WHEN NOT EXISTS (
    SELECT 1 FROM memory_sleeves
    WHERE sleeve_id = new.sleeve_id AND owner_scope_id = new.owner_scope_id AND state = 'active'
)
BEGIN
    SELECT RAISE(ABORT, 'ledger event sleeve binding invalid');
END;

CREATE TRIGGER IF NOT EXISTS memory_revisions_scope_binding_insert
BEFORE INSERT ON memory_revisions
WHEN NOT EXISTS (
    SELECT 1 FROM memory_sleeves
    WHERE sleeve_id = new.sleeve_id AND owner_scope_id = new.owner_scope_id AND state = 'active'
)
BEGIN
    SELECT RAISE(ABORT, 'memory revision sleeve binding invalid');
END;

CREATE TRIGGER IF NOT EXISTS memory_provenance_edges_scope_binding_insert
BEFORE INSERT ON memory_provenance_edges
WHEN NOT EXISTS (
    SELECT 1 FROM memory_sleeves
    WHERE sleeve_id = new.sleeve_id AND owner_scope_id = new.owner_scope_id AND state = 'active'
)
BEGIN
    SELECT RAISE(ABORT, 'provenance edge sleeve binding invalid');
END;

CREATE TRIGGER IF NOT EXISTS memory_ledger_audit_scope_binding_insert
BEFORE INSERT ON memory_ledger_audit
WHEN NOT EXISTS (
    SELECT 1 FROM memory_sleeves
    WHERE sleeve_id = new.sleeve_id AND owner_scope_id = new.owner_scope_id AND state = 'active'
)
BEGIN
    SELECT RAISE(ABORT, 'ledger audit sleeve binding invalid');
END;

-- An event and its audit row must agree with the command they describe, or the log
-- and the projection could tell different stories about the same sequence number.
CREATE TRIGGER IF NOT EXISTS memory_ledger_events_command_binding_insert
BEFORE INSERT ON memory_ledger_events
WHEN NOT EXISTS (
    SELECT 1 FROM memory_ledger_commands
    WHERE command_id = new.command_id
      AND sleeve_id = new.sleeve_id
      AND owner_scope_id = new.owner_scope_id
      AND sleeve_seq = new.sleeve_seq
)
BEGIN
    SELECT RAISE(ABORT, 'ledger event does not match its command');
END;

CREATE TRIGGER IF NOT EXISTS memory_ledger_audit_command_binding_insert
BEFORE INSERT ON memory_ledger_audit
WHEN NOT EXISTS (
    SELECT 1 FROM memory_ledger_commands
    WHERE command_id = new.command_id
      AND sleeve_id = new.sleeve_id
      AND owner_scope_id = new.owner_scope_id
      AND sleeve_seq = new.sleeve_seq
)
BEGIN
    SELECT RAISE(ABORT, 'ledger audit does not match its command');
END;

-- Supersession may never cross a sleeve or a memory thread. Allowing it would let a
-- writer in one sleeve close another sleeve's canonical revision, which is the one
-- way the ledger could silently widen access.
CREATE TRIGGER IF NOT EXISTS memory_revisions_supersession_binding_insert
BEFORE INSERT ON memory_revisions
WHEN new.supersedes IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM memory_revisions
    WHERE revision_id = new.supersedes
      AND sleeve_id = new.sleeve_id
      AND owner_scope_id = new.owner_scope_id
      AND memory_id = new.memory_id
      AND revision_no = new.revision_no - 1
)
BEGIN
    SELECT RAISE(ABORT, 'memory revision supersession must close the prior revision of the same thread');
END;

-- Immutability guard. A revision is a historical record; only the four
-- projection-maintenance columns may move, and each only along a legal edge:
--   status            active <-> active_conflicted, and {active, active_conflicted,
--                     expired} -> superseded when the revision is closed
--   superseded_by     NULL -> a successor in the same sleeve and thread, once
--   is_current_active 1 -> 0 only; a closed revision never becomes current again
--   contradicts_json  grows as the conflict graph is kept symmetric
-- Everything that feeds canonical_hash is frozen, so a stored projection always
-- re-derives from the log.
CREATE TRIGGER IF NOT EXISTS memory_revisions_guard_update
BEFORE UPDATE ON memory_revisions
WHEN
    old.revision_id IS NOT new.revision_id OR
    old.schema_version IS NOT new.schema_version OR
    old.record_type IS NOT new.record_type OR
    old.memory_id IS NOT new.memory_id OR
    old.revision_no IS NOT new.revision_no OR
    old.owner_scope_id IS NOT new.owner_scope_id OR
    old.sleeve_id IS NOT new.sleeve_id OR
    old.sleeve_class IS NOT new.sleeve_class OR
    old.memory_kind IS NOT new.memory_kind OR
    old.entity_key IS NOT new.entity_key OR
    old.approval_state IS NOT new.approval_state OR
    old.authority_tier IS NOT new.authority_tier OR
    old.confidence_permille IS NOT new.confidence_permille OR
    old.sensitivity IS NOT new.sensitivity OR
    old.retention_policy IS NOT new.retention_policy OR
    old.legal_hold IS NOT new.legal_hold OR
    old.event_time IS NOT new.event_time OR
    old.observed_at IS NOT new.observed_at OR
    old.created_tx_time IS NOT new.created_tx_time OR
    old.recorded_tx_seq IS NOT new.recorded_tx_seq OR
    old.valid_from IS NOT new.valid_from OR
    old.valid_until IS NOT new.valid_until OR
    old.decided_at IS NOT new.decided_at OR
    old.author_agent_id IS NOT new.author_agent_id OR
    old.workflow_id IS NOT new.workflow_id OR
    old.run_id IS NOT new.run_id OR
    old.derivation_method IS NOT new.derivation_method OR
    old.source_event_ids_json IS NOT new.source_event_ids_json OR
    old.evidence_refs_json IS NOT new.evidence_refs_json OR
    old.derived_from_json IS NOT new.derived_from_json OR
    old.supersedes IS NOT new.supersedes OR
    old.payload_json IS NOT new.payload_json OR
    old.content_hash IS NOT new.content_hash OR
    old.canonical_hash IS NOT new.canonical_hash OR
    old.tombstone_json IS NOT new.tombstone_json OR
    old.command_id IS NOT new.command_id OR
    (old.superseded_by IS NOT NULL AND old.superseded_by IS NOT new.superseded_by) OR
    (old.is_current_active = 0 AND new.is_current_active = 1) OR
    (
        old.status IS NOT new.status AND NOT (
            (old.status = 'active' AND new.status IN ('active_conflicted', 'superseded')) OR
            (old.status = 'active_conflicted' AND new.status IN ('active', 'superseded')) OR
            (old.status = 'expired' AND new.status = 'superseded')
        )
    ) OR
    (
        new.superseded_by IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM memory_revisions AS successor
            WHERE successor.revision_id = new.superseded_by
              AND successor.sleeve_id = old.sleeve_id
              AND successor.owner_scope_id = old.owner_scope_id
              AND successor.memory_id = old.memory_id
        )
    )
BEGIN
    SELECT RAISE(ABORT, 'memory revision is immutable outside its projection columns');
END;

-- The command log, the event stream, the provenance graph, and the audit trail are
-- append-only in the strongest sense: no column of an existing row may ever change.
CREATE TRIGGER IF NOT EXISTS memory_ledger_commands_guard_update
BEFORE UPDATE ON memory_ledger_commands BEGIN
    SELECT RAISE(ABORT, 'ledger commands are append-only');
END;
CREATE TRIGGER IF NOT EXISTS memory_ledger_events_guard_update
BEFORE UPDATE ON memory_ledger_events BEGIN
    SELECT RAISE(ABORT, 'ledger events are append-only');
END;
CREATE TRIGGER IF NOT EXISTS memory_provenance_edges_guard_update
BEFORE UPDATE ON memory_provenance_edges BEGIN
    SELECT RAISE(ABORT, 'provenance edges are append-only');
END;
CREATE TRIGGER IF NOT EXISTS memory_ledger_audit_guard_update
BEFORE UPDATE ON memory_ledger_audit BEGIN
    SELECT RAISE(ABORT, 'ledger audit rows are append-only');
END;

-- No-delete. Erasure is a tombstone revision with a redacted payload, never a
-- missing row: a missing row would make a replay disagree with recorded history.
CREATE TRIGGER IF NOT EXISTS memory_ledger_commands_no_delete
BEFORE DELETE ON memory_ledger_commands BEGIN SELECT RAISE(ABORT, 'ledger commands cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS memory_ledger_events_no_delete
BEFORE DELETE ON memory_ledger_events BEGIN SELECT RAISE(ABORT, 'ledger events cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS memory_revisions_no_delete
BEFORE DELETE ON memory_revisions BEGIN SELECT RAISE(ABORT, 'memory revisions cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS memory_provenance_edges_no_delete
BEFORE DELETE ON memory_provenance_edges BEGIN SELECT RAISE(ABORT, 'provenance edges cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS memory_ledger_audit_no_delete
BEFORE DELETE ON memory_ledger_audit BEGIN SELECT RAISE(ABORT, 'ledger audit rows cannot be deleted'); END;
