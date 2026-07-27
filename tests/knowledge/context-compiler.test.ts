import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { compileScopedContext } from '../../src/knowledge/context-compiler';

const evaluatedAt = '2026-07-21T12:00:00.000Z';

function candidate(id: string, content: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ownerScopeId: 'client:acme_corp',
    sleeveId: 'client:acme_corp',
    sourceId: `note:${id}`,
    sourceHash: createHash('sha256').update(id, 'utf8').digest('hex'),
    content,
    required: false,
    priority: 50,
    relevancePermille: 800,
    confidencePermille: 900,
    recordedAt: '2026-07-20T12:00:00.000Z',
    coverageKeys: ['close'],
    retrievalEligible: true,
    expiresAt: null,
    supersededByFragmentId: null,
    ...overrides
  };
}

function input(fragments: unknown[]) {
  return {
    ownerScopeId: 'client:acme_corp',
    sleeveId: 'client:acme_corp',
    totalCapacityTokens: 30,
    reservations: {
      output: 5,
      policy: 3,
      toolSchema: 2,
      workingState: 2,
      safety: 2
    },
    maxFragmentsPerSource: 2,
    evaluatedAt,
    fragments
  };
}

describe('compileScopedContext', () => {
  it('reserves every protected category before selecting whole evidence fragments', () => {
    const result = compileScopedContext(
      input([
        candidate('required', 'required', { required: true, priority: 1 }),
        candidate('best', 'abcdefgh', { priority: 100 }),
        candidate('too_large', 'x'.repeat(60), { priority: 99 })
      ])
    );

    expect(result).toMatchObject({
      status: 'ready',
      blockReason: null,
      estimateBasis: 'capacity_estimate_utf8_bytes_divided_by_4',
      capacity: {
        total: 30,
        reserved: 14,
        availableEvidence: 16,
        usedEvidence: 4,
        remainingEvidence: 12
      }
    });
    expect(result.selected.map(({ id }) => id)).toEqual(['required', 'best']);
    expect(result.selected).toEqual([
      expect.objectContaining({ id: 'required', content: 'required', estimatedTokens: 2 }),
      expect.objectContaining({ id: 'best', content: 'abcdefgh', estimatedTokens: 2 })
    ]);
    expect(result.manifest.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'too_large', reason: 'evidence_budget_exceeded' })
      ])
    );
    expect(result.manifest.omitted.every((entry) => !('content' in entry))).toBe(true);
    expect(result.manifest.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('blocks rather than truncating when required evidence exceeds post-reservation capacity', () => {
    const result = compileScopedContext(
      input([
        candidate('required_a', 'a'.repeat(40), { required: true }),
        candidate('required_b', 'b'.repeat(28), { required: true })
      ])
    );

    expect(result).toMatchObject({
      status: 'blocked',
      blockReason: 'required_evidence_exceeds_capacity',
      selected: [],
      capacity: { total: 30, reserved: 14, availableEvidence: 16, usedEvidence: 0 }
    });
    expect(result.manifest.omitted).toHaveLength(2);
    expect(
      result.manifest.omitted.every(({ reason }) => reason === 'required_budget_exceeded')
    ).toBe(true);
  });

  it('blocks when reservations consume more than the context window', () => {
    const result = compileScopedContext({
      ...input([]),
      totalCapacityTokens: 10
    });

    expect(result).toMatchObject({
      status: 'blocked',
      blockReason: 'reservations_exceed_capacity',
      capacity: { total: 10, reserved: 14, availableEvidence: 0 }
    });
  });

  it('fails closed for a single cross-scope fragment instead of partially compiling', () => {
    expect(() =>
      compileScopedContext(
        input([
          candidate('allowed', 'allowed'),
          candidate('foreign', 'private beta content', {
            ownerScopeId: 'client:beta_labs',
            sleeveId: 'client:beta_labs'
          })
        ])
      )
    ).toThrowError(expect.objectContaining({ code: 'CONTEXT_SCOPE_FORBIDDEN', statusCode: 403 }));
  });

  it('defensively excludes expired, superseded, and retrieval-disabled fragments', () => {
    const result = compileScopedContext(
      input([
        candidate('current', 'current'),
        candidate('expired', 'expired', { expiresAt: '2026-07-20T12:00:00.000Z' }),
        candidate('superseded', 'superseded', { supersededByFragmentId: 'current' }),
        candidate('disabled', 'disabled', { retrievalEligible: false })
      ])
    );

    expect(result.selected.map(({ id }) => id)).toEqual(['current']);
    expect(result.manifest.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'expired', reason: 'expired' }),
        expect.objectContaining({ id: 'superseded', reason: 'superseded' }),
        expect.objectContaining({ id: 'disabled', reason: 'retrieval_disabled' })
      ])
    );
  });

  it('deduplicates exact content and caps optional fragments per source', () => {
    const result = compileScopedContext(
      input([
        candidate('canonical', 'same'),
        candidate('duplicate', 'same', { required: true, sourceId: 'note:duplicate' }),
        candidate('source_a', 'aaaa', { sourceId: 'note:shared', priority: 90 }),
        candidate('source_b', 'bbbb', { sourceId: 'note:shared', priority: 80 }),
        candidate('source_c', 'cccc', { sourceId: 'note:shared', priority: 70 })
      ])
    );

    expect(result.selected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'canonical',
          required: true,
          fragmentIds: ['canonical', 'duplicate'],
          sourceIds: ['note:canonical', 'note:duplicate']
        })
      ])
    );
    expect(result.manifest.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'duplicate', reason: 'duplicate_content' }),
        expect.objectContaining({ id: 'source_c', reason: 'source_cap' })
      ])
    );
  });

  it('uses uncovered-query value and utility per token deterministically', () => {
    const shared = input([
      candidate('repeats_close', 'a'.repeat(12), {
        coverageKeys: ['close'],
        priority: 70
      }),
      candidate('adds_payroll', 'b'.repeat(12), {
        coverageKeys: ['payroll'],
        priority: 70
      }),
      candidate('long_low_value', 'c'.repeat(56), {
        coverageKeys: ['close'],
        priority: 70
      })
    ]);

    const first = compileScopedContext(shared);
    const second = compileScopedContext(shared);
    expect(second).toEqual(first);
    expect(first.selected.map(({ id }) => id)).toEqual(['repeats_close', 'adds_payroll']);
    expect(first.selected.every(({ selectionUtility }) => Number.isInteger(selectionUtility))).toBe(
      true
    );
  });

  it('rejects duplicate fragment IDs, unknown keys, and malformed reservations', () => {
    const valid = candidate('valid', 'valid');
    expect(() =>
      compileScopedContext(input([valid, { ...valid, content: 'different' }]))
    ).toThrow();
    expect(() => compileScopedContext({ ...input([valid]), secret: 'nope' })).toThrow();
    expect(() =>
      compileScopedContext({
        ...input([valid]),
        reservations: { ...input([]).reservations, safety: -1 }
      })
    ).toThrow();
    expect(() =>
      compileScopedContext(
        input([candidate('duplicate_coverage', 'coverage', { coverageKeys: ['close', 'close'] })])
      )
    ).toThrow();
  });
});
