import { describe, expect, it } from 'vitest';

import { MemoryFragmentInputSchema } from '../../../src/knowledge/retrieval-contracts';
import {
  DEMO_NOW,
  SAMPLE_MEMORY,
  SAMPLE_QUESTIONS,
  SAMPLE_SLEEVES,
  sampleItemById
} from '../../../src/memory/demo/sample-memory';

describe('sample memory corpus', () => {
  it('every fragment satisfies the production fragment contract', () => {
    for (const sample of SAMPLE_MEMORY) {
      expect(() => MemoryFragmentInputSchema.parse(sample.fragment)).not.toThrow();
    }
  });

  it('uses unique fragment ids', () => {
    const ids = SAMPLE_MEMORY.map((sample) => sample.fragment.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('orders revisions so a superseded fragment is always written first', () => {
    const seen = new Set<string>();
    for (const sample of SAMPLE_MEMORY) {
      const supersedes = sample.fragment.supersedesFragmentId;
      if (supersedes !== null) {
        expect(seen.has(supersedes)).toBe(true);
      }
      seen.add(sample.fragment.id);
    }
  });

  it('keeps the cross-sleeve trap in a genuinely different sleeve', () => {
    const trap = SAMPLE_MEMORY.find((sample) => sample.role === 'cross_sleeve_trap');
    expect(trap).toBeDefined();
    const acmeSleeves = new Set(
      SAMPLE_MEMORY.filter((sample) => sample.fragment.id.startsWith('acme-')).map(
        (sample) => sample.fragment.sleeveId
      )
    );
    expect(acmeSleeves.has(trap?.fragment.sleeveId ?? '')).toBe(false);
  });

  it('declares every sleeve its fragments are written into', () => {
    const declared = new Set(SAMPLE_SLEEVES.map((sleeve) => sleeve.sleeveId));
    for (const sample of SAMPLE_MEMORY) {
      expect(declared.has(sample.fragment.sleeveId)).toBe(true);
    }
  });

  it('binds each fragment to its own owning scope', () => {
    for (const sample of SAMPLE_MEMORY) {
      const sleeve = SAMPLE_SLEEVES.find((entry) => entry.sleeveId === sample.fragment.sleeveId);
      expect(sample.fragment.ownerScopeId).toBe(sleeve?.scopeId);
    }
  });

  it('has the validity-ended item genuinely expire before the demo clock', () => {
    const expired = SAMPLE_MEMORY.find((sample) => sample.role === 'validity_ended');
    expect(expired).toBeDefined();
    const validUntil = expired?.fragment.validUntil ?? null;
    expect(validUntil).not.toBeNull();
    expect(Date.parse(validUntil ?? '')).toBeLessThan(Date.parse(DEMO_NOW));
  });

  it('points every question at fragments that actually exist', () => {
    for (const question of SAMPLE_QUESTIONS) {
      for (const id of [...question.expectedFragmentIds, ...question.forbiddenFragmentIds]) {
        expect(
          sampleItemById(id),
          `unknown fragment ${id} in question ${question.id}`
        ).toBeDefined();
      }
    }
  });

  it('never lists a fragment as both expected and forbidden', () => {
    for (const question of SAMPLE_QUESTIONS) {
      const forbidden = new Set(question.forbiddenFragmentIds);
      for (const id of question.expectedFragmentIds) {
        expect(forbidden.has(id)).toBe(false);
      }
    }
  });

  it('keeps abstention questions free of expected evidence', () => {
    const abstentions = SAMPLE_QUESTIONS.filter(
      (question) => question.expectedFragmentIds.length === 0
    );
    expect(abstentions.length).toBeGreaterThan(0);
  });

  it('scopes every question to a sleeve it can be answered within', () => {
    const declared = new Set(SAMPLE_SLEEVES.map((sleeve) => sleeve.sleeveId));
    for (const question of SAMPLE_QUESTIONS) {
      expect(declared.has(question.sleeveId)).toBe(true);
      for (const id of question.expectedFragmentIds) {
        expect(sampleItemById(id)?.fragment.sleeveId).toBe(question.sleeveId);
      }
    }
  });
});
