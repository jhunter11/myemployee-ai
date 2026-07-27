import SQLite from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { applyProgrammaticMigrations } from '../../src/db/programmatic-migrations';

// The legacy (pre-widening) shape of migration 003 — the exact table an existing
// production database carries before the cost-basis widening, including the leaf
// foreign key to client_registry. The migration must rebuild this in place.
const LEGACY_NARROW_TABLE = `
CREATE TABLE model_usage_events (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 40),
    client_id TEXT,
    operation TEXT NOT NULL CHECK (operation IN ('classification','extraction','drafting','summarization','synthesis','code','review')),
    provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
    model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 96),
    route TEXT NOT NULL CHECK (route IN ('local','economy','frontier')),
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    latency_ms INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('succeeded','failed','timeout','cancelled')),
    cost_basis TEXT NOT NULL CHECK (cost_basis IN ('observed','estimated','unknown')),
    cost_microusd INTEGER,
    pricing_version TEXT,
    CHECK (
        (cost_basis = 'unknown' AND cost_microusd IS NULL AND pricing_version IS NULL) OR
        (cost_basis = 'observed' AND cost_microusd IS NOT NULL) OR
        (cost_basis = 'estimated' AND cost_microusd IS NOT NULL AND pricing_version IS NOT NULL)
    ),
    FOREIGN KEY (client_id) REFERENCES client_registry(id)
);`;

/**
 * Builds a database in the pre-migration state a real production database would
 * be in: foreign-key enforcement on, the parent `client_registry` table present,
 * and the legacy narrow `model_usage_events` table created.
 */
function legacyDatabase(): SQLite.Database {
  const sqlite = new SQLite(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(
    'CREATE TABLE client_registry (id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64));'
  );
  sqlite.exec(LEGACY_NARROW_TABLE);
  return sqlite;
}

function insertRow(
  sqlite: SQLite.Database,
  id: string,
  basis: string,
  microUsd: number | null,
  clientId: string | null = null
): void {
  sqlite
    .prepare(
      `INSERT INTO model_usage_events (id, recorded_at, client_id, operation, provider, model, route, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, latency_ms, status, cost_basis, cost_microusd, pricing_version)
       VALUES (?, '2026-07-23T18:00:00.000Z', ?, 'classification', 'ollama', 'qwen2.5-coder', 'local', 10, 5, 0, 0, 100, 'succeeded', ?, ?, NULL)`
    )
    .run(id, clientId, basis, microUsd);
}

// The legacy (pre-expiry) shape of migration 026, plus the member table whose
// trigger names the parent by name — that reference is what makes a modern
// ALTER TABLE RENAME reparse the schema mid-rebuild.
const LEGACY_PROFILE_INSTANCES = `
CREATE TABLE agent_profile_instances (
    instance_id TEXT PRIMARY KEY,
    recipe_id TEXT NOT NULL,
    recipe_sha256 TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    scope_version INTEGER NOT NULL,
    knowledge_scope_id TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('planned', 'active')),
    version INTEGER NOT NULL
        CHECK ((state = 'planned' AND version = 1) OR (state = 'active' AND version = 2)),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    activated_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (recipe_id, scope_id),
    FOREIGN KEY (scope_id) REFERENCES control_scopes(scope_id),
    FOREIGN KEY (knowledge_scope_id) REFERENCES knowledge_scopes(scope_id)
);

CREATE TABLE agent_profile_instance_members (
    agent_id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    template_profile_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    profile_json TEXT NOT NULL,
    profile_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (instance_id) REFERENCES agent_profile_instances(instance_id)
);

CREATE TRIGGER agent_profile_instance_members_planned_insert
BEFORE INSERT ON agent_profile_instance_members
WHEN NOT EXISTS (
    SELECT 1 FROM agent_profile_instances
    WHERE instance_id = NEW.instance_id AND state = 'planned' AND version = 1
)
BEGIN
    SELECT RAISE(ABORT, 'agent profile instance members require a planned instance');
END;`;

const INSTANCE_ID = `profile-instance:${'0123456789abcdef'.repeat(2)}`;
const DIGEST = 'a'.repeat(64);

function legacyInstanceDatabase(): SQLite.Database {
  const sqlite = new SQLite(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec('CREATE TABLE control_scopes (scope_id TEXT PRIMARY KEY);');
  sqlite.exec('CREATE TABLE knowledge_scopes (scope_id TEXT PRIMARY KEY);');
  sqlite.prepare("INSERT INTO control_scopes (scope_id) VALUES ('client:acme_corp')").run();
  sqlite.prepare("INSERT INTO knowledge_scopes (scope_id) VALUES ('client:acme_corp')").run();
  sqlite.exec(LEGACY_PROFILE_INSTANCES);
  return sqlite;
}

function insertLegacyInstance(sqlite: SQLite.Database, instanceId = INSTANCE_ID): void {
  sqlite
    .prepare(
      `INSERT INTO agent_profile_instances (instance_id, recipe_id, recipe_sha256, scope_id, scope_version, knowledge_scope_id, manifest_json, manifest_sha256, approved_by, state, version, created_at, expires_at, activated_at, updated_at)
       VALUES (?, 'marketing', ?, 'client:acme_corp', 1, 'client:acme_corp', '{}', ?, 'operator:jack_hunter', 'planned', 1, '2026-07-25T20:00:00.000Z', '2026-07-25T22:00:00.000Z', NULL, '2026-07-25T20:00:00.000Z')`
    )
    .run(instanceId, DIGEST, DIGEST);
}

describe('programmatic migrations — add agent_profile_instances expiry', () => {
  it('rebuilds a legacy table, preserves rows, and accepts the expired state afterwards', () => {
    const sqlite = legacyInstanceDatabase();
    insertLegacyInstance(sqlite);

    applyProgrammaticMigrations(sqlite);

    expect(
      sqlite
        .prepare('SELECT instance_id, state, version, expired_at FROM agent_profile_instances')
        .all()
    ).toEqual([{ instance_id: INSTANCE_ID, state: 'planned', version: 1, expired_at: null }]);

    // The quarantine transition the legacy CHECK constraints could not express.
    expect(() =>
      sqlite
        .prepare(
          "UPDATE agent_profile_instances SET state = 'expired', version = 2, expired_at = '2026-07-25T23:00:00.000Z', updated_at = '2026-07-25T23:00:00.000Z' WHERE instance_id = ?"
        )
        .run(INSTANCE_ID)
    ).not.toThrow();

    // Quarantined leases free the recipe scope for a renewal; live ones do not.
    const renewalId = `profile-instance:${'f'.repeat(32)}`;
    expect(() => insertLegacyInstance(sqlite, renewalId)).not.toThrow();
    expect(() => insertLegacyInstance(sqlite, `profile-instance:${'e'.repeat(32)}`)).toThrow();

    const objects = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE tbl_name = 'agent_profile_instances' AND name IS NOT NULL"
      )
      .all()
      .map((row) => (row as { name: string }).name);
    expect(objects).toEqual(
      expect.arrayContaining([
        'idx_agent_profile_instances_state',
        'idx_agent_profile_instances_live_recipe_scope',
        'agent_profile_instances_planned_insert',
        'agent_profile_instances_governed_transition',
        'agent_profile_instances_no_delete'
      ])
    );
  });

  it('restores foreign-key enforcement and the member relationship after the rebuild', () => {
    const sqlite = legacyInstanceDatabase();
    insertLegacyInstance(sqlite);

    applyProgrammaticMigrations(sqlite);

    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(sqlite.pragma('legacy_alter_table', { simple: true })).toBe(0);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // The member trigger still resolves its parent by name after the rename.
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO agent_profile_instance_members VALUES ('pi-agency-marketing-0123456789abcdef', ?, 'agency-marketing', 0, '{}', ?, '2026-07-25T20:00:00.000Z')`
        )
        .run(INSTANCE_ID, DIGEST)
    ).not.toThrow();
  });

  it('is idempotent and leaves an already-rebuilt table untouched', () => {
    const sqlite = legacyInstanceDatabase();
    insertLegacyInstance(sqlite);
    applyProgrammaticMigrations(sqlite);

    applyProgrammaticMigrations(sqlite);

    expect(sqlite.prepare('SELECT instance_id FROM agent_profile_instances').all()).toEqual([
      { instance_id: INSTANCE_ID }
    ]);
  });
});

describe('programmatic migrations — widen model_usage_events cost_basis', () => {
  it('rebuilds a legacy narrow table, preserves rows, and accepts subscription/local afterwards', () => {
    const sqlite = legacyDatabase();
    insertRow(sqlite, 'legacy-row-1', 'unknown', null);

    // The legacy table rejects the new bases before migration.
    expect(() => insertRow(sqlite, 'blocked', 'subscription', null)).toThrow();

    applyProgrammaticMigrations(sqlite);

    // Old row preserved.
    const preserved = sqlite
      .prepare('SELECT id, cost_basis FROM model_usage_events WHERE id = ?')
      .get('legacy-row-1');
    expect(preserved).toEqual({ id: 'legacy-row-1', cost_basis: 'unknown' });

    // New bases now accepted with the correct cost relationship.
    expect(() => insertRow(sqlite, 'sub-row', 'subscription', null)).not.toThrow();
    expect(() => insertRow(sqlite, 'local-row', 'local', 0)).not.toThrow();
    // local must be exactly 0; subscription must be NULL.
    expect(() => insertRow(sqlite, 'bad-local', 'local', 500)).toThrow();
    expect(() => insertRow(sqlite, 'bad-sub', 'subscription', 7)).toThrow();

    // Indexes were recreated.
    const indexes = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='model_usage_events'"
      )
      .all()
      .map((row) => (row as { name: string }).name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_model_usage_recorded',
        'idx_model_usage_client_recorded',
        'idx_model_usage_provider_route'
      ])
    );
  });

  it('is idempotent: a second run leaves the widened table and its rows untouched', () => {
    const sqlite = legacyDatabase();
    insertRow(sqlite, 'row-a', 'unknown', null);
    applyProgrammaticMigrations(sqlite);
    insertRow(sqlite, 'row-b', 'subscription', null);

    applyProgrammaticMigrations(sqlite);

    const rows = sqlite
      .prepare('SELECT id FROM model_usage_events ORDER BY id')
      .all()
      .map((row) => (row as { id: string }).id);
    expect(rows).toEqual(['row-a', 'row-b']);
  });

  it('is a no-op when the table is absent', () => {
    const sqlite = new SQLite(':memory:');
    expect(() => applyProgrammaticMigrations(sqlite)).not.toThrow();
  });

  it('preserves the caller foreign_keys state and the client_registry relationship', () => {
    const sqlite = legacyDatabase();
    sqlite.prepare("INSERT INTO client_registry (id) VALUES ('client-1')").run();
    insertRow(sqlite, 'legacy-row', 'unknown', null);

    applyProgrammaticMigrations(sqlite);

    // Enforcement is restored to ON, and the rebuilt table still enforces the FK.
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    // A row referencing a non-existent client is rejected by the preserved FK.
    expect(() => insertRow(sqlite, 'orphan', 'local', 0, 'missing-client')).toThrow();
    // A row whose client_id references an existing parent is accepted.
    expect(() => insertRow(sqlite, 'linked', 'subscription', null, 'client-1')).not.toThrow();
  });
});
