import { z } from 'zod';

import {
  evaluateLexicalRetrieval,
  RetrievalEvaluationRunsSchema,
  type LexicalEvaluationResult
} from '../../knowledge/retrieval-evaluation';
import { MemorySystemIdSchema, type MemorySystemId } from './contracts';
import { sha256 } from './hashing';

/**
 * Multi-backend memory evaluation. The research report's central practical point
 * is "test instead of guessing": run the same golden fixture through competing
 * backends and compare on retrieval correctness, temporal correctness, leakage,
 * and promotion precision. These evaluators are pure — no model calls, clocks, or
 * mutable state — so a shadow phase can compare backends offline before any
 * default is flipped.
 */

const MemoryBackendArmSchema = z.strictObject({
  backend: MemorySystemIdSchema,
  runs: RetrievalEvaluationRunsSchema
});

export const MemoryBackendComparisonInputSchema = z
  .strictObject({
    arms: z.array(MemoryBackendArmSchema).min(1).max(4)
  })
  .superRefine((input, context) => {
    const backends = new Set<string>();
    for (const arm of input.arms) {
      if (backends.has(arm.backend)) {
        context.addIssue({
          code: 'custom',
          path: ['arms'],
          message: `Duplicate backend arm: ${arm.backend}`
        });
      }
      backends.add(arm.backend);
    }
  });

export type MemoryBackendComparisonInput = z.infer<typeof MemoryBackendComparisonInputSchema>;

export interface MemoryBackendComparison {
  k: number;
  arms: Array<{ backend: MemorySystemId; result: LexicalEvaluationResult }>;
  /** Backends ranked best-first by the deterministic memory-quality order. */
  ranking: MemorySystemId[];
  leader: MemorySystemId;
  fingerprint: string;
}

/**
 * Ranking order (each criterion is a tie-breaker for the previous):
 *   1. fewest scope leakages           (safety first — leakage is disqualifying)
 *   2. fewest forbidden-source picks   (cross-scope traps)
 *   3. highest recall@k
 *   4. highest mean reciprocal rank
 *   5. highest citation precision@k
 *   6. highest abstention accuracy     (null treated as lowest)
 *   7. backend id ascending            (stable final tie-break)
 */
function compareArms(
  left: { backend: MemorySystemId; result: LexicalEvaluationResult },
  right: { backend: MemorySystemId; result: LexicalEvaluationResult }
): number {
  const a = left.result;
  const b = right.result;
  return (
    a.scopeLeakageCount - b.scopeLeakageCount ||
    a.forbiddenSourceSelectionCount - b.forbiddenSourceSelectionCount ||
    b.recallAtK - a.recallAtK ||
    b.meanReciprocalRank - a.meanReciprocalRank ||
    b.citationPrecisionAtK - a.citationPrecisionAtK ||
    (b.abstentionAccuracy ?? -1) - (a.abstentionAccuracy ?? -1) ||
    left.backend.localeCompare(right.backend)
  );
}

export function evaluateMemoryBackends(
  rawFixture: unknown,
  rawInput: unknown
): MemoryBackendComparison {
  const input = MemoryBackendComparisonInputSchema.parse(rawInput);
  const arms = input.arms.map((arm) => ({
    backend: arm.backend,
    result: evaluateLexicalRetrieval(rawFixture, arm.runs)
  }));
  const ranked = arms.slice().sort(compareArms);
  const leader = ranked[0];
  if (leader === undefined) throw new Error('Unreachable: at least one backend arm is required');
  const k = arms[0]?.result.k ?? 0;
  const fingerprint = sha256(
    JSON.stringify({
      k,
      arms: arms.map((arm) => ({
        backend: arm.backend,
        fingerprint: arm.result.resultFingerprint
      })),
      ranking: ranked.map((arm) => arm.backend)
    })
  );
  return {
    k,
    arms,
    ranking: ranked.map((arm) => arm.backend),
    leader: leader.backend,
    fingerprint
  };
}

// --- Promotion precision (bank-maintenance layer) ---------------------------

const candidateIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const PromotionEvaluationInputSchema = z
  .strictObject({
    proposed: z.array(z.string().regex(candidateIdPattern)).max(1_000),
    gold: z
      .array(
        z.strictObject({
          candidateId: z.string().regex(candidateIdPattern),
          shouldPromote: z.boolean()
        })
      )
      .min(1)
      .max(1_000)
  })
  .superRefine((input, context) => {
    if (new Set(input.proposed).size !== input.proposed.length) {
      context.addIssue({
        code: 'custom',
        path: ['proposed'],
        message: 'proposed ids must be unique'
      });
    }
    const goldIds = new Set<string>();
    for (const entry of input.gold) {
      if (goldIds.has(entry.candidateId)) {
        context.addIssue({
          code: 'custom',
          path: ['gold'],
          message: `Duplicate gold id: ${entry.candidateId}`
        });
      }
      goldIds.add(entry.candidateId);
    }
    for (const id of input.proposed) {
      if (!goldIds.has(id)) {
        context.addIssue({
          code: 'custom',
          path: ['proposed'],
          message: `Proposed id has no gold label: ${id}`
        });
      }
    }
  });

export type PromotionEvaluationInput = z.infer<typeof PromotionEvaluationInputSchema>;

export interface PromotionEvaluationResult {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  fingerprint: string;
}

/**
 * Promotion precision/recall for propose-only candidates: of the candidates the
 * planner proposed, how many should genuinely be promoted, and how many
 * promote-worthy candidates were missed. Penalizing over-eager promotion is the
 * research report's key defense against memory poisoning and sycophancy.
 */
export function evaluatePromotionPrecision(rawInput: unknown): PromotionEvaluationResult {
  const input = PromotionEvaluationInputSchema.parse(rawInput);
  const proposed = new Set(input.proposed);
  const shouldPromote = new Set(
    input.gold.filter((entry) => entry.shouldPromote).map((entry) => entry.candidateId)
  );

  let truePositives = 0;
  let falsePositives = 0;
  for (const id of proposed) {
    if (shouldPromote.has(id)) truePositives += 1;
    else falsePositives += 1;
  }
  let falseNegatives = 0;
  for (const id of shouldPromote) {
    if (!proposed.has(id)) falseNegatives += 1;
  }

  const precision =
    truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
  const recall =
    truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const fingerprint = sha256(
    JSON.stringify({ truePositives, falsePositives, falseNegatives, precision, recall, f1 })
  );

  return { truePositives, falsePositives, falseNegatives, precision, recall, f1, fingerprint };
}
