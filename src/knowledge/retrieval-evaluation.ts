import { createHash } from 'node:crypto';

import { z } from 'zod';

import { ControlScopeIdSchema, MemorySleeveIdSchema } from '../agents/access-control-contracts';
import { MemorySourceIdSchema } from './retrieval-contracts';

export const RetrievalEvaluationCategorySchema = z.enum([
  'exact_lookup',
  'paraphrase',
  'temporal_change',
  'correction',
  'multi_note',
  'whole_project',
  'procedure',
  'abstention',
  'freshness',
  'cross_scope_trap'
]);

export const RetrievalGoldenCaseSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,79}$/),
    category: RetrievalEvaluationCategorySchema,
    scopeId: ControlScopeIdSchema,
    sleeveId: MemorySleeveIdSchema,
    query: z.string().trim().min(2).max(1_000),
    expectedSourceIds: z.array(MemorySourceIdSchema).max(25),
    forbiddenSourceIds: z.array(MemorySourceIdSchema).max(25),
    expectAbstention: z.boolean()
  })
  .superRefine((testCase, context) => {
    if (testCase.expectAbstention !== (testCase.expectedSourceIds.length === 0)) {
      context.addIssue({
        code: 'custom',
        path: ['expectAbstention'],
        message: 'Abstention cases must have no expected source IDs and vice versa'
      });
    }
    if (new Set(testCase.expectedSourceIds).size !== testCase.expectedSourceIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['expectedSourceIds'],
        message: 'Expected source IDs must be unique'
      });
    }
    if (new Set(testCase.forbiddenSourceIds).size !== testCase.forbiddenSourceIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['forbiddenSourceIds'],
        message: 'Forbidden source IDs must be unique'
      });
    }
  });

export const RetrievalGoldenFixtureSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,79}$/),
    status: z.enum(['scaffold', 'frozen']),
    version: z.number().int().min(1).max(1_000),
    k: z.number().int().min(1).max(25),
    cases: z.array(RetrievalGoldenCaseSchema).min(1).max(200)
  })
  .superRefine((fixture, context) => {
    const caseIds = new Set<string>();
    for (const testCase of fixture.cases) {
      if (caseIds.has(testCase.id)) {
        context.addIssue({
          code: 'custom',
          path: ['cases'],
          message: `Duplicate golden case ID: ${testCase.id}`
        });
      }
      caseIds.add(testCase.id);
    }
    if (fixture.status === 'frozen' && fixture.cases.length < 120) {
      context.addIssue({
        code: 'custom',
        path: ['cases'],
        message: 'A frozen promotion fixture requires 120–200 cases'
      });
    }
  });

export const RetrievalEvaluationRunSchema = z.strictObject({
  caseId: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,79}$/),
  selected: z
    .array(
      z.strictObject({
        sourceId: MemorySourceIdSchema,
        scopeId: ControlScopeIdSchema,
        sleeveId: MemorySleeveIdSchema
      })
    )
    .max(25)
});

export const RetrievalEvaluationRunsSchema = z.array(RetrievalEvaluationRunSchema).max(200);

export interface LexicalEvaluationResult {
  fixtureId: string;
  fixtureStatus: 'scaffold' | 'frozen';
  fixtureVersion: number;
  queryCount: number;
  k: number;
  recallAtK: number;
  meanReciprocalRank: number;
  citationPrecisionAtK: number;
  abstentionAccuracy: number | null;
  scopeLeakageCount: number;
  forbiddenSourceSelectionCount: number;
  sizeEligibleForPromotion: boolean;
  resultFingerprint: string;
  cases: Array<{
    id: string;
    relevantAtK: number;
    expectedRelevant: number;
    reciprocalRank: number;
    abstentionCorrect: boolean | null;
    scopeLeakageCount: number;
    forbiddenSourceSelectionCount: number;
  }>;
}

/** Pure evaluator: no model calls, clocks, latency sampling, or mutable state. */
export function evaluateLexicalRetrieval(
  rawFixture: unknown,
  rawRuns: unknown
): LexicalEvaluationResult {
  const fixture = RetrievalGoldenFixtureSchema.parse(rawFixture);
  const runs = RetrievalEvaluationRunsSchema.parse(rawRuns);
  const runsByCase = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    if (runsByCase.has(run.caseId)) throw new Error(`Duplicate evaluation run: ${run.caseId}`);
    runsByCase.set(run.caseId, run);
  }
  const fixtureCaseIds = new Set(fixture.cases.map((testCase) => testCase.id));
  if (runs.some((run) => !fixtureCaseIds.has(run.caseId))) {
    throw new Error('Evaluation runs contain an unknown golden case ID');
  }
  if (fixture.cases.some((testCase) => !runsByCase.has(testCase.id))) {
    throw new Error('Every golden case requires exactly one evaluation run');
  }

  let relevantTotal = 0;
  let relevantReturned = 0;
  let returnedAtK = 0;
  let reciprocalRankTotal = 0;
  let rankedCaseCount = 0;
  let abstentionCount = 0;
  let correctAbstentionCount = 0;
  let scopeLeakageCount = 0;
  let forbiddenSourceSelectionCount = 0;
  const caseResults = fixture.cases.map((testCase) => {
    const run = runsByCase.get(testCase.id);
    if (run === undefined) throw new Error('Unreachable missing evaluation run');
    const selected = run.selected.slice(0, fixture.k);
    const expected = new Set(testCase.expectedSourceIds);
    const forbidden = new Set(testCase.forbiddenSourceIds);
    const uniqueRelevant = new Set(
      selected.filter((item) => expected.has(item.sourceId)).map((item) => item.sourceId)
    );
    const relevantAtK = uniqueRelevant.size;
    const firstRelevantIndex = selected.findIndex((item) => expected.has(item.sourceId));
    const reciprocalRank = firstRelevantIndex === -1 ? 0 : 1 / (firstRelevantIndex + 1);
    const caseScopeLeakage = selected.filter(
      (item) => item.scopeId !== testCase.scopeId || item.sleeveId !== testCase.sleeveId
    ).length;
    const caseForbiddenSelections = selected.filter((item) => forbidden.has(item.sourceId)).length;
    const abstentionCorrect = testCase.expectAbstention ? selected.length === 0 : null;

    relevantTotal += expected.size;
    relevantReturned += relevantAtK;
    returnedAtK += selected.length;
    if (expected.size > 0) {
      reciprocalRankTotal += reciprocalRank;
      rankedCaseCount += 1;
    }
    if (testCase.expectAbstention) {
      abstentionCount += 1;
      if (abstentionCorrect === true) correctAbstentionCount += 1;
    }
    scopeLeakageCount += caseScopeLeakage;
    forbiddenSourceSelectionCount += caseForbiddenSelections;

    return {
      id: testCase.id,
      relevantAtK,
      expectedRelevant: expected.size,
      reciprocalRank,
      abstentionCorrect,
      scopeLeakageCount: caseScopeLeakage,
      forbiddenSourceSelectionCount: caseForbiddenSelections
    };
  });
  const canonicalRuns = fixture.cases.map((testCase) => ({
    caseId: testCase.id,
    selected: runsByCase.get(testCase.id)?.selected ?? []
  }));

  return {
    fixtureId: fixture.id,
    fixtureStatus: fixture.status,
    fixtureVersion: fixture.version,
    queryCount: fixture.cases.length,
    k: fixture.k,
    recallAtK: relevantTotal === 0 ? 1 : relevantReturned / relevantTotal,
    meanReciprocalRank: rankedCaseCount === 0 ? 0 : reciprocalRankTotal / rankedCaseCount,
    citationPrecisionAtK: returnedAtK === 0 ? 1 : relevantReturned / returnedAtK,
    abstentionAccuracy: abstentionCount === 0 ? null : correctAbstentionCount / abstentionCount,
    scopeLeakageCount,
    forbiddenSourceSelectionCount,
    sizeEligibleForPromotion:
      fixture.status === 'frozen' && fixture.cases.length >= 120 && fixture.cases.length <= 200,
    resultFingerprint: createHash('sha256')
      .update(
        JSON.stringify({
          fixtureId: fixture.id,
          fixtureVersion: fixture.version,
          k: fixture.k,
          runs: canonicalRuns
        }),
        'utf8'
      )
      .digest('hex'),
    cases: caseResults
  };
}
