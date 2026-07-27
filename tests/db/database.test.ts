import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClientDatabase, createDatabase, type DatabaseContext } from '../../src/db/database';

const projectRoot = join(__dirname, '..', '..');

describe('database initialization', () => {
  let temporaryRoot: string;
  const contexts: DatabaseContext[] = [];

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-db-test-'));
  });

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((context) => context.destroy()));
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('executes the exact core schema and additive migrations', async () => {
    const context = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    contexts.push(context);

    const tables = context.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'agency_metrics',
        'agent_runs',
        'audit_logs',
        'client_registry',
        'knowledge_scopes',
        'model_usage_events',
        'run_recovery_queue',
        'task_frequency_log',
        'jarvis_primary_schema',
        'artifact_scope_claims',
        'source_snapshot_claims',
        'run_completion_candidates',
        'work_queue_verification_holds'
      ])
    );
    const indexes = context.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_model_usage_client_recorded',
        'idx_model_usage_provider_route',
        'idx_knowledge_scopes_client',
        'idx_knowledge_scopes_parent',
        'idx_model_usage_recorded'
      ])
    );
    expect(context.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(
      context.sqlite
        .prepare(
          "SELECT schema_version AS schemaVersion FROM jarvis_primary_schema WHERE singleton_id = 'primary'"
        )
        .get()
    ).toEqual({ schemaVersion: 19 });
  });

  it('can reopen and initialize the same global database idempotently', async () => {
    const filename = join(temporaryRoot, 'jarvis.sqlite');
    const first = await createDatabase({ projectRoot, filename });
    await first.destroy();

    const second = await createDatabase({ projectRoot, filename });
    contexts.push(second);

    const tableCount = second.sqlite
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('client_registry') as { count: number };

    expect(tableCount.count).toBe(1);
  });

  it('never downgrades a newer primary schema marker during replay', async () => {
    const filename = join(temporaryRoot, 'newer-primary.sqlite');
    const first = await createDatabase({ projectRoot, filename });
    first.sqlite
      .prepare(
        "UPDATE jarvis_primary_schema SET schema_version = 20 WHERE singleton_id = 'primary'"
      )
      .run();
    await first.destroy();

    const second = await createDatabase({ projectRoot, filename });
    contexts.push(second);
    expect(
      second.sqlite
        .prepare(
          "SELECT schema_version AS schemaVersion FROM jarvis_primary_schema WHERE singleton_id = 'primary'"
        )
        .get()
    ).toEqual({ schemaVersion: 20 });
    expect(() =>
      second.sqlite
        .prepare(
          "UPDATE jarvis_primary_schema SET schema_version = 19 WHERE singleton_id = 'primary'"
        )
        .run()
    ).toThrow(/advance exactly once/iu);
  });

  it('initializes an isolated client database from the exact template schema', async () => {
    const client = await createClientDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'clients', 'acme_corp', 'memory', 'client.sqlite')
    });
    contexts.push(client);

    const tables = client.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual(
      expect.arrayContaining(['agent_scratchpad', 'crm_leads', 'task_history'])
    );
    expect(tables).not.toContain('client_registry');
  });

  it('supports an in-memory global database', async () => {
    const context = await createDatabase({ projectRoot, filename: ':memory:' });
    contexts.push(context);

    const table = context.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('agent_runs') as { name: string };

    expect(table.name).toBe('agent_runs');
  });

  it('allows repeated shutdown without closing the database twice', async () => {
    const context = await createDatabase({ projectRoot, filename: ':memory:' });

    await context.destroy();

    await expect(context.destroy()).resolves.toBeUndefined();
  });
});
