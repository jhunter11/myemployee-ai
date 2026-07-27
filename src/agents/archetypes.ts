/**
 * The archetype layer.
 *
 * Every agent in the catalog is one of nine archetypes. An archetype owns the
 * *structure and safety invariants* of a role — who it escalates to, which
 * budget classes it may draw from, how its run opens and closes, and which
 * sleeve it writes to. It deliberately does NOT own domain content: stages,
 * tools, and purposes are per-profile and stay hand-authored, because all 34
 * catalog profiles have distinct stage sequences.
 *
 * The `generalizable` flag records which archetypes can be instantiated against
 * an arbitrary sleeve. The dividing line is whether the role's correctness is
 * defined inside or outside its sleeve:
 *
 *   - Inward-facing roles (specialist, advisor, builder, reviewer, verifier)
 *     consume pinned inputs and publish an artifact plus evidence. They are a
 *     pure function of their sleeve, so one definition serves any number of
 *     sleeves.
 *   - Boundary-crossing roles are not generalizable. `root` and `coordinator`
 *     cross upward to the operator and hold durable cross-run scope state;
 *     `operator` crosses outward to the world and its gate predicate is
 *     domain-specific; `auditor` crosses backward to an external ledger and its
 *     reconciliation invariant is domain-specific.
 *
 * That split is not asserted, it is measured: the boundary-crossing archetypes
 * are exactly the ones whose stage sequences track external state
 * (`lease -> commit -> settle`, `intake -> route -> handoff`) rather than the
 * uniform `*_pinned ... *_published` shape the inward-facing reviewers,
 * verifiers, and auditors all share.
 */
import { z } from 'zod';

import { AppError } from '../utils/errors';
import type { AgentProfile } from './profile-catalog';

export type AgentRelation = AgentProfile['relation'];
export type BudgetKind = 'coordinator' | 'specialist' | 'leaf' | 'deterministic' | 'worker';

/** Budget classes are shared across archetypes; a member picks one from its archetype's allowlist. */
export const BUDGETS: Record<BudgetKind, AgentProfile['continuation']['budgets']> = {
  coordinator: {
    maxTurns: 16,
    maxToolCalls: 48,
    maxDurationSeconds: 3_600,
    maxEstimatedTokens: 48_000,
    maxChildRuns: 8
  },
  specialist: {
    maxTurns: 12,
    maxToolCalls: 32,
    maxDurationSeconds: 2_400,
    maxEstimatedTokens: 32_000,
    maxChildRuns: 4
  },
  leaf: {
    maxTurns: 8,
    maxToolCalls: 20,
    maxDurationSeconds: 1_200,
    maxEstimatedTokens: 20_000,
    maxChildRuns: 0
  },
  deterministic: {
    maxTurns: 4,
    maxToolCalls: 16,
    maxDurationSeconds: 900,
    maxEstimatedTokens: 0,
    maxChildRuns: 0
  },
  worker: {
    maxTurns: 8,
    maxToolCalls: 32,
    maxDurationSeconds: 3_600,
    maxEstimatedTokens: 0,
    maxChildRuns: 0
  }
};

/**
 * How a member's propose-writable sleeve is resolved.
 *
 * `pod` writes to the pod's own sleeve. `pod_reviews` appends the `_reviews`
 * suffix, keeping adversarial output out of the sleeve it critiques — every
 * reviewer in the catalog follows this. `explicit` means the member must name
 * its sleeve; verifiers use it because their sleeves are genuinely irregular
 * (`security_reviews` and `submission_reviews` do not match their pod names).
 */
export const SleeveRuleSchema = z.enum(['pod', 'pod_reviews', 'explicit']);
export type SleeveRule = z.infer<typeof SleeveRuleSchema>;

/** Required first/last continuation stage suffixes, or `null` where no shape is enforced. */
export interface StageBookend {
  readonly firstSuffix: string;
  readonly lastSuffix: string;
}

export interface ArchetypeSpec {
  readonly relation: AgentRelation;
  readonly label: string;
  /** Whether one definition can serve an arbitrary sleeve. See the module note. */
  readonly generalizable: boolean;
  /** Budget classes this archetype may draw from. */
  readonly budgetKinds: readonly BudgetKind[];
  readonly defaultBudget: BudgetKind;
  readonly sleeveRule: SleeveRule;
  /** `operator` only for the root; every other archetype escalates to its parent. */
  readonly escalatesTo: 'parent' | 'operator';
  /** Enforced run shape, where the archetype has one. */
  readonly stageBookend: StageBookend | null;
}

const PIN_AND_PUBLISH: StageBookend = { firstSuffix: 'pinned', lastSuffix: 'published' };

export const ARCHETYPES: Record<AgentRelation, ArchetypeSpec> = {
  root: {
    relation: 'root',
    label: 'Root coordinator',
    generalizable: false,
    budgetKinds: ['coordinator'],
    defaultBudget: 'coordinator',
    sleeveRule: 'pod',
    escalatesTo: 'operator',
    stageBookend: null
  },
  coordinator: {
    relation: 'coordinator',
    label: 'Domain coordinator',
    generalizable: false,
    budgetKinds: ['coordinator'],
    defaultBudget: 'coordinator',
    sleeveRule: 'pod',
    escalatesTo: 'parent',
    stageBookend: null
  },
  specialist: {
    relation: 'specialist',
    label: 'Pod lead',
    generalizable: true,
    budgetKinds: ['coordinator', 'specialist'],
    defaultBudget: 'coordinator',
    sleeveRule: 'pod',
    escalatesTo: 'parent',
    stageBookend: null
  },
  advisor: {
    relation: 'advisor',
    label: 'Advisor',
    generalizable: true,
    budgetKinds: ['specialist', 'leaf'],
    defaultBudget: 'leaf',
    sleeveRule: 'pod',
    escalatesTo: 'parent',
    stageBookend: null
  },
  builder: {
    relation: 'builder',
    label: 'Builder',
    generalizable: true,
    budgetKinds: ['specialist', 'leaf', 'deterministic'],
    defaultBudget: 'leaf',
    sleeveRule: 'pod',
    escalatesTo: 'parent',
    stageBookend: null
  },
  reviewer: {
    relation: 'reviewer',
    label: 'Adversarial reviewer',
    generalizable: true,
    budgetKinds: ['leaf'],
    defaultBudget: 'leaf',
    sleeveRule: 'pod_reviews',
    escalatesTo: 'parent',
    stageBookend: PIN_AND_PUBLISH
  },
  verifier: {
    relation: 'verifier',
    label: 'Completion verifier',
    generalizable: true,
    budgetKinds: ['specialist', 'leaf', 'deterministic'],
    defaultBudget: 'leaf',
    sleeveRule: 'explicit',
    escalatesTo: 'parent',
    stageBookend: PIN_AND_PUBLISH
  },
  operator: {
    relation: 'operator',
    label: 'External-effect operator',
    generalizable: false,
    budgetKinds: ['worker', 'leaf'],
    defaultBudget: 'worker',
    sleeveRule: 'pod',
    escalatesTo: 'parent',
    stageBookend: null
  },
  auditor: {
    relation: 'auditor',
    label: 'External-record auditor',
    generalizable: false,
    budgetKinds: ['leaf'],
    defaultBudget: 'leaf',
    sleeveRule: 'pod',
    escalatesTo: 'parent',
    stageBookend: PIN_AND_PUBLISH
  }
};

/** Archetypes that may be instantiated against a sleeve chosen at runtime. */
export const GENERALIZABLE_RELATIONS: readonly AgentRelation[] = Object.values(ARCHETYPES)
  .filter(({ generalizable }) => generalizable)
  .map(({ relation }) => relation);

export function archetypeFor(relation: AgentRelation): ArchetypeSpec {
  return ARCHETYPES[relation];
}

function conformanceFailure(profileId: string, detail: string): AppError {
  return new AppError(
    500,
    'ARCHETYPE_CONFORMANCE_VIOLATION',
    `Profile ${profileId} violates its ${detail}`
  );
}

function stageSuffix(stageId: string): string {
  return stageId.split('_').pop() ?? '';
}

/**
 * Enforces the invariants every catalog profile shares with its archetype.
 * Structural rules only — content stays the profile's own.
 */
export function assertArchetypeConformance(profile: AgentProfile): void {
  const archetype = ARCHETYPES[profile.relation];

  const expectedTarget = archetype.escalatesTo === 'operator' ? 'operator' : profile.parentId;
  if (profile.continuation.escalation.target !== expectedTarget) {
    throw conformanceFailure(
      profile.id,
      `archetype escalation rule: ${profile.relation} must escalate to ${String(expectedTarget)}`
    );
  }

  const budget = JSON.stringify(profile.continuation.budgets);
  const allowed = archetype.budgetKinds.some((kind) => JSON.stringify(BUDGETS[kind]) === budget);
  if (!allowed) {
    throw conformanceFailure(
      profile.id,
      `archetype budget allowlist: ${profile.relation} may only use ${archetype.budgetKinds.join(', ')}`
    );
  }

  const bookend = archetype.stageBookend;
  if (bookend !== null) {
    const stages = profile.continuation.stages;
    const first = stages[0];
    const last = stages[stages.length - 1];
    if (first === undefined || stageSuffix(first.id) !== bookend.firstSuffix) {
      throw conformanceFailure(
        profile.id,
        `archetype run shape: ${profile.relation} must open on a *_${bookend.firstSuffix} stage`
      );
    }
    if (last === undefined || stageSuffix(last.id) !== bookend.lastSuffix) {
      throw conformanceFailure(
        profile.id,
        `archetype run shape: ${profile.relation} must close on a *_${bookend.lastSuffix} stage`
      );
    }
  }
}
