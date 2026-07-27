import { z } from 'zod';

import { sha256 } from '../system/hashing';
import { canonicalize } from './canonical';
import { isLiveClaim } from './lifecycle';
import type { ProvenanceEdge, ProvenanceEdgeType } from './reducer';
import type { MemoryRevision } from './record-contracts';

/**
 * Invalidation as a BUILD SYSTEM, not a search index.
 *
 * Bazel's Skyframe is the model the report names: deterministic functions declare
 * their dependencies explicitly, and when an input changes the system invalidates
 * exactly the reverse transitive closure of affected nodes. The alternative — a
 * heuristic sweep over "things that look related" — is both unsound (it misses
 * dependents whose relationship was never written down) and unstable (it produces
 * different answers on different runs).
 *
 * Three properties are load-bearing and are tested directly:
 *   1. Every dependent gets EXACTLY ONE class. A revision that is simultaneously
 *      "recheck" and "quarantine" gives an operator no action to take.
 *   2. Recomputation order is `(sleeveId, topologicalDepth, revisionId)`, so a
 *      diamond-shaped dependency graph produces one fixed order, not a traversal
 *      artifact.
 *   3. Nothing is mutated. The plan says what must be EMITTED — new revisions,
 *      retractions, quarantine reviews — because silently rewriting a dependent
 *      would destroy the very audit trail the ledger exists to keep.
 */

/** Why a source revision entered the pipeline. Drives the class assignment table. */
export const INVALIDATION_TRIGGERS = [
  'corrected',
  'revoked',
  'deleted',
  'poisoned',
  'reclassified'
] as const;

export const InvalidationTriggerSchema = z.enum(INVALIDATION_TRIGGERS);
export type InvalidationTrigger = z.infer<typeof InvalidationTriggerSchema>;

/** The report's four classes, ordered weakest to strongest. */
export const INVALIDATION_CLASSES = [
  'safe',
  'recheck_required',
  'retract_required',
  'quarantine_required'
] as const;

export const InvalidationClassSchema = z.enum(INVALIDATION_CLASSES);
export type InvalidationClass = z.infer<typeof InvalidationClassSchema>;

/**
 * Strength order. A dependent reachable by two paths takes the STRONGEST class
 * either path implies — the conservative direction, and the one that makes "exactly
 * one class" a well-defined function of the graph rather than of traversal order.
 */
const CLASS_STRENGTH: Readonly<Record<InvalidationClass, number>> = {
  safe: 0,
  recheck_required: 1,
  retract_required: 2,
  quarantine_required: 3
};

export type InvalidationRemedy = 'none' | 'revalidate' | 'retract' | 'quarantine_review';

export interface InvalidationClassPolicy {
  readonly klass: InvalidationClass;
  /** The ledger op an operator or job must issue. The plan never issues it itself. */
  readonly remedy: InvalidationRemedy;
  /** Whether the dependent must drop out of default retrieval before the remedy lands. */
  readonly suppressRetrieval: boolean;
  readonly description: string;
}

export const INVALIDATION_CLASS_POLICIES: Readonly<
  Record<InvalidationClass, InvalidationClassPolicy>
> = {
  safe: {
    klass: 'safe',
    remedy: 'none',
    suppressRetrieval: false,
    description: 'The source change cannot affect this claim; it stands unchanged.'
  },
  recheck_required: {
    klass: 'recheck_required',
    remedy: 'revalidate',
    suppressRetrieval: false,
    description: 'The claim may still hold but must be recomputed against the corrected source.'
  },
  retract_required: {
    klass: 'retract_required',
    remedy: 'retract',
    suppressRetrieval: true,
    description: 'The claim has lost its only support and is no longer supportable.'
  },
  quarantine_required: {
    klass: 'quarantine_required',
    remedy: 'quarantine_review',
    suppressRetrieval: true,
    description: 'Possible poisoning or a sensitivity breach; the claim is withheld pending review.'
  }
};

export function strongerClass(
  left: InvalidationClass,
  right: InvalidationClass
): InvalidationClass {
  return CLASS_STRENGTH[left] >= CLASS_STRENGTH[right] ? left : right;
}

/**
 * Edge types that carry a DERIVATION. Only these propagate invalidation: `used`
 * and `associated_with` describe what an activity touched and who ran it, which is
 * provenance worth keeping but not a claim that depends on the source's truth.
 */
const DEPENDENCY_EDGE_TYPES: readonly ProvenanceEdgeType[] = [
  'derived_from',
  'bundled_in',
  'invalidated_by'
];

export interface InvalidationAssignment {
  readonly revisionId: string;
  readonly memoryId: string;
  readonly sleeveId: string;
  readonly klass: InvalidationClass;
  readonly remedy: InvalidationRemedy;
  /** Shortest reverse-edge distance from any marked source. Sources sit at depth 0. */
  readonly topologicalDepth: number;
  /** The nearest marked source that reached this dependent, lowest id on a tie. */
  readonly sourceRevisionId: string;
  readonly reason: string;
}

export interface InvalidationPlan {
  readonly sleeveId: string;
  readonly trigger: InvalidationTrigger;
  /** The source revisions themselves, marked with the triggering event. */
  readonly markedRevisionIds: readonly string[];
  /** One assignment per dependent, ordered by (sleeveId, depth, revisionId). */
  readonly assignments: readonly InvalidationAssignment[];
  /**
   * Dependents named by an edge whose revision is not in this sleeve's supplied
   * set. Reported rather than traversed: following them would cross a sleeve
   * boundary, and dropping them silently would hide an unhandled dependency.
   */
  readonly unresolvedDependentIds: readonly string[];
  readonly fingerprint: string;
}

export interface InvalidationInput {
  readonly sleeveId: string;
  readonly trigger: InvalidationTrigger;
  readonly sourceRevisionIds: readonly string[];
  readonly revisions: readonly MemoryRevision[];
  readonly edges: readonly ProvenanceEdge[];
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Class assignment for one dependent, given the trigger and the dependent's own
 * evidence footing. Deterministic and total: every (trigger, dependent) pair has
 * an answer, and the answer never depends on traversal order.
 */
function classifyDependent(
  trigger: InvalidationTrigger,
  dependent: MemoryRevision,
  source: MemoryRevision | null,
  independentSupport: boolean
): { klass: InvalidationClass; reason: string } {
  // Poisoning and reclassification are CONTAMINATION events: they say something
  // about the source's trustworthiness or its disclosure class, and both travel
  // down every derivation path regardless of how well-supported the dependent is.
  if (trigger === 'poisoned') {
    return {
      klass: 'quarantine_required',
      reason: 'Source was identified as poisoned; the derivation chain is withheld pending review.'
    };
  }
  if (trigger === 'reclassified') {
    return {
      klass: 'quarantine_required',
      reason: 'Source sensitivity was reclassified; disclosure must be re-judged before reuse.'
    };
  }

  // An operator-authored explicit claim does not REST on a derived source: the
  // record contract already exempts it from the evidence obligation, so a change
  // upstream cannot unseat it. This is the only route to `safe`.
  const operatorAuthored =
    dependent.authorityTier === 'operator_explicit' ||
    dependent.authorityTier === 'policy_signed_approved';
  if (operatorAuthored && dependent.derivationMethod === 'explicit_operator_statement') {
    return {
      klass: 'safe',
      reason:
        'Dependent is an operator-authored explicit statement, not a derivation of the source.'
    };
  }

  if (trigger === 'deleted' || trigger === 'revoked') {
    if (!independentSupport) {
      return {
        klass: 'retract_required',
        reason:
          `Source '${source?.revisionId ?? 'unknown'}' was its only support; ` +
          'the claim is no longer supportable.'
      };
    }
    return {
      klass: 'recheck_required',
      reason: 'Source was withdrawn but independent evidence remains; the claim must be recomputed.'
    };
  }

  return {
    klass: 'recheck_required',
    reason: 'Source was corrected; the claim may still hold but must be recomputed.'
  };
}

/**
 * Does the dependent stand on anything other than the marked sources? A claim with
 * a second, unaffected evidence reference is a recheck; a claim with only the
 * marked source behind it has lost its footing entirely.
 */
function hasIndependentSupport(
  dependent: MemoryRevision,
  markedRevisionIds: ReadonlySet<string>,
  markedMemoryIds: ReadonlySet<string>
): boolean {
  const supportingEvidence = dependent.evidenceRefs.filter(
    (reference) => !markedRevisionIds.has(reference.id)
  );
  const supportingThreads = dependent.derivedFrom.filter(
    (memoryId) => !markedMemoryIds.has(memoryId)
  );
  return supportingEvidence.length > 0 || supportingThreads.length > 0;
}

/**
 * Plan the reverse transitive closure of an invalidation.
 *
 * Pure: identical input yields an identical plan, including assignment order and
 * fingerprint. Sources are marked at depth 0 and never appear as their own
 * dependents; every reachable dependent appears exactly once.
 */
export function planInvalidation(input: InvalidationInput): InvalidationPlan {
  const revisionById = new Map(
    input.revisions
      .filter((revision) => revision.sleeveId === input.sleeveId)
      .map((revision) => [revision.revisionId, revision] as const)
  );
  const markedRevisionIds = [...new Set(input.sourceRevisionIds)]
    .filter((revisionId) => revisionById.has(revisionId))
    .sort(compareCodeUnits);
  const markedSet = new Set(markedRevisionIds);
  const markedMemoryIds = new Set(
    markedRevisionIds.map((revisionId) => revisionById.get(revisionId)?.memoryId ?? revisionId)
  );

  // Reverse index: for a source id (a revision id OR the memory id of a thread),
  // which entities declared a dependency on it. Both keys matter because
  // `derivedFrom` names THREADS while `evidenceRefs` name REVISIONS.
  const dependentsBySource = new Map<string, string[]>();
  for (const edge of input.edges) {
    if (edge.sleeveId !== input.sleeveId) continue;
    if (!DEPENDENCY_EDGE_TYPES.includes(edge.edgeType)) continue;
    const existing = dependentsBySource.get(edge.toId);
    if (existing === undefined) dependentsBySource.set(edge.toId, [edge.fromId]);
    else existing.push(edge.fromId);
  }

  const assignedDepth = new Map<string, number>();
  const assignedSource = new Map<string, string>();
  const unresolved = new Set<string>();

  // Breadth-first over reverse edges. BFS gives the SHORTEST distance from any
  // source, and each frontier is sorted so a diamond resolves the same way every
  // time regardless of the order edges were appended.
  let depth = 0;
  let frontier: string[] = markedRevisionIds;
  const visitedKeys = new Set<string>(markedRevisionIds);
  for (const revisionId of markedRevisionIds) {
    const memoryId = revisionById.get(revisionId)?.memoryId;
    if (memoryId !== undefined) visitedKeys.add(memoryId);
  }

  while (frontier.length > 0 && depth < 64) {
    depth += 1;
    const next: string[] = [];
    for (const sourceKey of [...frontier].sort(compareCodeUnits)) {
      const keys = [sourceKey];
      const sourceRevision = revisionById.get(sourceKey);
      if (sourceRevision !== undefined) keys.push(sourceRevision.memoryId);
      for (const key of keys) {
        for (const dependentId of (dependentsBySource.get(key) ?? []).sort(compareCodeUnits)) {
          if (markedSet.has(dependentId)) continue;
          if (!revisionById.has(dependentId)) {
            unresolved.add(dependentId);
            continue;
          }
          if (assignedDepth.has(dependentId)) {
            // Already reached by a shorter or equal path. Only the source
            // attribution can improve, and it improves toward the lowest id so the
            // choice is total rather than order-dependent.
            const existingSource = assignedSource.get(dependentId);
            if (
              assignedDepth.get(dependentId) === depth &&
              existingSource !== undefined &&
              compareCodeUnits(sourceKey, existingSource) < 0
            ) {
              assignedSource.set(dependentId, sourceKey);
            }
            continue;
          }
          assignedDepth.set(dependentId, depth);
          assignedSource.set(dependentId, sourceKey);
          if (!visitedKeys.has(dependentId)) {
            visitedKeys.add(dependentId);
            next.push(dependentId);
          }
        }
      }
    }
    frontier = next;
  }

  const assignments: InvalidationAssignment[] = [];
  for (const [revisionId, dependentDepth] of assignedDepth) {
    const dependent = revisionById.get(revisionId);
    if (dependent === undefined) continue;
    const sourceKey = assignedSource.get(revisionId) ?? revisionId;
    const source = revisionById.get(sourceKey) ?? null;
    const independent = hasIndependentSupport(dependent, markedSet, markedMemoryIds);
    const verdict = classifyDependent(input.trigger, dependent, source, independent);
    // A dependent that is already out of the live set needs no remedy; re-judging a
    // retracted or deleted claim would produce busywork, not safety.
    const klass = isLiveClaim(dependent.status) ? verdict.klass : 'safe';
    assignments.push({
      revisionId,
      memoryId: dependent.memoryId,
      sleeveId: dependent.sleeveId,
      klass,
      remedy: INVALIDATION_CLASS_POLICIES[klass].remedy,
      topologicalDepth: dependentDepth,
      sourceRevisionId: source?.revisionId ?? sourceKey,
      reason: isLiveClaim(dependent.status)
        ? verdict.reason
        : `Dependent is already '${dependent.status}' and needs no further action.`
    });
  }

  assignments.sort((left, right) => {
    const bySleeve = compareCodeUnits(left.sleeveId, right.sleeveId);
    if (bySleeve !== 0) return bySleeve;
    if (left.topologicalDepth !== right.topologicalDepth) {
      return left.topologicalDepth - right.topologicalDepth;
    }
    return compareCodeUnits(left.revisionId, right.revisionId);
  });

  const unresolvedDependentIds = [...unresolved].sort(compareCodeUnits);
  const fingerprint = `sha256:${sha256(
    canonicalize({
      sleeveId: input.sleeveId,
      trigger: input.trigger,
      markedRevisionIds,
      unresolvedDependentIds,
      assignments: assignments.map((assignment) => ({
        revisionId: assignment.revisionId,
        klass: assignment.klass,
        topologicalDepth: assignment.topologicalDepth,
        sourceRevisionId: assignment.sourceRevisionId
      }))
    })
  )}`;

  return {
    sleeveId: input.sleeveId,
    trigger: input.trigger,
    markedRevisionIds,
    assignments,
    unresolvedDependentIds,
    fingerprint
  };
}

/**
 * The revisions that must stop being retrievable before their remedy lands.
 * Retrieval abstains rather than serving a claim whose support is under suspicion.
 */
export function suppressedRevisionIds(plan: InvalidationPlan): readonly string[] {
  return plan.assignments
    .filter((assignment) => INVALIDATION_CLASS_POLICIES[assignment.klass].suppressRetrieval)
    .map((assignment) => assignment.revisionId);
}
