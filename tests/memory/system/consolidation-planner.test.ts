import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MemoryConsolidationRunner,
  planMemoryConsolidation
} from '../../../src/memory/system/consolidation-planner';
import { FlatLexicalMemorySystem } from '../../../src/memory/system/flat-lexical-system';
import { TypedHybridMemorySystem } from '../../../src/memory/system/typed-hybrid-system';
import {
  AGENT_ID,
  createMemorySystemHarness,
  EVALUATED_AT,
  OWNER_SCOPE_ID,
  SLEEVE_ID,
  type MemorySystemHarness
} from './memory-system-harness';

const ONE_HOUR = 3_600_000;
const ONE_YEAR = 31_536_000_000;
const THIRTY_DAYS = 2_592_000_000;

function episode(fragmentId: string, topicKeys: string[], overrides: Record<string, unknown> = {}) {
  return {
    fragmentId,
    kind: 'episode',
    title: `Episode ${fragmentId}`,
    topicKeys,
    recordedAt: '2026-07-19T12:00:00.000Z',
    sensitivity: 'confidential',
    ...overrides
  };
}

function workflow(steps: string[], outcome: 'success' | 'failure', observedAt: string) {
  return {
    steps,
    outcome,
    observedAt,
    title: null,
    sourceFragmentId: null,
    sensitivity: 'internal'
  };
}

function planInput(overrides: Record<string, unknown> = {}) {
  return {
    ownerScopeId: OWNER_SCOPE_ID,
    sleeveId: SLEEVE_ID,
    proposedBy: AGENT_ID,
    plannerVersion: 'planner-1',
    evaluatedAt: EVALUATED_AT,
    candidateTtlMs: THIRTY_DAYS,
    historicalAfterMs: ONE_YEAR,
    minEpisodesPerTopic: 3,
    minSuccessesPerWorkflow: 2,
    maxProposals: 50,
    episodes: [
      episode('frag-a', ['close']),
      episode('frag-b', ['close']),
      episode('frag-c', ['close']),
      episode('frag-d', ['onboarding'])
    ],
    workflows: [
      workflow(['open ledger', 'reconcile', 'sign off'], 'success', '2026-07-10T12:00:00.000Z'),
      workflow(['Open ledger', 'reconcile', 'sign off'], 'success', '2026-07-12T12:00:00.000Z'),
      workflow(['open ledger', 'reconcile', 'sign off'], 'failure', '2026-07-13T12:00:00.000Z')
    ],
    ...overrides
  };
}

describe('memory consolidation planner (pure)', () => {
  it('is deterministic for identical input', () => {
    expect(planMemoryConsolidation(planInput())).toEqual(planMemoryConsolidation(planInput()));
  });

  it('proposes a semantic summary only once a topic clears the episode threshold', () => {
    const plan = planMemoryConsolidation(planInput());
    expect(plan.consolidations).toHaveLength(1);
    const [candidate] = plan.consolidations;
    expect(candidate).toMatchObject({
      targetStore: 'semantic',
      proposedKind: 'summary',
      evidenceCount: 3,
      temporalState: 'current'
    });
    expect(candidate?.sourceFragmentIds).toEqual(['frag-a', 'frag-b', 'frag-c']);
    expect(plan.summary.topicsProposed).toBe(1);
  });

  it('skips non-episodic kinds and counts them', () => {
    const plan = planMemoryConsolidation(
      planInput({
        episodes: [
          episode('frag-a', ['close']),
          episode('frag-b', ['close']),
          episode('frag-c', ['close']),
          episode('frag-x', ['close'], { kind: 'fact' })
        ]
      })
    );
    expect(plan.summary.episodesSkippedNonEpisodic).toBe(1);
    expect(plan.consolidations[0]?.evidenceCount).toBe(3);
  });

  it('marks a topic historical when its newest episode is stale', () => {
    const plan = planMemoryConsolidation(planInput({ historicalAfterMs: ONE_HOUR }));
    expect(plan.consolidations[0]?.temporalState).toBe('historical');
  });

  it('promotes a workflow that succeeds enough times, ignoring failures and wording', () => {
    const plan = planMemoryConsolidation(planInput());
    expect(plan.procedures).toHaveLength(1);
    expect(plan.procedures[0]).toMatchObject({ successCount: 2 });
    expect(plan.summary.workflowsProposed).toBe(1);
  });

  it('never emits an auto-supersession pointer', () => {
    const plan = planMemoryConsolidation(planInput());
    for (const candidate of [...plan.consolidations, ...plan.procedures]) {
      expect(candidate.supersedesCandidateId).toBeNull();
    }
  });
});

describe('memory consolidation runner (driver)', () => {
  let harness: MemorySystemHarness;

  beforeEach(async () => {
    harness = await createMemorySystemHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('persists proposals through the typed-hybrid backend, idempotently', async () => {
    const system = new TypedHybridMemorySystem({
      sqlite: harness.context.sqlite,
      access: harness.boundAccess
    });
    const runner = new MemoryConsolidationRunner(system);

    const first = await runner.run(planInput());
    expect(first.consolidationReceipts).toHaveLength(1);
    expect(first.procedureReceipts).toHaveLength(1);

    const second = await runner.run(planInput());
    expect(second.consolidationReceipts).toEqual(first.consolidationReceipts);
    expect(second.procedureReceipts).toEqual(first.procedureReceipts);

    const open = await system.consolidation().listOpen({
      ownerScopeId: OWNER_SCOPE_ID,
      sleeveId: SLEEVE_ID,
      targetStore: null,
      evaluatedAt: '2026-07-21T18:00:00.000Z',
      limit: 10
    });
    expect(open).toHaveLength(1);
  });

  it('fails closed on a backend without the propose-only stores', async () => {
    const flat = new FlatLexicalMemorySystem({
      sqlite: harness.context.sqlite,
      access: harness.boundAccess
    });
    const runner = new MemoryConsolidationRunner(flat);
    await expect(runner.run(planInput())).rejects.toMatchObject({
      code: 'MEMORY_SYSTEM_UNSUPPORTED'
    });
  });
});
