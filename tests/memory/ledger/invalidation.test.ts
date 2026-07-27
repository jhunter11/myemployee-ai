import { describe, expect, it } from 'vitest';

import { canonicalHash, contentHash } from '../../../src/memory/ledger/canonical';
import {
  INVALIDATION_CLASSES,
  INVALIDATION_CLASS_POLICIES,
  planInvalidation,
  strongerClass,
  suppressedRevisionIds,
  type InvalidationInput
} from '../../../src/memory/ledger/invalidation';
import type { ProvenanceEdge } from '../../../src/memory/ledger/reducer';
import {
  MemoryRevisionSchema,
  sleeveClassForSleeveId,
  type MemoryEvidenceRef,
  type MemoryRevision
} from '../../../src/memory/ledger/record-contracts';

const SLEEVE_ID = 'client:acme_corp';
const OWNER_SCOPE_ID = 'client:acme_corp';
const AGENT_ID = 'agency-developer';
const T0 = '2026-07-24T18:00:00.000Z';

interface RevisionSpec {
  readonly id: string;
  readonly memoryId: string;
  readonly evidence?: readonly MemoryEvidenceRef[];
  readonly derivedFrom?: readonly string[];
  readonly status?: MemoryRevision['status'];
  readonly authorityTier?: MemoryRevision['authorityTier'];
  readonly derivationMethod?: MemoryRevision['derivationMethod'];
  readonly sleeveId?: string;
}

function revision(spec: RevisionSpec): MemoryRevision {
  const payload = {
    form: 'structured' as const,
    fields: { claim: spec.id }
  };
  const base = {
    schemaVersion: 'memrec/v1',
    recordType: 'MemoryRevision',
    memoryId: spec.memoryId,
    revisionId: spec.id,
    revisionNo: 1,
    ownerScopeId: OWNER_SCOPE_ID,
    sleeveId: spec.sleeveId ?? SLEEVE_ID,
    sleeveClass: sleeveClassForSleeveId(spec.sleeveId ?? SLEEVE_ID),
    kind: 'fact',
    entityKey: null,
    status: spec.status ?? 'active',
    approvalState: 'auto_accepted',
    authorityTier: spec.authorityTier ?? 'agent_observation',
    confidencePermille: 800,
    sensitivity: 'confidential',
    retentionPolicy: 'until_superseded',
    legalHold: false,
    eventTime: null,
    observedAt: T0,
    createdTxTime: T0,
    recordedTxSeq: 1,
    validFrom: T0,
    validUntil: null,
    decidedAt: null,
    authorAgentId: AGENT_ID,
    workflowId: null,
    runId: null,
    derivationMethod: spec.derivationMethod ?? 'episode_extraction',
    sourceEventIds: [],
    evidenceRefs: [...(spec.evidence ?? [{ type: 'artifact', id: 'art_seed' }])],
    derivedFrom: [...(spec.derivedFrom ?? [])],
    contradicts: [],
    supersedes: null,
    supersededBy: null,
    payloadCanonical: payload,
    contentHash: contentHash(payload),
    canonicalHash: `sha256:${'0'.repeat(64)}`,
    tombstone: null
  } as MemoryRevision;
  return MemoryRevisionSchema.parse({ ...base, canonicalHash: canonicalHash(base) });
}

function derivedEdge(fromId: string, toId: string, sleeveId = SLEEVE_ID): ProvenanceEdge {
  return {
    edgeId: `pve_${fromId}_${toId}`.replace(/[^A-Za-z0-9_-]/gu, '_'),
    sleeveId,
    ownerScopeId: OWNER_SCOPE_ID,
    edgeType: 'derived_from',
    fromId,
    toId,
    commandId: 'cmd_seed',
    recordedAt: T0
  };
}

function usedEdge(fromId: string, toId: string): ProvenanceEdge {
  return { ...derivedEdge(fromId, toId), edgeId: `pve_used_${fromId}_${toId}`, edgeType: 'used' };
}

/**
 * The diamond. `rev_a` is the source; `rev_b` and `rev_c` each derive from it; and
 * `rev_d` derives from BOTH. A traversal that double-counts, or one whose answer
 * depends on which arm it walks first, shows up here and nowhere else.
 */
function diamond(): { revisions: MemoryRevision[]; edges: ProvenanceEdge[] } {
  const revisions = [
    revision({ id: 'rev_a', memoryId: 'mem_a' }),
    revision({
      id: 'rev_b',
      memoryId: 'mem_b',
      evidence: [{ type: 'memory_revision', id: 'rev_a' }]
    }),
    revision({
      id: 'rev_c',
      memoryId: 'mem_c',
      evidence: [
        { type: 'memory_revision', id: 'rev_a' },
        { type: 'artifact', id: 'art_independent' }
      ]
    }),
    revision({
      id: 'rev_d',
      memoryId: 'mem_d',
      evidence: [
        { type: 'memory_revision', id: 'rev_b' },
        { type: 'memory_revision', id: 'rev_c' }
      ]
    })
  ];
  const edges = [
    derivedEdge('rev_b', 'rev_a'),
    derivedEdge('rev_c', 'rev_a'),
    derivedEdge('rev_d', 'rev_b'),
    derivedEdge('rev_d', 'rev_c')
  ];
  return { revisions, edges };
}

function plan(overrides: Partial<InvalidationInput> = {}) {
  const graph = diamond();
  return planInvalidation({
    sleeveId: SLEEVE_ID,
    trigger: 'corrected',
    sourceRevisionIds: ['rev_a'],
    revisions: graph.revisions,
    edges: graph.edges,
    ...overrides
  });
}

describe('Skyframe-style invalidation', () => {
  describe('the class table', () => {
    it('names exactly four classes, each with a remedy the reducer does not apply itself', () => {
      expect(INVALIDATION_CLASSES).toEqual([
        'safe',
        'recheck_required',
        'retract_required',
        'quarantine_required'
      ]);
      expect(INVALIDATION_CLASS_POLICIES.safe.remedy).toBe('none');
      expect(INVALIDATION_CLASS_POLICIES.recheck_required.remedy).toBe('revalidate');
      expect(INVALIDATION_CLASS_POLICIES.retract_required.remedy).toBe('retract');
      expect(INVALIDATION_CLASS_POLICIES.quarantine_required.remedy).toBe('quarantine_review');
      // The two classes that mean "do not serve this" must suppress retrieval.
      expect(INVALIDATION_CLASS_POLICIES.retract_required.suppressRetrieval).toBe(true);
      expect(INVALIDATION_CLASS_POLICIES.quarantine_required.suppressRetrieval).toBe(true);
      expect(INVALIDATION_CLASS_POLICIES.recheck_required.suppressRetrieval).toBe(false);
    });

    it('resolves two paths to the strongest class, not the last one walked', () => {
      expect(strongerClass('safe', 'recheck_required')).toBe('recheck_required');
      expect(strongerClass('retract_required', 'recheck_required')).toBe('retract_required');
      expect(strongerClass('quarantine_required', 'retract_required')).toBe('quarantine_required');
      expect(strongerClass('safe', 'safe')).toBe('safe');
    });
  });

  describe('exactly one class per dependent', () => {
    it('assigns every reachable dependent once, sources excluded', () => {
      const result = plan();
      const ids = result.assignments.map((assignment) => assignment.revisionId);
      // rev_d is reachable by two arms of the diamond and must still appear once.
      expect(ids).toEqual(['rev_b', 'rev_c', 'rev_d']);
      expect(new Set(ids).size).toBe(ids.length);
      // A source is marked, never classified as its own dependent.
      expect(result.markedRevisionIds).toEqual(['rev_a']);
      expect(ids).not.toContain('rev_a');
      for (const assignment of result.assignments) {
        expect(INVALIDATION_CLASSES).toContain(assignment.klass);
        expect(assignment.remedy).toBe(INVALIDATION_CLASS_POLICIES[assignment.klass].remedy);
        expect(assignment.reason.length).toBeGreaterThan(0);
      }
    });

    it('measures depth as the shortest path from any marked source', () => {
      const result = plan();
      const depths = Object.fromEntries(
        result.assignments.map((assignment) => [assignment.revisionId, assignment.topologicalDepth])
      );
      expect(depths).toEqual({ rev_b: 1, rev_c: 1, rev_d: 2 });
    });
  });

  describe('deterministic ordering', () => {
    it('produces an identical plan and fingerprint however the edges arrive', () => {
      const graph = diamond();
      const forward = planInvalidation({
        sleeveId: SLEEVE_ID,
        trigger: 'corrected',
        sourceRevisionIds: ['rev_a'],
        revisions: graph.revisions,
        edges: graph.edges
      });
      const shuffled = planInvalidation({
        sleeveId: SLEEVE_ID,
        trigger: 'corrected',
        sourceRevisionIds: ['rev_a'],
        revisions: [...graph.revisions].reverse(),
        // Append order of the provenance graph is an artifact of when commands
        // landed; the plan must not inherit it.
        edges: [graph.edges[3], graph.edges[1], graph.edges[0], graph.edges[2]].filter(
          (edge): edge is ProvenanceEdge => edge !== undefined
        )
      });
      expect(shuffled.fingerprint).toBe(forward.fingerprint);
      expect(shuffled.assignments).toEqual(forward.assignments);
    });

    it('orders assignments by (sleeveId, topologicalDepth, revisionId)', () => {
      const result = plan();
      const ordered = [...result.assignments].sort((left, right) => {
        if (left.sleeveId !== right.sleeveId) return left.sleeveId < right.sleeveId ? -1 : 1;
        if (left.topologicalDepth !== right.topologicalDepth) {
          return left.topologicalDepth - right.topologicalDepth;
        }
        return left.revisionId < right.revisionId ? -1 : 1;
      });
      expect(result.assignments).toEqual(ordered);
    });
  });

  describe('class assignment by trigger', () => {
    it('quarantines the whole closure when a source is poisoned', () => {
      const result = plan({ trigger: 'poisoned' });
      expect(result.assignments.map((assignment) => assignment.klass)).toEqual([
        'quarantine_required',
        'quarantine_required',
        'quarantine_required'
      ]);
      // Contamination travels regardless of how well-supported a dependent is.
      expect(suppressedRevisionIds(result)).toEqual(['rev_b', 'rev_c', 'rev_d']);
    });

    it('quarantines the closure when a source is reclassified', () => {
      const result = plan({ trigger: 'reclassified' });
      expect(new Set(result.assignments.map((assignment) => assignment.klass))).toEqual(
        new Set(['quarantine_required'])
      );
    });

    it('retracts a dependent that loses its only support, rechecks the rest', () => {
      const result = plan({ trigger: 'deleted' });
      const byId = Object.fromEntries(
        result.assignments.map((assignment) => [assignment.revisionId, assignment.klass])
      );
      // rev_b stood on rev_a alone; rev_c also cites an independent artifact.
      expect(byId.rev_b).toBe('retract_required');
      expect(byId.rev_c).toBe('recheck_required');
      // rev_d rests on rev_b and rev_c, neither of which is itself marked, so it is
      // recomputed after they are — not retracted pre-emptively.
      expect(byId.rev_d).toBe('recheck_required');
      expect(suppressedRevisionIds(result)).toEqual(['rev_b']);
    });

    it('rechecks the closure on a plain correction', () => {
      const result = plan({ trigger: 'corrected' });
      expect(new Set(result.assignments.map((assignment) => assignment.klass))).toEqual(
        new Set(['recheck_required'])
      );
      expect(suppressedRevisionIds(result)).toEqual([]);
    });

    it('leaves an operator-authored explicit statement safe under correction', () => {
      const graph = diamond();
      const revisions = graph.revisions.map((entry) =>
        entry.revisionId === 'rev_b'
          ? revision({
              id: 'rev_b',
              memoryId: 'mem_b',
              evidence: [{ type: 'memory_revision', id: 'rev_a' }],
              authorityTier: 'operator_explicit',
              derivationMethod: 'explicit_operator_statement'
            })
          : entry
      );
      const result = planInvalidation({
        sleeveId: SLEEVE_ID,
        trigger: 'deleted',
        sourceRevisionIds: ['rev_a'],
        revisions,
        edges: graph.edges
      });
      const byId = Object.fromEntries(
        result.assignments.map((assignment) => [assignment.revisionId, assignment.klass])
      );
      // The record contract already exempts operator-authored policy from the
      // evidence obligation, so a change upstream cannot unseat it.
      expect(byId.rev_b).toBe('safe');
      expect(byId.rev_c).toBe('recheck_required');
    });

    it('needs no remedy for a dependent that is already out of the live set', () => {
      const graph = diamond();
      const revisions = graph.revisions.map((entry) =>
        entry.revisionId === 'rev_c'
          ? revision({
              id: 'rev_c',
              memoryId: 'mem_c',
              evidence: [{ type: 'memory_revision', id: 'rev_a' }],
              status: 'retracted'
            })
          : entry
      );
      const result = planInvalidation({
        sleeveId: SLEEVE_ID,
        trigger: 'poisoned',
        sourceRevisionIds: ['rev_a'],
        revisions,
        edges: graph.edges
      });
      const assignment = result.assignments.find((entry) => entry.revisionId === 'rev_c');
      expect(assignment?.klass).toBe('safe');
      expect(assignment?.remedy).toBe('none');
    });
  });

  describe('fail-closed boundaries', () => {
    it('reports a dependent it cannot resolve rather than silently dropping it', () => {
      const graph = diamond();
      const result = planInvalidation({
        sleeveId: SLEEVE_ID,
        trigger: 'deleted',
        sourceRevisionIds: ['rev_a'],
        revisions: graph.revisions,
        edges: [...graph.edges, derivedEdge('rev_elsewhere', 'rev_a')]
      });
      expect(result.unresolvedDependentIds).toEqual(['rev_elsewhere']);
      expect(result.assignments.map((assignment) => assignment.revisionId)).not.toContain(
        'rev_elsewhere'
      );
      // An unhandled dependency changes the plan's identity; it must not hash the
      // same as a plan where everything resolved.
      expect(result.fingerprint).not.toBe(plan({ trigger: 'deleted' }).fingerprint);
    });

    it('never traverses an edge belonging to another sleeve', () => {
      const graph = diamond();
      const result = planInvalidation({
        sleeveId: SLEEVE_ID,
        trigger: 'poisoned',
        sourceRevisionIds: ['rev_a'],
        revisions: [
          ...graph.revisions,
          revision({ id: 'rev_foreign', memoryId: 'mem_foreign', sleeveId: 'agency:agency' })
        ],
        edges: [...graph.edges, derivedEdge('rev_foreign', 'rev_a', 'agency:agency')]
      });
      expect(result.assignments.map((assignment) => assignment.revisionId)).toEqual([
        'rev_b',
        'rev_c',
        'rev_d'
      ]);
      expect(result.unresolvedDependentIds).toEqual([]);
    });

    it('propagates through derivations only, not through mere use', () => {
      const graph = diamond();
      const result = planInvalidation({
        sleeveId: SLEEVE_ID,
        trigger: 'poisoned',
        sourceRevisionIds: ['rev_a'],
        revisions: [...graph.revisions, revision({ id: 'rev_e', memoryId: 'mem_e' })],
        // `used` records what an activity touched, not a claim that rests on it.
        edges: [...graph.edges, usedEdge('rev_e', 'rev_a')]
      });
      expect(result.assignments.map((assignment) => assignment.revisionId)).not.toContain('rev_e');
    });

    it('ignores a source revision that is not in this sleeve’s supplied set', () => {
      const result = plan({ sourceRevisionIds: ['rev_a', 'rev_unknown'] });
      expect(result.markedRevisionIds).toEqual(['rev_a']);
    });
  });
});
