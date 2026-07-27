import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditRepository } from '../../src/db/audit-repository';
import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import { RunRepository } from '../../src/db/run-repository';
import { TaskFrequencyRepository } from '../../src/db/task-frequency-repository';

const projectRoot = join(__dirname, '..', '..');

describe('execution repositories', () => {
  let temporaryRoot: string;
  let context: GlobalDatabaseContext;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-execution-repositories-'));
    context = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    await context.db
      .insertInto('client_registry')
      .values({
        id: 'acme_corp',
        name: 'Acme Corporation',
        profile_type: 'data_processing',
        status: 'active',
        created_at: '2026-07-18T12:00:00.000Z'
      })
      .execute();
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  describe('RunRepository', () => {
    it('creates a running run with provenance and round-trips JSON input', async () => {
      const repository = new RunRepository(context.db);

      const created = await repository.createRunning({
        id: 'run_child',
        clientId: 'acme_corp',
        automation: 'daily-report',
        input: { filters: ['qualified'], dryRun: false },
        parentRunId: 'run_parent',
        workerId: 'data_worker',
        startedAt: '2026-07-18T14:00:00.000Z'
      });

      expect(created).toEqual({
        id: 'run_child',
        clientId: 'acme_corp',
        automation: 'daily-report',
        status: 'running',
        input: { filters: ['qualified'], dryRun: false },
        output: null,
        errorMessage: null,
        parentRunId: 'run_parent',
        workerId: 'data_worker',
        startedAt: '2026-07-18T14:00:00.000Z',
        completedAt: null
      });
      await expect(repository.findById('run_child')).resolves.toEqual(created);
      await expect(repository.findById('missing_run')).resolves.toBeUndefined();
    });

    it('rejects an unsafe run id before inserting a row', async () => {
      const repository = new RunRepository(context.db);

      await expect(
        repository.createRunning({
          id: '../escape',
          clientId: 'acme_corp',
          automation: 'daily-report',
          workerId: 'data_worker',
          startedAt: '2026-07-18T14:00:00.000Z'
        })
      ).rejects.toBeDefined();

      const count = await context.db
        .selectFrom('agent_runs')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();
      expect(Number(count.count)).toBe(0);
    });

    it('marks one running record succeeded with JSON output', async () => {
      const repository = new RunRepository(context.db);
      await repository.createRunning({
        id: 'run_success',
        clientId: 'acme_corp',
        automation: 'daily-report',
        workerId: 'data_worker',
        startedAt: '2026-07-18T14:00:00.000Z'
      });

      const completed = await repository.markSucceeded('run_success', {
        output: { qualifiedCount: 4, nested: { valid: true } },
        completedAt: '2026-07-18T14:00:02.000Z'
      });

      expect(completed).toMatchObject({
        id: 'run_success',
        status: 'succeeded',
        input: undefined,
        output: { qualifiedCount: 4, nested: { valid: true } },
        errorMessage: null,
        parentRunId: null,
        completedAt: '2026-07-18T14:00:02.000Z'
      });
      await expect(repository.findById('run_success')).resolves.toEqual(completed);
      await expect(
        repository.markSucceeded('missing_run', {
          output: null,
          completedAt: '2026-07-18T14:00:02.000Z'
        })
      ).resolves.toBeUndefined();
    });

    it('marks one running record failed without inventing output', async () => {
      const repository = new RunRepository(context.db);
      await repository.createRunning({
        id: 'run_failure',
        clientId: 'acme_corp',
        automation: 'daily-report',
        input: ['one', 2, null],
        parentRunId: null,
        workerId: 'data_worker',
        startedAt: '2026-07-18T14:00:00.000Z'
      });

      const failed = await repository.markFailed('run_failure', {
        errorMessage: 'CSV parsing failed',
        completedAt: '2026-07-18T14:00:01.000Z'
      });

      expect(failed).toMatchObject({
        status: 'failed',
        input: ['one', 2, null],
        output: null,
        errorMessage: 'CSV parsing failed',
        completedAt: '2026-07-18T14:00:01.000Z'
      });
      await expect(
        repository.markFailed('missing_run', {
          errorMessage: 'missing',
          completedAt: '2026-07-18T14:00:01.000Z'
        })
      ).resolves.toBeUndefined();
    });

    it('atomically marks interrupted runs failed and keeps recovery pending until cleared', async () => {
      const repository = new RunRepository(context.db);
      await repository.createRunning({
        id: 'run_interrupted',
        clientId: 'acme_corp',
        automation: 'daily-report',
        workerId: 'data_worker',
        startedAt: '2026-07-18T14:00:00.000Z'
      });

      const interrupted = await repository.markInterruptedForRecovery('run_interrupted', {
        errorMessage: 'Gateway stopped before completion',
        completedAt: '2026-07-18T14:00:01.000Z'
      });

      expect(interrupted).toMatchObject({
        id: 'run_interrupted',
        status: 'failed',
        errorMessage: 'Gateway stopped before completion',
        completedAt: '2026-07-18T14:00:01.000Z'
      });
      await expect(repository.listPendingRecovery()).resolves.toEqual([interrupted]);

      await expect(
        repository.markInterruptedForRecovery('run_interrupted', {
          errorMessage: 'A later retry must not rewrite the failure',
          completedAt: '2026-07-18T14:00:02.000Z'
        })
      ).resolves.toEqual(interrupted);
      await expect(repository.listPendingRecovery()).resolves.toEqual([interrupted]);
      await expect(repository.clearPendingRecovery('run_interrupted')).resolves.toBe(true);
      await expect(repository.clearPendingRecovery('run_interrupted')).resolves.toBe(false);
      await expect(repository.listPendingRecovery()).resolves.toEqual([]);
    });

    it('does not queue missing or already completed successful runs for recovery', async () => {
      const repository = new RunRepository(context.db);
      await expect(
        repository.markInterruptedForRecovery('missing_run', {
          errorMessage: 'Missing run',
          completedAt: '2026-07-18T14:00:01.000Z'
        })
      ).resolves.toBeUndefined();
      await repository.createRunning({
        id: 'run_already_succeeded',
        clientId: 'acme_corp',
        automation: 'daily-report',
        workerId: 'data_worker',
        startedAt: '2026-07-18T14:00:00.000Z'
      });
      await repository.markSucceeded('run_already_succeeded', {
        output: { ok: true },
        completedAt: '2026-07-18T14:00:01.000Z'
      });

      await expect(
        repository.markInterruptedForRecovery('run_already_succeeded', {
          errorMessage: 'Must not rewrite success',
          completedAt: '2026-07-18T14:00:02.000Z'
        })
      ).resolves.toBeUndefined();
      await expect(repository.listPendingRecovery()).resolves.toEqual([]);
    });

    it('validates completion data before changing a running row', async () => {
      const repository = new RunRepository(context.db);
      await repository.createRunning({
        id: 'run_guarded',
        clientId: 'acme_corp',
        automation: 'daily-report',
        workerId: 'data_worker',
        startedAt: '2026-07-18T14:00:00.000Z'
      });

      await expect(
        repository.markSucceeded('run_guarded', {
          output: { qualifiedCount: 4 },
          completedAt: 'not-a-timestamp'
        })
      ).rejects.toBeDefined();

      const raw = await context.db
        .selectFrom('agent_runs')
        .select(['status', 'completed_at'])
        .where('id', '=', 'run_guarded')
        .executeTakeFirstOrThrow();
      expect(raw).toEqual({ status: 'running', completed_at: null });
    });
  });

  describe('AuditRepository', () => {
    it('stores and reconstructs a deterministic P1 escalation envelope', async () => {
      const repository = new AuditRepository(context.db);
      const event = {
        severity: 'P1' as const,
        clientId: 'acme_corp',
        runId: 'run_failure',
        eventDescription: 'Automation daily-report failed',
        actions: ['persist_failure', 'request_patch'],
        resolved: false,
        timestamp: '2026-07-18T14:00:01.000Z'
      };

      const recorded = await repository.record(event);

      expect(recorded).toEqual({ id: 1, ...event });
      await expect(repository.findById(recorded.id)).resolves.toEqual(recorded);
      const raw = await context.db
        .selectFrom('audit_logs')
        .selectAll()
        .where('id', '=', recorded.id)
        .executeTakeFirstOrThrow();
      expect(raw).toMatchObject({
        severity: 'P1',
        client_id: 'acme_corp',
        resolved: 0,
        timestamp: '2026-07-18T14:00:01.000Z',
        event_description:
          '{"runId":"run_failure","eventDescription":"Automation daily-report failed","actions":["persist_failure","request_patch"]}'
      });
    });

    it('replays identical recovery audits without creating duplicates', async () => {
      const runs = new RunRepository(context.db);
      await runs.createRunning({
        id: 'run_recovery',
        clientId: 'acme_corp',
        automation: 'daily-report',
        workerId: 'data_worker',
        startedAt: '2026-07-18T14:00:00.000Z'
      });
      await runs.markInterruptedForRecovery('run_recovery', {
        errorMessage: 'Gateway stopped before completion',
        completedAt: '2026-07-18T14:00:01.000Z'
      });
      const repository = new AuditRepository(context.db);
      const event = {
        severity: 'P1' as const,
        clientId: 'acme_corp',
        runId: 'run_recovery',
        eventDescription: 'Interrupted run recovered during gateway startup',
        actions: ['persist_failure', 'request_patch'],
        resolved: false,
        timestamp: '2026-07-18T14:00:01.000Z'
      };

      const first = await repository.recordRecoveryOnce('run_recovery', event);
      const replay = await repository.recordRecoveryOnce('run_recovery', {
        ...event,
        eventDescription: 'Updated wording after a configuration change',
        actions: ['updated_action']
      });

      expect(replay).toEqual(first);
      const stored = await context.db.selectFrom('audit_logs').selectAll().execute();
      expect(stored).toHaveLength(1);
    });

    it('fails closed when a recovery audit and its durable marker do not match', async () => {
      const repository = new AuditRepository(context.db);
      const event = {
        severity: 'P1' as const,
        clientId: 'acme_corp',
        runId: 'run_expected',
        eventDescription: 'Interrupted run recovered during gateway startup',
        actions: ['inspect_recovery'],
        resolved: false,
        timestamp: '2026-07-18T14:00:01.000Z'
      };

      await expect(repository.recordRecoveryOnce('run_other', event)).rejects.toThrow(
        /does not match its durable marker/i
      );
      await expect(repository.recordRecoveryOnce('run_expected', event)).rejects.toThrow(
        /has no durable marker/i
      );
    });

    it('records the resolved state for a marked recovery audit', async () => {
      const runs = new RunRepository(context.db);
      await runs.createRunning({
        id: 'run_resolved_recovery',
        clientId: 'acme_corp',
        automation: 'daily-report',
        workerId: 'data_worker',
        startedAt: '2026-07-18T14:00:00.000Z'
      });
      await runs.markInterruptedForRecovery('run_resolved_recovery', {
        errorMessage: 'Gateway stopped before completion',
        completedAt: '2026-07-18T14:00:01.000Z'
      });

      const recorded = await new AuditRepository(context.db).recordRecoveryOnce(
        'run_resolved_recovery',
        {
          severity: 'P1',
          clientId: 'acme_corp',
          runId: 'run_resolved_recovery',
          eventDescription: 'Recovery was operator-confirmed',
          actions: ['none'],
          resolved: true,
          timestamp: '2026-07-18T14:00:01.000Z'
        }
      );

      expect(recorded.resolved).toBe(true);
    });

    it('fails closed when a durable recovery marker references missing audit evidence', async () => {
      const runs = new RunRepository(context.db);
      await runs.createRunning({
        id: 'run_missing_audit',
        clientId: 'acme_corp',
        automation: 'daily-report',
        workerId: 'data_worker',
        startedAt: '2026-07-18T14:00:00.000Z'
      });
      await runs.markInterruptedForRecovery('run_missing_audit', {
        errorMessage: 'Gateway stopped before completion',
        completedAt: '2026-07-18T14:00:01.000Z'
      });
      const repository = new AuditRepository(context.db);
      const event = {
        severity: 'P1' as const,
        clientId: 'acme_corp',
        runId: 'run_missing_audit',
        eventDescription: 'Interrupted run recovered during gateway startup',
        actions: ['inspect_recovery'],
        resolved: false,
        timestamp: '2026-07-18T14:00:01.000Z'
      };
      const recorded = await repository.recordRecoveryOnce('run_missing_audit', event);
      context.sqlite.pragma('foreign_keys = OFF');
      context.sqlite.prepare('DELETE FROM audit_logs WHERE id = ?').run(recorded.id);
      context.sqlite.pragma('foreign_keys = ON');

      await expect(repository.recordRecoveryOnce('run_missing_audit', event)).rejects.toThrow(
        /references a missing audit record/i
      );
    });

    it('supports global audit events and reports missing IDs', async () => {
      const repository = new AuditRepository(context.db);

      const recorded = await repository.record({
        severity: 'P1',
        clientId: null,
        runId: null,
        eventDescription: 'Heartbeat degraded',
        actions: ['inspect_infrastructure'],
        resolved: true,
        timestamp: '2026-07-18T15:00:00.000Z'
      });

      expect(recorded.clientId).toBeNull();
      expect(recorded.resolved).toBe(true);
      await expect(repository.findById(999)).resolves.toBeUndefined();
    });
  });

  describe('TaskFrequencyRepository', () => {
    it('uses an additive unique index for one row per task signature', () => {
      const indexes = context.sqlite
        .prepare("PRAGMA index_list('task_frequency_log')")
        .all() as Array<{ name: string; unique: number }>;

      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'idx_task_frequency_log_signature_unique',
            unique: 1
          })
        ])
      );
    });

    it('atomically increments count, rolling average, intervention count, and time', async () => {
      const repository = new TaskFrequencyRepository(context.db);

      await repository.recordExecution({
        taskSignature: 'acme_corp:daily-report',
        durationSeconds: 2,
        executedAt: '2026-07-18T14:00:02.000Z'
      });
      const updated = await repository.recordExecution({
        taskSignature: 'acme_corp:daily-report',
        durationSeconds: 4,
        executedAt: '2026-07-18T14:01:04.000Z',
        manualIntervention: true
      });

      expect(updated).toEqual({
        id: 1,
        taskSignature: 'acme_corp:daily-report',
        executionCount: 2,
        avgDurationSeconds: 3,
        lastExecutedAt: '2026-07-18T14:01:04.000Z',
        manualInterventionCount: 1
      });
      await expect(repository.findBySignature('acme_corp:daily-report')).resolves.toEqual(updated);
      await expect(repository.findBySignature('missing:task')).resolves.toBeUndefined();
    });

    it('does not lose concurrent increments', async () => {
      const repository = new TaskFrequencyRepository(context.db);
      const durations = Array.from({ length: 20 }, (_, index) => index + 1);

      await Promise.all(
        durations.map((durationSeconds, index) =>
          repository.recordExecution({
            taskSignature: 'acme_corp:daily-report',
            durationSeconds,
            executedAt: `2026-07-18T14:${String(index).padStart(2, '0')}:00.000Z`,
            manualIntervention: index % 4 === 0
          })
        )
      );

      const record = await repository.findBySignature('acme_corp:daily-report');
      expect(record).toMatchObject({
        executionCount: 20,
        avgDurationSeconds: 10.5,
        manualInterventionCount: 5
      });
    });

    it('does not regress the last execution timestamp for an out-of-order event', async () => {
      const repository = new TaskFrequencyRepository(context.db);
      await repository.recordExecution({
        taskSignature: 'acme_corp:daily-report',
        durationSeconds: 2,
        executedAt: '2026-07-18T15:00:00.000Z'
      });

      const record = await repository.recordExecution({
        taskSignature: 'acme_corp:daily-report',
        durationSeconds: 4,
        executedAt: '2026-07-18T14:00:00.000Z'
      });

      expect(record).toMatchObject({
        executionCount: 2,
        avgDurationSeconds: 3,
        lastExecutedAt: '2026-07-18T15:00:00.000Z'
      });
    });

    it('selects threshold candidates deterministically', async () => {
      const repository = new TaskFrequencyRepository(context.db);
      for (let index = 0; index < 5; index += 1) {
        await repository.recordExecution({
          taskSignature: 'zeta:task',
          durationSeconds: 1,
          executedAt: '2026-07-18T14:00:00.000Z'
        });
        await repository.recordExecution({
          taskSignature: 'alpha:task',
          durationSeconds: 1,
          executedAt: '2026-07-18T14:00:00.000Z'
        });
      }
      await repository.recordExecution({
        taskSignature: 'below:task',
        durationSeconds: 1,
        executedAt: '2026-07-18T14:00:00.000Z'
      });

      await expect(repository.findAtOrAbove(5)).resolves.toEqual([
        expect.objectContaining({ taskSignature: 'alpha:task', executionCount: 5 }),
        expect.objectContaining({ taskSignature: 'zeta:task', executionCount: 5 })
      ]);
    });
  });
});
