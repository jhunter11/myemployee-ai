import { isDeepStrictEqual } from 'node:util';

import {
  AdvanceBlueprintInputSchema,
  CreateBlueprintProposalInputSchema,
  RejectBlueprintInputSchema,
  RetireBlueprintInputSchema,
  RollbackBlueprintInputSchema,
  type AdvanceBlueprintInput,
  type BlueprintConfig,
  type BlueprintGateDecision,
  type BlueprintGateObservation,
  type BlueprintRecord,
  type BlueprintState,
  type CreateBlueprintProposalInput,
  type RejectBlueprintInput,
  type RetireBlueprintInput,
  type RollbackBlueprintInput
} from './contracts';
import type { BlueprintImplementationRegistry } from './implementation-registry';
import type { BlueprintRepository } from '../db/blueprint-repository';
import { AppError } from '../utils/errors';

const NEXT_STATE: Readonly<Partial<Record<BlueprintState, BlueprintState>>> = Object.freeze({
  proposed: 'sandboxed',
  sandboxed: 'evaluated',
  evaluated: 'awaiting_approval',
  awaiting_approval: 'shadow',
  shadow: 'canary',
  canary: 'active'
});

const BUDGET_FIELDS = [
  'maxDurationMs',
  'maxTurns',
  'maxToolCalls',
  'maxInputTokens',
  'maxOutputTokens',
  'maxCostMicrousd',
  'maxDepth',
  'maxFanout'
] as const satisfies readonly (keyof BlueprintConfig['budgets'])[];

function includesAll<T>(ceiling: readonly T[], requested: readonly T[]): boolean {
  const allowed = new Set(ceiling);
  return requested.every((value) => allowed.has(value));
}

function authorityIsNotBroader(previous: BlueprintConfig, candidate: BlueprintConfig): boolean {
  if (
    previous.ownerScopeId !== candidate.ownerScopeId ||
    previous.inputContractDigest !== candidate.inputContractDigest ||
    previous.outputContractDigest !== candidate.outputContractDigest
  ) {
    return false;
  }
  if (!includesAll(previous.toolGrants, candidate.toolGrants)) return false;

  const previousSleeves = new Map(
    previous.sleeveGrants.map((grant) => [grant.sleeveId, grant.permissions] as const)
  );
  for (const grant of candidate.sleeveGrants) {
    const previousPermissions = previousSleeves.get(grant.sleeveId);
    if (previousPermissions === undefined || !includesAll(previousPermissions, grant.permissions)) {
      return false;
    }
  }

  if (candidate.networkPolicy.mode === 'allowlist') {
    if (previous.networkPolicy.mode !== 'allowlist') return false;
    if (!includesAll(previous.networkPolicy.allowedHosts, candidate.networkPolicy.allowedHosts)) {
      return false;
    }
  }
  const effectRank = { none: 0, reversible_internal: 1 } as const;
  if (effectRank[candidate.sideEffectPolicy] > effectRank[previous.sideEffectPolicy]) return false;

  return BUDGET_FIELDS.every((field) => candidate.budgets[field] <= previous.budgets[field]);
}

function assertGovernanceUnchanged(previous: BlueprintConfig, candidate: BlueprintConfig): void {
  if (!isDeepStrictEqual(previous.evalSuite, candidate.evalSuite)) {
    throw new AppError(
      403,
      'BLUEPRINT_GRADER_CHANGE_FORBIDDEN',
      'Blueprint revisions cannot change graders or hidden holdouts'
    );
  }
  if (
    !isDeepStrictEqual(previous.gatePolicy, candidate.gatePolicy) ||
    !isDeepStrictEqual(previous.economicsPolicy, candidate.economicsPolicy) ||
    !isDeepStrictEqual(previous.rollout, candidate.rollout)
  ) {
    throw new AppError(
      403,
      'BLUEPRINT_POLICY_CHANGE_FORBIDDEN',
      'Blueprint revisions cannot change gate, economics, or rollout policy'
    );
  }
}

function evaluateGates(
  config: BlueprintConfig,
  observation: BlueprintGateObservation,
  targetState: BlueprintState
): BlueprintGateDecision {
  const reasons: string[] = [];
  const { policy, economics } = observation;
  const gate = config.gatePolicy;
  const cost = config.economicsPolicy;

  if (policy.policyViolations > gate.maxPolicyViolations) reasons.push('policy_violation');
  if (policy.scopeViolations > gate.maxScopeViolations) reasons.push('scope_violation');
  if (policy.budgetBreaches > gate.maxBudgetBreaches) reasons.push('budget_breach');
  if (policy.irreversibleEffects > gate.maxIrreversibleEffects) {
    reasons.push('irreversible_effect');
  }
  if (policy.trialsCompleted < gate.requiredTrials) reasons.push('insufficient_trials');
  if (gate.requireCompleteTrajectories && !policy.trajectoriesComplete) {
    reasons.push('incomplete_trajectories');
  }
  if (gate.requireHiddenHoldouts && !policy.hiddenHoldoutsPassed) {
    reasons.push('hidden_holdout_failure');
  }
  if (policy.qualityRegressionBps > gate.maxQualityRegressionBps) {
    reasons.push('quality_regression');
  }
  if (policy.interventionIncreaseBps > gate.maxInterventionIncreaseBps) {
    reasons.push('intervention_regression');
  }

  if (economics.pricingVersion === null) {
    reasons.push('pricing_unknown');
  } else if (economics.pricingVersion !== cost.pricingVersion) {
    reasons.push('pricing_version_mismatch');
  }
  if (economics.knownCostCoverageBps < cost.minKnownCostCoverageBps) {
    reasons.push('cost_coverage_incomplete');
  }
  if (economics.successfulTasks === 0) reasons.push('no_successful_tasks');
  if (economics.costPerSuccessfulTaskMicrousd === null) {
    reasons.push('cost_per_success_unknown');
  } else if (economics.costPerSuccessfulTaskMicrousd > cost.maxCostPerSuccessfulTaskMicrousd) {
    reasons.push('cost_per_success_exceeded');
  }
  if (economics.p95LatencyMs === null) {
    reasons.push('latency_unknown');
  } else if (economics.p95LatencyMs > cost.maxP95LatencyMs) {
    reasons.push('latency_exceeded');
  }
  if (economics.unexplainedCostIncreaseBps === null) {
    reasons.push('cost_change_unknown');
  } else if (economics.unexplainedCostIncreaseBps > cost.maxUnexplainedCostIncreaseBps) {
    reasons.push('unexplained_cost_increase');
  }
  if (targetState === 'active' && economics.successfulTasks < config.rollout.canaryTaskCount) {
    reasons.push('fixed_canary_incomplete');
  }

  return { passed: reasons.length === 0, reasons };
}

function assertCurrent(record: BlueprintRecord, expectedVersion: number): void {
  if (record.stateVersion !== expectedVersion) {
    throw new AppError(
      409,
      'BLUEPRINT_VERSION_CONFLICT',
      `Blueprint version ${record.stateVersion} does not match expected version ${expectedVersion}`
    );
  }
}

export class BlueprintLifecycleService {
  constructor(
    private readonly repository: BlueprintRepository,
    private readonly implementations: BlueprintImplementationRegistry
  ) {}

  async propose(rawInput: CreateBlueprintProposalInput): Promise<BlueprintRecord> {
    const input = CreateBlueprintProposalInputSchema.parse(rawInput);
    const implementation = this.implementations.resolve(input.config.implementationDigest);
    const expectedSource = {
      human: 'operator',
      agent: 'toolsmith',
      research_feed: 'research_feed'
    } as const;
    if (input.config.provenance.sourceKind !== expectedSource[input.proposer.kind]) {
      throw new AppError(
        403,
        'BLUEPRINT_PROVENANCE_MISMATCH',
        'Blueprint authority proposals require provenance matching the proposer kind'
      );
    }

    if (input.config.previousRevision === null) {
      if (input.proposer.kind !== 'human') {
        throw new AppError(
          403,
          'BLUEPRINT_BASELINE_REQUIRED',
          'An agent or research feed cannot create a new authority baseline'
        );
      }
    } else {
      const previous = await this.repository.find(
        input.config.blueprintId,
        input.config.previousRevision
      );
      if (previous === undefined) {
        throw new AppError(
          404,
          'BLUEPRINT_PREVIOUS_REVISION_NOT_FOUND',
          `Previous blueprint revision ${input.config.previousRevision} was not found`
        );
      }
      assertGovernanceUnchanged(previous.config, input.config);
      if (!authorityIsNotBroader(previous.config, input.config)) {
        throw new AppError(
          403,
          'BLUEPRINT_AUTHORITY_BROADENING_FORBIDDEN',
          'Blueprint revisions cannot broaden scope, tools, sleeves, network, effects, or budgets'
        );
      }
    }

    return this.repository.createProposal(input, implementation.implementationId);
  }

  async advance(rawInput: AdvanceBlueprintInput): Promise<BlueprintRecord> {
    const input = AdvanceBlueprintInputSchema.parse(rawInput);
    const record = await this.requireRecord(input.blueprintId, input.revision);
    assertCurrent(record, input.expectedVersion);
    if (NEXT_STATE[record.state] !== input.targetState) {
      throw new AppError(
        409,
        'INVALID_BLUEPRINT_TRANSITION',
        `Invalid blueprint transition from ${record.state} to ${input.targetState}`
      );
    }

    if (input.actor.kind === 'agent' && input.targetState !== 'shadow') {
      throw new AppError(
        403,
        'BLUEPRINT_AGENT_TRANSITION_FORBIDDEN',
        'An agent may propose a blueprint but cannot authorize lifecycle transitions'
      );
    }
    if (
      input.targetState !== 'sandboxed' &&
      input.targetState !== 'shadow' &&
      input.actor.kind !== 'system'
    ) {
      throw new AppError(
        403,
        'BLUEPRINT_SYSTEM_GATE_REQUIRED',
        'Evaluation and rollout gates must be recorded by the system controller'
      );
    }

    if (input.targetState === 'shadow') {
      if (input.actor.kind !== 'human') {
        throw new AppError(
          403,
          'BLUEPRINT_HUMAN_APPROVAL_REQUIRED',
          'Blueprint shadow promotion requires human approval'
        );
      }
      if (input.actor.id === record.proposer.id) {
        throw new AppError(
          403,
          'BLUEPRINT_SELF_APPROVAL_FORBIDDEN',
          'Blueprint self-approval is forbidden'
        );
      }
    }

    if (input.targetState === 'sandboxed') {
      return this.repository.transition({
        ...input,
        fromState: record.state,
        toState: input.targetState,
        decisionCode: 'stage_evidence_recorded',
        reasonCode: null,
        gateDecision: null,
        observation: null
      });
    }
    if (input.observation === undefined) {
      throw new AppError(
        422,
        'BLUEPRINT_GATE_OBSERVATION_REQUIRED',
        `Blueprint transition to ${input.targetState} requires policy and economics observations`
      );
    }

    const gateDecision = evaluateGates(record.config, input.observation, input.targetState);
    if (!gateDecision.passed) {
      return this.repository.transition({
        ...input,
        fromState: record.state,
        toState: 'rolled_back',
        decisionCode: 'automatic_gate_rollback',
        reasonCode: 'automatic_gate_failure',
        gateDecision,
        observation: input.observation
      });
    }

    return this.repository.transition({
      ...input,
      fromState: record.state,
      toState: input.targetState,
      decisionCode: input.targetState === 'shadow' ? 'operator_approved' : 'gate_passed',
      reasonCode: null,
      gateDecision,
      observation: input.observation
    });
  }

  async reject(rawInput: RejectBlueprintInput): Promise<BlueprintRecord> {
    const input = RejectBlueprintInputSchema.parse(rawInput);
    if (input.actor.kind !== 'human') {
      throw new AppError(403, 'BLUEPRINT_HUMAN_REJECTION_REQUIRED', 'Only a human may reject');
    }
    const record = await this.requireRecord(input.blueprintId, input.revision);
    assertCurrent(record, input.expectedVersion);
    if (!['proposed', 'sandboxed', 'evaluated', 'awaiting_approval'].includes(record.state)) {
      throw new AppError(
        409,
        'INVALID_BLUEPRINT_TRANSITION',
        `Invalid blueprint transition from ${record.state} to rejected`
      );
    }
    return this.repository.transition({
      ...input,
      fromState: record.state,
      toState: 'rejected',
      decisionCode: 'operator_rejected',
      reasonCode: input.reasonCode,
      gateDecision: null,
      observation: null
    });
  }

  async rollback(rawInput: RollbackBlueprintInput): Promise<BlueprintRecord> {
    const input = RollbackBlueprintInputSchema.parse(rawInput);
    if (input.actor.kind === 'agent') {
      throw new AppError(
        403,
        'BLUEPRINT_AGENT_ROLLBACK_FORBIDDEN',
        'An agent cannot authorize a blueprint rollback'
      );
    }
    const record = await this.requireRecord(input.blueprintId, input.revision);
    assertCurrent(record, input.expectedVersion);
    if (
      !['sandboxed', 'evaluated', 'awaiting_approval', 'shadow', 'canary', 'active'].includes(
        record.state
      )
    ) {
      throw new AppError(
        409,
        'INVALID_BLUEPRINT_TRANSITION',
        `Invalid blueprint transition from ${record.state} to rolled_back`
      );
    }
    return this.repository.transition({
      ...input,
      fromState: record.state,
      toState: 'rolled_back',
      decisionCode: input.actor.kind === 'human' ? 'operator_rollback' : 'automatic_gate_rollback',
      reasonCode: input.reasonCode,
      gateDecision: null,
      observation: null
    });
  }

  async retire(rawInput: RetireBlueprintInput): Promise<BlueprintRecord> {
    const input = RetireBlueprintInputSchema.parse(rawInput);
    if (input.actor.kind !== 'human') {
      throw new AppError(403, 'BLUEPRINT_HUMAN_RETIREMENT_REQUIRED', 'Only a human may retire');
    }
    const record = await this.requireRecord(input.blueprintId, input.revision);
    assertCurrent(record, input.expectedVersion);
    if (record.state !== 'active') {
      throw new AppError(
        409,
        'INVALID_BLUEPRINT_TRANSITION',
        `Invalid blueprint transition from ${record.state} to retired`
      );
    }
    return this.repository.transition({
      ...input,
      fromState: record.state,
      toState: 'retired',
      decisionCode: 'operator_retired',
      reasonCode: input.reasonCode,
      gateDecision: null,
      observation: null
    });
  }

  private async requireRecord(blueprintId: string, revision: number): Promise<BlueprintRecord> {
    const record = await this.repository.find(blueprintId, revision);
    if (record === undefined) {
      throw new AppError(
        404,
        'BLUEPRINT_NOT_FOUND',
        `Blueprint ${blueprintId}@${revision} was not found`
      );
    }
    return record;
  }
}
