CREATE TABLE IF NOT EXISTS control_scopes (
    scope_id TEXT PRIMARY KEY,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN (
        'personal', 'agency', 'task_market', 'company', 'client', 'project'
    )),
    subject_id TEXT NOT NULL
        CHECK (
            length(subject_id) BETWEEN 2 AND 96 AND
            substr(subject_id, 1, 1) GLOB '[a-z]' AND
            subject_id NOT GLOB '*[^a-z0-9_-]*'
        ),
    parent_scope_id TEXT,
    trust_domain TEXT NOT NULL CHECK (trust_domain IN ('personal', 'agency', 'task_market')),
    state TEXT NOT NULL CHECK (state IN ('active', 'disabled')),
    version INTEGER NOT NULL
        CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 2147483647),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL AND updated_at >= created_at),
    CHECK (scope_id = scope_kind || ':' || subject_id),
    CHECK (parent_scope_id IS NULL OR parent_scope_id <> scope_id),
    FOREIGN KEY (parent_scope_id) REFERENCES control_scopes(scope_id)
);

CREATE INDEX IF NOT EXISTS idx_control_scopes_parent
    ON control_scopes (parent_scope_id, state, scope_id);

CREATE TABLE IF NOT EXISTS access_agents (
    agent_id TEXT PRIMARY KEY
        CHECK (
            length(agent_id) BETWEEN 3 AND 64 AND
            substr(agent_id, 1, 1) GLOB '[a-z]' AND
            agent_id NOT GLOB '*[^a-z0-9-]*'
        ),
    home_scope_id TEXT NOT NULL,
    trust_domain TEXT NOT NULL CHECK (trust_domain IN ('personal', 'agency', 'task_market')),
    profile_revision INTEGER NOT NULL
        CHECK (typeof(profile_revision) = 'integer' AND profile_revision BETWEEN 1 AND 2147483647),
    state TEXT NOT NULL CHECK (state IN ('active', 'disabled')),
    version INTEGER NOT NULL
        CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 2147483647),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL AND updated_at >= created_at),
    FOREIGN KEY (home_scope_id) REFERENCES control_scopes(scope_id)
);

CREATE INDEX IF NOT EXISTS idx_access_agents_scope
    ON access_agents (home_scope_id, state, agent_id);

CREATE TABLE IF NOT EXISTS memory_sleeves (
    sleeve_id TEXT PRIMARY KEY,
    owner_scope_id TEXT NOT NULL,
    sleeve_kind TEXT NOT NULL CHECK (sleeve_kind IN (
        'personal', 'agency', 'task_market', 'company', 'client', 'project',
        'agent_scratch', 'shared_approved'
    )),
    max_sensitivity TEXT NOT NULL CHECK (max_sensitivity IN (
        'public', 'internal', 'confidential', 'private', 'restricted'
    )),
    partition_key TEXT NOT NULL UNIQUE
        CHECK (
            length(partition_key) BETWEEN 20 AND 192 AND
            substr(partition_key, 1, 15) = 'memory/sleeves/' AND
            partition_key NOT GLOB '*[^a-z0-9_/-]*' AND
            partition_key NOT GLOB '*//*' AND
            partition_key NOT GLOB '*..*'
        ),
    expires_at TEXT CHECK (expires_at IS NULL OR unixepoch(expires_at) IS NOT NULL),
    state TEXT NOT NULL CHECK (state IN ('active', 'disabled')),
    version INTEGER NOT NULL
        CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 2147483647),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL AND updated_at >= created_at),
    CHECK (expires_at IS NULL OR expires_at > created_at),
    FOREIGN KEY (owner_scope_id) REFERENCES control_scopes(scope_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_sleeves_scope
    ON memory_sleeves (owner_scope_id, state, sleeve_id);

CREATE TABLE IF NOT EXISTS agent_sleeve_grants (
    grant_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    sleeve_id TEXT NOT NULL,
    authority_layer TEXT NOT NULL CHECK (authority_layer IN (
        'blueprint', 'operator', 'tenant', 'channel', 'run'
    )),
    permission TEXT NOT NULL CHECK (permission IN ('read', 'propose')),
    purpose TEXT NOT NULL
        CHECK (
            length(purpose) BETWEEN 3 AND 96 AND
            substr(purpose, 1, 1) GLOB '[a-z]' AND
            purpose NOT GLOB '*[^a-z0-9_]*'
        ),
    sensitivity_cap TEXT NOT NULL CHECK (sensitivity_cap IN (
        'public', 'internal', 'confidential', 'private', 'restricted'
    )),
    expires_at TEXT NOT NULL CHECK (unixepoch(expires_at) IS NOT NULL),
    state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
    version INTEGER NOT NULL
        CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 2147483647),
    bound_agent_version INTEGER NOT NULL
        CHECK (typeof(bound_agent_version) = 'integer' AND bound_agent_version > 0),
    bound_scope_version INTEGER NOT NULL
        CHECK (typeof(bound_scope_version) = 'integer' AND bound_scope_version > 0),
    bound_sleeve_version INTEGER NOT NULL
        CHECK (typeof(bound_sleeve_version) = 'integer' AND bound_sleeve_version > 0),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL AND updated_at >= created_at),
    CHECK (expires_at > created_at),
    FOREIGN KEY (agent_id) REFERENCES access_agents(agent_id),
    FOREIGN KEY (sleeve_id) REFERENCES memory_sleeves(sleeve_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sleeve_grants_one_active
    ON agent_sleeve_grants (agent_id, sleeve_id, authority_layer, permission)
    WHERE state = 'active';

CREATE INDEX IF NOT EXISTS idx_agent_sleeve_grants_authorize
    ON agent_sleeve_grants (agent_id, sleeve_id, permission, state, authority_layer);

CREATE TABLE IF NOT EXISTS agent_tool_grants (
    grant_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    tool_id TEXT NOT NULL
        CHECK (
            length(tool_id) BETWEEN 3 AND 128 AND
            substr(tool_id, 1, 1) GLOB '[a-z]' AND
            tool_id NOT GLOB '*[^a-z0-9._:-]*'
        ),
    authority_layer TEXT NOT NULL CHECK (authority_layer IN (
        'blueprint', 'operator', 'tenant', 'channel', 'run'
    )),
    access TEXT NOT NULL CHECK (access IN ('read', 'propose', 'execute')),
    purpose TEXT NOT NULL
        CHECK (
            length(purpose) BETWEEN 3 AND 96 AND
            substr(purpose, 1, 1) GLOB '[a-z]' AND
            purpose NOT GLOB '*[^a-z0-9_]*'
        ),
    sensitivity_cap TEXT NOT NULL CHECK (sensitivity_cap IN (
        'public', 'internal', 'confidential', 'private', 'restricted'
    )),
    expires_at TEXT NOT NULL CHECK (unixepoch(expires_at) IS NOT NULL),
    state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
    version INTEGER NOT NULL
        CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 2147483647),
    bound_agent_version INTEGER NOT NULL
        CHECK (typeof(bound_agent_version) = 'integer' AND bound_agent_version > 0),
    bound_scope_version INTEGER NOT NULL
        CHECK (typeof(bound_scope_version) = 'integer' AND bound_scope_version > 0),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL AND updated_at >= created_at),
    CHECK (expires_at > created_at),
    FOREIGN KEY (agent_id) REFERENCES access_agents(agent_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tool_grants_one_active
    ON agent_tool_grants (agent_id, tool_id, authority_layer, access)
    WHERE state = 'active';

CREATE INDEX IF NOT EXISTS idx_agent_tool_grants_authorize
    ON agent_tool_grants (agent_id, tool_id, access, state, authority_layer);

CREATE TABLE IF NOT EXISTS shared_approved_bundles (
    bundle_id TEXT PRIMARY KEY,
    source_scope_id TEXT NOT NULL,
    source_scope_version INTEGER NOT NULL
        CHECK (typeof(source_scope_version) = 'integer' AND source_scope_version > 0),
    target_sleeve_id TEXT NOT NULL,
    target_scope_version INTEGER NOT NULL
        CHECK (typeof(target_scope_version) = 'integer' AND target_scope_version > 0),
    target_sleeve_version INTEGER NOT NULL
        CHECK (typeof(target_sleeve_version) = 'integer' AND target_sleeve_version > 0),
    purpose TEXT NOT NULL
        CHECK (
            length(purpose) BETWEEN 3 AND 96 AND
            substr(purpose, 1, 1) GLOB '[a-z]' AND
            purpose NOT GLOB '*[^a-z0-9_]*'
        ),
    published_sensitivity TEXT NOT NULL CHECK (published_sensitivity IN (
        'public', 'internal', 'confidential', 'private', 'restricted'
    )),
    fragments_json TEXT NOT NULL
        CHECK (
            json_valid(fragments_json) AND
            json_type(fragments_json) = 'array' AND
            json_array_length(fragments_json) BETWEEN 1 AND 64 AND
            length(fragments_json) BETWEEN 2 AND 262144
        ),
    content_sha256 TEXT NOT NULL
        CHECK (
            length(content_sha256) = 64 AND
            content_sha256 NOT GLOB '*[^a-f0-9]*'
        ),
    reviewed_by TEXT NOT NULL
        CHECK (
            length(reviewed_by) BETWEEN 12 AND 128 AND
            substr(reviewed_by, 1, 9) = 'operator:' AND
            reviewed_by NOT GLOB '*[^a-z0-9_:-]*'
        ),
    reviewed_at TEXT NOT NULL CHECK (unixepoch(reviewed_at) IS NOT NULL),
    expires_at TEXT NOT NULL CHECK (unixepoch(expires_at) IS NOT NULL),
    state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
    version INTEGER NOT NULL
        CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 2147483647),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL AND updated_at >= created_at),
    CHECK (expires_at > reviewed_at),
    CHECK (created_at = reviewed_at),
    FOREIGN KEY (source_scope_id) REFERENCES control_scopes(scope_id),
    FOREIGN KEY (target_sleeve_id) REFERENCES memory_sleeves(sleeve_id)
);

CREATE INDEX IF NOT EXISTS idx_shared_approved_bundles_target
    ON shared_approved_bundles (target_sleeve_id, state, expires_at, reviewed_at DESC, bundle_id);

CREATE TRIGGER IF NOT EXISTS control_scopes_guard_update
BEFORE UPDATE ON control_scopes
WHEN
    OLD.scope_id IS NOT NEW.scope_id OR
    OLD.scope_kind IS NOT NEW.scope_kind OR
    OLD.subject_id IS NOT NEW.subject_id OR
    OLD.parent_scope_id IS NOT NEW.parent_scope_id OR
    OLD.trust_domain IS NOT NEW.trust_domain OR
    OLD.created_at IS NOT NEW.created_at OR
    NEW.version <> OLD.version + 1 OR
    NEW.updated_at < OLD.updated_at
BEGIN
    SELECT RAISE(ABORT, 'control scope immutable binding or version failed');
END;

CREATE TRIGGER IF NOT EXISTS access_agents_guard_update
BEFORE UPDATE ON access_agents
WHEN
    OLD.agent_id IS NOT NEW.agent_id OR
    OLD.home_scope_id IS NOT NEW.home_scope_id OR
    OLD.trust_domain IS NOT NEW.trust_domain OR
    OLD.profile_revision IS NOT NEW.profile_revision OR
    OLD.created_at IS NOT NEW.created_at OR
    NEW.version <> OLD.version + 1 OR
    NEW.updated_at < OLD.updated_at
BEGIN
    SELECT RAISE(ABORT, 'access agent immutable binding or version failed');
END;

CREATE TRIGGER IF NOT EXISTS memory_sleeves_guard_update
BEFORE UPDATE ON memory_sleeves
WHEN
    OLD.sleeve_id IS NOT NEW.sleeve_id OR
    OLD.owner_scope_id IS NOT NEW.owner_scope_id OR
    OLD.sleeve_kind IS NOT NEW.sleeve_kind OR
    OLD.max_sensitivity IS NOT NEW.max_sensitivity OR
    OLD.partition_key IS NOT NEW.partition_key OR
    OLD.expires_at IS NOT NEW.expires_at OR
    OLD.created_at IS NOT NEW.created_at OR
    NEW.version <> OLD.version + 1 OR
    NEW.updated_at < OLD.updated_at
BEGIN
    SELECT RAISE(ABORT, 'memory sleeve immutable binding or version failed');
END;

CREATE TRIGGER IF NOT EXISTS agent_sleeve_grants_guard_update
BEFORE UPDATE ON agent_sleeve_grants
WHEN
    OLD.grant_id IS NOT NEW.grant_id OR
    OLD.agent_id IS NOT NEW.agent_id OR
    OLD.sleeve_id IS NOT NEW.sleeve_id OR
    OLD.authority_layer IS NOT NEW.authority_layer OR
    OLD.permission IS NOT NEW.permission OR
    OLD.purpose IS NOT NEW.purpose OR
    OLD.sensitivity_cap IS NOT NEW.sensitivity_cap OR
    OLD.expires_at IS NOT NEW.expires_at OR
    OLD.bound_agent_version IS NOT NEW.bound_agent_version OR
    OLD.bound_scope_version IS NOT NEW.bound_scope_version OR
    OLD.bound_sleeve_version IS NOT NEW.bound_sleeve_version OR
    OLD.created_at IS NOT NEW.created_at OR
    OLD.state <> 'active' OR NEW.state <> 'revoked' OR
    NEW.version <> OLD.version + 1 OR
    NEW.updated_at < OLD.updated_at
BEGIN
    SELECT RAISE(ABORT, 'sleeve grant immutable binding or revocation failed');
END;

CREATE TRIGGER IF NOT EXISTS agent_tool_grants_guard_update
BEFORE UPDATE ON agent_tool_grants
WHEN
    OLD.grant_id IS NOT NEW.grant_id OR
    OLD.agent_id IS NOT NEW.agent_id OR
    OLD.tool_id IS NOT NEW.tool_id OR
    OLD.authority_layer IS NOT NEW.authority_layer OR
    OLD.access IS NOT NEW.access OR
    OLD.purpose IS NOT NEW.purpose OR
    OLD.sensitivity_cap IS NOT NEW.sensitivity_cap OR
    OLD.expires_at IS NOT NEW.expires_at OR
    OLD.bound_agent_version IS NOT NEW.bound_agent_version OR
    OLD.bound_scope_version IS NOT NEW.bound_scope_version OR
    OLD.created_at IS NOT NEW.created_at OR
    OLD.state <> 'active' OR NEW.state <> 'revoked' OR
    NEW.version <> OLD.version + 1 OR
    NEW.updated_at < OLD.updated_at
BEGIN
    SELECT RAISE(ABORT, 'tool grant immutable binding or revocation failed');
END;

CREATE TRIGGER IF NOT EXISTS shared_approved_bundles_guard_update
BEFORE UPDATE ON shared_approved_bundles
WHEN
    OLD.bundle_id IS NOT NEW.bundle_id OR
    OLD.source_scope_id IS NOT NEW.source_scope_id OR
    OLD.source_scope_version IS NOT NEW.source_scope_version OR
    OLD.target_sleeve_id IS NOT NEW.target_sleeve_id OR
    OLD.target_scope_version IS NOT NEW.target_scope_version OR
    OLD.target_sleeve_version IS NOT NEW.target_sleeve_version OR
    OLD.purpose IS NOT NEW.purpose OR
    OLD.published_sensitivity IS NOT NEW.published_sensitivity OR
    OLD.fragments_json IS NOT NEW.fragments_json OR
    OLD.content_sha256 IS NOT NEW.content_sha256 OR
    OLD.reviewed_by IS NOT NEW.reviewed_by OR
    OLD.reviewed_at IS NOT NEW.reviewed_at OR
    OLD.expires_at IS NOT NEW.expires_at OR
    OLD.created_at IS NOT NEW.created_at OR
    OLD.state <> 'active' OR NEW.state <> 'revoked' OR
    NEW.version <> OLD.version + 1 OR
    NEW.updated_at < OLD.updated_at
BEGIN
    SELECT RAISE(ABORT, 'shared bundle immutable publication or revocation failed');
END;

CREATE TRIGGER IF NOT EXISTS control_scopes_no_delete
BEFORE DELETE ON control_scopes BEGIN SELECT RAISE(ABORT, 'control scopes cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS access_agents_no_delete
BEFORE DELETE ON access_agents BEGIN SELECT RAISE(ABORT, 'access agents cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS memory_sleeves_no_delete
BEFORE DELETE ON memory_sleeves BEGIN SELECT RAISE(ABORT, 'memory sleeves cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS agent_sleeve_grants_no_delete
BEFORE DELETE ON agent_sleeve_grants BEGIN SELECT RAISE(ABORT, 'sleeve grants cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS agent_tool_grants_no_delete
BEFORE DELETE ON agent_tool_grants BEGIN SELECT RAISE(ABORT, 'tool grants cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS shared_approved_bundles_no_delete
BEFORE DELETE ON shared_approved_bundles BEGIN SELECT RAISE(ABORT, 'shared bundles cannot be deleted'); END;
