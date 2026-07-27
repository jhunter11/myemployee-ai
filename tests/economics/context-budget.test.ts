import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ContextBudgetInputSchema } from '../../src/economics/contracts';
import { budgetContext } from '../../src/economics/context-budget';

function provenance(reference: string) {
  return { kind: 'repository' as const, reference };
}

describe('budgetContext', () => {
  it('preserves required context and selects optional fragments by stable priority', () => {
    const result = budgetContext({
      maxUtf8Bytes: 12,
      maxEstimatedTokens: 3,
      fragments: [
        {
          id: 'required',
          priority: 1,
          required: true,
          provenance: provenance('policy'),
          content: 'core'
        },
        {
          id: 'highest',
          priority: 100,
          required: false,
          provenance: provenance('high'),
          content: 'abcdefgh'
        },
        {
          id: 'lower',
          priority: 10,
          required: false,
          provenance: provenance('low'),
          content: 'wxyz'
        }
      ]
    });

    expect(result).toMatchObject({
      status: 'ready',
      blockReason: null,
      estimateBasis: 'capacity_estimate_utf8_bytes_divided_by_4',
      limits: { maxUtf8Bytes: 12, maxEstimatedTokens: 3 },
      totals: {
        inputFragments: 3,
        uniqueFragments: 3,
        selectedFragments: 2,
        selectedUtf8Bytes: 12,
        selectedEstimatedTokens: 3
      }
    });
    expect(result.selected.map(({ id }) => id)).toEqual(['highest', 'required']);
    expect(result.omitted).toEqual([
      expect.objectContaining({
        id: 'lower',
        reason: 'budget_exceeded',
        utf8Bytes: 4,
        estimatedTokens: 1,
        provenance: [provenance('low')]
      })
    ]);
    expect(result.omitted[0]).not.toHaveProperty('content');
  });

  it('de-duplicates exact content by SHA-256 and retains all provenance', () => {
    const result = budgetContext({
      maxUtf8Bytes: 4,
      maxEstimatedTokens: 1,
      fragments: [
        {
          id: 'first',
          priority: 5,
          required: false,
          provenance: { kind: 'memory', reference: 'note-a' },
          content: 'same'
        },
        {
          id: 'duplicate',
          priority: 90,
          required: true,
          provenance: provenance('file-a'),
          content: 'same'
        },
        {
          id: 'other',
          priority: 10,
          required: false,
          provenance: provenance('file-b'),
          content: 'else'
        }
      ]
    });

    const expectedHash = createHash('sha256').update('same', 'utf8').digest('hex');
    expect(result.status).toBe('ready');
    expect(result.selected).toEqual([
      expect.objectContaining({
        id: 'first',
        sourceIds: ['first', 'duplicate'],
        priority: 90,
        required: true,
        content: 'same',
        contentHash: expectedHash,
        utf8Bytes: 4,
        estimatedTokens: 1,
        provenance: [{ kind: 'memory', reference: 'note-a' }, provenance('file-a')]
      })
    ]);
    expect(result.deduplicated).toEqual([
      {
        id: 'duplicate',
        canonicalId: 'first',
        contentHash: expectedHash,
        utf8Bytes: 4,
        estimatedTokens: 1,
        provenance: provenance('file-a'),
        reason: 'duplicate_content'
      }
    ]);
    expect(result.deduplicated[0]).not.toHaveProperty('content');
  });

  it('uses input order as the stable tie-breaker for equal priorities', () => {
    const result = budgetContext({
      maxUtf8Bytes: 4,
      maxEstimatedTokens: 1,
      fragments: [
        {
          id: 'first',
          priority: 50,
          required: false,
          provenance: provenance('first'),
          content: 'aaaa'
        },
        {
          id: 'second',
          priority: 50,
          required: false,
          provenance: provenance('second'),
          content: 'bbbb'
        }
      ]
    });

    expect(result.selected.map(({ id }) => id)).toEqual(['first']);
    expect(result.omitted.map(({ id }) => id)).toEqual(['second']);
  });

  it('blocks without returning raw text when required bytes exceed the cap', () => {
    const result = budgetContext({
      maxUtf8Bytes: 7,
      maxEstimatedTokens: 2,
      fragments: [
        {
          id: 'required-a',
          priority: 10,
          required: true,
          provenance: provenance('required-a'),
          content: 'abcd'
        },
        {
          id: 'required-b',
          priority: 9,
          required: true,
          provenance: provenance('required-b'),
          content: 'efgh'
        }
      ]
    });

    expect(result).toMatchObject({
      status: 'blocked',
      blockReason: 'required_context_exceeds_budget',
      selected: [],
      totals: {
        selectedFragments: 0,
        selectedUtf8Bytes: 0,
        selectedEstimatedTokens: 0,
        requiredUtf8Bytes: 8,
        requiredEstimatedTokens: 2
      }
    });
    expect(result.omitted).toHaveLength(2);
    expect(result.omitted.every((fragment) => !('content' in fragment))).toBe(true);
    expect(result.omitted.every((fragment) => fragment.reason === 'required_budget_exceeded')).toBe(
      true
    );
  });

  it('blocks when required estimated tokens exceed the token cap', () => {
    const result = budgetContext({
      maxUtf8Bytes: 100,
      maxEstimatedTokens: 1,
      fragments: [
        {
          id: 'required',
          priority: 1,
          required: true,
          provenance: provenance('required'),
          content: 'abcde'
        }
      ]
    });

    expect(result.status).toBe('blocked');
    expect(result.totals.requiredUtf8Bytes).toBe(5);
    expect(result.totals.requiredEstimatedTokens).toBe(2);
  });

  it('reports UTF-8 bytes independently from its labeled token estimate', () => {
    const result = budgetContext({
      maxUtf8Bytes: 4,
      maxEstimatedTokens: 1,
      fragments: [
        {
          id: 'emoji',
          priority: 1,
          required: false,
          provenance: provenance('emoji'),
          content: '🙂'
        }
      ]
    });

    expect(result.selected[0]).toMatchObject({ utf8Bytes: 4, estimatedTokens: 1 });
  });

  it('rejects unknown keys, duplicate IDs, oversized arrays, and invalid caps', () => {
    const fragment = {
      id: 'valid',
      priority: 1,
      required: false,
      provenance: provenance('valid'),
      content: 'valid'
    };

    expect(
      ContextBudgetInputSchema.safeParse({
        maxUtf8Bytes: 10,
        maxEstimatedTokens: 10,
        fragments: [{ ...fragment, secret: 'nope' }]
      }).success
    ).toBe(false);
    expect(
      ContextBudgetInputSchema.safeParse({
        maxUtf8Bytes: 10,
        maxEstimatedTokens: 10,
        fragments: [fragment, { ...fragment, content: 'different' }]
      }).success
    ).toBe(false);
    expect(
      ContextBudgetInputSchema.safeParse({
        maxUtf8Bytes: 10,
        maxEstimatedTokens: 10,
        fragments: Array.from({ length: 65 }, (_, index) => ({
          ...fragment,
          id: `fragment-${index}`
        }))
      }).success
    ).toBe(false);
    expect(() =>
      budgetContext({
        maxUtf8Bytes: 0,
        maxEstimatedTokens: 10,
        fragments: [fragment]
      })
    ).toThrow();
  });
});
