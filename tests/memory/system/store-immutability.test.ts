import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { workflowSignatureForSteps } from '../../../src/memory/system/hashing';
import { TypedHybridMemorySystem } from '../../../src/memory/system/typed-hybrid-system';
import {
  AGENT_ID,
  createMemorySystemHarness,
  EVALUATED_AT,
  OWNER_SCOPE_ID,
  SLEEVE_ID,
  type MemorySystemHarness
} from './memory-system-harness';

const STEPS = ['open ledger', 'reconcile balances', 'sign off'];

function workingEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wm-1',
    ownerScopeId: OWNER_SCOPE_ID,
    sleeveId: SLEEVE_ID,
    runId: 'run-1',
    slotKey: 'active_goal',
    content: 'draft plan',
    sensitivity: 'confidential',
    recordedAt: EVALUATED_AT,
    expiresAt: '2026-07-22T00:00:00.000Z',
    supersedesEntryId: null,
    ...overrides
  };
}

function consolidation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'memcons-1',
    ownerScopeId: OWNER_SCOPE_ID,
    sleeveId: SLEEVE_ID,
    targetStore: 'semantic',
    proposedKind: 'summary',
    title: 'Summary: close',
    content: 'Recurring close topic',
    sourceFragmentIds: ['frag-a', 'frag-b'],
    evidenceCount: 2,
    temporalState: 'current',
    confidencePermille: 600,
    rationale: 'Recurred twice.',
    plannerVersion: 'planner-1',
    proposedBy: AGENT_ID,
    sensitivity: 'confidential',
    recordedAt: EVALUATED_AT,
    expiresAt: '2026-08-21T12:00:00.000Z',
    supersedesCandidateId: null,
    ...overrides
  };
}

function procedure(overrides: Record<string, unknown> = {}) {
  return {
    id: 'memproc-1',
    ownerScopeId: OWNER_SCOPE_ID,
    sleeveId: SLEEVE_ID,
    workflowSignature: workflowSignatureForSteps(STEPS),
    title: 'Monthly close',
    steps: STEPS,
    successCount: 4,
    firstSeenAt: '2026-05-21T12:00:00.000Z',
    lastSeenAt: EVALUATED_AT,
    rationale: 'Succeeded 4 times.',
    plannerVersion: 'planner-1',
    proposedBy: AGENT_ID,
    sensitivity: 'internal',
    recordedAt: EVALUATED_AT,
    expiresAt: '2026-08-21T12:00:00.000Z',
    supersedesCandidateId: null,
    ...overrides
  };
}

describe('typed store immutability', () => {
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

  it('working memory: idempotent re-record, conflict on divergent content', async () => {
    const store = system.workingMemory();
    const first = await store.record(workingEntry());
    expect(await store.record(workingEntry())).toEqual(first);
    await expect(store.record(workingEntry({ content: 'different' }))).rejects.toMatchObject({
      code: 'WORKING_MEMORY_CONFLICT'
    });
  });

  it('consolidation: idempotent re-propose, conflict on divergent content', async () => {
    const store = system.consolidation();
    const first = await store.propose(consolidation());
    expect(await store.propose(consolidation())).toEqual(first);
    await expect(store.propose(consolidation({ content: 'different' }))).rejects.toMatchObject({
      code: 'CONSOLIDATION_CANDIDATE_CONFLICT'
    });
  });

  it('procedure: idempotent re-propose, conflict on divergent content', async () => {
    const store = system.procedures();
    const first = await store.propose(procedure());
    expect(await store.propose(procedure())).toEqual(first);
    await expect(store.propose(procedure({ title: 'Renamed close' }))).rejects.toMatchObject({
      code: 'PROCEDURE_CANDIDATE_CONFLICT'
    });
  });

  it('procedure supersession drops the prior candidate from the open list', async () => {
    const store = system.procedures();
    await store.propose(procedure());
    const nextSteps = ['open ledger', 'reconcile balances', 'sign off', 'archive'];
    await store.propose(
      procedure({
        id: 'memproc-2',
        workflowSignature: workflowSignatureForSteps(nextSteps),
        steps: nextSteps,
        successCount: 5,
        supersedesCandidateId: 'memproc-1'
      })
    );
    const open = await store.listOpen({
      ownerScopeId: OWNER_SCOPE_ID,
      sleeveId: SLEEVE_ID,
      evaluatedAt: '2026-07-21T18:00:00.000Z',
      limit: 10
    });
    expect(open.map((candidate) => candidate.id)).toEqual(['memproc-2']);
  });

  it('typed-hybrid compiles context identically to the substrate path', () => {
    const compiled = system.compileContext({
      ownerScopeId: OWNER_SCOPE_ID,
      sleeveId: SLEEVE_ID,
      totalCapacityTokens: 2_000,
      reservations: { output: 50, policy: 50, toolSchema: 50, workingState: 50, safety: 50 },
      maxFragmentsPerSource: 2,
      evaluatedAt: EVALUATED_AT,
      fragments: []
    });
    expect(compiled.status).toBe('ready');
    expect(compiled.selected).toEqual([]);
  });
});
