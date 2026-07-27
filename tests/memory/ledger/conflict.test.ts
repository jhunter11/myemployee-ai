import { describe, expect, it } from 'vitest';

import {
  CONFLICT_OUTCOME_POLICIES,
  CONFLICT_OUTCOMES,
  compareClaims,
  intervalsOverlap,
  resolveConflict,
  retrievalMustAbstain,
  type ConflictOutcome
} from '../../../src/memory/ledger/conflict';
import {
  MEMORY_RECORD_SCHEMA_VERSION,
  MemoryRevisionSchema
} from '../../../src/memory/ledger/record-contracts';

function claim(overrides: Record<string, unknown> = {}) {
  const payloadOverrides = (overrides.payloadCanonical ?? {}) as Record<string, unknown>;
  const rest = { ...overrides };
  delete rest.payloadCanonical;
  return {
    schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
    recordType: 'MemoryRevision',
    memoryId: 'mem_fact_114',
    revisionId: 'rev_fact_114_a',
    revisionNo: 1,
    ownerScopeId: 'client:acme_corp',
    sleeveId: 'client:acme_corp',
    sleeveClass: 'client',
    kind: 'fact',
    entityKey: 'launch/date',
    status: 'active',
    approvalState: 'auto_accepted',
    authorityTier: 'agent_observation',
    confidencePermille: 800,
    sensitivity: 'confidential',
    retentionPolicy: 'until_superseded',
    legalHold: false,
    eventTime: null,
    observedAt: '2026-07-24T18:18:00.000Z',
    createdTxTime: '2026-07-24T18:20:12.022Z',
    recordedTxSeq: 88_261,
    validFrom: '2026-07-01T00:00:00.000Z',
    validUntil: null,
    decidedAt: null,
    authorAgentId: 'agency-developer',
    workflowId: null,
    runId: null,
    derivationMethod: 'episode_extraction',
    sourceEventIds: ['evt_call_7742'],
    evidenceRefs: [],
    derivedFrom: [],
    contradicts: [],
    supersedes: null,
    supersededBy: null,
    payloadCanonical: {
      form: 'triple',
      subject: 'project:acme_relaunch',
      predicate: 'launch_date',
      object: '2026-09-30',
      qualifiers: [],
      ...payloadOverrides
    },
    contentHash: `sha256:${'a'.repeat(64)}`,
    canonicalHash: `sha256:${'b'.repeat(64)}`,
    tombstone: null,
    ...rest
  };
}

/** The candidate always asserts a different value on the same entity as `existing()`. */
function candidate(overrides: Record<string, unknown> = {}) {
  return claim({
    memoryId: 'mem_fact_200',
    revisionId: 'rev_fact_200_a',
    payloadCanonical: { object: '2026-10-15' },
    ...overrides
  });
}

function existing(overrides: Record<string, unknown> = {}) {
  return claim(overrides);
}

function parsed(raw: Record<string, unknown>) {
  return MemoryRevisionSchema.parse(raw);
}

const interval = (validFrom: string, validUntil: string | null) => ({ validFrom, validUntil });

describe('interval overlap (half-open [validFrom, validUntil))', () => {
  it('treats touching endpoints as NON-overlapping so clean handovers are not conflicts', () => {
    const first = interval('2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
    const second = interval('2026-06-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
    expect(intervalsOverlap(first, second)).toBe(false);
    expect(intervalsOverlap(second, first)).toBe(false);
  });

  it('detects overlap by a single millisecond', () => {
    const first = interval('2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.001Z');
    const second = interval('2026-06-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
    expect(intervalsOverlap(first, second)).toBe(true);
    expect(intervalsOverlap(second, first)).toBe(true);
  });

  it('handles disjoint, nested, and identical intervals', () => {
    const early = interval('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    const late = interval('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    expect(intervalsOverlap(early, late)).toBe(false);

    const outer = interval('2026-01-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
    const inner = interval('2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');
    expect(intervalsOverlap(outer, inner)).toBe(true);
    expect(intervalsOverlap(inner, outer)).toBe(true);
    expect(intervalsOverlap(outer, outer)).toBe(true);
  });

  it('treats a null validUntil as open-ended, not as unknown', () => {
    const openEnded = interval('2026-06-01T00:00:00.000Z', null);
    expect(intervalsOverlap(openEnded, interval('2026-01-01T00:00:00.000Z', null))).toBe(true);
    // A closed interval that ends exactly where the open one begins still does not overlap.
    expect(
      intervalsOverlap(openEnded, interval('2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'))
    ).toBe(false);
    expect(
      intervalsOverlap(openEnded, interval('2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.001Z'))
    ).toBe(true);
    // An open-ended claim starting later never reaches backwards.
    expect(
      intervalsOverlap(
        interval('2027-01-01T00:00:00.000Z', null),
        interval('2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')
      )
    ).toBe(false);
  });
});

describe('stage one: are the claims actually in conflict?', () => {
  const nonCompeting: [string, Record<string, unknown>, string][] = [
    ['a different owning scope', { ownerScopeId: 'client:beta_labs' }, 'different_owner_scope'],
    [
      'a different sleeve',
      { sleeveId: 'project:acme_relaunch', sleeveClass: 'project' },
      'different_sleeve'
    ],
    ['a different entity key', { entityKey: 'launch/scope' }, 'different_entity_key'],
    [
      'a different subject',
      { payloadCanonical: { subject: 'project:other_relaunch' } },
      'different_subject'
    ],
    [
      'a different predicate',
      { payloadCanonical: { predicate: 'kickoff_date' } },
      'different_predicate'
    ],
    [
      'a disjoint qualifier context',
      { payloadCanonical: { qualifiers: ['channel_slack'] } },
      'disjoint_context'
    ],
    [
      'a disjoint valid interval',
      { validFrom: '2020-01-01T00:00:00.000Z', validUntil: '2026-07-01T00:00:00.000Z' },
      'disjoint_valid_interval'
    ],
    ['an already-superseded revision', { status: 'superseded' }, 'inactive_revision'],
    ['an expired revision', { status: 'expired' }, 'inactive_revision'],
    ['the same memory thread', { memoryId: 'mem_fact_200' }, 'same_memory_thread']
  ];

  it.each(nonCompeting)('preserves both when they differ by %s', (_label, override, reason) => {
    const subject = candidate({
      payloadCanonical: { object: '2026-10-15', qualifiers: ['channel_email'] }
    });
    const other = existing({
      payloadCanonical: { qualifiers: ['channel_email'] },
      ...override
    });
    const comparison = compareClaims(parsed(subject), parsed(other));
    expect(comparison.competes).toBe(false);
    expect(comparison.reason).toBe(reason);

    const resolution = resolveConflict(subject, [other]);
    expect(resolution.outcome).toBe('preserve_both');
    expect(resolution.preservedRevisionIds).toEqual([other.revisionId]);
    expect(resolution.competingRevisionIds).toEqual([]);
    expect(resolution.conflictedRevisionIds).toEqual([]);
  });

  it('does not treat agreement as conflict', () => {
    const resolution = resolveConflict(candidate({ payloadCanonical: { object: '2026-09-30' } }), [
      existing()
    ]);
    expect(resolution.outcome).toBe('preserve_both');
    expect(resolution.comparisons[0]?.reason).toBe('compatible_values');
  });

  it('refuses to adjudicate a payload it cannot read', () => {
    const structuredEpisode = {
      ...existing({
        kind: 'episode',
        authorityTier: 'tool_observation',
        derivationMethod: 'direct_observation'
      }),
      payloadCanonical: {
        form: 'structured',
        fields: { summary: 'launch moved to september thirtieth' }
      }
    };
    const resolution = resolveConflict(candidate(), [structuredEpisode]);
    expect(resolution.outcome).toBe('preserve_both');
    expect(resolution.comparisons[0]?.reason).toBe('non_comparable_payload');
  });

  it('never compares a revision with itself', () => {
    const self = candidate();
    const resolution = resolveConflict(self, [self]);
    expect(resolution.comparisons[0]?.reason).toBe('same_revision');
    expect(resolution.outcome).toBe('preserve_both');
  });

  it('recognises a genuine competition when every axis lines up', () => {
    const comparison = compareClaims(parsed(candidate()), parsed(existing()));
    expect(comparison).toMatchObject({
      competes: true,
      reason: 'competes',
      contextRelation: 'identical',
      authorityComparison: 0
    });
  });
});

describe('stage two: precedence, applied only to real competition', () => {
  it('selects the strictly higher authority on identical context', () => {
    const resolution = resolveConflict(candidate({ authorityTier: 'operator_explicit' }), [
      existing({ authorityTier: 'agent_inference' })
    ]);
    expect(resolution.outcome).toBe('select_one');
    expect(resolution.winnerRevisionId).toBe('rev_fact_200_a');
    expect(resolution.conflictedRevisionIds).toEqual([]);
    expect(resolution.reason).toContain('operator_explicit');
  });

  it('lets an outranked candidate lose without touching the incumbent', () => {
    const resolution = resolveConflict(candidate({ authorityTier: 'statistical_pattern' }), [
      existing({ authorityTier: 'policy_signed_approved' })
    ]);
    expect(resolution.outcome).toBe('select_one');
    expect(resolution.winnerRevisionId).toBe('rev_fact_114_a');
    expect(retrievalMustAbstain(resolution)).toBe(false);
  });

  it('marks a conflict on an authority tie rather than picking silently', () => {
    const resolution = resolveConflict(candidate(), [existing()]);
    expect(resolution.outcome).toBe('mark_conflict');
    expect(resolution.winnerRevisionId).toBeNull();
    expect(resolution.conflictedRevisionIds).toEqual(['rev_fact_114_a']);
    expect(retrievalMustAbstain(resolution)).toBe(true);
  });

  it('escalates a tied conflict that governs behavior or sits under legal hold', () => {
    const policyTie = resolveConflict(
      candidate({
        kind: 'policy',
        payloadCanonical: { predicate: 'retention_rule', object: 'delete_after_90d' }
      }),
      [
        existing({
          kind: 'policy',
          payloadCanonical: { predicate: 'retention_rule', object: 'retain_forever' }
        })
      ]
    );
    expect(policyTie.outcome).toBe('ask_operator');
    expect(policyTie.conflictedRevisionIds).toEqual(['rev_fact_114_a']);
    expect(retrievalMustAbstain(policyTie)).toBe(true);

    const heldTie = resolveConflict(candidate(), [existing({ legalHold: true })]);
    expect(heldTie.outcome).toBe('ask_operator');
  });

  it('narrows context when one tied claim is a strict refinement of the other', () => {
    const narrower = resolveConflict(
      candidate({ payloadCanonical: { object: '2026-10-15', qualifiers: ['channel_email'] } }),
      [existing()]
    );
    expect(narrower.outcome).toBe('narrow_context');
    expect(narrower.winnerRevisionId).toBe('rev_fact_200_a');
    expect(narrower.comparisons[0]?.contextRelation).toBe('candidate_narrower');
    expect(retrievalMustAbstain(narrower)).toBe(false);

    const broader = resolveConflict(candidate(), [
      existing({ payloadCanonical: { qualifiers: ['channel_email'] } })
    ]);
    expect(broader.outcome).toBe('narrow_context');
    expect(broader.winnerRevisionId).toBe('rev_fact_114_a');
    expect(broader.comparisons[0]?.contextRelation).toBe('existing_narrower');
  });

  it('abstains while an unresolved conflict is already active', () => {
    const flagged = existing({
      status: 'active_conflicted',
      contradicts: ['rev_fact_999_a']
    });
    const tied = resolveConflict(candidate(), [flagged]);
    expect(tied.outcome).toBe('abstain');
    expect(tied.winnerRevisionId).toBeNull();
    expect(retrievalMustAbstain(tied)).toBe(true);
    expect(tied.reason).toContain('abstains');

    // Being outranked by a flagged record is no better: still abstain.
    const outranked = resolveConflict(candidate({ authorityTier: 'agent_inference' }), [flagged]);
    expect(outranked.outcome).toBe('abstain');
  });

  it('lets a strictly higher authority break an already-flagged deadlock', () => {
    const flagged = existing({
      status: 'active_conflicted',
      contradicts: ['rev_fact_999_a']
    });
    const resolution = resolveConflict(candidate({ authorityTier: 'policy_signed_approved' }), [
      flagged
    ]);
    expect(resolution.outcome).toBe('select_one');
    expect(resolution.winnerRevisionId).toBe('rev_fact_200_a');
  });

  it('refuses to guess when several incumbents tie above an outranked candidate', () => {
    const resolution = resolveConflict(candidate({ authorityTier: 'agent_inference' }), [
      existing({
        memoryId: 'mem_fact_301',
        revisionId: 'rev_fact_301_a',
        authorityTier: 'operator_explicit'
      }),
      existing({
        memoryId: 'mem_fact_302',
        revisionId: 'rev_fact_302_a',
        authorityTier: 'operator_explicit',
        payloadCanonical: { object: '2026-11-01' }
      })
    ]);
    expect(resolution.outcome).toBe('mark_conflict');
    expect(resolution.winnerRevisionId).toBeNull();
    expect(resolution.conflictedRevisionIds).toEqual(['rev_fact_301_a', 'rev_fact_302_a']);
  });

  it('takes the most conservative reading when competitors disagree in shape', () => {
    // One tied competitor sits on an identical context, another is narrower:
    // no single refinement exists, so the pair is flagged rather than narrowed.
    const resolution = resolveConflict(
      candidate({ payloadCanonical: { object: '2026-10-15', qualifiers: ['channel_email'] } }),
      [
        existing({ memoryId: 'mem_fact_301', revisionId: 'rev_fact_301_a' }),
        existing({
          memoryId: 'mem_fact_302',
          revisionId: 'rev_fact_302_a',
          payloadCanonical: { object: '2026-11-01', qualifiers: ['channel_email'] }
        })
      ]
    );
    expect(resolution.outcome).toBe('mark_conflict');
    expect(resolution.conflictedRevisionIds).toEqual(['rev_fact_301_a', 'rev_fact_302_a']);
  });
});

describe('resolveConflict as a pure function', () => {
  it('is deterministic and insensitive to the order of the existing set', () => {
    const first = existing({ memoryId: 'mem_fact_301', revisionId: 'rev_fact_301_a' });
    const second = existing({
      memoryId: 'mem_fact_302',
      revisionId: 'rev_fact_302_a',
      entityKey: 'launch/scope'
    });
    const left = resolveConflict(candidate(), [first, second]);
    const right = resolveConflict(candidate(), [second, first]);
    expect(left).toEqual(right);
    expect(left.fingerprint).toBe(right.fingerprint);
    expect(left).toEqual(resolveConflict(candidate(), [first, second]));
    expect(left.comparisons.map((comparison) => comparison.existingRevisionId)).toEqual([
      'rev_fact_301_a',
      'rev_fact_302_a'
    ]);
  });

  it('fingerprints different outcomes differently', () => {
    const tie = resolveConflict(candidate(), [existing()]);
    const win = resolveConflict(candidate({ authorityTier: 'operator_explicit' }), [existing()]);
    const none = resolveConflict(candidate(), [existing({ entityKey: 'launch/scope' })]);
    expect(new Set([tie.fingerprint, win.fingerprint, none.fingerprint]).size).toBe(3);
  });

  it('preserves everything when there is nothing to compare against', () => {
    const resolution = resolveConflict(candidate(), []);
    expect(resolution.outcome).toBe('preserve_both');
    expect(resolution.comparisons).toEqual([]);
    expect(retrievalMustAbstain(resolution)).toBe(false);
  });

  it('fails closed on malformed input rather than resolving it', () => {
    expect(() => resolveConflict(candidate({ sleeveClass: 'project' }), [existing()])).toThrow();
    expect(() => resolveConflict(candidate(), [{ revisionId: 'rev_x' }])).toThrow();
    expect(() =>
      resolveConflict(candidate({ validUntil: '2020-01-01T00:00:00.000Z' }), [existing()])
    ).toThrow();
  });

  it('classifies every declared outcome, with abstention exactly on the unresolved ones', () => {
    expect(Object.keys(CONFLICT_OUTCOME_POLICIES).sort()).toEqual([...CONFLICT_OUTCOMES].sort());
    const unresolved: ConflictOutcome[] = ['mark_conflict', 'ask_operator', 'abstain'];
    for (const outcome of CONFLICT_OUTCOMES) {
      const policy = CONFLICT_OUTCOME_POLICIES[outcome];
      expect(policy.outcome).toBe(outcome);
      expect(policy.resolved).toBe(!unresolved.includes(outcome));
      expect(policy.flagsConflict).toBe(unresolved.includes(outcome));
    }
  });
});
