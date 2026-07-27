import { describe, expect, it } from 'vitest';

import {
  entityKeyForFragment,
  planTemporalRetrieval,
  supportsRevisionCollapse,
  TEMPORAL_OMISSION_REASONS,
  TEMPORAL_RETRIEVAL_POLICY_VERSION,
  temporalStateAt,
  type TemporalFragmentView,
  type TemporalSuppressionReason
} from '../../../src/memory/system/temporal-retrieval';

const JANUARY = '2026-01-01T00:00:00.000Z';
const MARCH = '2026-03-01T00:00:00.000Z';
const JUNE = '2026-06-01T00:00:00.000Z';
const JULY = '2026-07-21T12:00:00.000Z';
const DECEMBER = '2026-12-01T00:00:00.000Z';

function view(id: string, overrides: Partial<TemporalFragmentView> = {}): TemporalFragmentView {
  return {
    id,
    kind: 'fact',
    title: 'Acme billing contact',
    validFrom: JANUARY,
    validUntil: null,
    recordedAt: JANUARY,
    expiresAt: null,
    supersedesFragmentId: null,
    supersededByFragmentId: null,
    retrievalEligible: true,
    ...overrides
  };
}

function reasonFor(
  plan: ReturnType<typeof planTemporalRetrieval>,
  fragmentId: string
): TemporalSuppressionReason | null {
  const decision = plan.decisions.find((entry) => entry.fragmentId === fragmentId);
  expect(decision).toBeDefined();
  return decision?.suppressionReason ?? null;
}

describe('temporalStateAt', () => {
  it('labels an open, unsuperseded fact current', () => {
    expect(temporalStateAt(view('f'), JULY)).toBe('current');
  });

  it('labels a closed validity window historical', () => {
    expect(temporalStateAt(view('f', { validUntil: JUNE }), JULY)).toBe('historical');
  });

  it('labels a superseded revision historical even while its own window is open', () => {
    expect(temporalStateAt(view('f', { supersededByFragmentId: 'g' }), JULY)).toBe('historical');
  });

  it('labels a retention-expired fragment historical', () => {
    expect(temporalStateAt(view('f', { expiresAt: JUNE }), JULY)).toBe('historical');
  });

  it('labels a not-yet-effective fact transitional', () => {
    expect(temporalStateAt(view('f', { validFrom: DECEMBER }), JULY)).toBe('transitional');
  });

  it('labels an in-force fact with a scheduled end transitional, not current', () => {
    expect(temporalStateAt(view('f', { validUntil: DECEMBER }), JULY)).toBe('transitional');
  });

  it('re-evaluates the same fragment differently at a different instant', () => {
    const bounded = view('f', { validFrom: JUNE, validUntil: DECEMBER });
    expect(temporalStateAt(bounded, MARCH)).toBe('transitional');
    expect(temporalStateAt(bounded, JULY)).toBe('transitional');
    expect(temporalStateAt(bounded, '2027-01-01T00:00:00.000Z')).toBe('historical');
  });
});

describe('entity identity and revision eligibility', () => {
  it('canonicalizes titles so punctuation and case do not mint a new entity', () => {
    expect(entityKeyForFragment(view('a', { title: '  Acme, Billing  Contact ' }))).toBe(
      entityKeyForFragment(view('b', { title: 'acme billing contact' }))
    );
  });

  it('keeps kinds apart so a summary never collapses a fact', () => {
    expect(entityKeyForFragment(view('a', { kind: 'fact' }))).not.toBe(
      entityKeyForFragment(view('b', { kind: 'summary' }))
    );
  });

  it('allows revision collapse only in the supersede-based stores', () => {
    expect(supportsRevisionCollapse('fact')).toBe(true);
    expect(supportsRevisionCollapse('procedure')).toBe(true);
    expect(supportsRevisionCollapse('episode')).toBe(false);
    expect(supportsRevisionCollapse('artifact')).toBe(false);
    expect(supportsRevisionCollapse('decision')).toBe(false);
  });
});

describe('planTemporalRetrieval — stale suppression', () => {
  it('retains a valid current fact and withholds nothing', () => {
    const plan = planTemporalRetrieval({
      mode: 'current',
      queryTime: JULY,
      candidates: [view('live')]
    });
    expect(plan.retainedFragmentIds).toEqual(['live']);
    expect(reasonFor(plan, 'live')).toBeNull();
    expect(plan.ghostPairs).toEqual([]);
  });

  it('withholds each stale shape with an auditable reason instead of dropping it', () => {
    const plan = planTemporalRetrieval({
      mode: 'current',
      queryTime: JULY,
      candidates: [
        view('linked', { supersededByFragmentId: 'newer' }),
        view('ended', { validUntil: JUNE, title: 'Ended fact' }),
        view('purged', { expiresAt: JUNE, title: 'Purged fact' }),
        view('future', { validFrom: DECEMBER, title: 'Future fact' }),
        view('withdrawn', { retrievalEligible: false, title: 'Withdrawn fact' })
      ]
    });
    expect(plan.retainedFragmentIds).toEqual([]);
    expect(reasonFor(plan, 'linked')).toBe('superseded_link');
    expect(reasonFor(plan, 'ended')).toBe('validity_ended');
    expect(reasonFor(plan, 'purged')).toBe('expired');
    expect(reasonFor(plan, 'future')).toBe('not_yet_valid');
    expect(reasonFor(plan, 'withdrawn')).toBe('retrieval_disabled');
    for (const decision of plan.decisions) {
      expect(decision.suppressionReason).not.toBeNull();
    }
  });

  it('projects every temporal reason onto the audited manifest vocabulary', () => {
    expect(TEMPORAL_OMISSION_REASONS.ghost_revision).toBe('superseded');
    expect(TEMPORAL_OMISSION_REASONS.superseded_link).toBe('superseded');
    expect(TEMPORAL_OMISSION_REASONS.validity_ended).toBe('validity_ended');
    expect(TEMPORAL_OMISSION_REASONS.not_yet_valid).toBe('not_yet_valid');
    expect(TEMPORAL_OMISSION_REASONS.expired).toBe('expired');
    expect(TEMPORAL_OMISSION_REASONS.retrieval_disabled).toBe('retrieval_disabled');
  });

  it('honours a forward supersession edge when the back-link was never written', () => {
    const plan = planTemporalRetrieval({
      mode: 'current',
      queryTime: JULY,
      candidates: [
        view('v1', { title: 'Escalation owner' }),
        view('v2', { title: 'Escalation policy', validFrom: JUNE, supersedesFragmentId: 'v1' })
      ]
    });
    expect(plan.retainedFragmentIds).toEqual(['v2']);
    expect(reasonFor(plan, 'v1')).toBe('superseded_link');
    expect(plan.ghostPairs).toEqual([
      {
        entityKey: entityKeyForFragment(view('v1', { title: 'Escalation owner' })),
        currentFragmentId: 'v2',
        ghostFragmentId: 'v1',
        detectedBy: 'supersession_link'
      }
    ]);
  });
});

describe('planTemporalRetrieval — ghost memory defense', () => {
  it('suppresses an unlinked older revision that would otherwise read as current', () => {
    const plan = planTemporalRetrieval({
      mode: 'current',
      queryTime: JULY,
      candidates: [view('stale', { validFrom: JANUARY }), view('fresh', { validFrom: JUNE })]
    });
    expect(plan.retainedFragmentIds).toEqual(['fresh']);
    expect(reasonFor(plan, 'stale')).toBe('ghost_revision');
    const stale = plan.decisions.find((entry) => entry.fragmentId === 'stale');
    // The ghost is relabelled, not silently dropped: its own metadata still claims
    // `current`, which is exactly the A-TMA failure this pass exists to catch.
    expect(temporalStateAt(view('stale'), JULY)).toBe('current');
    expect(stale?.state).toBe('historical');
    expect(stale?.displacedByFragmentId).toBe('fresh');
    expect(plan.ghostPairs).toEqual([
      {
        entityKey: entityKeyForFragment(view('stale')),
        currentFragmentId: 'fresh',
        ghostFragmentId: 'stale',
        detectedBy: 'entity_revision'
      }
    ]);
  });

  it('never empties a revision group: three revisions collapse to exactly one', () => {
    const plan = planTemporalRetrieval({
      mode: 'current',
      queryTime: JULY,
      candidates: [
        view('r1', { validFrom: JANUARY }),
        view('r2', { validFrom: MARCH }),
        view('r3', { validFrom: JUNE })
      ]
    });
    expect(plan.retainedFragmentIds).toEqual(['r3']);
    expect(plan.ghostPairs.map((pair) => pair.ghostFragmentId)).toEqual(['r1', 'r2']);
  });

  it('breaks a same-instant revision tie on recordedAt then id, never at random', () => {
    const plan = planTemporalRetrieval({
      mode: 'current',
      queryTime: JULY,
      candidates: [
        view('zulu', { validFrom: JUNE, recordedAt: JUNE }),
        view('alpha', { validFrom: JUNE, recordedAt: JUNE })
      ]
    });
    expect(plan.retainedFragmentIds).toEqual(['alpha']);
  });

  it('never collapses episodic evidence: repeated event titles are distinct events', () => {
    const plan = planTemporalRetrieval({
      mode: 'current',
      queryTime: JULY,
      candidates: [
        view('e1', { kind: 'episode', title: 'Weekly sync', validFrom: JANUARY }),
        view('e2', { kind: 'episode', title: 'Weekly sync', validFrom: JUNE })
      ]
    });
    expect(plan.retainedFragmentIds).toEqual(['e1', 'e2']);
    expect(plan.ghostPairs).toEqual([]);
  });

  it('does not collapse two differently-named live facts', () => {
    const plan = planTemporalRetrieval({
      mode: 'current',
      queryTime: JULY,
      candidates: [
        view('billing', { title: 'Acme billing contact' }),
        view('security', { title: 'Acme security contact' })
      ]
    });
    expect(plan.retainedFragmentIds).toEqual(['billing', 'security']);
  });
});

describe('planTemporalRetrieval — as-of reconstruction', () => {
  const v1 = view('v1', { validFrom: JANUARY, validUntil: JUNE, supersededByFragmentId: 'v2' });
  const v2 = view('v2', { validFrom: JUNE, recordedAt: JUNE, supersedesFragmentId: 'v1' });

  it('answers "current" with the successor', () => {
    const plan = planTemporalRetrieval({ mode: 'current', queryTime: JULY, candidates: [v1, v2] });
    expect(plan.retainedFragmentIds).toEqual(['v2']);
    expect(reasonFor(plan, 'v1')).toBe('superseded_link');
  });

  it('answers "as of March" with the revision March actually had', () => {
    const plan = planTemporalRetrieval({ mode: 'as_of', queryTime: MARCH, candidates: [v1, v2] });
    expect(plan.retainedFragmentIds).toEqual(['v1']);
    expect(reasonFor(plan, 'v2')).toBe('not_yet_valid');
    expect(plan.decisions.find((entry) => entry.fragmentId === 'v1')?.state).toBe('historical');
  });

  it('keeps the operator kill switch closed even in as-of mode', () => {
    const plan = planTemporalRetrieval({
      mode: 'as_of',
      queryTime: MARCH,
      candidates: [view('withdrawn', { retrievalEligible: false })]
    });
    expect(plan.retainedFragmentIds).toEqual([]);
    expect(reasonFor(plan, 'withdrawn')).toBe('retrieval_disabled');
  });

  it('still collapses ghosts among revisions that were concurrently valid as-of', () => {
    const plan = planTemporalRetrieval({
      mode: 'as_of',
      queryTime: MARCH,
      candidates: [view('older', { validFrom: JANUARY }), view('newer', { validFrom: MARCH })]
    });
    expect(plan.retainedFragmentIds).toEqual(['newer']);
    expect(reasonFor(plan, 'older')).toBe('ghost_revision');
  });
});

describe('planTemporalRetrieval — determinism and fail-closed input', () => {
  const candidates = [
    view('stale', { validFrom: JANUARY }),
    view('fresh', { validFrom: JUNE }),
    view('ended', { title: 'Retired policy', kind: 'policy', validUntil: MARCH }),
    view('sync', { kind: 'episode', title: 'Weekly sync' })
  ];

  it('produces an identical fingerprint on a repeated run', () => {
    const first = planTemporalRetrieval({ mode: 'current', queryTime: JULY, candidates });
    const second = planTemporalRetrieval({ mode: 'current', queryTime: JULY, candidates });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.decisions).toEqual(first.decisions);
    expect(first.policyVersion).toBe(TEMPORAL_RETRIEVAL_POLICY_VERSION);
  });

  it('reaches the same verdict whatever order the candidates arrive in', () => {
    const forward = planTemporalRetrieval({ mode: 'current', queryTime: JULY, candidates });
    const reversed = planTemporalRetrieval({
      mode: 'current',
      queryTime: JULY,
      candidates: [...candidates].reverse()
    });
    expect(reversed.fingerprint).toBe(forward.fingerprint);
    expect([...reversed.retainedFragmentIds].sort()).toEqual(
      [...forward.retainedFragmentIds].sort()
    );
  });

  it('changes the fingerprint when the query instant changes the verdict', () => {
    const before = planTemporalRetrieval({ mode: 'current', queryTime: JANUARY, candidates });
    const after = planTemporalRetrieval({ mode: 'current', queryTime: JULY, candidates });
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('fails closed on duplicate candidates rather than guessing which one wins', () => {
    expect(() =>
      planTemporalRetrieval({
        mode: 'current',
        queryTime: JULY,
        candidates: [view('dupe'), view('dupe', { validFrom: JUNE })]
      })
    ).toThrowError(expect.objectContaining({ code: 'MEMORY_TEMPORAL_RETRIEVAL_INVALID' }));
  });

  it('fails closed on an unparsable query instant', () => {
    expect(() =>
      planTemporalRetrieval({ mode: 'current', queryTime: 'yesterday', candidates: [view('a')] })
    ).toThrowError(expect.objectContaining({ code: 'MEMORY_TEMPORAL_RETRIEVAL_INVALID' }));
  });
});
