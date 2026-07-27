import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';

const projectRoot = join(__dirname, '..', '..');

describe('verification freeze migration', () => {
  const contexts: GlobalDatabaseContext[] = [];
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((context) => context.destroy()));
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  async function open(filename?: string): Promise<GlobalDatabaseContext> {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-verification-freeze-migration-'));
    temporaryRoots.push(temporaryRoot);
    const context = await createDatabase({
      projectRoot,
      filename: filename ?? join(temporaryRoot, 'jarvis.sqlite')
    });
    contexts.push(context);
    return context;
  }

  it('installs the immutable claim, source, candidate, and hold substrate', async () => {
    const context = await open();
    const objects = context.sqlite
      .prepare(
        `SELECT type, name
         FROM sqlite_master
         WHERE name LIKE 'artifact_scope_%'
            OR name LIKE 'source_snapshot_%'
            OR name LIKE 'run_completion_%'
            OR name LIKE 'work_queue_verification_%'
            OR name LIKE 'idx_artifact_scope_%'
            OR name = 'work_queue_tasks_hold_fence'
         ORDER BY type, name`
      )
      .all() as Array<{ type: string; name: string }>;

    expect(objects.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'artifact_scope_claims',
        'source_snapshot_claims',
        'run_completion_candidates',
        'work_queue_verification_holds',
        'idx_artifact_scope_claims_one_active_scope',
        'artifact_scope_claims_immutable_ownership',
        'artifact_scope_claims_guard_transition',
        'source_snapshot_claims_no_update',
        'source_snapshot_claims_no_delete',
        'run_completion_candidates_no_update',
        'run_completion_candidates_no_delete',
        'work_queue_verification_holds_guard_update',
        'work_queue_verification_holds_no_delete',
        'work_queue_tasks_hold_fence'
      ])
    );
    const holdBindingTrigger = context.sqlite
      .prepare(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'trigger' AND name = 'work_queue_verification_holds_validate_binding'`
      )
      .get() as { sql: string };
    expect(holdBindingTrigger.sql).toContain('task.lease_expires_at > NEW.created_at');
    expect(holdBindingTrigger.sql).toContain('posture.version = NEW.captured_posture_version');
    expect(holdBindingTrigger.sql).toContain("posture.posture = 'active'");
  });

  it('replays the additive migration on an existing database', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-verification-freeze-replay-'));
    temporaryRoots.push(temporaryRoot);
    const filename = join(temporaryRoot, 'jarvis.sqlite');
    const first = await createDatabase({ projectRoot, filename });
    await first.destroy();

    const second = await createDatabase({ projectRoot, filename });
    contexts.push(second);
    const counts = second.sqlite
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name = 'work_queue_verification_holds') AS hold_tables,
           (SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index' AND name = 'idx_artifact_scope_claims_one_active_scope') AS scope_indexes`
      )
      .get() as { hold_tables: number; scope_indexes: number };

    expect(counts).toEqual({ hold_tables: 1, scope_indexes: 1 });
  });
});
