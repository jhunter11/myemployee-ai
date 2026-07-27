CREATE TABLE IF NOT EXISTS agent_profile_instances (
    instance_id TEXT PRIMARY KEY
        CHECK (
            length(instance_id) = 49 AND
            instance_id GLOB 'profile-instance:[a-f0-9]*' AND
            substr(instance_id, 18) NOT GLOB '*[^a-f0-9]*'
        ),
    recipe_id TEXT NOT NULL
        CHECK (
            length(recipe_id) BETWEEN 3 AND 64 AND
            substr(recipe_id, 1, 1) GLOB '[a-z]' AND
            recipe_id NOT GLOB '*[^a-z0-9-]*'
        ),
    recipe_sha256 TEXT NOT NULL
        CHECK (
            length(recipe_sha256) = 64 AND
            recipe_sha256 NOT GLOB '*[^a-f0-9]*'
        ),
    scope_id TEXT NOT NULL,
    scope_version INTEGER NOT NULL
        CHECK (
            typeof(scope_version) = 'integer' AND
            scope_version BETWEEN 1 AND 2147483647
        ),
    knowledge_scope_id TEXT NOT NULL,
    manifest_json TEXT NOT NULL
        CHECK (json_valid(manifest_json) AND json_type(manifest_json) = 'object'),
    manifest_sha256 TEXT NOT NULL
        CHECK (
            length(manifest_sha256) = 64 AND
            manifest_sha256 NOT GLOB '*[^a-f0-9]*'
        ),
    approved_by TEXT NOT NULL
        CHECK (
            length(approved_by) BETWEEN 12 AND 128 AND
            approved_by GLOB 'operator:*' AND
            approved_by NOT GLOB '*[^a-z0-9:_-]*'
        ),
    state TEXT NOT NULL CHECK (state IN ('planned', 'active', 'expired')),
    version INTEGER NOT NULL
        CHECK (
            (state = 'planned' AND version = 1) OR
            (state = 'active' AND version = 2) OR
            (state = 'expired' AND version IN (2, 3))
        ),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    expires_at TEXT NOT NULL CHECK (unixepoch(expires_at) IS NOT NULL),
    activated_at TEXT CHECK (activated_at IS NULL OR unixepoch(activated_at) IS NOT NULL),
    expired_at TEXT CHECK (expired_at IS NULL OR unixepoch(expired_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
    CHECK (expires_at > created_at),
    CHECK (updated_at >= created_at),
    CHECK (
        (
            state = 'planned' AND
            activated_at IS NULL AND
            expired_at IS NULL AND
            updated_at = created_at
        ) OR
        (
            state = 'active' AND
            activated_at IS NOT NULL AND
            expired_at IS NULL AND
            activated_at >= created_at AND
            activated_at < expires_at AND
            updated_at = activated_at
        ) OR
        (
            state = 'expired' AND
            expired_at IS NOT NULL AND
            expired_at >= expires_at AND
            updated_at = expired_at AND
            (
                activated_at IS NULL OR
                (activated_at >= created_at AND activated_at < expires_at)
            )
        )
    ),
    FOREIGN KEY (scope_id) REFERENCES control_scopes(scope_id),
    FOREIGN KEY (knowledge_scope_id) REFERENCES knowledge_scopes(scope_id)
);

CREATE TABLE IF NOT EXISTS agent_profile_instance_members (
    agent_id TEXT PRIMARY KEY
        CHECK (
            length(agent_id) BETWEEN 3 AND 64 AND
            substr(agent_id, 1, 1) GLOB '[a-z]' AND
            agent_id NOT GLOB '*[^a-z0-9-]*'
        ),
    instance_id TEXT NOT NULL,
    template_profile_id TEXT NOT NULL
        CHECK (
            length(template_profile_id) BETWEEN 3 AND 64 AND
            substr(template_profile_id, 1, 1) GLOB '[a-z]' AND
            template_profile_id NOT GLOB '*[^a-z0-9-]*'
        ),
    ordinal INTEGER NOT NULL
        CHECK (typeof(ordinal) = 'integer' AND ordinal BETWEEN 0 AND 99),
    profile_json TEXT NOT NULL
        CHECK (json_valid(profile_json) AND json_type(profile_json) = 'object'),
    profile_sha256 TEXT NOT NULL
        CHECK (
            length(profile_sha256) = 64 AND
            profile_sha256 NOT GLOB '*[^a-f0-9]*'
        ),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    UNIQUE (instance_id, template_profile_id),
    UNIQUE (instance_id, ordinal),
    FOREIGN KEY (instance_id) REFERENCES agent_profile_instances(instance_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_profile_instances_state
    ON agent_profile_instances (state, created_at, instance_id);

-- One live lease per recipe scope. Quarantined leases are retained as immutable
-- history, so the uniqueness that governs instantiation excludes them and a
-- renewal can bind the same recipe scope to a new lease.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profile_instances_live_recipe_scope
    ON agent_profile_instances (recipe_id, scope_id)
    WHERE state <> 'expired';

CREATE INDEX IF NOT EXISTS idx_agent_profile_instance_members_instance
    ON agent_profile_instance_members (instance_id, ordinal);

CREATE TRIGGER IF NOT EXISTS agent_profile_instances_planned_insert
BEFORE INSERT ON agent_profile_instances
WHEN
    NEW.state <> 'planned' OR
    NEW.version <> 1 OR
    NEW.activated_at IS NOT NULL OR
    NEW.expired_at IS NOT NULL OR
    NEW.updated_at <> NEW.created_at
BEGIN
    SELECT RAISE(ABORT, 'agent profile instances must begin in the planned state');
END;

-- Exactly two transitions are governed: a planned lease may activate inside its
-- own window, and a planned or active lease may be quarantined at or after its
-- expiry. Everything else, including any edit to the approved snapshot columns,
-- aborts.
CREATE TRIGGER IF NOT EXISTS agent_profile_instances_governed_transition
BEFORE UPDATE ON agent_profile_instances
WHEN
    OLD.instance_id IS NOT NEW.instance_id OR
    OLD.recipe_id IS NOT NEW.recipe_id OR
    OLD.recipe_sha256 IS NOT NEW.recipe_sha256 OR
    OLD.scope_id IS NOT NEW.scope_id OR
    OLD.scope_version IS NOT NEW.scope_version OR
    OLD.knowledge_scope_id IS NOT NEW.knowledge_scope_id OR
    OLD.manifest_json IS NOT NEW.manifest_json OR
    OLD.manifest_sha256 IS NOT NEW.manifest_sha256 OR
    OLD.approved_by IS NOT NEW.approved_by OR
    OLD.created_at IS NOT NEW.created_at OR
    OLD.expires_at IS NOT NEW.expires_at OR
    NOT (
        (
            OLD.state = 'planned' AND
            OLD.version = 1 AND
            OLD.activated_at IS NULL AND
            OLD.expired_at IS NULL AND
            NEW.state = 'active' AND
            NEW.version = 2 AND
            NEW.activated_at IS NOT NULL AND
            NEW.expired_at IS NULL AND
            NEW.updated_at = NEW.activated_at AND
            NEW.activated_at >= OLD.created_at AND
            NEW.activated_at < OLD.expires_at
        ) OR
        (
            OLD.state IN ('planned', 'active') AND
            OLD.expired_at IS NULL AND
            NEW.state = 'expired' AND
            NEW.version = OLD.version + 1 AND
            NEW.activated_at IS OLD.activated_at AND
            NEW.expired_at IS NOT NULL AND
            NEW.updated_at = NEW.expired_at AND
            NEW.expired_at >= OLD.expires_at
        )
    )
BEGIN
    SELECT RAISE(ABORT, 'agent profile instance state transition is not governed');
END;

CREATE TRIGGER IF NOT EXISTS agent_profile_instances_no_delete
BEFORE DELETE ON agent_profile_instances
BEGIN
    SELECT RAISE(ABORT, 'agent profile instances cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS agent_profile_instance_members_no_update
BEFORE UPDATE ON agent_profile_instance_members
BEGIN
    SELECT RAISE(ABORT, 'agent profile instance members are immutable');
END;

CREATE TRIGGER IF NOT EXISTS agent_profile_instance_members_planned_insert
BEFORE INSERT ON agent_profile_instance_members
WHEN NOT EXISTS (
    SELECT 1
    FROM agent_profile_instances
    WHERE
        instance_id = NEW.instance_id AND
        state = 'planned' AND
        version = 1
)
BEGIN
    SELECT RAISE(ABORT, 'agent profile instance members require a planned instance');
END;

CREATE TRIGGER IF NOT EXISTS agent_profile_instance_members_no_delete
BEFORE DELETE ON agent_profile_instance_members
BEGIN
    SELECT RAISE(ABORT, 'agent profile instance members cannot be deleted');
END;
