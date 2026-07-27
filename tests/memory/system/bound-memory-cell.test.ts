import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BoundMemoryCell,
  BoundMemoryCellPolicyError,
  type BoundMemoryCellBinding
} from '../../../src/memory/system/bound-memory-cell';
import { workflowSignatureForSteps } from '../../../src/memory/system/hashing';
import { TypedHybridMemorySystem } from '../../../src/memory/system/typed-hybrid-system';
import {
  AGENT_ID,
  createMemorySystemHarness,
  EVALUATED_AT,
  fragmentInput,
  OWNER_SCOPE_ID,
  retrievalAuthorization,
  SLEEVE_ID,
  type MemorySystemHarness
} from './memory-system-harness';

const RUN_ID = 'run-1';
const OTHER_RUN_ID = 'run-2';
const EXPIRES_AT = '2026-07-22T00:00:00.000Z';
const PROCEDURE_STEPS = ['open ledger', 'reconcile balances', 'sign off'];

function workingEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ownerScopeId: 'client:spoofed',
    sleeveId: 'client:spoofed',
    runId: OTHER_RUN_ID,
    slotKey: 'active_goal',
    content: `working state ${id}`,
    sensitivity: 'confidential',
    recordedAt: EVALUATED_AT,
    expiresAt: EXPIRES_AT,
    supersedesEntryId: null,
    ...overrides
  };
}

function consolidationCandidate(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ownerScopeId: 'client:spoofed',
    sleeveId: 'client:spoofed',
    targetStore: 'semantic',
    proposedKind: 'summary',
    title: 'Summary: close',
    content: 'Recurring close topic',
    sourceFragmentIds: ['episode-1'],
    evidenceCount: 1,
    temporalState: 'current',
    confidencePermille: 600,
    rationale: 'Recurred in the run.',
    plannerVersion: 'planner-1',
    proposedBy: 'jarvis',
    sensitivity: 'confidential',
    recordedAt: EVALUATED_AT,
    expiresAt: '2026-08-21T12:00:00.000Z',
    supersedesCandidateId: null,
    ...overrides
  };
}

function procedureCandidate(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ownerScopeId: 'client:spoofed',
    sleeveId: 'client:spoofed',
    workflowSignature: workflowSignatureForSteps(PROCEDURE_STEPS),
    title: 'Monthly close',
    steps: PROCEDURE_STEPS,
    successCount: 4,
    firstSeenAt: '2026-05-21T12:00:00.000Z',
    lastSeenAt: EVALUATED_AT,
    rationale: 'Succeeded four times.',
    plannerVersion: 'planner-1',
    proposedBy: 'jarvis',
    sensitivity: 'internal',
    recordedAt: EVALUATED_AT,
    expiresAt: '2026-08-21T12:00:00.000Z',
    supersedesCandidateId: null,
    ...overrides
  };
}

function compileInput() {
  return {
    ownerScopeId: 'client:spoofed',
    sleeveId: 'client:spoofed',
    totalCapacityTokens: 4_000,
    reservations: { output: 100, policy: 100, toolSchema: 100, workingState: 100, safety: 100 },
    maxFragmentsPerSource: 3,
    evaluatedAt: '2027-01-01T00:00:00.000Z',
    fragments: []
  };
}

describe('BoundMemoryCell', () => {
  let harness: MemorySystemHarness;
  let system: TypedHybridMemorySystem;

  beforeEach(async () => {
    harness = await createMemorySystemHarness();
    system = new TypedHybridMemorySystem({
      sqlite: harness.context.sqlite,
      access: harness.boundAccess
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  function binding(
    tier: BoundMemoryCellBinding['tier'],
    overrides: Partial<BoundMemoryCellBinding> = {}
  ): BoundMemoryCellBinding {
    return {
      agentId: AGENT_ID,
      ownerScopeId: OWNER_SCOPE_ID,
      sleeveId: SLEEVE_ID,
      runId: RUN_ID,
      tier,
      readAuthorization: retrievalAuthorization(harness.grantVersions),
      proposeAuthorization: {
        sleeveId: SLEEVE_ID,
        expectedSleeveVersion: 1,
        expectedOwnerScopeVersion: 1,
        permission: 'propose',
        purpose: 'memory_system_propose',
        sensitivity: 'confidential',
        grantVersions: harness.proposeGrantVersions
      },
      ...overrides
    };
  }

  it('reauthorizes a full cell and overwrites caller-controlled principal bindings', async () => {
    const cell = new BoundMemoryCell({
      system,
      access: harness.boundAccess,
      binding: binding('full')
    });

    const episode = await cell.write(
      fragmentInput('episode-1', {
        kind: 'episode',
        ownerScopeId: 'client:spoofed',
        sleeveId: 'client:spoofed'
      })
    );
    expect(episode).toMatchObject({
      ownerScopeId: OWNER_SCOPE_ID,
      sleeveId: SLEEVE_ID,
      kind: 'episode'
    });

    const working = cell.workingMemory();
    await expect(working?.record(workingEntry('working-1'))).resolves.toMatchObject({
      ownerScopeId: OWNER_SCOPE_ID,
      sleeveId: SLEEVE_ID,
      runId: RUN_ID
    });
    await expect(
      working?.read({
        ownerScopeId: 'client:spoofed',
        sleeveId: 'client:spoofed',
        runId: OTHER_RUN_ID,
        slotKey: null,
        evaluatedAt: '2027-01-01T00:00:00.000Z',
        limit: 10
      })
    ).resolves.toEqual([expect.objectContaining({ id: 'working-1', runId: RUN_ID })]);

    await expect(
      cell.consolidation()?.propose(consolidationCandidate('candidate-1'))
    ).resolves.toMatchObject({
      ownerScopeId: OWNER_SCOPE_ID,
      sleeveId: SLEEVE_ID,
      proposedBy: AGENT_ID
    });
    await expect(
      cell.procedures()?.propose(procedureCandidate('procedure-1'))
    ).resolves.toMatchObject({
      ownerScopeId: OWNER_SCOPE_ID,
      sleeveId: SLEEVE_ID,
      proposedBy: AGENT_ID
    });

    await expect(cell.compileContext(compileInput())).resolves.toMatchObject({
      ownerScopeId: OWNER_SCOPE_ID,
      sleeveId: SLEEVE_ID
    });
    await expect(
      cell.retrieve({
        authorization: {
          ...retrievalAuthorization(harness.grantVersions),
          sleeveId: 'client:spoofed',
          grantVersions: { ...harness.grantVersions, run: 99 }
        },
        text: 'cobalt reconciliation',
        limit: 10
      })
    ).resolves.toMatchObject({
      ownerScopeId: OWNER_SCOPE_ID,
      sleeveId: SLEEVE_ID,
      items: [expect.objectContaining({ id: 'episode-1' })]
    });
  });

  it('fails closed on stale, revoked, or over-cap proposal authority before delegate writes', async () => {
    const write = vi.spyOn(system, 'write');
    const stale = new BoundMemoryCell({
      system,
      access: harness.boundAccess,
      binding: binding('full', {
        proposeAuthorization: {
          ...binding('full').proposeAuthorization,
          grantVersions: { ...harness.proposeGrantVersions, run: 99 }
        }
      })
    });

    await expect(
      stale.write(fragmentInput('stale-episode', { kind: 'episode' }))
    ).rejects.toMatchObject({ code: 'MEMORY_ACCESS_DENIED' });
    expect(write).not.toHaveBeenCalled();

    const cell = new BoundMemoryCell({
      system,
      access: harness.boundAccess,
      binding: binding('full')
    });
    await expect(
      cell.write(
        fragmentInput('over-cap-episode', {
          kind: 'episode',
          sensitivity: 'restricted'
        })
      )
    ).rejects.toMatchObject({ code: 'MEMORY_ACCESS_DENIED' });
    expect(write).not.toHaveBeenCalled();

    await harness.access.revokeSleeveGrant({
      id: `sleeve-grant:${AGENT_ID}-acme-propose-run`,
      expectedVersion: 1,
      revokedAt: '2026-07-21T12:00:01.000Z'
    });
    await expect(
      cell.write(fragmentInput('revoked-episode', { kind: 'episode' }))
    ).rejects.toMatchObject({ code: 'MEMORY_ACCESS_DENIED' });
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps a run-bounded cell to working and episodic stores with no denied delegate I/O', async () => {
    const write = vi.spyOn(system, 'write');
    const consolidation = system.consolidation();
    const procedures = system.procedures();
    const proposeConsolidation = vi.spyOn(consolidation, 'propose');
    const listConsolidation = vi.spyOn(consolidation, 'listOpen');
    const proposeProcedure = vi.spyOn(procedures, 'propose');
    const listProcedures = vi.spyOn(procedures, 'listOpen');
    const cell = new BoundMemoryCell({
      system,
      access: harness.boundAccess,
      binding: binding('run_bounded')
    });

    await expect(
      cell.write(fragmentInput('worker-episode', { kind: 'episode' }))
    ).resolves.toMatchObject({ kind: 'episode', sleeveId: SLEEVE_ID });
    expect(write).toHaveBeenCalledTimes(1);

    await expect(cell.write(fragmentInput('worker-fact', { kind: 'fact' }))).rejects.toBeInstanceOf(
      BoundMemoryCellPolicyError
    );
    await expect(
      cell.write(fragmentInput('worker-procedure', { kind: 'procedure' }))
    ).rejects.toBeInstanceOf(BoundMemoryCellPolicyError);
    expect(write).toHaveBeenCalledTimes(1);

    await expect(
      cell.consolidation()?.propose(consolidationCandidate('worker-candidate'))
    ).rejects.toBeInstanceOf(BoundMemoryCellPolicyError);
    await expect(
      cell.consolidation()?.listOpen({
        ownerScopeId: OWNER_SCOPE_ID,
        sleeveId: SLEEVE_ID,
        targetStore: null,
        evaluatedAt: EVALUATED_AT,
        limit: 10
      })
    ).rejects.toBeInstanceOf(BoundMemoryCellPolicyError);
    await expect(
      cell.procedures()?.propose(procedureCandidate('worker-procedure-candidate'))
    ).rejects.toBeInstanceOf(BoundMemoryCellPolicyError);
    await expect(
      cell.procedures()?.listOpen({
        ownerScopeId: OWNER_SCOPE_ID,
        sleeveId: SLEEVE_ID,
        evaluatedAt: EVALUATED_AT,
        limit: 10
      })
    ).rejects.toBeInstanceOf(BoundMemoryCellPolicyError);

    expect(proposeConsolidation).not.toHaveBeenCalled();
    expect(listConsolidation).not.toHaveBeenCalled();
    expect(proposeProcedure).not.toHaveBeenCalled();
    expect(listProcedures).not.toHaveBeenCalled();
  });
});
