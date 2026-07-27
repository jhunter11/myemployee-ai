import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccessControlRepository } from '../../agents/access-control-repository';
import { createDatabase } from '../../db/database';
import type { LexicalRetrievalItem } from '../../knowledge/retrieval-contracts';
import { createMemorySystem } from '../system/factory';
import { sha256 } from '../system/hashing';
import type { MemorySystemId } from '../system/contracts';
import { buildReasoningTrace, type ReasoningTrace } from './reasoning-trace';
import {
  DEMO_AGENT_ID,
  DEMO_NOW,
  SAMPLE_QUESTIONS,
  loadSampleMemory,
  provisionSampleMemory,
  type SampleQuestion
} from './sample-memory';

/**
 * Runs the identical sample corpus and the identical questions through two or more
 * memory backends and collects a reasoning trace for each pairing.
 *
 * This is the swap test the research reports insist on ("test instead of guessing"):
 * every arm sees the same evidence in the same order under the same context budget,
 * so any behavioural difference is attributable to the backend. Each backend gets a
 * freshly migrated database of its own, so no arm can benefit from another's writes.
 */

/** The compiled-context budget every backend shares — fairness depends on it being frozen. */
export const DEMO_CONTEXT_BUDGET = {
  totalCapacityTokens: 1_200,
  reservations: { output: 200, policy: 80, toolSchema: 60, workingState: 60, safety: 40 },
  maxFragmentsPerSource: 2
} as const;

export interface BackendComparisonInput {
  readonly backends: readonly MemorySystemId[];
  readonly questions?: readonly SampleQuestion[];
  readonly evaluatedAt?: string;
  readonly projectRoot: string;
}

export interface BackendResult {
  readonly backend: MemorySystemId;
  readonly traces: readonly ReasoningTrace[];
  /** Questions where retrieval surfaced everything required and nothing forbidden. */
  readonly memoryCorrectCount: number;
  /** Questions where the fixed resolver also reached the right conclusion. */
  readonly answerCorrectCount: number;
  /** Expected-abstention questions where the resolver correctly declined. */
  readonly abstentionCorrectCount: number;
  readonly abstentionQuestionCount: number;
  readonly questionCount: number;
  /** Forbidden evidence reached the selected set — the disqualifying safety failure. */
  readonly leakCount: number;
  readonly fingerprint: string;
  /**
   * Digest of what this backend DID, with its own name excluded. Two backends
   * sharing this value made identical decisions on every question — which is the
   * comparison `fingerprint` cannot express, since it always differs by name alone.
   */
  readonly behaviorFingerprint: string;
}

export interface BackendComparison {
  readonly evaluatedAt: string;
  readonly results: readonly BackendResult[];
  readonly fingerprint: string;
}

function toContextCandidate(item: LexicalRetrievalItem) {
  return {
    id: item.id,
    ownerScopeId: item.ownerScopeId,
    sleeveId: item.sleeveId,
    sourceId: item.sourceId,
    sourceHash: item.sourceHash,
    content: item.content,
    required: false,
    priority: 50,
    relevancePermille: Math.max(0, 1_000 - (item.rank - 1) * 100),
    confidencePermille: item.confidencePermille,
    recordedAt: item.recordedAt,
    coverageKeys: item.tags,
    retrievalEligible: item.retrievalEligible,
    expiresAt: item.expiresAt,
    supersededByFragmentId: item.supersededByFragmentId
  };
}

/** Runs every question through one backend against its own freshly migrated database. */
async function runBackend(
  backend: MemorySystemId,
  questions: readonly SampleQuestion[],
  evaluatedAt: string,
  projectRoot: string
): Promise<BackendResult> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), `jarvis-memory-demo-${backend}-`));
  const context = await createDatabase({
    projectRoot,
    filename: join(temporaryRoot, 'jarvis.sqlite')
  });
  try {
    const access = new AccessControlRepository(context.db, () => new Date(evaluatedAt));
    const { grantVersions } = await provisionSampleMemory(access);
    const boundAccess = access.bindAgent({ agentId: DEMO_AGENT_ID, expectedAgentVersion: 1 });
    const system = createMemorySystem({ sqlite: context.sqlite, access: boundAccess, backend });

    await loadSampleMemory(system);

    const traces: ReasoningTrace[] = [];
    for (const question of questions) {
      const sleeveGrants = grantVersions[question.sleeveId];
      if (sleeveGrants === undefined) {
        throw new Error(`No read grant provisioned for sleeve ${question.sleeveId}`);
      }
      const retrieval = await system.retrieve({
        authorization: {
          sleeveId: question.sleeveId,
          expectedSleeveVersion: 1,
          expectedOwnerScopeVersion: 1,
          permission: 'read',
          purpose: 'memory_backend_demo',
          sensitivity: 'confidential',
          grantVersions: sleeveGrants
        },
        text: question.question,
        limit: 5
      });

      const compilation =
        retrieval.items.length === 0
          ? null
          : system.compileContext({
              ownerScopeId: question.scopeId,
              sleeveId: question.sleeveId,
              totalCapacityTokens: DEMO_CONTEXT_BUDGET.totalCapacityTokens,
              reservations: DEMO_CONTEXT_BUDGET.reservations,
              maxFragmentsPerSource: DEMO_CONTEXT_BUDGET.maxFragmentsPerSource,
              evaluatedAt,
              fragments: retrieval.items.map(toContextCandidate)
            });

      traces.push(buildReasoningTrace({ backend, question, retrieval, evaluatedAt, compilation }));
    }

    return {
      backend,
      traces,
      memoryCorrectCount: traces.filter((trace) => trace.assessment.memoryCorrect).length,
      answerCorrectCount: traces.filter((trace) => trace.assessment.answerCorrect).length,
      abstentionCorrectCount: traces.filter(
        (trace) => trace.assessment.abstentionExpected && trace.assessment.abstentionCorrect
      ).length,
      abstentionQuestionCount: traces.filter((trace) => trace.assessment.abstentionExpected).length,
      questionCount: traces.length,
      leakCount: traces.filter((trace) => trace.assessment.leakedEvidence.length > 0).length,
      fingerprint: sha256(JSON.stringify(traces.map((trace) => trace.fingerprint))),
      behaviorFingerprint: sha256(JSON.stringify(traces.map((trace) => trace.behaviorFingerprint)))
    };
  } finally {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function compareMemoryBackends(
  input: BackendComparisonInput
): Promise<BackendComparison> {
  const questions = input.questions ?? SAMPLE_QUESTIONS;
  const evaluatedAt = input.evaluatedAt ?? DEMO_NOW;
  const results: BackendResult[] = [];
  for (const backend of input.backends) {
    results.push(await runBackend(backend, questions, evaluatedAt, input.projectRoot));
  }
  return {
    evaluatedAt,
    results,
    fingerprint: sha256(
      JSON.stringify(results.map((result) => [result.backend, result.fingerprint]))
    )
  };
}

/**
 * Compact scoreboard. Memory correctness leads because it is what differs between
 * backends; answer correctness is downstream of a resolver held constant across
 * all of them. Leakage is reported separately and is never traded against accuracy.
 */
export function renderComparisonTable(comparison: BackendComparison): string {
  // Backends that made identical decisions share a behaviour group. Without this
  // column a reader sees equal scores and concludes the backends are equivalent,
  // when they may have ranked candidates completely differently and merely landed
  // on the same answers — or may genuinely be the same code path. Those are very
  // different facts and the scoreboard alone cannot tell them apart.
  const groupByDigest = new Map<string, string>();
  for (const result of comparison.results) {
    if (!groupByDigest.has(result.behaviorFingerprint)) {
      groupByDigest.set(result.behaviorFingerprint, String.fromCharCode(65 + groupByDigest.size));
    }
  }

  const header = 'backend         memory    answer    abstain   leaks   behaviour  safety';
  const rows = comparison.results.map((result) => {
    const backend = result.backend.padEnd(14);
    const memory = `${result.memoryCorrectCount}/${result.questionCount}`.padEnd(9);
    const answer = `${result.answerCorrectCount}/${result.questionCount}`.padEnd(9);
    const abstention = `${result.abstentionCorrectCount}/${result.abstentionQuestionCount}`.padEnd(
      10
    );
    const leaks = String(result.leakCount).padEnd(7);
    const group = (groupByDigest.get(result.behaviorFingerprint) ?? '?').padEnd(10);
    const safety = result.leakCount > 0 ? 'FAIL (forbidden evidence surfaced)' : 'pass';
    return `${backend}  ${memory} ${answer} ${abstention}${leaks} ${group} ${safety}`;
  });
  return [header, '-'.repeat(header.length), ...rows].join('\n');
}
