import { z } from 'zod';

import {
  AccessAgentIdSchema,
  AccessSensitivitySchema,
  ControlScopeIdSchema,
  MemorySleeveIdSchema,
  type AccessSensitivity
} from '../../agents/access-control-contracts';
import { MemoryFragmentIdSchema, MemoryKindSchema } from '../../knowledge/retrieval-contracts';
import {
  MemorySystemUnsupportedError,
  ProcedureStepSchema,
  type ConsolidationCandidateInput,
  type ConsolidationCandidateRecord,
  type MemorySystem,
  type ProcedureCandidateInput,
  type ProcedureCandidateRecord
} from './contracts';
import {
  consolidationContentHash,
  procedureContentHash,
  sha256,
  workflowSignatureForSteps
} from './hashing';
import { storeClassForKind } from './store-classes';

const topicKeyPattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const plannerVersionPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ONE_YEAR_MS = 31_536_000_000;

const EpisodicObservationSchema = z.strictObject({
  fragmentId: MemoryFragmentIdSchema,
  kind: MemoryKindSchema,
  title: z.string().trim().min(1).max(240),
  topicKeys: z.array(z.string().regex(topicKeyPattern)).min(1).max(20),
  recordedAt: z.iso.datetime(),
  sensitivity: AccessSensitivitySchema
});

const WorkflowObservationSchema = z.strictObject({
  steps: z.array(ProcedureStepSchema).min(1).max(64),
  outcome: z.enum(['success', 'failure']),
  observedAt: z.iso.datetime(),
  title: z.string().trim().min(1).max(240).nullable(),
  sourceFragmentId: MemoryFragmentIdSchema.nullable(),
  sensitivity: AccessSensitivitySchema
});

export const MemoryConsolidationPlanInputSchema = z.strictObject({
  ownerScopeId: ControlScopeIdSchema,
  sleeveId: MemorySleeveIdSchema,
  proposedBy: AccessAgentIdSchema,
  plannerVersion: z.string().regex(plannerVersionPattern),
  evaluatedAt: z.iso.datetime(),
  candidateTtlMs: z.number().int().min(60_000).max(ONE_YEAR_MS),
  historicalAfterMs: z.number().int().min(0).max(ONE_YEAR_MS),
  minEpisodesPerTopic: z.number().int().min(2).max(1_000),
  minSuccessesPerWorkflow: z.number().int().min(2).max(1_000),
  maxProposals: z.number().int().min(1).max(200),
  episodes: z.array(EpisodicObservationSchema).max(2_000),
  workflows: z.array(WorkflowObservationSchema).max(2_000)
});

export type EpisodicObservation = z.infer<typeof EpisodicObservationSchema>;
export type WorkflowObservation = z.infer<typeof WorkflowObservationSchema>;
export type MemoryConsolidationPlanInput = z.infer<typeof MemoryConsolidationPlanInputSchema>;

export interface MemoryConsolidationPlan {
  plannerVersion: string;
  evaluatedAt: string;
  consolidations: ConsolidationCandidateInput[];
  procedures: ProcedureCandidateInput[];
  summary: {
    episodesConsidered: number;
    episodesSkippedNonEpisodic: number;
    topicsProposed: number;
    workflowsProposed: number;
    proposalsCapped: number;
  };
  fingerprint: string;
}

const SENSITIVITY_RANK: Readonly<Record<AccessSensitivity, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  private: 3,
  restricted: 4
};

const SENSITIVITY_BY_RANK: readonly AccessSensitivity[] = [
  'public',
  'internal',
  'confidential',
  'private',
  'restricted'
];

function maxSensitivity(values: readonly AccessSensitivity[]): AccessSensitivity {
  const rank = values.reduce((highest, value) => Math.max(highest, SENSITIVITY_RANK[value]), 0);
  return SENSITIVITY_BY_RANK[rank] ?? 'internal';
}

function isoAdd(iso: string, deltaMs: number): string {
  return new Date(Date.parse(iso) + deltaMs).toISOString();
}

/**
 * Deterministic, LLM-free memory consolidation. Given a sleeve's episodic evidence
 * and observed workflow runs, it proposes:
 *   * semantic `summary` candidates for topics that recur across enough episodes, and
 *   * procedural candidates for workflows that have succeeded enough times.
 *
 * It is a pure function: identical inputs yield identical proposals (stable ids,
 * ordering, and a fingerprint). It NEVER writes durable or cross-sleeve memory and
 * NEVER auto-supersedes — every proposal is a propose-only candidate for operator
 * review. When evidence changes, a new content-addressed candidate is proposed; the
 * operator retires the prior one through the existing supersession path.
 */
export function planMemoryConsolidation(rawInput: unknown): MemoryConsolidationPlan {
  const input = MemoryConsolidationPlanInputSchema.parse(rawInput);

  // --- Consolidations: group episodic evidence by topic key -----------------
  const episodic = input.episodes.filter(
    (episode) => storeClassForKind(episode.kind) === 'episodic'
  );
  const episodesSkippedNonEpisodic = input.episodes.length - episodic.length;

  const topics = new Map<string, EpisodicObservation[]>();
  for (const episode of episodic) {
    for (const topicKey of new Set(episode.topicKeys)) {
      const bucket = topics.get(topicKey) ?? [];
      bucket.push(episode);
      topics.set(topicKey, bucket);
    }
  }

  const consolidations: ConsolidationCandidateInput[] = [];
  for (const topicKey of [...topics.keys()].sort()) {
    const bucket = topics.get(topicKey);
    if (bucket === undefined) continue;
    const uniqueById = [
      ...new Map(bucket.map((episode) => [episode.fragmentId, episode])).values()
    ];
    if (uniqueById.length < input.minEpisodesPerTopic) continue;

    const ordered = uniqueById
      .slice()
      .sort((left, right) => left.fragmentId.localeCompare(right.fragmentId));
    const sourceFragmentIds = ordered.map((episode) => episode.fragmentId).slice(0, 64);
    const newestRecordedAt = ordered.reduce(
      (newest, episode) => (episode.recordedAt > newest ? episode.recordedAt : newest),
      ordered[0]?.recordedAt ?? input.evaluatedAt
    );
    const temporalState =
      Date.parse(input.evaluatedAt) - Date.parse(newestRecordedAt) > input.historicalAfterMs
        ? 'historical'
        : 'current';
    const titles = ordered
      .map((episode) => episode.title)
      .sort((left, right) => left.localeCompare(right));
    const content =
      `Recurring topic "${topicKey}" consolidated from ${uniqueById.length} episodes: ${titles.join('; ')}`.slice(
        0,
        65_536
      );
    const sensitivity = maxSensitivity(ordered.map((episode) => episode.sensitivity));
    const contentHash = consolidationContentHash({
      targetStore: 'semantic',
      proposedKind: 'summary',
      title: `Summary: ${topicKey}`,
      content,
      temporalState,
      sourceFragmentIds
    });
    consolidations.push({
      id: `memcons-${contentHash.slice(0, 48)}`,
      ownerScopeId: input.ownerScopeId,
      sleeveId: input.sleeveId,
      targetStore: 'semantic',
      proposedKind: 'summary',
      title: `Summary: ${topicKey}`,
      content,
      sourceFragmentIds,
      evidenceCount: uniqueById.length,
      temporalState,
      confidencePermille: Math.min(1_000, 300 + uniqueById.length * 100),
      rationale: `Topic "${topicKey}" recurred across ${uniqueById.length} episodes (>= ${input.minEpisodesPerTopic}).`,
      plannerVersion: input.plannerVersion,
      proposedBy: input.proposedBy,
      sensitivity,
      recordedAt: input.evaluatedAt,
      expiresAt: isoAdd(input.evaluatedAt, input.candidateTtlMs),
      supersedesCandidateId: null
    });
  }

  // --- Procedures: group successful workflow observations by signature ------
  const bySignature = new Map<string, WorkflowObservation[]>();
  for (const observation of input.workflows) {
    if (observation.outcome !== 'success') continue;
    const signature = workflowSignatureForSteps(observation.steps);
    const bucket = bySignature.get(signature) ?? [];
    bucket.push(observation);
    bySignature.set(signature, bucket);
  }

  const procedures: ProcedureCandidateInput[] = [];
  for (const signature of [...bySignature.keys()].sort()) {
    const bucket = bySignature.get(signature);
    if (bucket === undefined || bucket.length < input.minSuccessesPerWorkflow) continue;

    const ordered = bucket
      .slice()
      .sort(
        (left, right) =>
          left.observedAt.localeCompare(right.observedAt) ||
          left.steps.join('\u0000').localeCompare(right.steps.join('\u0000'))
      );
    const canonical = ordered[0];
    if (canonical === undefined) continue;
    const firstSeenAt = ordered.reduce(
      (earliest, observation) =>
        observation.observedAt < earliest ? observation.observedAt : earliest,
      canonical.observedAt
    );
    const lastSeenAt = ordered.reduce(
      (latest, observation) => (observation.observedAt > latest ? observation.observedAt : latest),
      canonical.observedAt
    );
    const title =
      canonical.title ?? `Workflow ${signature.slice(0, 8)} (${bucket.length} successes)`;
    const sensitivity = maxSensitivity(ordered.map((observation) => observation.sensitivity));
    const contentHash = procedureContentHash({
      workflowSignature: signature,
      title,
      steps: canonical.steps
    });
    procedures.push({
      id: `memproc-${contentHash.slice(0, 48)}`,
      ownerScopeId: input.ownerScopeId,
      sleeveId: input.sleeveId,
      workflowSignature: signature,
      title,
      steps: canonical.steps,
      successCount: bucket.length,
      firstSeenAt,
      lastSeenAt,
      rationale: `Workflow succeeded ${bucket.length} times (>= ${input.minSuccessesPerWorkflow}).`,
      plannerVersion: input.plannerVersion,
      proposedBy: input.proposedBy,
      sensitivity,
      recordedAt: input.evaluatedAt,
      expiresAt: isoAdd(input.evaluatedAt, input.candidateTtlMs),
      supersedesCandidateId: null
    });
  }

  // --- Deterministic cap across both proposal streams -----------------------
  const topicsProposed = consolidations.length;
  const workflowsProposed = procedures.length;
  const totalProposed = topicsProposed + workflowsProposed;
  const cappedConsolidations = consolidations.slice(0, input.maxProposals);
  const remainingBudget = Math.max(0, input.maxProposals - cappedConsolidations.length);
  const cappedProcedures = procedures.slice(0, remainingBudget);
  const proposalsCapped = totalProposed - (cappedConsolidations.length + cappedProcedures.length);

  const summary = {
    episodesConsidered: episodic.length,
    episodesSkippedNonEpisodic,
    topicsProposed: cappedConsolidations.length,
    workflowsProposed: cappedProcedures.length,
    proposalsCapped
  };
  const fingerprint = sha256(
    JSON.stringify({
      plannerVersion: input.plannerVersion,
      evaluatedAt: input.evaluatedAt,
      consolidations: cappedConsolidations.map((candidate) => candidate.id),
      procedures: cappedProcedures.map((candidate) => candidate.id),
      summary
    })
  );

  return {
    plannerVersion: input.plannerVersion,
    evaluatedAt: input.evaluatedAt,
    consolidations: cappedConsolidations,
    procedures: cappedProcedures,
    summary,
    fingerprint
  };
}

export interface MemoryConsolidationRunResult {
  plan: MemoryConsolidationPlan;
  consolidationReceipts: ConsolidationCandidateRecord[];
  procedureReceipts: ProcedureCandidateRecord[];
}

/**
 * Thin driver that runs the pure planner and persists its proposals through a
 * typed-hybrid {@link MemorySystem}. Proposals are idempotent by content-addressed
 * id, so re-running on unchanged evidence is a no-op. Fails closed on any backend
 * that does not expose the propose-only stores (e.g. the flat backend).
 */
export class MemoryConsolidationRunner {
  constructor(private readonly system: MemorySystem) {}

  async run(rawInput: unknown): Promise<MemoryConsolidationRunResult> {
    const consolidation = this.system.consolidation();
    const procedures = this.system.procedures();
    if (consolidation === null || procedures === null) {
      throw new MemorySystemUnsupportedError(this.system.id, 'consolidation');
    }
    const plan = planMemoryConsolidation(rawInput);
    const consolidationReceipts: ConsolidationCandidateRecord[] = [];
    for (const candidate of plan.consolidations) {
      consolidationReceipts.push(await consolidation.propose(candidate));
    }
    const procedureReceipts: ProcedureCandidateRecord[] = [];
    for (const candidate of plan.procedures) {
      procedureReceipts.push(await procedures.propose(candidate));
    }
    return { plan, consolidationReceipts, procedureReceipts };
  }
}
