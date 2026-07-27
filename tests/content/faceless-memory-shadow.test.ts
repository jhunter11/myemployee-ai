import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runFacelessMemoryShadowPilot } from '../../src/content/faceless-memory-shadow';

const projectRoot = join(__dirname, '..', '..');

describe('faceless-content typed-memory shadow pilot', () => {
  it('gives later runs exact-sleeve episodic visibility without widening to a neighbour', async () => {
    const report = await runFacelessMemoryShadowPilot({ projectRoot });

    expect(report.binding).toEqual({
      agentId: 'faceless-content-shadow',
      ownerScopeId: 'client:creator_lab',
      sleeveId: 'client:creator_lab_marketing',
      purpose: 'faceless_memory_shadow',
      sensitivity: 'confidential'
    });
    expect(report.workingIsolation).toEqual({
      runAEntryIds: ['faceless-shadow-working-run-a'],
      runBEntryIds: [],
      passed: true
    });

    for (const arm of report.arms) {
      const priorEpisode = arm.cases.find(({ caseId }) => caseId === 'prior_episode');
      expect(priorEpisode?.retrievedFragmentIds).toContain('faceless-episode-run-a');
      expect(priorEpisode?.selectedFragmentId).toBe('faceless-episode-run-a');
      expect(arm.cases.flatMap(({ retrievedFragmentIds }) => retrievedFragmentIds)).not.toContain(
        'neighbor-episode-run-a'
      );
      expect(arm.metrics.scopeLeakageCount).toBe(0);
      expect(arm.metrics.forbiddenSelectionCount).toBe(0);
    }
  });

  it('suppresses stale evidence and abstains after compilation on unsupported questions', async () => {
    const report = await runFacelessMemoryShadowPilot({ projectRoot });

    for (const arm of report.arms) {
      expect(arm.cases.find(({ caseId }) => caseId === 'current_rights_decision')).toMatchObject({
        selectedFragmentId: 'faceless-rights-decision-v2',
        answerCorrect: true,
        expectedSuppressionsObserved: true
      });
      expect(arm.cases.find(({ caseId }) => caseId === 'expired_premium_gate')).toMatchObject({
        outcome: 'abstained',
        expectedSuppressionsObserved: true,
        answerCorrect: true
      });
      expect(arm.cases.find(({ caseId }) => caseId === 'withdrawn_account_plan')).toMatchObject({
        outcome: 'abstained',
        expectedSuppressionsObserved: true,
        answerCorrect: true
      });
      expect(arm.cases.find(({ caseId }) => caseId === 'future_analytics')).toMatchObject({
        outcome: 'abstained',
        expectedSuppressionsObserved: true,
        answerCorrect: true
      });
      expect(arm.cases.find(({ caseId }) => caseId === 'refund_policy')).toMatchObject({
        outcome: 'abstained',
        resolverReason: 'insufficient_query_coverage',
        answerCorrect: true
      });
    }
  });

  it('keeps the treatment read-only, deterministic, and no worse than the flat control', async () => {
    const first = await runFacelessMemoryShadowPilot({ projectRoot });
    const second = await runFacelessMemoryShadowPilot({ projectRoot });
    const flat = first.arms.find(({ backend }) => backend === 'flat');
    const typed = first.arms.find(({ backend }) => backend === 'typed_hybrid');

    expect(first).toEqual(second);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.storage).toEqual({
      mode: 'ephemeral_temp_database',
      controlReadOnly: true,
      treatmentReadOnly: true,
      exposedCapabilities: ['retrieve', 'compileContext']
    });
    expect(first.storage).not.toHaveProperty('databasePath');
    expect(first.mutations).toMatchObject({
      durableUnchanged: true,
      consolidationCandidatesBefore: 0,
      consolidationCandidatesAfter: 0,
      procedureCandidatesBefore: 0,
      procedureCandidatesAfter: 0,
      sharedBundlesBefore: 0,
      sharedBundlesAfter: 0,
      workingRowsAfter: 1
    });
    expect(first.mutations.durableFingerprintAfter).toBe(first.mutations.durableFingerprintBefore);

    expect(flat).toBeDefined();
    expect(typed).toBeDefined();
    expect(typed?.metrics.recallCorrectCount).toBeGreaterThanOrEqual(
      flat?.metrics.recallCorrectCount ?? Number.POSITIVE_INFINITY
    );
    expect(typed?.metrics.temporalCorrectCount).toBeGreaterThanOrEqual(
      flat?.metrics.temporalCorrectCount ?? Number.POSITIVE_INFINITY
    );
    expect(typed?.metrics.abstentionCorrectCount).toBeGreaterThanOrEqual(
      flat?.metrics.abstentionCorrectCount ?? Number.POSITIVE_INFINITY
    );
    expect(first.gates).toEqual({
      retrievalConnectionsReadOnly: true,
      zeroLeakage: true,
      recallNonRegressed: true,
      temporalNonRegressed: true,
      abstentionNonRegressed: true,
      durableMutationFree: true,
      workingMemoryRunIsolated: true,
      passed: true
    });
    expect(first.fixtureStatus).toBe('scaffold');
    expect(first.livePromotionAuthorized).toBe(false);
  });
});
