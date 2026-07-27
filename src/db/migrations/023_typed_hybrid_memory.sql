-- Typed-hybrid memory stores (CoALA store classes) layered additively over the
-- flat memory_fragments substrate. These tables activate the passive `kind` axis:
--   * working_memory              -> run-local working state, never auto-promoted
--   * memory_consolidation_candidates -> propose-only episodic->semantic/procedural distillations
--   * memory_procedure_candidates -> propose-only repeated-workflow (Voyager-style) skills
-- Every table keeps the established discipline: immutable content, append-only
-- supersession, active-sleeve binding, no-delete. Nothing here becomes durable
-- shared memory without the existing operator-gated shared_approved_bundles path.

CREATE TABLE IF NOT EXISTS working_memory (
    entry_id TEXT PRIMARY KEY
        CHECK (
            length(entry_id) BETWEEN 1 AND 128 AND
            substr(entry_id, 1, 1) GLOB '[A-Za-z0-9]' AND
            entry_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        ),
    owner_scope_id TEXT NOT NULL,
    sleeve_id TEXT NOT NULL,
    run_id TEXT NOT NULL
        CHECK (
            length(run_id) BETWEEN 1 AND 128 AND
            substr(run_id, 1, 1) GLOB '[A-Za-z0-9]' AND
            run_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        ),
    slot_key TEXT NOT NULL
        CHECK (
            length(slot_key) BETWEEN 1 AND 64 AND
            substr(slot_key, 1, 1) GLOB '[a-z]' AND
            slot_key NOT GLOB '*[^a-z0-9_:-]*'
        ),
    content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 65536),
    content_sha256 TEXT NOT NULL
        CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^a-f0-9]*'),
    sensitivity TEXT NOT NULL
        CHECK (sensitivity IN ('public', 'internal', 'confidential', 'private', 'restricted')),
    recorded_at TEXT NOT NULL CHECK (unixepoch(recorded_at) IS NOT NULL),
    expires_at TEXT NOT NULL CHECK (unixepoch(expires_at) IS NOT NULL),
    supersedes_entry_id TEXT,
    superseded_by_entry_id TEXT,
    CHECK (unixepoch(expires_at) > unixepoch(recorded_at)),
    CHECK (supersedes_entry_id IS NULL OR supersedes_entry_id <> entry_id),
    CHECK (superseded_by_entry_id IS NULL OR superseded_by_entry_id <> entry_id),
    FOREIGN KEY (owner_scope_id) REFERENCES control_scopes(scope_id),
    FOREIGN KEY (sleeve_id) REFERENCES memory_sleeves(sleeve_id),
    FOREIGN KEY (supersedes_entry_id) REFERENCES working_memory(entry_id),
    FOREIGN KEY (superseded_by_entry_id) REFERENCES working_memory(entry_id)
);

-- Retrieval is only ever scoped to (owner_scope_id, sleeve_id, run_id, slot_key);
-- there is no cross-run index by design so working state cannot leak between runs.
CREATE INDEX IF NOT EXISTS idx_working_memory_run_slot
    ON working_memory (
        sleeve_id,
        owner_scope_id,
        run_id,
        slot_key,
        superseded_by_entry_id,
        expires_at,
        recorded_at DESC,
        entry_id
    );

CREATE TABLE IF NOT EXISTS memory_consolidation_candidates (
    candidate_id TEXT PRIMARY KEY
        CHECK (
            length(candidate_id) BETWEEN 1 AND 128 AND
            substr(candidate_id, 1, 1) GLOB '[A-Za-z0-9]' AND
            candidate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        ),
    owner_scope_id TEXT NOT NULL,
    sleeve_id TEXT NOT NULL,
    target_store TEXT NOT NULL CHECK (target_store IN ('semantic', 'procedural')),
    proposed_kind TEXT NOT NULL
        CHECK (
            proposed_kind IN (
                'policy', 'identity', 'fact', 'decision', 'preference',
                'procedure', 'blueprint', 'episode', 'artifact', 'summary'
            )
        ),
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 240),
    content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 65536),
    source_fragment_ids_json TEXT NOT NULL
        CHECK (
            json_valid(source_fragment_ids_json) AND
            json_type(source_fragment_ids_json) = 'array' AND
            json_array_length(source_fragment_ids_json) BETWEEN 1 AND 64
        ),
    evidence_count INTEGER NOT NULL
        CHECK (typeof(evidence_count) = 'integer' AND evidence_count BETWEEN 1 AND 100000),
    temporal_state TEXT NOT NULL
        CHECK (temporal_state IN ('current', 'historical', 'transitional')),
    confidence_permille INTEGER NOT NULL
        CHECK (typeof(confidence_permille) = 'integer' AND confidence_permille BETWEEN 0 AND 1000),
    rationale TEXT NOT NULL CHECK (length(trim(rationale)) BETWEEN 1 AND 2000),
    planner_version TEXT NOT NULL
        CHECK (
            length(planner_version) BETWEEN 1 AND 64 AND
            substr(planner_version, 1, 1) GLOB '[a-z0-9]' AND
            planner_version NOT GLOB '*[^a-z0-9._-]*'
        ),
    proposed_by TEXT NOT NULL,
    sensitivity TEXT NOT NULL
        CHECK (sensitivity IN ('public', 'internal', 'confidential', 'private', 'restricted')),
    content_sha256 TEXT NOT NULL
        CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^a-f0-9]*'),
    recorded_at TEXT NOT NULL CHECK (unixepoch(recorded_at) IS NOT NULL),
    expires_at TEXT NOT NULL CHECK (unixepoch(expires_at) IS NOT NULL),
    supersedes_candidate_id TEXT,
    superseded_by_candidate_id TEXT,
    CHECK (unixepoch(expires_at) > unixepoch(recorded_at)),
    CHECK (supersedes_candidate_id IS NULL OR supersedes_candidate_id <> candidate_id),
    CHECK (superseded_by_candidate_id IS NULL OR superseded_by_candidate_id <> candidate_id),
    FOREIGN KEY (owner_scope_id) REFERENCES control_scopes(scope_id),
    FOREIGN KEY (sleeve_id) REFERENCES memory_sleeves(sleeve_id),
    FOREIGN KEY (proposed_by) REFERENCES access_agents(agent_id),
    FOREIGN KEY (supersedes_candidate_id) REFERENCES memory_consolidation_candidates(candidate_id),
    FOREIGN KEY (superseded_by_candidate_id) REFERENCES memory_consolidation_candidates(candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_consolidation_candidates_open
    ON memory_consolidation_candidates (
        sleeve_id,
        owner_scope_id,
        target_store,
        superseded_by_candidate_id,
        expires_at,
        recorded_at DESC,
        candidate_id
    );

CREATE TABLE IF NOT EXISTS memory_procedure_candidates (
    candidate_id TEXT PRIMARY KEY
        CHECK (
            length(candidate_id) BETWEEN 1 AND 128 AND
            substr(candidate_id, 1, 1) GLOB '[A-Za-z0-9]' AND
            candidate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        ),
    owner_scope_id TEXT NOT NULL,
    sleeve_id TEXT NOT NULL,
    workflow_signature TEXT NOT NULL
        CHECK (length(workflow_signature) = 64 AND workflow_signature NOT GLOB '*[^a-f0-9]*'),
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 240),
    steps_json TEXT NOT NULL
        CHECK (
            json_valid(steps_json) AND
            json_type(steps_json) = 'array' AND
            json_array_length(steps_json) BETWEEN 1 AND 64
        ),
    success_count INTEGER NOT NULL
        CHECK (typeof(success_count) = 'integer' AND success_count BETWEEN 1 AND 100000),
    first_seen_at TEXT NOT NULL CHECK (unixepoch(first_seen_at) IS NOT NULL),
    last_seen_at TEXT NOT NULL CHECK (unixepoch(last_seen_at) IS NOT NULL),
    rationale TEXT NOT NULL CHECK (length(trim(rationale)) BETWEEN 1 AND 2000),
    planner_version TEXT NOT NULL
        CHECK (
            length(planner_version) BETWEEN 1 AND 64 AND
            substr(planner_version, 1, 1) GLOB '[a-z0-9]' AND
            planner_version NOT GLOB '*[^a-z0-9._-]*'
        ),
    proposed_by TEXT NOT NULL,
    sensitivity TEXT NOT NULL
        CHECK (sensitivity IN ('public', 'internal', 'confidential', 'private', 'restricted')),
    content_sha256 TEXT NOT NULL
        CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^a-f0-9]*'),
    recorded_at TEXT NOT NULL CHECK (unixepoch(recorded_at) IS NOT NULL),
    expires_at TEXT NOT NULL CHECK (unixepoch(expires_at) IS NOT NULL),
    supersedes_candidate_id TEXT,
    superseded_by_candidate_id TEXT,
    CHECK (unixepoch(last_seen_at) >= unixepoch(first_seen_at)),
    CHECK (unixepoch(expires_at) > unixepoch(recorded_at)),
    CHECK (supersedes_candidate_id IS NULL OR supersedes_candidate_id <> candidate_id),
    CHECK (superseded_by_candidate_id IS NULL OR superseded_by_candidate_id <> candidate_id),
    FOREIGN KEY (owner_scope_id) REFERENCES control_scopes(scope_id),
    FOREIGN KEY (sleeve_id) REFERENCES memory_sleeves(sleeve_id),
    FOREIGN KEY (proposed_by) REFERENCES access_agents(agent_id),
    FOREIGN KEY (supersedes_candidate_id) REFERENCES memory_procedure_candidates(candidate_id),
    FOREIGN KEY (superseded_by_candidate_id) REFERENCES memory_procedure_candidates(candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_procedure_candidates_open
    ON memory_procedure_candidates (
        sleeve_id,
        owner_scope_id,
        workflow_signature,
        superseded_by_candidate_id,
        expires_at,
        recorded_at DESC,
        candidate_id
    );

-- Active-sleeve binding: every store entry requires a live registered sleeve,
-- exactly like memory_fragments.
CREATE TRIGGER IF NOT EXISTS working_memory_scope_binding_insert
BEFORE INSERT ON working_memory
WHEN NOT EXISTS (
    SELECT 1 FROM memory_sleeves
    WHERE sleeve_id = new.sleeve_id AND owner_scope_id = new.owner_scope_id AND state = 'active'
)
BEGIN
    SELECT RAISE(ABORT, 'working memory sleeve binding invalid');
END;

CREATE TRIGGER IF NOT EXISTS consolidation_candidate_scope_binding_insert
BEFORE INSERT ON memory_consolidation_candidates
WHEN NOT EXISTS (
    SELECT 1 FROM memory_sleeves
    WHERE sleeve_id = new.sleeve_id AND owner_scope_id = new.owner_scope_id AND state = 'active'
)
BEGIN
    SELECT RAISE(ABORT, 'consolidation candidate sleeve binding invalid');
END;

CREATE TRIGGER IF NOT EXISTS procedure_candidate_scope_binding_insert
BEFORE INSERT ON memory_procedure_candidates
WHEN NOT EXISTS (
    SELECT 1 FROM memory_sleeves
    WHERE sleeve_id = new.sleeve_id AND owner_scope_id = new.owner_scope_id AND state = 'active'
)
BEGIN
    SELECT RAISE(ABORT, 'procedure candidate sleeve binding invalid');
END;

-- Supersession may never cross a sleeve.
CREATE TRIGGER IF NOT EXISTS working_memory_supersession_binding_insert
BEFORE INSERT ON working_memory
WHEN new.supersedes_entry_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM working_memory
    WHERE entry_id = new.supersedes_entry_id
      AND sleeve_id = new.sleeve_id
      AND owner_scope_id = new.owner_scope_id
      AND run_id = new.run_id
)
BEGIN
    SELECT RAISE(ABORT, 'working memory supersession cannot cross sleeve or run');
END;

CREATE TRIGGER IF NOT EXISTS consolidation_candidate_supersession_binding_insert
BEFORE INSERT ON memory_consolidation_candidates
WHEN new.supersedes_candidate_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM memory_consolidation_candidates
    WHERE candidate_id = new.supersedes_candidate_id
      AND sleeve_id = new.sleeve_id
      AND owner_scope_id = new.owner_scope_id
)
BEGIN
    SELECT RAISE(ABORT, 'consolidation supersession cannot cross sleeves');
END;

CREATE TRIGGER IF NOT EXISTS procedure_candidate_supersession_binding_insert
BEFORE INSERT ON memory_procedure_candidates
WHEN new.supersedes_candidate_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM memory_procedure_candidates
    WHERE candidate_id = new.supersedes_candidate_id
      AND sleeve_id = new.sleeve_id
      AND owner_scope_id = new.owner_scope_id
)
BEGIN
    SELECT RAISE(ABORT, 'procedure supersession cannot cross sleeves');
END;

-- Immutable content: the only permitted update is a one-time supersession pointer
-- set to a successor in the same sleeve. Mirrors memory_fragments_guard_update.
CREATE TRIGGER IF NOT EXISTS working_memory_guard_update
BEFORE UPDATE ON working_memory
WHEN
    old.entry_id IS NOT new.entry_id OR
    old.owner_scope_id IS NOT new.owner_scope_id OR
    old.sleeve_id IS NOT new.sleeve_id OR
    old.run_id IS NOT new.run_id OR
    old.slot_key IS NOT new.slot_key OR
    old.content IS NOT new.content OR
    old.content_sha256 IS NOT new.content_sha256 OR
    old.sensitivity IS NOT new.sensitivity OR
    old.recorded_at IS NOT new.recorded_at OR
    old.expires_at IS NOT new.expires_at OR
    old.supersedes_entry_id IS NOT new.supersedes_entry_id OR
    old.superseded_by_entry_id IS NOT NULL OR
    new.superseded_by_entry_id IS NULL OR
    NOT EXISTS (
        SELECT 1 FROM working_memory AS successor
        WHERE successor.entry_id = new.superseded_by_entry_id
          AND successor.sleeve_id = old.sleeve_id
          AND successor.owner_scope_id = old.owner_scope_id
          AND successor.run_id = old.run_id
    )
BEGIN
    SELECT RAISE(ABORT, 'working memory immutable binding or supersession failed');
END;

CREATE TRIGGER IF NOT EXISTS consolidation_candidate_guard_update
BEFORE UPDATE ON memory_consolidation_candidates
WHEN
    old.candidate_id IS NOT new.candidate_id OR
    old.owner_scope_id IS NOT new.owner_scope_id OR
    old.sleeve_id IS NOT new.sleeve_id OR
    old.target_store IS NOT new.target_store OR
    old.proposed_kind IS NOT new.proposed_kind OR
    old.title IS NOT new.title OR
    old.content IS NOT new.content OR
    old.source_fragment_ids_json IS NOT new.source_fragment_ids_json OR
    old.evidence_count IS NOT new.evidence_count OR
    old.temporal_state IS NOT new.temporal_state OR
    old.confidence_permille IS NOT new.confidence_permille OR
    old.rationale IS NOT new.rationale OR
    old.planner_version IS NOT new.planner_version OR
    old.proposed_by IS NOT new.proposed_by OR
    old.sensitivity IS NOT new.sensitivity OR
    old.content_sha256 IS NOT new.content_sha256 OR
    old.recorded_at IS NOT new.recorded_at OR
    old.expires_at IS NOT new.expires_at OR
    old.supersedes_candidate_id IS NOT new.supersedes_candidate_id OR
    old.superseded_by_candidate_id IS NOT NULL OR
    new.superseded_by_candidate_id IS NULL OR
    NOT EXISTS (
        SELECT 1 FROM memory_consolidation_candidates AS successor
        WHERE successor.candidate_id = new.superseded_by_candidate_id
          AND successor.sleeve_id = old.sleeve_id
          AND successor.owner_scope_id = old.owner_scope_id
    )
BEGIN
    SELECT RAISE(ABORT, 'consolidation candidate immutable binding or supersession failed');
END;

CREATE TRIGGER IF NOT EXISTS procedure_candidate_guard_update
BEFORE UPDATE ON memory_procedure_candidates
WHEN
    old.candidate_id IS NOT new.candidate_id OR
    old.owner_scope_id IS NOT new.owner_scope_id OR
    old.sleeve_id IS NOT new.sleeve_id OR
    old.workflow_signature IS NOT new.workflow_signature OR
    old.title IS NOT new.title OR
    old.steps_json IS NOT new.steps_json OR
    old.success_count IS NOT new.success_count OR
    old.first_seen_at IS NOT new.first_seen_at OR
    old.last_seen_at IS NOT new.last_seen_at OR
    old.rationale IS NOT new.rationale OR
    old.planner_version IS NOT new.planner_version OR
    old.proposed_by IS NOT new.proposed_by OR
    old.sensitivity IS NOT new.sensitivity OR
    old.content_sha256 IS NOT new.content_sha256 OR
    old.recorded_at IS NOT new.recorded_at OR
    old.expires_at IS NOT new.expires_at OR
    old.supersedes_candidate_id IS NOT new.supersedes_candidate_id OR
    old.superseded_by_candidate_id IS NOT NULL OR
    new.superseded_by_candidate_id IS NULL OR
    NOT EXISTS (
        SELECT 1 FROM memory_procedure_candidates AS successor
        WHERE successor.candidate_id = new.superseded_by_candidate_id
          AND successor.sleeve_id = old.sleeve_id
          AND successor.owner_scope_id = old.owner_scope_id
    )
BEGIN
    SELECT RAISE(ABORT, 'procedure candidate immutable binding or supersession failed');
END;

CREATE TRIGGER IF NOT EXISTS working_memory_no_delete
BEFORE DELETE ON working_memory BEGIN SELECT RAISE(ABORT, 'working memory cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS memory_consolidation_candidates_no_delete
BEFORE DELETE ON memory_consolidation_candidates BEGIN SELECT RAISE(ABORT, 'consolidation candidates cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS memory_procedure_candidates_no_delete
BEFORE DELETE ON memory_procedure_candidates BEGIN SELECT RAISE(ABORT, 'procedure candidates cannot be deleted'); END;
