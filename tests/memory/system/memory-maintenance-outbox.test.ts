import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccessControlRepository } from '../../../src/agents/access-control-repository';
import { createDatabase, type GlobalDatabaseContext } from '../../../src/db/database';
import { RunRepository } from '../../../src/db/run-repository';
import {
  MemoryMaintenanceOutboxRepository,
  type MemoryMaintenanceBinding
} from '../../../src/memory/system/memory-maintenance-outbox';

const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const STARTED_AT = '2026-07-25T12:00:00.000Z';
const COMPLETED_AT = '2026-07-25T12:00:05.000Z';
const LEASED_AT = '2026-07-25T12:01:00.000Z';

const binding: MemoryMaintenanceBinding = {
  jobKind: 'terminal_episode_and_consolidation',
  policyRevision: 'faceless-memory-v1',
  agentId: 'faceless-content-curator',
  expectedAgentVersion: 1,
  ownerScopeId: 'client:creator_lab',
  expectedOwnerScopeVersion: 1,
  sleeveId: 'client:creator_lab_marketing',
  expectedSleeveVersion: 1,
  purpose: 'faceless_run_memory',
  sensitivity: 'confidential',
  grantVersions: {
    blueprint: 1,
    operator: 1,
    tenant: 1,
    channel: 1,
    run: 1
  }
};

describe('memory maintenance outbox', () => {
  let temporaryRoot: string;
  let context: GlobalDatabaseContext;
  let runs: RunRepository;
  let outbox: MemoryMaintenanceOutboxRepository;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-memory-outbox-'));
    context = await createDatabase({
      projectRoot: PROJECT_ROOT,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    runs = new RunRepository(context.db);
    outbox = new MemoryMaintenanceOutboxRepository(context.db);

    await context.db
      .insertInto('client_registry')
      .values({
        id: 'creator_lab',
        name: 'Creator Lab',
        profile_type: 'content',
        status: 'active',
        created_at: STARTED_AT
      })
      .execute();

    const access = new AccessControlRepository(context.db, () => new Date(COMPLETED_AT));
    await access.registerScope({
      id: 'agency:agency',
      kind: 'agency',
      subjectId: 'agency',
      parentScopeId: null,
      trustDomain: 'agency',
      createdAt: STARTED_AT
    });
    await access.registerScope({
      id: binding.ownerScopeId,
      kind: 'client',
      subjectId: 'creator_lab',
      parentScopeId: 'agency:agency',
      trustDomain: 'agency',
      createdAt: STARTED_AT
    });
    await access.registerAgent({
      id: binding.agentId,
      homeScopeId: 'agency:agency',
      trustDomain: 'agency',
      profileRevision: 1,
      createdAt: STARTED_AT
    });
    await access.registerSleeve({
      id: binding.sleeveId,
      ownerScopeId: binding.ownerScopeId,
      maxSensitivity: 'confidential',
      expiresAt: null,
      createdAt: STARTED_AT
    });
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  async function createRunning(id = 'run-faceless-1'): Promise<void> {
    await runs.createRunning({
      id,
      clientId: 'creator_lab',
      automation: 'faceless-content',
      workerId: 'creator-lab-faceless-content',
      startedAt: STARTED_AT
    });
  }

  it('atomically commits success and one content-free maintenance job', async () => {
    await createRunning();

    const completed = await runs.markSucceeded('run-faceless-1', {
      output: { secretDraft: 'must never enter the outbox' },
      completedAt: COMPLETED_AT,
      memoryMaintenance: binding
    });

    expect(completed?.status).toBe('succeeded');
    const jobs = await outbox.listForRun('run-faceless-1');
    expect(jobs).toEqual([
      expect.objectContaining({
        runId: 'run-faceless-1',
        state: 'pending',
        attemptCount: 0,
        policyRevision: binding.policyRevision,
        sleeveId: binding.sleeveId
      })
    ]);

    const raw = context.sqlite
      .prepare('SELECT * FROM memory_maintenance_outbox WHERE run_id = ?')
      .get('run-faceless-1') as Record<string, unknown>;
    expect(JSON.stringify(raw)).not.toContain('must never enter the outbox');
    expect(Object.keys(raw)).not.toContain('output_json');

    await expect(
      runs.markSucceeded('run-faceless-1', {
        output: { secretDraft: 'different' },
        completedAt: '2026-07-25T12:00:06.000Z',
        memoryMaintenance: binding
      })
    ).resolves.toBeUndefined();
    await expect(outbox.listForRun('run-faceless-1')).resolves.toHaveLength(1);
  });

  it('rolls back the terminal transition if the bound outbox insert is invalid', async () => {
    await createRunning('run-atomic');

    await expect(
      runs.markSucceeded('run-atomic', {
        output: { ok: true },
        completedAt: COMPLETED_AT,
        memoryMaintenance: {
          ...binding,
          sleeveId: 'client:missing_sleeve'
        }
      })
    ).rejects.toBeDefined();

    await expect(runs.findById('run-atomic')).resolves.toMatchObject({
      status: 'running',
      completedAt: null
    });
    await expect(outbox.listForRun('run-atomic')).resolves.toEqual([]);
  });

  it('claims only terminal jobs and reclaims an expired lease deterministically', async () => {
    await createRunning();
    await runs.markSucceeded('run-faceless-1', {
      output: { ok: true },
      completedAt: COMPLETED_AT,
      memoryMaintenance: binding
    });

    const first = await outbox.claimNext({
      workerId: 'curator-a',
      leaseToken: 'lease-token-a',
      claimedAt: LEASED_AT,
      leaseExpiresAt: '2026-07-25T12:02:00.000Z'
    });
    expect(first).toMatchObject({
      state: 'leased',
      leaseOwner: 'curator-a',
      attemptCount: 1
    });

    await expect(
      outbox.claimNext({
        workerId: 'curator-b',
        leaseToken: 'lease-token-b',
        claimedAt: '2026-07-25T12:01:30.000Z',
        leaseExpiresAt: '2026-07-25T12:03:00.000Z'
      })
    ).resolves.toBeUndefined();

    const reclaimed = await outbox.claimNext({
      workerId: 'curator-b',
      leaseToken: 'lease-token-b',
      claimedAt: '2026-07-25T12:02:00.000Z',
      leaseExpiresAt: '2026-07-25T12:03:00.000Z'
    });
    expect(reclaimed).toMatchObject({
      id: first?.id,
      state: 'leased',
      leaseOwner: 'curator-b',
      attemptCount: 2
    });
  });

  it('records retry failure without changing the committed run status', async () => {
    await createRunning();
    await runs.markSucceeded('run-faceless-1', {
      output: { ok: true },
      completedAt: COMPLETED_AT,
      memoryMaintenance: binding
    });
    const claimed = await outbox.claimNext({
      workerId: 'curator-a',
      leaseToken: 'lease-token-a',
      claimedAt: LEASED_AT,
      leaseExpiresAt: '2026-07-25T12:02:00.000Z'
    });
    if (claimed === undefined) throw new Error('expected one claimed job');

    const retried = await outbox.retry({
      id: claimed.id,
      expectedVersion: claimed.version,
      leaseToken: 'lease-token-a',
      errorCode: 'SOURCE_NOT_READY',
      availableAt: '2026-07-25T12:05:00.000Z',
      recordedAt: '2026-07-25T12:01:15.000Z'
    });
    expect(retried).toMatchObject({
      state: 'pending',
      lastErrorCode: 'SOURCE_NOT_READY',
      attemptCount: 1
    });
    await expect(runs.findById('run-faceless-1')).resolves.toMatchObject({
      status: 'succeeded',
      output: { ok: true }
    });
  });

  it('completes a lease exactly once and leaves append-only lifecycle evidence', async () => {
    await createRunning();
    await runs.markFailed('run-faceless-1', {
      errorMessage: 'worker failed',
      completedAt: COMPLETED_AT,
      memoryMaintenance: binding
    });
    const claimed = await outbox.claimNext({
      workerId: 'curator-a',
      leaseToken: 'lease-token-a',
      claimedAt: LEASED_AT,
      leaseExpiresAt: '2026-07-25T12:02:00.000Z'
    });
    if (claimed === undefined) throw new Error('expected one claimed job');

    const completed = await outbox.complete({
      id: claimed.id,
      expectedVersion: claimed.version,
      leaseToken: 'lease-token-a',
      completedAt: '2026-07-25T12:01:30.000Z'
    });
    expect(completed).toMatchObject({
      state: 'completed',
      completedAt: '2026-07-25T12:01:30.000Z'
    });
    await expect(
      outbox.complete({
        id: claimed.id,
        expectedVersion: claimed.version,
        leaseToken: 'lease-token-a',
        completedAt: '2026-07-25T12:01:31.000Z'
      })
    ).resolves.toBeUndefined();

    const events = await outbox.listEvents(claimed.id);
    expect(events.map((event) => event.eventType)).toEqual(['queued', 'claimed', 'completed']);
    expect(JSON.stringify(events)).not.toContain('worker failed');
  });
});
