import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditRepository } from '../../src/db/audit-repository';
import { ClientRepository } from '../../src/db/client-repository';
import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import { RunRepository } from '../../src/db/run-repository';
import { TaskFrequencyRepository } from '../../src/db/task-frequency-repository';

const projectRoot = join(__dirname, '..', '..');

describe('dashboard repository projections', () => {
  let temporaryRoot: string;
  let database: GlobalDatabaseContext;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-dashboard-repositories-'));
    database = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    await new ClientRepository(database.db).create({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing',
      status: 'active',
      createdAt: '2026-07-18T17:00:00.000Z'
    });
  });

  afterEach(async () => {
    await database.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('returns bounded recent run summaries and all-status counts without sensitive fields', async () => {
    const runs = new RunRepository(database.db);
    await runs.createRunning({
      id: 'run-old-success',
      clientId: 'acme_corp',
      automation: 'daily-report',
      input: { secret: 'input' },
      workerId: 'worker-a',
      startedAt: '2026-07-18T17:00:00.000Z'
    });
    await runs.markSucceeded('run-old-success', {
      output: { secret: 'output' },
      completedAt: '2026-07-18T17:00:02.000Z'
    });
    await runs.createRunning({
      id: 'run-middle-failed',
      clientId: 'acme_corp',
      automation: 'daily-report',
      workerId: 'worker-b',
      startedAt: '2026-07-18T17:01:00.000Z'
    });
    await runs.markFailed('run-middle-failed', {
      errorMessage: 'sensitive stack detail',
      completedAt: '2026-07-18T17:01:02.000Z'
    });
    await runs.createRunning({
      id: 'run-new-running',
      clientId: 'acme_corp',
      automation: 'daily-report',
      workerId: 'worker-c',
      startedAt: '2026-07-18T17:02:00.000Z'
    });

    const summary = await runs.dashboardSummary(2);

    expect(summary).toEqual({
      counts: { pending: 0, running: 1, succeeded: 1, failed: 1 },
      recent: [
        {
          id: 'run-new-running',
          clientId: 'acme_corp',
          automation: 'daily-report',
          status: 'running',
          workerId: 'worker-c',
          startedAt: '2026-07-18T17:02:00.000Z',
          completedAt: null,
          parentRunId: null,
          // A root run inside a tenant sleeve is supervised by that sleeve's
          // manager, read from the run's own client_id edge.
          supervisor: {
            kind: 'sleeve_manager',
            id: 'sleeve:acme_corp',
            label: 'acme_corp sleeve manager',
            sleeveId: 'acme_corp',
            derivedFrom: 'client_id'
          }
        },
        {
          id: 'run-middle-failed',
          clientId: 'acme_corp',
          automation: 'daily-report',
          status: 'failed',
          workerId: 'worker-b',
          startedAt: '2026-07-18T17:01:00.000Z',
          completedAt: '2026-07-18T17:01:02.000Z',
          parentRunId: null,
          supervisor: {
            kind: 'sleeve_manager',
            id: 'sleeve:acme_corp',
            label: 'acme_corp sleeve manager',
            sleeveId: 'acme_corp',
            derivedFrom: 'client_id'
          }
        }
      ]
    });
    expect(JSON.stringify(summary)).not.toContain('secret');
    expect(JSON.stringify(summary)).not.toContain('sensitive stack');
  });

  it('attributes a delegated run to the run that spawned it, not to its sleeve', async () => {
    const runs = new RunRepository(database.db);
    await runs.createRunning({
      id: 'run-parent',
      clientId: 'acme_corp',
      automation: 'client-intake-review',
      workerId: 'worker-a',
      startedAt: '2026-07-18T18:00:00.000Z'
    });
    await runs.createRunning({
      id: 'run-child',
      clientId: 'acme_corp',
      automation: 'brief-drafting',
      parentRunId: 'run-parent',
      workerId: 'worker-a',
      startedAt: '2026-07-18T18:01:00.000Z'
    });

    const summary = await runs.dashboardSummary(1);

    expect(summary.recent[0]).toMatchObject({
      id: 'run-child',
      parentRunId: 'run-parent',
      supervisor: {
        kind: 'delegating_run',
        id: 'run-parent',
        // Humanized from the parent's automation name.
        label: 'client intake review',
        sleeveId: 'acme_corp',
        derivedFrom: 'parent_run_id'
      }
    });
  });

  it('returns bounded client cards with complete status counts', async () => {
    const clients = new ClientRepository(database.db);
    await clients.create({
      id: 'beta_labs',
      name: 'Beta Labs',
      profile: 'email_only',
      status: 'suspended',
      createdAt: '2026-07-18T17:01:00.000Z'
    });

    await expect(clients.dashboardSummary(1)).resolves.toEqual({
      counts: { total: 2, active: 1, suspended: 1 },
      items: [
        {
          id: 'beta_labs',
          name: 'Beta Labs',
          profile: 'email_only',
          status: 'suspended',
          createdAt: '2026-07-18T17:01:00.000Z'
        }
      ]
    });
    await expect(clients.dashboardSummary(0)).rejects.toThrow(RangeError);
  });

  it('returns bounded safe audit attention without descriptions or actions', async () => {
    const audits = new AuditRepository(database.db);
    await audits.record({
      severity: 'P2',
      clientId: 'acme_corp',
      runId: 'run-old',
      eventDescription: 'sensitive old audit detail',
      actions: ['sensitive action'],
      resolved: true,
      timestamp: '2026-07-18T17:00:00.000Z'
    });
    await audits.record({
      severity: 'P1',
      clientId: 'acme_corp',
      runId: 'run-new',
      eventDescription: 'sensitive new audit detail',
      actions: ['another sensitive action'],
      resolved: false,
      timestamp: '2026-07-18T17:01:00.000Z'
    });

    const summary = await audits.dashboardSummary(1);

    expect(summary).toEqual({
      unresolvedCount: 1,
      recent: [
        {
          id: 2,
          severity: 'P1',
          clientId: 'acme_corp',
          runId: 'run-new',
          resolved: false,
          timestamp: '2026-07-18T17:01:00.000Z'
        }
      ]
    });
    expect(JSON.stringify(summary)).not.toContain('sensitive');
    expect(JSON.stringify(summary)).not.toContain('actions');
  });

  it('validates dashboard limits and bounds frequency candidates in SQL order', async () => {
    const runs = new RunRepository(database.db);
    const audits = new AuditRepository(database.db);
    const frequency = new TaskFrequencyRepository(database.db);
    for (let index = 0; index < 6; index += 1) {
      for (let count = 0; count <= index; count += 1) {
        await frequency.recordExecution({
          taskSignature: `task-${index}`,
          durationSeconds: 1,
          executedAt: '2026-07-18T17:00:00.000Z'
        });
      }
    }

    await expect(frequency.findAtOrAbove(1, 3)).resolves.toEqual([
      expect.objectContaining({ taskSignature: 'task-5', executionCount: 6 }),
      expect.objectContaining({ taskSignature: 'task-4', executionCount: 5 }),
      expect.objectContaining({ taskSignature: 'task-3', executionCount: 4 })
    ]);
    await expect(runs.dashboardSummary(0)).rejects.toThrow(RangeError);
    await expect(audits.dashboardSummary(101)).rejects.toThrow(RangeError);
    await expect(frequency.findAtOrAbove(1, Number.POSITIVE_INFINITY)).rejects.toThrow(RangeError);
  });
});
