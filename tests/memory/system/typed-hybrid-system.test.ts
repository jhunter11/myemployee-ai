import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

const LATER = '2026-07-21T18:00:00.000Z';
const AFTER_EXPIRY = '2026-07-22T06:00:00.000Z';

function workingEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ownerScopeId: OWNER_SCOPE_ID,
    sleeveId: SLEEVE_ID,
    runId: 'run-1',
    slotKey: 'active_goal',
    content: `working state ${id}`,
    sensitivity: 'confidential',
    recordedAt: EVALUATED_AT,
    expiresAt: '2026-07-22T00:00:00.000Z',
    supersedesEntryId: null,
    ...overrides
  };
}

function consolidationCandidate(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
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

describe('typed-hybrid memory system (backend B)', () => {
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

  it('exposes all typed stores and stays interchangeable on the core path', async () => {
    expect(system.id).toBe('typed_hybrid');
    expect(system.capabilities).toMatchObject({
      workingMemory: true,
      consolidation: true,
      proceduralPromotion: true
    });
    expect(system.workingMemory()).not.toBeNull();

    await system.write(fragmentInput('acme_close'));
    const result = await system.retrieve({
      authorization: retrievalAuthorization(harness.grantVersions),
      text: 'cobalt close',
      limit: 10
    });
    expect(result.items.map((item) => item.id)).toEqual(['acme_close']);
  });

  describe('working memory', () => {
    it('records, supersedes within a run, and returns only the head entry', async () => {
      const store = system.workingMemory();
      await store.record(workingEntry('wm-1'));
      await store.record(
        workingEntry('wm-2', { supersedesEntryId: 'wm-1', content: 'refined goal' })
      );

      const live = await store.read({
        ownerScopeId: OWNER_SCOPE_ID,
        sleeveId: SLEEVE_ID,
        runId: 'run-1',
        slotKey: 'active_goal',
        evaluatedAt: LATER,
        limit: 10
      });
      expect(live.map((entry) => entry.id)).toEqual(['wm-2']);
      expect(live[0]?.supersededByEntryId).toBeNull();
    });

    it('never returns another run and honors expiry', async () => {
      const store = system.workingMemory();
      await store.record(workingEntry('wm-1'));
      await store.record(workingEntry('wm-other', { runId: 'run-2' }));

      const runOne = await store.read({
        ownerScopeId: OWNER_SCOPE_ID,
        sleeveId: SLEEVE_ID,
        runId: 'run-1',
        slotKey: null,
        evaluatedAt: LATER,
        limit: 10
      });
      expect(runOne.map((entry) => entry.id)).toEqual(['wm-1']);

      const expired = await store.read({
        ownerScopeId: OWNER_SCOPE_ID,
        sleeveId: SLEEVE_ID,
        runId: 'run-1',
        slotKey: null,
        evaluatedAt: AFTER_EXPIRY,
        limit: 10
      });
      expect(expired).toEqual([]);
    });

    it('fails closed on an unregistered sleeve or an over-cap sensitivity', async () => {
      const store = system.workingMemory();
      await expect(
        store.record(workingEntry('wm-x', { sleeveId: 'client:beta_labs' }))
      ).rejects.toMatchObject({ code: 'WORKING_MEMORY_SLEEVE_INVALID' });
      await expect(
        store.record(workingEntry('wm-y', { sensitivity: 'restricted' }))
      ).rejects.toMatchObject({ code: 'WORKING_MEMORY_SENSITIVITY_INVALID' });
    });
  });

  describe('consolidation proposals', () => {
    it('proposes idempotently and lists only open candidates', async () => {
      const store = system.consolidation();
      const first = await store.propose(consolidationCandidate('memcons-1'));
      const again = await store.propose(consolidationCandidate('memcons-1'));
      expect(again).toEqual(first);

      const open = await store.listOpen({
        ownerScopeId: OWNER_SCOPE_ID,
        sleeveId: SLEEVE_ID,
        targetStore: null,
        evaluatedAt: LATER,
        limit: 10
      });
      expect(open.map((candidate) => candidate.id)).toEqual(['memcons-1']);
    });

    it('supersedes a prior candidate and drops it from the open list', async () => {
      const store = system.consolidation();
      await store.propose(consolidationCandidate('memcons-1'));
      await store.propose(
        consolidationCandidate('memcons-2', {
          supersedesCandidateId: 'memcons-1',
          content: 'Refined close topic',
          evidenceCount: 3,
          sourceFragmentIds: ['frag-a', 'frag-b', 'frag-c']
        })
      );

      const open = await store.listOpen({
        ownerScopeId: OWNER_SCOPE_ID,
        sleeveId: SLEEVE_ID,
        targetStore: 'semantic',
        evaluatedAt: LATER,
        limit: 10
      });
      expect(open.map((candidate) => candidate.id)).toEqual(['memcons-2']);
    });
  });

  describe('procedure proposals', () => {
    it('proposes a signature-checked procedure and rejects a mislabeled one', async () => {
      const store = system.procedures();
      const steps = ['open ledger', 'reconcile balances', 'sign off'];
      const signature = workflowSignatureForSteps(steps);
      const base = {
        id: 'memproc-1',
        ownerScopeId: OWNER_SCOPE_ID,
        sleeveId: SLEEVE_ID,
        workflowSignature: signature,
        title: 'Monthly close',
        steps,
        successCount: 4,
        firstSeenAt: '2026-05-21T12:00:00.000Z',
        lastSeenAt: EVALUATED_AT,
        rationale: 'Succeeded 4 times.',
        plannerVersion: 'planner-1',
        proposedBy: AGENT_ID,
        sensitivity: 'internal',
        recordedAt: EVALUATED_AT,
        expiresAt: '2026-08-21T12:00:00.000Z',
        supersedesCandidateId: null
      };
      const receipt = await store.propose(base);
      expect(receipt.workflowSignature).toBe(signature);

      await expect(
        store.propose({ ...base, id: 'memproc-2', workflowSignature: 'a'.repeat(64) })
      ).rejects.toMatchObject({ code: 'PROCEDURE_SIGNATURE_MISMATCH' });

      const open = await store.listOpen({
        ownerScopeId: OWNER_SCOPE_ID,
        sleeveId: SLEEVE_ID,
        evaluatedAt: LATER,
        limit: 10
      });
      expect(open.map((candidate) => candidate.id)).toEqual(['memproc-1']);
    });
  });
});
