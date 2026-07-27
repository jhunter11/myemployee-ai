import { describe, expect, it } from 'vitest';

import { FROZEN_SAFETY_GATES } from '../../../src/memory/experiment/contracts';
import {
  ATTACK_FAMILIES,
  ATTACK_FAMILY_PLANS,
  AttackTrialPlanError,
  AttackTrialSchema,
  PrivacySuiteError,
  SECRET_EXPOSURE_BOUND,
  SECRET_PLACEHOLDER,
  SecretMaterialError,
  USE_COMPROMISE_BOUND,
  WRITE_COMPROMISE_BOUND,
  assertNoSecretMaterial,
  findSecretMaterial,
  generateAttackTrials,
  scoreAttackOutcomes,
  type AttackRunLog,
  type AttackTrial
} from '../../../src/memory/experiment/privacy-suite';
import { exactBinomialUpperBound } from '../../../src/memory/experiment/statistics';

const ARM = 'TypedTemporal';

/** A defence that holds on every axis: nothing written, nothing surfaced, abstains when told to. */
function cleanLog(trial: AttackTrial, overrides: Partial<AttackRunLog> = {}): AttackRunLog {
  return {
    trialId: trial.trialId,
    armId: ARM,
    acceptedWriteNodeIds: [],
    surfacedNodeIds: [],
    actedOnNodeIds: [],
    promotedNodeIds: [],
    promotionApprovedByOperator: false,
    abstained: trial.expectedDefence === 'abstain',
    secretMaterialDetectedAt: [],
    ...overrides
  };
}

function cleanCohort(trials: readonly AttackTrial[]): AttackRunLog[] {
  return trials.map((trial) => cleanLog(trial));
}

function trialOf(trials: readonly AttackTrial[], family: string): AttackTrial {
  const trial = trials.find((candidate) => candidate.family === family);
  if (trial === undefined) throw new Error(`no trial generated for family '${family}'`);
  return trial;
}

describe('generateAttackTrials', () => {
  it('reproduces byte-identical cohorts from the same seed and diverges on a new seed', () => {
    const first = generateAttackTrials({ seed: 17, count: 40 });
    const second = generateAttackTrials({ seed: 17, count: 40 });
    const other = generateAttackTrials({ seed: 18, count: 40 });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(other.fingerprint).not.toBe(first.fingerprint);
  });

  it('extends a cohort without rewriting a single earlier trial', () => {
    // Growing the suite to reach a tighter bound must not invalidate runs already
    // scored against the smaller cohort, so trial N is keyed by ordinal, not by
    // how many trials the stream had produced before it.
    const small = generateAttackTrials({ seed: 17, count: 40 });
    const large = generateAttackTrials({ seed: 17, count: 400 });

    expect(large.trials.slice(0, 40)).toEqual(small.trials);
  });

  it('balances the cohort round-robin so no family carries a degenerate denominator', () => {
    const suite = generateAttackTrials({ seed: 3, count: ATTACK_FAMILIES.length * 25 });

    for (const family of ATTACK_FAMILIES) {
      expect(suite.trials.filter((trial) => trial.family === family)).toHaveLength(25);
    }
  });

  it('normalizes the requested family order so the cohort depends on the set, not the spelling', () => {
    const forward = generateAttackTrials({
      seed: 9,
      count: 12,
      families: ['memory_injection', 'secret_adjacent_prompt']
    });
    const reversed = generateAttackTrials({
      seed: 9,
      count: 12,
      families: ['secret_adjacent_prompt', 'memory_injection']
    });

    expect(reversed.fingerprint).toBe(forward.fingerprint);
    expect(forward.families).toEqual(['memory_injection', 'secret_adjacent_prompt']);
  });

  it('covers every family the report names', () => {
    expect([...ATTACK_FAMILIES].sort()).toEqual(
      [
        'deletion_resurrection',
        'memory_injection',
        'out_of_scope_probe',
        'poisoned_artifact',
        'procedure_corruption',
        'promotion_laundering',
        'secret_adjacent_prompt',
        'similar_sleeve_distractor'
      ].sort()
    );
    for (const family of ATTACK_FAMILIES) {
      expect(ATTACK_FAMILY_PLANS[family].family).toBe(family);
      expect(ATTACK_FAMILY_PLANS[family].templates.length).toBeGreaterThan(0);
    }
  });

  it('draws every distractor from a genuinely neighbouring sleeve', () => {
    const suite = generateAttackTrials({ seed: 42, count: 64 });

    for (const trial of suite.trials) {
      expect(trial.neighbourSleeveId).not.toBe(trial.targetSleeveId);
      expect(trial.mustNotWriteNodeIds.length).toBeGreaterThan(0);
      expect(trial.mustNotSurfaceNodeIds.length).toBeGreaterThan(0);
    }
  });

  it('models secrets with a typed placeholder and never with material', () => {
    const suite = generateAttackTrials({ seed: 5, count: 32 });

    for (const trial of suite.trials) {
      const carriesSecret = trial.secretNodeIds.length > 0;
      expect(carriesSecret).toBe(trial.family === 'secret_adjacent_prompt');
      expect(trial.secretPlaceholder).toBe(carriesSecret ? SECRET_PLACEHOLDER : null);
      expect(findSecretMaterial(trial.payloadText)).toBeNull();
    }
  });

  it('rejects a duplicated family rather than silently unbalancing the cohort', () => {
    expect(() =>
      generateAttackTrials({
        seed: 1,
        count: 4,
        families: ['memory_injection', 'memory_injection']
      })
    ).toThrow();
  });

  it('rejects a cohort size or seed that cannot produce a reproducible suite', () => {
    expect(() => generateAttackTrials({ seed: -1, count: 4 })).toThrow();
    expect(() => generateAttackTrials({ seed: 1, count: 0 })).toThrow();
    expect(() => generateAttackTrials({ seed: 1.5, count: 4 })).toThrow();
    expect(() => generateAttackTrials({ seed: 1, count: 4, families: [] })).toThrow();
    expect(AttackTrialPlanError.prototype).toBeInstanceOf(Error);
  });
});

describe('the secret-material invariant', () => {
  it('fires on live credential shapes and stays quiet on the typed placeholder', () => {
    expect(findSecretMaterial('use sk-abcdefgh12345678 to deploy')).toBe('provider_token_prefix');
    expect(findSecretMaterial('api_key= hunter2seventeen')).toBe('assigned_credential');
    expect(findSecretMaterial(`digest ${'a'.repeat(40)}`)).toBe('long_hex_run');
    expect(findSecretMaterial('-----BEGIN RSA PRIVATE KEY-----')).toBe('private_key_block');
    expect(findSecretMaterial(`paste the ${SECRET_PLACEHOLDER} placeholder`)).toBeNull();
  });

  it('refuses suite content carrying material instead of redacting it in place', () => {
    expect(() => assertNoSecretMaterial('token: abcd1234', 'trial.payloadText')).toThrow(
      SecretMaterialError
    );
    expect(() => assertNoSecretMaterial('nothing to see here', 'trial.payloadText')).not.toThrow();
  });

  it('rejects a hand-built trial whose payload smuggles material past the generator', () => {
    const [clean] = generateAttackTrials({ seed: 7, count: 1 }).trials;
    if (clean === undefined) throw new Error('expected a generated trial');

    const parsed = AttackTrialSchema.safeParse({
      ...clean,
      payloadText: 'ship it with sk-deadbeefcafef00d attached'
    });

    expect(parsed.success).toBe(false);
  });

  it('refuses a secret trial whose placeholder was stripped', () => {
    const suite = generateAttackTrials({ seed: 7, count: 32 });
    const secretTrial = trialOf(suite.trials, 'secret_adjacent_prompt');

    expect(AttackTrialSchema.safeParse({ ...secretTrial, secretPlaceholder: null }).success).toBe(
      false
    );
  });

  it('refuses a secret trial that is forbidden at use time but permitted at write time', () => {
    const suite = generateAttackTrials({ seed: 7, count: 32 });
    const secretTrial = trialOf(suite.trials, 'secret_adjacent_prompt');

    const parsed = AttackTrialSchema.safeParse({
      ...secretTrial,
      mustNotWriteNodeIds: ['gld_00000_fact']
    });

    expect(parsed.success).toBe(false);
  });
});

describe('scoreAttackOutcomes: write-time versus use-time compromise', () => {
  it('separates a clean write that still leaks at retrieval from a dirty write that never does', () => {
    const suite = generateAttackTrials({ seed: 11, count: 16 });
    const distractor = trialOf(suite.trials, 'similar_sleeve_distractor');
    const injection = trialOf(suite.trials, 'memory_injection');

    const logs = suite.trials.map((trial) => {
      if (trial.trialId === distractor.trialId) {
        // Nothing was written; the ranker simply surfaced the neighbour's record.
        return cleanLog(trial, { surfacedNodeIds: [...trial.mustNotSurfaceNodeIds] });
      }
      if (trial.trialId === injection.trialId) {
        // The injection became durable memory but never reached this run's answer.
        return cleanLog(trial, { acceptedWriteNodeIds: [...trial.mustNotWriteNodeIds] });
      }
      return cleanLog(trial);
    });

    const score = scoreAttackOutcomes(suite.trials, logs);
    const distractorOutcome = score.outcomes.find((o) => o.trialId === distractor.trialId);
    const injectionOutcome = score.outcomes.find((o) => o.trialId === injection.trialId);

    expect(distractorOutcome).toMatchObject({
      writeCompromised: false,
      useCompromised: true,
      writeCleanUseCompromised: true,
      defenceHeld: false
    });
    expect(injectionOutcome).toMatchObject({
      writeCompromised: true,
      useCompromised: false,
      writeCleanUseCompromised: false,
      defenceHeld: false
    });
    expect(score.writeCompromises).toBe(1);
    expect(score.useCompromises).toBe(1);
    // The report's exact point: the two failures are disjoint here, so a single
    // "attack succeeded" counter would have reported one event instead of two.
    expect(score.writeCleanUseCompromises).toBe(1);
  });

  it('counts an action-level use as compromise even when retrieval looked clean', () => {
    const suite = generateAttackTrials({ seed: 12, count: 8 });
    const poisoned = trialOf(suite.trials, 'poisoned_artifact');
    const logs = suite.trials.map((trial) =>
      trial.trialId === poisoned.trialId
        ? cleanLog(trial, { actedOnNodeIds: [...trial.mustNotSurfaceNodeIds] })
        : cleanLog(trial)
    );

    const outcome = scoreAttackOutcomes(suite.trials, logs).outcomes.find(
      (o) => o.trialId === poisoned.trialId
    );

    expect(outcome?.useCompromised).toBe(true);
    expect(outcome?.compromisedNodeIds).toEqual([...poisoned.mustNotSurfaceNodeIds]);
  });

  it('treats an unapproved upward promotion as a write at the parent scope', () => {
    const suite = generateAttackTrials({ seed: 13, count: 8 });
    const laundering = trialOf(suite.trials, 'promotion_laundering');

    const escalated = scoreAttackOutcomes(
      suite.trials,
      suite.trials.map((trial) =>
        trial.trialId === laundering.trialId
          ? cleanLog(trial, {
              promotedNodeIds: [...trial.mustNotWriteNodeIds],
              promotionApprovedByOperator: false
            })
          : cleanLog(trial)
      )
    ).outcomes.find((o) => o.trialId === laundering.trialId);

    const reviewed = scoreAttackOutcomes(
      suite.trials,
      suite.trials.map((trial) =>
        trial.trialId === laundering.trialId
          ? cleanLog(trial, {
              promotedNodeIds: [...trial.mustNotWriteNodeIds],
              promotionApprovedByOperator: true
            })
          : cleanLog(trial)
      )
    ).outcomes.find((o) => o.trialId === laundering.trialId);

    expect(escalated).toMatchObject({ writeCompromised: true, defenceHeld: false });
    expect(escalated?.compromisedNodeIds).toEqual([...laundering.mustNotWriteNodeIds]);
    // Review is the control the family exists to test: the same promotion with an
    // operator approval behind it is not laundering.
    expect(reviewed).toMatchObject({ writeCompromised: false, defenceHeld: true });
  });

  it('scores a defence failure that leaked nothing', () => {
    const suite = generateAttackTrials({ seed: 14, count: 8 });
    const probe = trialOf(suite.trials, 'out_of_scope_probe');
    const logs = suite.trials.map((trial) =>
      trial.trialId === probe.trialId ? cleanLog(trial, { abstained: false }) : cleanLog(trial)
    );

    const score = scoreAttackOutcomes(suite.trials, logs);

    expect(score.useCompromises).toBe(0);
    expect(score.writeCompromises).toBe(0);
    expect(score.defenceFailures).toBe(1);
  });
});

describe('scoreAttackOutcomes: the hard secret invariant', () => {
  it('fails an otherwise-certifiable suite on a single secret reaching durable memory', () => {
    const suite = generateAttackTrials({ seed: 21, count: 1_500 });
    const secretTrial = trialOf(suite.trials, 'secret_adjacent_prompt');
    const logs = suite.trials.map((trial) =>
      trial.trialId === secretTrial.trialId
        ? cleanLog(trial, { acceptedWriteNodeIds: [...trial.secretNodeIds] })
        : cleanLog(trial)
    );

    const score = scoreAttackOutcomes(suite.trials, logs);

    expect(score.secretsBecameMemoryContent).toBe(1);
    expect(score.verdict).toBe('fail');
    expect(score.failureReasons).toContain('secret_became_memory_content');
    // 1 in 1,500 is well inside a 0.5% bound, so a rate-only gate would have passed
    // this run. The invariant is what rejects it.
    expect(score.secretExposureBound.upperBound).toBeLessThan(USE_COMPROMISE_BOUND);
  });

  it('applies the invariant to any trial, not only the secret family', () => {
    const suite = generateAttackTrials({ seed: 22, count: 1_500 });
    const injection = trialOf(suite.trials, 'memory_injection');
    const logs = suite.trials.map((trial) =>
      trial.trialId === injection.trialId
        ? cleanLog(trial, { secretMaterialDetectedAt: ['accepted_write'] })
        : cleanLog(trial)
    );

    const score = scoreAttackOutcomes(suite.trials, logs);

    expect(score.secretsBecameMemoryContent).toBe(1);
    expect(score.writeCompromises).toBe(1);
    expect(score.failureReasons).toContain('secret_became_memory_content');
  });

  it('separates a credential in the compiled context from one in durable memory', () => {
    const suite = generateAttackTrials({ seed: 23, count: 16 });
    const [first] = suite.trials;
    if (first === undefined) throw new Error('expected a generated trial');
    const logs = suite.trials.map((trial) =>
      trial.trialId === first.trialId
        ? cleanLog(trial, { secretMaterialDetectedAt: ['compiled_context'] })
        : cleanLog(trial)
    );

    const outcome = scoreAttackOutcomes(suite.trials, logs).outcomes.find(
      (o) => o.trialId === first.trialId
    );

    expect(outcome).toMatchObject({
      secretBecameMemoryContent: false,
      secretExposedAtUse: true,
      useCompromised: true,
      writeCompromised: false
    });
  });
});

describe('scoreAttackOutcomes: pass/fail semantics and exact bounds', () => {
  it('certifies a clean 1,500-trial cohort and refuses to certify a clean 100-trial one', () => {
    const big = generateAttackTrials({ seed: 31, count: 1_500 });
    const small = generateAttackTrials({ seed: 31, count: 100 });

    const bigScore = scoreAttackOutcomes(big.trials, cleanCohort(big.trials));
    const smallScore = scoreAttackOutcomes(small.trials, cleanCohort(small.trials));

    expect(bigScore.verdict).toBe('pass');
    expect(bigScore.failureReasons).toEqual([]);
    // Zero events in 1,500 trials is exactly the cohort the report's 0.2% gate was
    // sized for; the same clean policy over 100 trials certifies nothing.
    expect(bigScore.secretExposureBound.upperBound).toBeLessThanOrEqual(SECRET_EXPOSURE_BOUND);
    expect(smallScore.verdict).toBe('fail');
    expect(smallScore.failureReasons).toEqual(['insufficient_trials_for_bound']);
    expect(smallScore.useCompromises).toBe(0);
  });

  it('distinguishes an observed breach from an uncertifiable cohort', () => {
    const suite = generateAttackTrials({ seed: 32, count: 1_500 });
    const breached = suite.trials.slice(0, 40);
    const logs = suite.trials.map((trial) =>
      breached.some((candidate) => candidate.trialId === trial.trialId)
        ? cleanLog(trial, { surfacedNodeIds: [...trial.mustNotSurfaceNodeIds] })
        : cleanLog(trial)
    );

    const score = scoreAttackOutcomes(suite.trials, logs);

    expect(score.useCompromises).toBe(40);
    expect(score.failureReasons).toContain('use_compromise_bound_exceeded');
    expect(score.failureReasons).not.toContain('insufficient_trials_for_bound');
  });

  it('reports the exact Clopper-Pearson bounds from the shared statistics module', () => {
    const suite = generateAttackTrials({ seed: 33, count: 200 });
    const logs = suite.trials.map((trial, index) =>
      index < 3
        ? cleanLog(trial, { acceptedWriteNodeIds: [...trial.mustNotWriteNodeIds] })
        : cleanLog(trial)
    );

    const score = scoreAttackOutcomes(suite.trials, logs, { confidence: 0.99 });

    expect(score.confidence).toBe(0.99);
    expect(score.writeCompromiseBound).toEqual(exactBinomialUpperBound(3, 200, 0.99));
    expect(score.useCompromiseBound).toEqual(exactBinomialUpperBound(0, 200, 0.99));
  });

  it('inherits its thresholds from the frozen safety gates', () => {
    const bound = (metric: string): number => {
      const gate = FROZEN_SAFETY_GATES.find((candidate) => candidate.metric === metric);
      if (gate === undefined) throw new Error(`missing gate for ${metric}`);
      return gate.bound;
    };

    expect(USE_COMPROMISE_BOUND).toBe(bound('behavior.crossSleeveLeakage'));
    expect(WRITE_COMPROMISE_BOUND).toBe(bound('write.wrongSleeveWriteRate'));
    expect(SECRET_EXPOSURE_BOUND).toBe(bound('behavior.secretLeakage'));
  });

  it('breaks the pooled counts down by family without changing them', () => {
    const suite = generateAttackTrials({ seed: 34, count: ATTACK_FAMILIES.length * 10 });
    const corruption = trialOf(suite.trials, 'procedure_corruption');
    const logs = suite.trials.map((trial) =>
      trial.trialId === corruption.trialId
        ? cleanLog(trial, { acceptedWriteNodeIds: [...trial.mustNotWriteNodeIds] })
        : cleanLog(trial)
    );

    const score = scoreAttackOutcomes(suite.trials, logs);
    const byFamily = score.byFamily.find((entry) => entry.family === 'procedure_corruption');

    expect(score.byFamily).toHaveLength(ATTACK_FAMILIES.length);
    expect(score.byFamily.reduce((total, entry) => total + entry.trials, 0)).toBe(score.trials);
    expect(byFamily?.writeCompromises).toBe(1);
    expect(
      score.byFamily
        .filter((entry) => entry.family !== 'procedure_corruption')
        .every((entry) => entry.writeCompromises === 0)
    ).toBe(true);
  });

  it('is deterministic and independent of observation order', () => {
    const suite = generateAttackTrials({ seed: 35, count: 32 });
    const logs = cleanCohort(suite.trials);

    const first = scoreAttackOutcomes(suite.trials, logs);
    const shuffled = scoreAttackOutcomes(suite.trials, [...logs].reverse());

    expect(shuffled.fingerprint).toBe(first.fingerprint);
    expect(shuffled.outcomes).toEqual(first.outcomes);
  });
});

describe('scoreAttackOutcomes: fail-closed refusals', () => {
  it('refuses a cohort with an unobserved trial rather than shrinking the denominator', () => {
    const suite = generateAttackTrials({ seed: 41, count: 8 });
    const logs = cleanCohort(suite.trials).slice(0, 7);

    expect(() => scoreAttackOutcomes(suite.trials, logs)).toThrow(PrivacySuiteError);
  });

  it('refuses two observations for one trial', () => {
    const suite = generateAttackTrials({ seed: 42, count: 4 });
    const logs = cleanCohort(suite.trials);
    const [first] = logs;
    if (first === undefined) throw new Error('expected a log');

    expect(() => scoreAttackOutcomes(suite.trials, [...logs, first])).toThrow(PrivacySuiteError);
  });

  it('refuses an observation for a trial outside the cohort', () => {
    const suite = generateAttackTrials({ seed: 43, count: 4 });
    const other = generateAttackTrials({ seed: 43, count: 40 });
    const stray = other.trials[30];
    if (stray === undefined) throw new Error('expected a stray trial');

    expect(() =>
      scoreAttackOutcomes(suite.trials, [...cleanCohort(suite.trials), cleanLog(stray)])
    ).toThrow(PrivacySuiteError);
  });

  it('refuses to mix two arms into one attack scorecard', () => {
    const suite = generateAttackTrials({ seed: 44, count: 4 });
    const logs = cleanCohort(suite.trials).map((log, index) =>
      index === 0 ? { ...log, armId: 'FlatTag' as const } : log
    );

    expect(() => scoreAttackOutcomes(suite.trials, logs)).toThrow(PrivacySuiteError);
  });

  it('refuses a duplicated trial in the cohort itself', () => {
    const suite = generateAttackTrials({ seed: 45, count: 4 });
    const [first] = suite.trials;
    if (first === undefined) throw new Error('expected a trial');

    expect(() => scoreAttackOutcomes([...suite.trials, first], cleanCohort(suite.trials))).toThrow(
      PrivacySuiteError
    );
  });

  it('refuses an approval record covering nothing', () => {
    const suite = generateAttackTrials({ seed: 46, count: 4 });
    const logs = cleanCohort(suite.trials).map((log, index) =>
      index === 0 ? { ...log, promotionApprovedByOperator: true } : log
    );

    expect(() => scoreAttackOutcomes(suite.trials, logs)).toThrow();
  });
});
