import { describe, expect, it } from 'vitest';

import { comparePolicyBands, scoreWithinBand } from '../../src/queue/priority-policy';

describe('deterministic priority policy', () => {
  it('keeps policy bands absolute and ordered from P0 through P3', () => {
    expect(
      ([...['P0', 'P1', 'P2', 'P3']] as Array<'P0' | 'P1' | 'P2' | 'P3'>).sort(comparePolicyBands)
    ).toEqual(['P0', 'P1', 'P2', 'P3']);
    expect(comparePolicyBands('P0', 'P3')).toBeLessThan(0);
  });

  it('scores objective inputs and applies capped 15-minute aging deterministically', () => {
    const policy = { band: 'P2' as const, impact: 4, urgency: 3, effort: 6 };

    expect(
      scoreWithinBand(policy, {
        availableAt: '2026-07-18T10:00:00.000Z',
        now: '2026-07-18T10:00:00.000Z'
      })
    ).toEqual({ base: 36, age: 0, effective: 36 });
    expect(
      scoreWithinBand(policy, {
        availableAt: '2026-07-18T10:00:00.000Z',
        now: '2026-07-18T11:00:00.000Z'
      })
    ).toEqual({ base: 36, age: 4, effective: 40 });
    expect(
      scoreWithinBand(policy, {
        availableAt: '2026-07-01T00:00:00.000Z',
        now: '2026-07-18T11:00:00.000Z'
      })
    ).toEqual({ base: 36, age: 100, effective: 136 });
  });

  it('rejects timestamps that move backwards instead of creating negative aging', () => {
    expect(() =>
      scoreWithinBand(
        { band: 'P1', impact: 1, urgency: 1, effort: 1 },
        {
          availableAt: '2026-07-18T10:01:00.000Z',
          now: '2026-07-18T10:00:00.000Z'
        }
      )
    ).toThrow('now must not precede availableAt');
  });
});
