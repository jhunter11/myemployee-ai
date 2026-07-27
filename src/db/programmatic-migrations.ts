import type SQLite from 'better-sqlite3';

/**
 * Idempotent, code-level migrations for schema changes that a re-executed
 * `CREATE TABLE IF NOT EXISTS` cannot express — specifically widening a CHECK
 * constraint on an already-created table. Each step inspects the live schema and
 * acts only when the legacy shape is present, so it is safe to run on every
 * startup (fresh databases already carry the new shape and are skipped).
 */
export function applyProgrammaticMigrations(sqlite: SQLite.Database): void {
  widenModelUsageCostBasis(sqlite);
  addProfileInstanceExpiry(sqlite);
}

const WIDE_MODEL_USAGE_EVENTS = `
CREATE TABLE model_usage_events__wide (
    id TEXT PRIMARY KEY
        CHECK (length(id) BETWEEN 3 AND 128),
    recorded_at TEXT NOT NULL
        CHECK (length(recorded_at) BETWEEN 20 AND 40),
    client_id TEXT,
    operation TEXT NOT NULL
        CHECK (operation IN (
            'classification', 'extraction', 'drafting', 'summarization',
            'synthesis', 'code', 'review'
        )),
    provider TEXT NOT NULL
        CHECK (length(provider) BETWEEN 1 AND 32),
    model TEXT NOT NULL
        CHECK (length(model) BETWEEN 1 AND 96),
    route TEXT NOT NULL
        CHECK (route IN ('local', 'economy', 'frontier')),
    input_tokens INTEGER
        CHECK (input_tokens IS NULL OR (typeof(input_tokens) = 'integer' AND input_tokens BETWEEN 0 AND 2147483647)),
    output_tokens INTEGER
        CHECK (output_tokens IS NULL OR (typeof(output_tokens) = 'integer' AND output_tokens BETWEEN 0 AND 2147483647)),
    cache_read_tokens INTEGER
        CHECK (cache_read_tokens IS NULL OR (typeof(cache_read_tokens) = 'integer' AND cache_read_tokens BETWEEN 0 AND 2147483647)),
    cache_write_tokens INTEGER
        CHECK (cache_write_tokens IS NULL OR (typeof(cache_write_tokens) = 'integer' AND cache_write_tokens BETWEEN 0 AND 2147483647)),
    latency_ms INTEGER NOT NULL
        CHECK (typeof(latency_ms) = 'integer' AND latency_ms BETWEEN 0 AND 86400000),
    status TEXT NOT NULL
        CHECK (status IN ('succeeded', 'failed', 'timeout', 'cancelled')),
    cost_basis TEXT NOT NULL
        CHECK (cost_basis IN ('observed', 'estimated', 'unknown', 'subscription', 'local')),
    cost_microusd INTEGER
        CHECK (cost_microusd IS NULL OR (typeof(cost_microusd) = 'integer' AND cost_microusd BETWEEN 0 AND 1000000000000)),
    pricing_version TEXT
        CHECK (pricing_version IS NULL OR length(pricing_version) BETWEEN 1 AND 64),
    CHECK (
        (cost_basis = 'unknown' AND cost_microusd IS NULL AND pricing_version IS NULL) OR
        (cost_basis = 'subscription' AND cost_microusd IS NULL AND pricing_version IS NULL) OR
        (cost_basis = 'local' AND cost_microusd = 0 AND pricing_version IS NULL) OR
        (cost_basis = 'observed' AND cost_microusd IS NOT NULL) OR
        (cost_basis = 'estimated' AND cost_microusd IS NOT NULL AND pricing_version IS NOT NULL)
    ),
    FOREIGN KEY (client_id) REFERENCES client_registry(id)
);`;

const MODEL_USAGE_COLUMNS = [
  'id',
  'recorded_at',
  'client_id',
  'operation',
  'provider',
  'model',
  'route',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'latency_ms',
  'status',
  'cost_basis',
  'cost_microusd',
  'pricing_version'
].join(', ');

function widenModelUsageCostBasis(sqlite: SQLite.Database): void {
  const table = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_usage_events'")
    .get() as { sql: string } | undefined;
  // Table absent (schema not yet applied) or already widened → nothing to do.
  if (!table || table.sql.includes("'subscription'")) return;

  // SQLite's canonical table-redefinition procedure: foreign-key enforcement must
  // be disabled around a DROP/RENAME rebuild, and `PRAGMA foreign_keys` is a no-op
  // inside a transaction, so we toggle it OUTSIDE the transaction and restore the
  // caller's original state afterwards. `model_usage_events` is a leaf table (its
  // only foreign key points at client_registry; nothing references it), and rows
  // are copied verbatim, so no reference relationship changes — the widening only
  // relaxes a CHECK constraint. Enforcement is disabled purely so the rebuild does
  // not require the parent table to be resolvable mid-transaction.
  const foreignKeysEnabled = sqlite.pragma('foreign_keys', { simple: true }) === 1;
  if (foreignKeysEnabled) sqlite.pragma('foreign_keys = OFF');
  try {
    sqlite.transaction(() => {
      sqlite.exec(WIDE_MODEL_USAGE_EVENTS);
      sqlite.exec(
        `INSERT INTO model_usage_events__wide (${MODEL_USAGE_COLUMNS}) SELECT ${MODEL_USAGE_COLUMNS} FROM model_usage_events;`
      );
      sqlite.exec('DROP TABLE model_usage_events;');
      sqlite.exec('ALTER TABLE model_usage_events__wide RENAME TO model_usage_events;');
      sqlite.exec(
        'CREATE INDEX IF NOT EXISTS idx_model_usage_recorded ON model_usage_events (recorded_at DESC);'
      );
      sqlite.exec(
        'CREATE INDEX IF NOT EXISTS idx_model_usage_client_recorded ON model_usage_events (client_id, recorded_at DESC);'
      );
      sqlite.exec(
        'CREATE INDEX IF NOT EXISTS idx_model_usage_provider_route ON model_usage_events (provider, model, route, recorded_at DESC);'
      );
    })();
  } finally {
    if (foreignKeysEnabled) sqlite.pragma('foreign_keys = ON');
  }
}

const WIDE_AGENT_PROFILE_INSTANCES = `
CREATE TABLE agent_profile_instances__expiry (
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
`;

const AGENT_PROFILE_INSTANCE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_agent_profile_instances_state
    ON agent_profile_instances (state, created_at, instance_id);

-- One live lease per recipe scope. Quarantined leases are retained as immutable
-- history, so the uniqueness that governs instantiation excludes them and a
-- renewal can bind the same recipe scope to a new lease.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profile_instances_live_recipe_scope
    ON agent_profile_instances (recipe_id, scope_id)
    WHERE state <> 'expired';
`;

const AGENT_PROFILE_INSTANCE_TRIGGERS = `
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
`;

const PROFILE_INSTANCE_COLUMNS = [
  'instance_id',
  'recipe_id',
  'recipe_sha256',
  'scope_id',
  'scope_version',
  'knowledge_scope_id',
  'manifest_json',
  'manifest_sha256',
  'approved_by',
  'state',
  'version',
  'created_at',
  'expires_at',
  'activated_at',
  'updated_at'
].join(', ');

/**
 * Adds the quarantined `expired` lease state to `agent_profile_instances`.
 *
 * A database created before the expiry state already carries the table, so
 * `CREATE TABLE IF NOT EXISTS` in migration 026 is a no-op there and leaves the
 * narrow CHECK constraints in place. This rebuild replays 026's current shape.
 * The DDL below is the expiry-carrying half of 026 and must stay identical to
 * it; a fresh database gets that shape directly and skips this step.
 */
function addProfileInstanceExpiry(sqlite: SQLite.Database): void {
  const table = sqlite
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_profile_instances'"
    )
    .get() as { sql: string } | undefined;
  // Table absent (schema not yet applied) or already rebuilt → nothing to do.
  if (!table || table.sql.includes("'expired'")) return;

  // Same canonical table-redefinition procedure as the widening above:
  // foreign-key enforcement is toggled outside the transaction because
  // `PRAGMA foreign_keys` is a no-op inside one. `agent_profile_instance_members`
  // references this table by name, and the rebuild restores that exact name with
  // rows copied verbatim, so no reference relationship changes. Triggers and
  // indexes are dropped with the old table and recreated below.
  const foreignKeysEnabled = sqlite.pragma('foreign_keys', { simple: true }) === 1;
  if (foreignKeysEnabled) sqlite.pragma('foreign_keys = OFF');
  // `agent_profile_instance_members` carries a trigger that names this table.
  // A modern ALTER TABLE RENAME reparses every such reference to rewrite it, and
  // the target name is deliberately absent mid-rebuild, so the reparse fails.
  // Legacy rename semantics skip the fixup, which is what this rebuild wants:
  // the name is restored exactly, so no reference needs rewriting.
  sqlite.pragma('legacy_alter_table = ON');
  try {
    sqlite.transaction(() => {
      sqlite.exec(WIDE_AGENT_PROFILE_INSTANCES);
      sqlite.exec(
        `INSERT INTO agent_profile_instances__expiry (${PROFILE_INSTANCE_COLUMNS}) SELECT ${PROFILE_INSTANCE_COLUMNS} FROM agent_profile_instances;`
      );
      sqlite.exec('DROP TABLE agent_profile_instances;');
      sqlite.exec('ALTER TABLE agent_profile_instances__expiry RENAME TO agent_profile_instances;');
      sqlite.exec(AGENT_PROFILE_INSTANCE_INDEXES);
      sqlite.exec(AGENT_PROFILE_INSTANCE_TRIGGERS);
    })();
  } finally {
    sqlite.pragma('legacy_alter_table = OFF');
    if (foreignKeysEnabled) sqlite.pragma('foreign_keys = ON');
  }
}
