import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BlueprintLifecycleService } from '../../src/blueprints/blueprint-lifecycle-service';
import type {
  BlueprintActor,
  BlueprintConfig,
  BlueprintGateObservation,
  BlueprintState
} from '../../src/blueprints/contracts';
import { BlueprintImplementationRegistry } from '../../src/blueprints/implementation-registry';
import { BlueprintRepository } from '../../src/db/blueprint-repository';
import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';

const projectRoot = join(__dirname, '..', '..');
const IMPLEMENTATION_DIGEST = 'a'.repeat(64);
const EVIDENCE_DIGEST = '9'.repeat(64);

function config(overrides: Partial<BlueprintConfig> = {}): BlueprintConfig {
  return {
    blueprintId: 'daily_report',
    revision: 1,
    previousRevision: null,
    ownerScopeId: 'client:acme_corp',
    objective: 'Create an internal daily qualification report.',
    inputContractDigest: 'b'.repeat(64),
    outputContractDigest: 'c'.repeat(64),
    workflowPattern: 'sequential',
    implementationDigest: IMPLEMENTATION_DIGEST,
    toolGrants: ['report.read'],
    sleeveGrants: [{ sleeveId: 'client:acme_corp:shared', permissions: ['read'] }],
    networkPolicy: { mode: 'none', allowedHosts: [] },
    sideEffectPolicy: 'reversible_internal',
    budgets: {
      maxDurationMs: 60_000,
      maxTurns: 8,
      maxToolCalls: 12,
      maxInputTokens: 20_000,
      maxOutputTokens: 4_000,
      maxCostMicrousd: 500_000,
      maxDepth: 2,
      maxFanout: 3
    },
    evalSuite: {
      suiteId: 'daily_report_eval',
      revision: 1,
      graderDigest: 'd'.repeat(64),
      hiddenHoldoutDigest: 'e'.repeat(64)
    },
    gatePolicy: {
      requiredTrials: 3,
      requireCompleteTrajectories: true,
      requireHiddenHoldouts: true,
      maxPolicyViolations: 0,
      maxScopeViolations: 0,
      maxBudgetBreaches: 0,
      maxIrreversibleEffects: 0,
      maxQualityRegressionBps: 0,
      maxInterventionIncreaseBps: 0
    },
    economicsPolicy: {
      pricingVersion: 'pricing-2026-07-01',
      minKnownCostCoverageBps: 10_000,
      maxCostPerSuccessfulTaskMicrousd: 250_000,
      maxP95LatencyMs: 45_000,
      maxUnexplainedCostIncreaseBps: 0
    },
    rollout: {
      shadowMode: 'read_only',
      canaryTaskCount: 3,
      canaryRisk: 'low',
      canaryEffects: 'reversible_internal'
    },
    provenance: {
      sourceKind: 'operator',
      sourceRef: 'decision:daily-report-v1',
      evidenceDigest: 'f'.repeat(64)
    },
    rollbackRevision: null,
    ...overrides
  };
}

type GateObservationOverrides = {
  policy?: Partial<BlueprintGateObservation['policy']>;
  economics?: Partial<BlueprintGateObservation['economics']>;
};

function passingObservation(overrides: GateObservationOverrides = {}) {
  return {
    policy: {
      policyViolations: 0,
      scopeViolations: 0,
      budgetBreaches: 0,
      irreversibleEffects: 0,
      trialsCompleted: 3,
      trajectoriesComplete: true,
      hiddenHoldoutsPassed: true,
      qualityRegressionBps: 0,
      interventionIncreaseBps: 0,
      ...overrides.policy
    },
    economics: {
      pricingVersion: 'pricing-2026-07-01',
      knownCostCoverageBps: 10_000,
      successfulTasks: 3,
      costPerSuccessfulTaskMicrousd: 100_000,
      p95LatencyMs: 20_000,
      unexplainedCostIncreaseBps: 0,
      ...overrides.economics
    }
  } satisfies BlueprintGateObservation;
}

describe('BlueprintLifecycleService', () => {
  let temporaryRoot: string;
  let context: GlobalDatabaseContext;
  let repository: BlueprintRepository;
  let service: BlueprintLifecycleService;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-blueprints-'));
    context = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    repository = new BlueprintRepository(context.db);
    service = new BlueprintLifecycleService(
      repository,
      new BlueprintImplementationRegistry([
        { implementationId: 'daily_report_v1', digest: IMPLEMENTATION_DIGEST }
      ])
    );
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  async function propose(candidate = config()) {
    return service.propose({
      config: candidate,
      proposer: { id: 'operator:jack', kind: 'human' },
      proposedAt: '2026-07-21T12:00:00.000Z'
    });
  }

  async function advance(
    state: Exclude<BlueprintState, 'proposed' | 'rejected' | 'rolled_back' | 'retired'>,
    expectedVersion: number,
    actor: BlueprintActor = { id: 'system:blueprint-controller', kind: 'system' },
    observation?: BlueprintGateObservation
  ) {
    return service.advance({
      blueprintId: 'daily_report',
      revision: 1,
      expectedVersion,
      targetState: state,
      actor,
      evidenceDigest: EVIDENCE_DIGEST,
      observedAt: `2026-07-21T12:0${expectedVersion}:00.000Z`,
      observation
    });
  }

  it('persists an immutable proposal only for a statically registered digest', async () => {
    const created = await propose();

    expect(created).toMatchObject({
      blueprintId: 'daily_report',
      revision: 1,
      implementationId: 'daily_report_v1',
      state: 'proposed',
      stateVersion: 1,
      proposer: { id: 'operator:jack', kind: 'human' },
      runtime: {
        lifecycleOnly: true,
        sandboxRunner: 'not_implemented',
        modelExecution: 'not_implemented'
      }
    });
    expect(created.configDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(repository.find('daily_report', 1)).resolves.toEqual(created);

    await expect(
      propose(config({ blueprintId: 'unknown_worker', implementationDigest: '1'.repeat(64) }))
    ).rejects.toThrowError(/not statically registered/i);
  });

  it('enforces the exact promotion path and records every transition', async () => {
    await propose();
    let record = await advance('sandboxed', 1);
    record = await advance('evaluated', record.stateVersion, undefined, passingObservation());
    record = await advance(
      'awaiting_approval',
      record.stateVersion,
      undefined,
      passingObservation()
    );
    record = await advance(
      'shadow',
      record.stateVersion,
      { id: 'operator:reviewer', kind: 'human' },
      passingObservation()
    );
    record = await advance('canary', record.stateVersion, undefined, passingObservation());
    record = await advance('active', record.stateVersion, undefined, passingObservation());

    expect(record).toMatchObject({ state: 'active', stateVersion: 7 });
    const events = await repository.listEvents('daily_report', 1, 20);
    expect(events.map(({ toState }) => toState)).toEqual([
      'proposed',
      'sandboxed',
      'evaluated',
      'awaiting_approval',
      'shadow',
      'canary',
      'active'
    ]);
    expect(events.every((event) => event.evidenceDigest.length === 64)).toBe(true);
    expect(events.at(-1)).toMatchObject({
      decisionCode: 'gate_passed',
      gateDecision: { passed: true, reasons: [] },
      observation: passingObservation()
    });
  });

  it('denies skipped states, stale versions, and self-approval', async () => {
    await propose();
    await expect(advance('evaluated', 1, undefined, passingObservation())).rejects.toThrowError(
      /invalid blueprint transition/i
    );

    let record = await advance('sandboxed', 1);
    await expect(advance('sandboxed', 1)).rejects.toThrowError(/version|transition/i);
    record = await advance('evaluated', record.stateVersion, undefined, passingObservation());
    record = await advance(
      'awaiting_approval',
      record.stateVersion,
      undefined,
      passingObservation()
    );

    await expect(
      advance(
        'shadow',
        record.stateVersion,
        { id: 'operator:jack', kind: 'human' },
        passingObservation()
      )
    ).rejects.toThrowError(/self-approval/i);
    await expect(
      advance(
        'shadow',
        record.stateVersion,
        { id: 'agent:reviewer', kind: 'agent' },
        passingObservation()
      )
    ).rejects.toThrowError(/human approval/i);
  });

  it('fails closed on missing records, evidence, provenance, and terminal authority', async () => {
    await expect(
      service.advance({
        blueprintId: 'missing_blueprint',
        revision: 1,
        expectedVersion: 1,
        targetState: 'sandboxed',
        actor: { id: 'system:blueprint-controller', kind: 'system' },
        evidenceDigest: EVIDENCE_DIGEST,
        observedAt: '2026-07-21T11:00:00.000Z'
      })
    ).rejects.toMatchObject({ code: 'BLUEPRINT_NOT_FOUND' });
    await expect(
      service.propose({
        config: config({
          blueprintId: 'missing_lineage',
          revision: 2,
          previousRevision: 1,
          rollbackRevision: 1
        }),
        proposer: { id: 'operator:jack', kind: 'human' },
        proposedAt: '2026-07-21T11:01:00.000Z'
      })
    ).rejects.toMatchObject({ code: 'BLUEPRINT_PREVIOUS_REVISION_NOT_FOUND' });
    await expect(
      service.propose({
        config: config({
          blueprintId: 'bad_provenance',
          provenance: {
            sourceKind: 'toolsmith',
            sourceRef: 'frequency:bad-provenance',
            evidenceDigest: EVIDENCE_DIGEST
          }
        }),
        proposer: { id: 'operator:jack', kind: 'human' },
        proposedAt: '2026-07-21T11:02:00.000Z'
      })
    ).rejects.toMatchObject({ code: 'BLUEPRINT_PROVENANCE_MISMATCH' });

    await propose(config({ blueprintId: 'evidence_required' }));
    const sandboxed = await service.advance({
      blueprintId: 'evidence_required',
      revision: 1,
      expectedVersion: 1,
      targetState: 'sandboxed',
      actor: { id: 'system:blueprint-controller', kind: 'system' },
      evidenceDigest: EVIDENCE_DIGEST,
      observedAt: '2026-07-21T12:03:00.000Z'
    });
    await expect(
      service.advance({
        blueprintId: 'evidence_required',
        revision: 1,
        expectedVersion: sandboxed.stateVersion,
        targetState: 'evaluated',
        actor: { id: 'agent:toolsmith', kind: 'agent' },
        evidenceDigest: EVIDENCE_DIGEST,
        observedAt: '2026-07-21T12:03:30.000Z',
        observation: passingObservation()
      })
    ).rejects.toMatchObject({ code: 'BLUEPRINT_AGENT_TRANSITION_FORBIDDEN' });
    await expect(
      service.advance({
        blueprintId: 'evidence_required',
        revision: 1,
        expectedVersion: sandboxed.stateVersion,
        targetState: 'evaluated',
        actor: { id: 'system:blueprint-controller', kind: 'system' },
        evidenceDigest: EVIDENCE_DIGEST,
        observedAt: '2026-07-21T12:04:00.000Z'
      })
    ).rejects.toMatchObject({ code: 'BLUEPRINT_GATE_OBSERVATION_REQUIRED' });
    await expect(
      service.reject({
        blueprintId: 'evidence_required',
        revision: 1,
        expectedVersion: sandboxed.stateVersion,
        actor: { id: 'agent:toolsmith', kind: 'agent' },
        evidenceDigest: EVIDENCE_DIGEST,
        observedAt: '2026-07-21T12:05:00.000Z',
        reasonCode: 'operator_rejected'
      })
    ).rejects.toMatchObject({ code: 'BLUEPRINT_HUMAN_REJECTION_REQUIRED' });
    await expect(
      service.retire({
        blueprintId: 'evidence_required',
        revision: 1,
        expectedVersion: sandboxed.stateVersion,
        actor: { id: 'system:blueprint-controller', kind: 'system' },
        evidenceDigest: EVIDENCE_DIGEST,
        observedAt: '2026-07-21T12:06:00.000Z',
        reasonCode: 'operator_retired'
      })
    ).rejects.toMatchObject({ code: 'BLUEPRINT_HUMAN_RETIREMENT_REQUIRED' });
    await expect(
      service.retire({
        blueprintId: 'evidence_required',
        revision: 1,
        expectedVersion: sandboxed.stateVersion,
        actor: { id: 'operator:reviewer', kind: 'human' },
        evidenceDigest: EVIDENCE_DIGEST,
        observedAt: '2026-07-21T12:07:00.000Z',
        reasonCode: 'operator_retired'
      })
    ).rejects.toMatchObject({ code: 'INVALID_BLUEPRINT_TRANSITION' });
  });

  it.each([
    ['policy violation', { policy: { policyViolations: 1 } }],
    ['tenant scope violation', { policy: { scopeViolations: 1 } }],
    ['budget breach', { policy: { budgetBreaches: 1 } }],
    ['irreversible effect', { policy: { irreversibleEffects: 1 } }],
    ['insufficient trials', { policy: { trialsCompleted: 2 } }],
    ['incomplete trajectories', { policy: { trajectoriesComplete: false } }],
    ['failed hidden holdout', { policy: { hiddenHoldoutsPassed: false } }],
    ['quality regression', { policy: { qualityRegressionBps: 1 } }],
    ['intervention regression', { policy: { interventionIncreaseBps: 1 } }],
    ['unknown pricing', { economics: { pricingVersion: null } }],
    ['wrong pricing basis', { economics: { pricingVersion: 'pricing-stale' } }],
    ['partial cost coverage', { economics: { knownCostCoverageBps: 9_999 } }],
    ['no successful tasks', { economics: { successfulTasks: 0 } }],
    ['unknown cost per success', { economics: { costPerSuccessfulTaskMicrousd: null } }],
    ['excess cost per success', { economics: { costPerSuccessfulTaskMicrousd: 250_001 } }],
    ['unknown latency', { economics: { p95LatencyMs: null } }],
    ['excess latency', { economics: { p95LatencyMs: 45_001 } }],
    ['unknown cost change', { economics: { unexplainedCostIncreaseBps: null } }],
    ['unexplained cost increase', { economics: { unexplainedCostIncreaseBps: 1 } }]
  ])('automatically rolls back on %s', async (_label, overrides) => {
    await propose();
    const sandboxed = await advance('sandboxed', 1);
    const rolledBack = await advance(
      'evaluated',
      sandboxed.stateVersion,
      undefined,
      passingObservation(overrides)
    );

    expect(rolledBack).toMatchObject({ state: 'rolled_back', stateVersion: 3 });
    expect((await repository.listEvents('daily_report', 1, 10)).at(-1)).toMatchObject({
      decisionCode: 'automatic_gate_rollback',
      gateDecision: { passed: false }
    });
  });

  it('requires the complete fixed canary before activation', async () => {
    await propose();
    let record = await advance('sandboxed', 1);
    record = await advance('evaluated', record.stateVersion, undefined, passingObservation());
    record = await advance(
      'awaiting_approval',
      record.stateVersion,
      undefined,
      passingObservation()
    );
    record = await advance(
      'shadow',
      record.stateVersion,
      { id: 'operator:reviewer', kind: 'human' },
      passingObservation()
    );
    record = await advance('canary', record.stateVersion, undefined, passingObservation());

    const result = await advance(
      'active',
      record.stateVersion,
      undefined,
      passingObservation({ economics: { successfulTasks: 2 } })
    );
    expect(result.state).toBe('rolled_back');
  });

  it('permits rejection, human retirement, and system rollback but no terminal escape', async () => {
    await propose();
    const rejected = await service.reject({
      blueprintId: 'daily_report',
      revision: 1,
      expectedVersion: 1,
      actor: { id: 'operator:reviewer', kind: 'human' },
      evidenceDigest: EVIDENCE_DIGEST,
      observedAt: '2026-07-21T12:01:00.000Z',
      reasonCode: 'operator_rejected'
    });
    expect(rejected.state).toBe('rejected');
    await expect(advance('sandboxed', rejected.stateVersion)).rejects.toThrowError(
      /invalid blueprint transition/i
    );

    await propose(config({ blueprintId: 'rollback_report' }));
    const rollbackSandbox = await service.advance({
      blueprintId: 'rollback_report',
      revision: 1,
      expectedVersion: 1,
      targetState: 'sandboxed',
      actor: { id: 'system:blueprint-controller', kind: 'system' },
      evidenceDigest: EVIDENCE_DIGEST,
      observedAt: '2026-07-21T12:30:00.000Z'
    });
    await expect(
      service.rollback({
        blueprintId: 'rollback_report',
        revision: 1,
        expectedVersion: rollbackSandbox.stateVersion,
        actor: { id: 'agent:toolsmith', kind: 'agent' },
        evidenceDigest: EVIDENCE_DIGEST,
        observedAt: '2026-07-21T12:31:00.000Z',
        reasonCode: 'policy_violation'
      })
    ).rejects.toMatchObject({ code: 'BLUEPRINT_AGENT_ROLLBACK_FORBIDDEN' });
    const manuallyRolledBack = await service.rollback({
      blueprintId: 'rollback_report',
      revision: 1,
      expectedVersion: rollbackSandbox.stateVersion,
      actor: { id: 'system:blueprint-controller', kind: 'system' },
      evidenceDigest: EVIDENCE_DIGEST,
      observedAt: '2026-07-21T12:32:00.000Z',
      reasonCode: 'policy_violation'
    });
    expect(manuallyRolledBack.state).toBe('rolled_back');

    await propose(config({ blueprintId: 'retirable_report' }));
    const retirableServiceAdvance = async (
      targetState: Parameters<BlueprintLifecycleService['advance']>[0]['targetState'],
      expectedVersion: number,
      actor: BlueprintActor = { id: 'system:blueprint-controller', kind: 'system' }
    ) =>
      service.advance({
        blueprintId: 'retirable_report',
        revision: 1,
        expectedVersion,
        targetState,
        actor,
        evidenceDigest: EVIDENCE_DIGEST,
        observedAt: `2026-07-21T13:0${expectedVersion}:00.000Z`,
        observation: targetState === 'sandboxed' ? undefined : passingObservation()
      });
    let active = await retirableServiceAdvance('sandboxed', 1);
    active = await retirableServiceAdvance('evaluated', active.stateVersion);
    active = await retirableServiceAdvance('awaiting_approval', active.stateVersion);
    active = await retirableServiceAdvance('shadow', active.stateVersion, {
      id: 'operator:reviewer',
      kind: 'human'
    });
    active = await retirableServiceAdvance('canary', active.stateVersion);
    active = await retirableServiceAdvance('active', active.stateVersion);
    const retired = await service.retire({
      blueprintId: 'retirable_report',
      revision: 1,
      expectedVersion: active.stateVersion,
      actor: { id: 'operator:reviewer', kind: 'human' },
      evidenceDigest: EVIDENCE_DIGEST,
      observedAt: '2026-07-21T14:00:00.000Z',
      reasonCode: 'operator_retired'
    });
    expect(retired.state).toBe('retired');
  });

  it('allows agent revisions only within prior authority and fixed governance', async () => {
    await expect(
      service.propose({
        config: config({
          blueprintId: 'agent_baseline',
          provenance: {
            sourceKind: 'toolsmith',
            sourceRef: 'frequency:new-work',
            evidenceDigest: '8'.repeat(64)
          }
        }),
        proposer: { id: 'agent:toolsmith', kind: 'agent' },
        proposedAt: '2026-07-21T14:59:00.000Z'
      })
    ).rejects.toMatchObject({ code: 'BLUEPRINT_BASELINE_REQUIRED' });

    await propose();
    const narrower = config({
      revision: 2,
      previousRevision: 1,
      implementationDigest: IMPLEMENTATION_DIGEST,
      budgets: { ...config().budgets, maxToolCalls: 10 },
      sideEffectPolicy: 'none',
      provenance: {
        sourceKind: 'toolsmith',
        sourceRef: 'frequency:daily-report',
        evidenceDigest: '8'.repeat(64)
      },
      rollbackRevision: 1
    });
    await expect(
      service.propose({
        config: narrower,
        proposer: { id: 'agent:toolsmith', kind: 'agent' },
        proposedAt: '2026-07-21T15:00:00.000Z'
      })
    ).resolves.toMatchObject({ revision: 2, state: 'proposed' });

    const baseRevision3 = {
      ...narrower,
      revision: 3,
      previousRevision: 2,
      rollbackRevision: 2,
      provenance: {
        sourceKind: 'toolsmith' as const,
        sourceRef: 'frequency:daily-report-v3',
        evidenceDigest: '7'.repeat(64)
      }
    } satisfies BlueprintConfig;
    const attempts: Array<{ candidate: BlueprintConfig; code: string }> = [
      {
        candidate: {
          ...baseRevision3,
          toolGrants: ['report.read', 'email.send']
        },
        code: 'BLUEPRINT_AUTHORITY_BROADENING_FORBIDDEN'
      },
      {
        candidate: {
          ...baseRevision3,
          sleeveGrants: [{ sleeveId: 'client:acme_corp:shared', permissions: ['read', 'write'] }]
        },
        code: 'BLUEPRINT_AUTHORITY_BROADENING_FORBIDDEN'
      },
      {
        candidate: {
          ...baseRevision3,
          networkPolicy: { mode: 'allowlist', allowedHosts: ['api.example.com'] }
        },
        code: 'BLUEPRINT_AUTHORITY_BROADENING_FORBIDDEN'
      },
      {
        candidate: {
          ...baseRevision3,
          sideEffectPolicy: 'reversible_internal'
        },
        code: 'BLUEPRINT_AUTHORITY_BROADENING_FORBIDDEN'
      },
      {
        candidate: {
          ...baseRevision3,
          budgets: { ...narrower.budgets, maxToolCalls: 11 }
        },
        code: 'BLUEPRINT_AUTHORITY_BROADENING_FORBIDDEN'
      },
      {
        candidate: {
          ...baseRevision3,
          evalSuite: { ...narrower.evalSuite, graderDigest: '6'.repeat(64) }
        },
        code: 'BLUEPRINT_GRADER_CHANGE_FORBIDDEN'
      },
      {
        candidate: {
          ...baseRevision3,
          evalSuite: { ...narrower.evalSuite, hiddenHoldoutDigest: '5'.repeat(64) }
        },
        code: 'BLUEPRINT_GRADER_CHANGE_FORBIDDEN'
      },
      {
        candidate: {
          ...baseRevision3,
          gatePolicy: { ...narrower.gatePolicy, requiredTrials: 4 }
        },
        code: 'BLUEPRINT_POLICY_CHANGE_FORBIDDEN'
      },
      {
        candidate: {
          ...baseRevision3,
          economicsPolicy: {
            ...narrower.economicsPolicy,
            maxCostPerSuccessfulTaskMicrousd: 300_000
          }
        },
        code: 'BLUEPRINT_POLICY_CHANGE_FORBIDDEN'
      },
      {
        candidate: {
          ...baseRevision3,
          rollout: { ...narrower.rollout, canaryTaskCount: 4 }
        },
        code: 'BLUEPRINT_POLICY_CHANGE_FORBIDDEN'
      }
    ];
    for (const attempt of attempts) {
      await expect(
        service.propose({
          config: attempt.candidate,
          proposer: { id: 'agent:toolsmith', kind: 'agent' },
          proposedAt: '2026-07-21T15:01:00.000Z'
        })
      ).rejects.toMatchObject({ code: attempt.code });
    }

    const researchCandidate = {
      ...baseRevision3,
      provenance: {
        sourceKind: 'research_feed' as const,
        sourceRef: 'research:daily-report-v3',
        evidenceDigest: '4'.repeat(64)
      }
    } satisfies BlueprintConfig;
    const researchProposal = await service.propose({
      config: researchCandidate,
      proposer: { id: 'research:curated-feed', kind: 'research_feed' },
      proposedAt: '2026-07-21T15:02:00.000Z'
    });
    expect(researchProposal.state).toBe('proposed');
    expect((await repository.listEvents('daily_report', 3, 10))[0]).toMatchObject({
      actor: { id: 'research:curated-feed', kind: 'research_feed' },
      decisionCode: 'proposal_recorded'
    });
  });

  it('rejects duplicate revisions and unbounded audit reads', async () => {
    await propose();
    await expect(propose()).rejects.toMatchObject({ code: 'BLUEPRINT_REVISION_EXISTS' });
    await expect(repository.listEvents('daily_report', 1, 0)).rejects.toThrow(RangeError);
    await expect(repository.listEvents('daily_report', 1, 101)).rejects.toThrow(RangeError);
  });

  it('makes blueprint configuration and audit events immutable at the database boundary', async () => {
    await propose();

    expect(() =>
      context.sqlite
        .prepare('UPDATE agent_blueprints SET config_json = ? WHERE blueprint_id = ?')
        .run('{}', 'daily_report')
    ).toThrowError(/immutable/i);
    expect(() => context.sqlite.prepare('DELETE FROM agent_blueprint_events').run()).toThrowError(
      /append-only/i
    );
    expect(() =>
      context.sqlite
        .prepare(
          "UPDATE agent_blueprints SET state = 'sandboxed', state_version = 2, updated_at = ? WHERE blueprint_id = ?"
        )
        .run('2026-07-21T12:01:00.000Z', 'daily_report')
    ).toThrowError(/audit evidence/i);
  });
});
