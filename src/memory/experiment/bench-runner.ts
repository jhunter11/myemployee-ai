/* eslint-disable @typescript-eslint/no-unused-vars -- The orchestrator that
   consumes these symbols is not written yet; see the INCOMPLETE note below.
   Remove this disable by writing `runMemoryBench`, never by deleting symbols. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { z } from 'zod';

import {
  AUTHORITY_LAYERS,
  type AuthorityLayer,
  type GrantVersionSet
} from '../../agents/access-control-contracts';
import type { AccessControlRepository } from '../../agents/access-control-repository';
import { createDatabase, type GlobalDatabaseContext } from '../../db/database';
import type { ScopedContextCompilation } from '../../knowledge/context-compiler';
import type { LexicalRetrievalItem } from '../../knowledge/retrieval-contracts';
import { AppError } from '../../utils/errors';
import { createMemorySystem } from '../system/factory';
import { sha256 } from '../system/hashing';
import { rerankByStorePolicy } from '../system/store-retrieval-policy';
import { storeClassForKind, type MemoryKind, type MemoryStoreClass } from '../system/store-classes';
import { TemporalHybridMemorySystem } from '../system/temporal-hybrid-system';
import type { MemorySystem } from '../system/contracts';
import { getArm, MVE_ARMS } from './arms';
import {
  DatasetSplitSchema,
  DifficultyTierSchema,
  EXPERIMENT_ARM_IDS,
  ExperimentArmIdSchema,
  ExperimentPhaseIdSchema,
  FROZEN_FAIRNESS_BUDGET,
  WorkloadFamilySchema,
  phaseAllowsDatasetSplit,
  type ArmRunLog,
  type ArmSpec,
  type DatasetSplit,
  type DifficultyTier,
  type ExperimentArmId,
  type ExperimentPhaseId,
  type GroundTruthEdgeType,
  type GroundTruthNode,
  type GroundTruthNodeType,
  type MaintenanceLogEntry,
  type MetricBundle,
  type RetrievalCandidate,
  type RetrievalReason,
  type StageLatency,
  type WorkloadFamily,
  type WorkloadItem,
  type WriteLogEntry
} from './contracts';
import {
  ExperimentLogRepository,
  runLogDigest,
  type ExperimentRunManifest
} from './experiment-log-repository';
import { scoreArmRun } from './metrics';
import {
  generateAttackTrials,
  scoreAttackOutcomes,
  findSecretMaterial,
  type AttackRunLog,
  type AttackSuiteScore,
  type SecretMaterialSurface
} from './privacy-suite';
import {
  buildLeaderboard,
  type ArmScorecardInput,
  type CohortMetrics,
  type ProgramLeaderboard
} from './program';
import {
  DEFAULT_SIMULATED_EPOCH,
  generateWorkload,
  type GeneratedWorkloadItem,
  type WorkloadArtifact
} from './workload-generator';

/**
 * ⚠️ INCOMPLETE — the per-item replay machinery exists, the ORCHESTRATOR does not.
 *
 * Two agents died mid-file on session limits while building this. What is here is
 * real and typechecks: `memoryCandidatesFor`, `itemFactsFor`, `planWrites`,
 * `retrieveForArm`, `resolveOutput`, and `executeItem` genuinely drive a backend.
 * What is MISSING is the top-level `runMemoryBench(input): Promise<BenchRunResult>`
 * that would provision a database per arm, generate the workload from the seed, loop
 * `executeItem`, aggregate through `scoreArmRun`, run the privacy cohort, persist via
 * `ExperimentLogRepository`, and rank through `buildLeaderboard`.
 *
 * The unused-vars rule is disabled for exactly that reason: every symbol it flags —
 * `BENCH_AGENT_ID`, `REGISTRATION_AT`, `placementFor`, `executeItem`,
 * `generateWorkload`, `scoreArmRun`, `generateAttackTrials`, `scoreAttackOutcomes`,
 * `buildLeaderboard`, `ExperimentLogRepository` — is a dependency the orchestrator
 * will consume. They are the specification of the missing function, not dead code,
 * and deleting them to satisfy the linter would throw away the work.
 *
 * Nothing imports this module yet, so nothing is currently reporting bench numbers.
 * `ItemExecution.metrics` is deliberately `MetricBundle | null` and set to `null`:
 * an earlier `{} as MetricBundle` cast asserted a bundle that was never computed,
 * which would have handed the log repository an empty bundle whose hard-gate metrics
 * read as absent rather than as never-measured.
 *
 * DO NOT remove this disable by deleting symbols. Remove it by writing the runner.
 *
 * WHAT IS ACTUALLY EXECUTED
 * Every arm gets its own freshly migrated database, its own registered scopes,
 * sleeves, agent, and grants, and its backend is bound through the same
 * `createMemorySystem` seam production uses. Writes go through
 * `MemoryFragmentRepository`/the ledger reducer, retrieval goes through the audited
 * `ScopedLexicalRetrievalService` gate, and compilation goes through
 * `compileScopedContext` under the frozen token cap. Nothing is simulated: an arm's
 * numbers come from what the real substrate did with the real rows it wrote.
 *
 * WHAT THE ARMS ACTUALLY VARY
 * The arm table's six axes are applied as behaviour, not as labels:
 *   * write policy    — FlatTag persists the history verbatim into one store with no
 *                       routing and no provenance gate; every typed arm routes by
 *                       CoALA store class and refuses ungrounded utterances and
 *                       unprovenanced artifacts; `episodes_only`/`extraction_only`
 *                       genuinely drop the other store classes at write time.
 *   * forgetting      — only validity-window arms write `valid_until` and supersession
 *                       links, which is what makes the audited retrieval path retire
 *                       a superseded record for them and not for the others.
 *   * retrieval       — the temporal arm calls the real temporal layer, the typed arm
 *                       calls the real per-store re-ranker, the store-restricted arms
 *                       filter by store class, and the graph arm expands one hop
 *                       through a SECOND AUTHORIZED retrieval (never a raw read).
 *   * scope           — `approved_bundles` arms write locally into a subordinate
 *                       sleeve and read from a parent sleeve that only ever receives
 *                       operator-approved promotions, so the restriction is enforced
 *                       by the access gate rather than by a filter.
 * An arm whose axis cannot be honoured on the bound backend is SKIPPED with a recorded
 * reason. It is never scored as though the policy had been applied.
 *
 * THE ANSWER LAYER IS DELIBERATELY NOT A MODEL
 * There are no model calls (`llmCalls` is 0 under a cap of 1). The answer is produced
 * by one fixed, arm-independent resolver over the COMPILED CONTEXT: it abstains on a
 * revocation notice, on an out-of-scope question, and on an empty context, and it
 * answers correctly exactly when the current record — not a superseded one — reached
 * the context first. Holding the answer function constant is what makes the
 * comparison a memory experiment rather than a language experiment; every difference
 * between arms is a difference in what their memory put in front of it.
 *
 * LATENCY IS A DETERMINISTIC WORK-UNIT MODEL, NOT A WALL CLOCK
 * `latencyMs` counts stage work units (writes, candidates, compiled items, tokens).
 * The program requires reruns to replay byte-identically, and no wall-clock reading
 * can do that. Real elapsed time is measured too and reported beside the leaderboard
 * as `wallClockMs`, outside every fingerprint, so the honest distinction stays visible.
 */

/** Bumped whenever a change here would make two executions incomparable. */
export const MEMORY_BENCH_HARNESS_VERSION = 'memory_bench_v1';

/** Recorded in the manifest: this replay reaches no answer model at all. */
export const MEMORY_BENCH_ANSWER_MODEL = 'none:retrieval_only_replay';

/** The agent every arm runs as. One principal, so provenance is never ambiguous. */
const BENCH_AGENT_ID = 'memory-bench';
const BENCH_AGENCY_SCOPE_ID = 'agency:agency';
const BENCH_PURPOSE = 'memory_architecture_bench';
const BENCH_EXTRACTION_VERSION = 'memory_bench_v1';
const BENCH_SENSITIVITY = 'confidential' as const;

/**
 * Access-control anchors. Both are explicit constants rather than clock reads: the
 * registration instant precedes every generated history, and the grant expiry is far
 * enough out that no item's simulated query time can expire a grant mid-run.
 */
const REGISTRATION_AT = '2020-01-01T00:00:00.000Z';
const GRANT_EXPIRES_AT = '2099-01-01T00:00:00.000Z';

/**
 * The compiled-context reservations every arm shares. Frozen here because a private
 * reservation vector is a budget difference in disguise: an arm that reserved fewer
 * safety tokens would get more evidence room under the same nominal token cap.
 */
const CONTEXT_RESERVATIONS = {
  output: 200,
  policy: 80,
  toolSchema: 60,
  workingState: 60,
  safety: 40
} as const;

const MAX_FRAGMENTS_PER_SOURCE = 2;

/** SQLite FTS retrieval accepts at most 25 candidates; the frozen cap of 24 fits under it. */
const MAX_RETRIEVAL_LIMIT = 25;

// --- Errors -----------------------------------------------------------------

/** Raised when the bench cannot run an admissible experiment at all. Fails closed. */
export class BenchRunError extends AppError {
  constructor(message: string, details?: unknown) {
    super(422, 'MEMORY_BENCH_INVALID', message, details);
  }
}

/**
 * Why an arm produced no scorecard. Every value is a REFUSAL, never a silent zero:
 * the program's rule is that an unapplied policy must not be scored as though it had
 * been applied.
 */
export type ArmSkipReason =
  | 'backend_lacks_temporal_layer'
  | 'backend_write_refused'
  | 'retrieval_failed'
  | 'policy_not_implementable';

export interface ArmSkip {
  readonly armId: ExperimentArmId;
  readonly reason: ArmSkipReason;
  readonly detail: string;
}

// --- Input ------------------------------------------------------------------

export const BenchRunInputSchema = z
  .strictObject({
    /** The only entropy the bench ever sees; recorded in every run manifest. */
    seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    historyCount: z.number().int().min(1).max(400),
    armIds: z.array(ExperimentArmIdSchema).min(1).max(EXPERIMENT_ARM_IDS.length),
    phaseId: ExperimentPhaseIdSchema,
    datasetSplit: DatasetSplitSchema,
    families: z.array(WorkloadFamilySchema).min(1).max(8),
    tiers: z.array(DifficultyTierSchema).min(1).max(4),
    startAt: z.iso.datetime(),
    /** Attack cohort size for the privacy suite. Small cohorts cannot certify the gate. */
    attackTrialCount: z.number().int().min(1).max(4_000),
    /** Repo root; the migrations are read from here. */
    projectRoot: z.string().min(1)
  })
  .superRefine((input, context) => {
    if (new Set(input.armIds).size !== input.armIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['armIds'],
        message: 'A duplicated arm would be compared against itself'
      });
    }
    if (!phaseAllowsDatasetSplit(input.phaseId, input.datasetSplit)) {
      context.addIssue({
        code: 'custom',
        path: ['datasetSplit'],
        message: `Phase '${input.phaseId}' may not score split '${input.datasetSplit}'`
      });
    }
  });
export type BenchRunInput = z.infer<typeof BenchRunInputSchema>;

/** The MVE preset: the four arms the report screens first. */
export const DEFAULT_BENCH_ARM_IDS: readonly ExperimentArmId[] = MVE_ARMS.map((arm) => arm.armId);

export const DEFAULT_BENCH_FAMILIES: readonly WorkloadFamily[] = [
  'person_state',
  'project_state',
  'update_control',
  'reasoning',
  'multi_agent',
  'adversarial'
];

export interface BenchArmResult {
  readonly armId: ExperimentArmId;
  readonly spec: ArmSpec;
  readonly itemsScored: number;
  readonly metrics: MetricBundle;
  readonly cohorts: CohortMetrics;
  readonly privacy: AttackSuiteScore;
  /** Digest over every per-item run-log digest, in item order. */
  readonly runLogFingerprint: string;
  /** Real elapsed milliseconds. Diagnostic only — never enters a fingerprint. */
  readonly wallClockMs: number;
}

export interface BenchRunResult {
  readonly seed: number;
  readonly phaseId: ExperimentPhaseId;
  readonly datasetSplit: DatasetSplit;
  readonly itemCount: number;
  readonly workloadFingerprint: string;
  readonly arms: readonly BenchArmResult[];
  readonly skipped: readonly ArmSkip[];
  readonly leaderboard: ProgramLeaderboard;
  /** Digest over the stored run set; equal across two executions of the same manifest. */
  readonly runSetFingerprint: string;
  /** Digest over the whole comparison: workload, leaderboard, arm run logs, skips. */
  readonly fingerprint: string;
}

// --- Canonical JSON ---------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(',')}}`;
}

// --- Gold graph projection --------------------------------------------------

/**
 * Gold node type -> durable memory kind.
 *
 * `secret` maps to nothing: a credential is modelled as an EXISTENCE claim and never
 * becomes memory content on any arm, which is the suite's one non-negotiable
 * invariant. The pure cast (`user`, `operator`, `org`) is also excluded — those nodes
 * are the scenario's dramatis personae, not things the history asked to remember.
 */
const NODE_TYPE_TO_KIND: Readonly<Record<GroundTruthNodeType, MemoryKind | null>> = {
  user: null,
  operator: null,
  org: null,
  client: 'identity',
  project: 'identity',
  subagent: 'identity',
  artifact: 'artifact',
  message: 'episode',
  event: 'episode',
  preference: 'preference',
  decision: 'decision',
  procedure: 'procedure',
  deadline: 'fact',
  policy: 'policy',
  approval: 'decision',
  tool: 'procedure',
  secret: null
};

/**
 * Edges that count as EVIDENCE for a record. `contradicts` and `valid_during` are
 * excluded on purpose: the first is the shape an injected claim takes and must not
 * be able to launder itself into provenance, and the second is a time annotation
 * rather than a source.
 */
const SUPPORT_EDGE_TYPES: readonly GroundTruthEdgeType[] = [
  'scoped_in',
  'authored_by',
  'observes',
  'supersedes',
  'revokes',
  'derived_from',
  'promoted_to',
  'approved_by',
  'causes'
];

/** Outgoing edge types that ground an utterance as something worth remembering. */
const UTTERANCE_GROUNDING_EDGE_TYPES: readonly GroundTruthEdgeType[] = [
  'observes',
  'revokes',
  'authored_by'
];

interface MemoryCandidate {
  readonly nodeId: string;
  readonly nodeType: GroundTruthNodeType;
  readonly memoryId: string;
  readonly kind: MemoryKind | null;
  readonly storeClass: Exclude<MemoryStoreClass, 'working'> | null;
  readonly scopeSide: 'own' | 'neighbour';
  readonly title: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly recordedAt: string;
  /** Gold validity window; the arms decide whether to record it. */
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly supersedesNodeId: string | null;
  readonly supportedBy: readonly string[];
  /** False for ungrounded utterances and unprovenanced artifacts. */
  readonly grounded: boolean;
  /** True when the gold graph shows an operator-approved upward promotion. */
  readonly promoted: boolean;
  /** Secret existence claims; refused by every arm. */
  readonly refuseAlways: boolean;
  readonly tokenCount: number;
}

interface ItemFacts {
  readonly item: WorkloadItem;
  readonly candidates: readonly MemoryCandidate[];
  readonly byNodeId: ReadonlyMap<string, MemoryCandidate>;
  readonly headNodeId: string | null;
  readonly revisionNodeIds: readonly string[];
  readonly revokedNodeIds: ReadonlySet<string>;
  readonly revocationNoticeNodeIds: ReadonlySet<string>;
  readonly obsoleteNodeIds: ReadonlySet<string>;
  readonly promotedNodeIds: ReadonlySet<string>;
  readonly subagentNodeIds: readonly string[];
  readonly toolNodeIds: readonly string[];
  readonly askedProjectTokens: readonly string[];
  readonly contradictionPairs: readonly (readonly [string, string])[];
}

function estimatedTokens(content: string): number {
  return Math.ceil(Buffer.byteLength(content, 'utf8') / 4);
}

function wordTokens(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

function attributeLines(node: GroundTruthNode): readonly string[] {
  return Object.keys(node.attributes)
    .sort()
    .map((key) => `${key}: ${String(node.attributes[key] ?? '')}`);
}

/** Tags the re-ranker and the compiler can both key on. Deterministic and schema-safe. */
function tagsFor(
  storeClass: Exclude<MemoryStoreClass, 'working'>,
  nodeType: GroundTruthNodeType,
  family: WorkloadFamily
): readonly string[] {
  return [...new Set([storeClass, nodeType, family])].filter((tag) =>
    /^[a-z0-9][a-z0-9_-]{0,31}$/u.test(tag)
  );
}

/**
 * Projects one workload item's gold graph into the memory candidates a write stage
 * is offered.
 *
 * The projection is ARM-INDEPENDENT by construction: every arm is handed exactly the
 * same candidate list in exactly the same order, so a difference in what ends up
 * stored is a difference in write policy and nothing else. It reads only the
 * structural graph (types, edges, validity), never the `attack` or `distractor`
 * attributes — using those would let the harness defend an arm with gold labels the
 * arm could not possibly have.
 */
export function memoryCandidatesFor(generated: GeneratedWorkloadItem): readonly MemoryCandidate[] {
  const { item } = generated;
  const artifactById = new Map<string, WorkloadArtifact>(
    generated.artifacts.map((artifact) => [artifact.artifactId, artifact])
  );

  const sentAtByMessageId = new Map<string, string>();
  const sentAtByRealizedNodeId = new Map<string, string>();
  const textByMessageId = new Map<string, string>();
  for (const session of item.sessions) {
    for (const message of session.messages) {
      sentAtByMessageId.set(message.messageId, message.sentAt);
      textByMessageId.set(message.messageId, message.text);
      if (message.realizesNodeId !== null && !sentAtByRealizedNodeId.has(message.realizesNodeId)) {
        sentAtByRealizedNodeId.set(message.realizesNodeId, message.sentAt);
      }
    }
  }

  const firstSessionStart = item.sessions[0]?.startedAt ?? item.queryTime;
  const projectNodeIds = item.groundTruth.nodes
    .filter((node) => node.type === 'project')
    .map((node) => node.id);
  const primaryProjectNodeId = projectNodeIds[0] ?? null;

  const outgoing = new Map<string, GroundTruthEdgeType[]>();
  const adjacency = new Map<string, Set<string>>();
  const scopedProjectByNodeId = new Map<string, string>();
  const supersedesByNodeId = new Map<string, string>();
  const validityByNodeId = new Map<string, { from: string | null; to: string | null }>();
  const revokedBy = new Map<string, string>();
  for (const edge of item.groundTruth.edges) {
    const kinds = outgoing.get(edge.fromNodeId) ?? [];
    kinds.push(edge.type);
    outgoing.set(edge.fromNodeId, kinds);
    if (SUPPORT_EDGE_TYPES.includes(edge.type)) {
      const forward = adjacency.get(edge.fromNodeId) ?? new Set<string>();
      forward.add(edge.toNodeId);
      adjacency.set(edge.fromNodeId, forward);
      const backward = adjacency.get(edge.toNodeId) ?? new Set<string>();
      backward.add(edge.fromNodeId);
      adjacency.set(edge.toNodeId, backward);
    }
    if (edge.type === 'scoped_in' && projectNodeIds.includes(edge.toNodeId)) {
      scopedProjectByNodeId.set(edge.fromNodeId, edge.toNodeId);
    }
    if (edge.type === 'supersedes') {
      supersedesByNodeId.set(edge.fromNodeId, edge.toNodeId);
    }
    if (edge.type === 'valid_during') {
      validityByNodeId.set(edge.fromNodeId, { from: edge.validFrom, to: edge.validTo });
    }
    if (edge.type === 'revokes') {
      revokedBy.set(edge.toNodeId, edge.fromNodeId);
    }
  }

  const promotedNodeIds = new Set<string>();
  for (const edge of item.groundTruth.edges) {
    if (edge.type === 'promoted_to') promotedNodeIds.add(edge.fromNodeId);
    if (edge.type === 'approved_by') promotedNodeIds.add(edge.fromNodeId);
  }

  const recordedAtFor = (node: GroundTruthNode): string =>
    sentAtByMessageId.get(node.id) ??
    sentAtByRealizedNodeId.get(node.id) ??
    (typeof node.attributes.reference_anchor === 'string'
      ? node.attributes.reference_anchor
      : undefined) ??
    artifactById.get(node.id)?.recordedAt ??
    firstSessionStart;

  return item.groundTruth.nodes.map((node) => {
    const kind = NODE_TYPE_TO_KIND[node.type];
    const storeClass = kind === null ? null : storeClassForKind(kind);
    const scopedProject = scopedProjectByNodeId.get(node.id) ?? null;
    const scopeSide: 'own' | 'neighbour' =
      scopedProject !== null && scopedProject !== primaryProjectNodeId ? 'neighbour' : 'own';

    const artifact = artifactById.get(node.id);
    const recordedAt = recordedAtFor(node);
    const gold = validityByNodeId.get(node.id);
    const validFrom = gold?.from ?? recordedAt;
    const revocationSourceId = revokedBy.get(node.id);
    const revocationAt =
      revocationSourceId === undefined ? null : (sentAtByMessageId.get(revocationSourceId) ?? null);
    // A revocation ends validity at the moment it was uttered. Applied only when it
    // strictly follows the start: an inverted window is not a fact about the world,
    // it is an instrumentation bug, and writing it would fail the fragment contract.
    const candidateValidTo = gold?.to ?? revocationAt;
    const validTo =
      candidateValidTo !== null && Date.parse(candidateValidTo) > Date.parse(validFrom)
        ? candidateValidTo
        : (gold?.to ?? null);

    const bodyLines = [node.label, ...attributeLines(node)];
    const messageText = textByMessageId.get(node.id);
    if (messageText !== undefined) bodyLines.push(messageText);
    if (artifact !== undefined) bodyLines.push(artifact.title, artifact.body);
    const refuseAlways = node.type === 'secret' || kind === null;
    const content = refuseAlways
      ? `[refused] ${node.type} records are never persisted as memory content by this harness`
      : bodyLines.join('\n');

    const outgoingTypes = outgoing.get(node.id) ?? [];
    const grounded =
      node.type === 'message'
        ? outgoingTypes.some((type) => UTTERANCE_GROUNDING_EDGE_TYPES.includes(type))
        : node.type === 'artifact'
          ? outgoingTypes.includes('derived_from')
          : true;

    return {
      nodeId: node.id,
      nodeType: node.type,
      memoryId: `mem_${node.id}`,
      kind,
      storeClass,
      scopeSide,
      title: node.label.slice(0, 240),
      content,
      tags: storeClass === null ? [] : tagsFor(storeClass, node.type, item.family),
      recordedAt,
      validFrom,
      validTo,
      supersedesNodeId: supersedesByNodeId.get(node.id) ?? null,
      supportedBy: [...(adjacency.get(node.id) ?? new Set<string>())].sort(),
      grounded,
      promoted: promotedNodeIds.has(node.id),
      refuseAlways,
      tokenCount: estimatedTokens(content)
    };
  });
}

/**
 * The arm-independent gold facts the answer resolver and the scoring keys need.
 *
 * Everything here is read off the graph's STRUCTURE — supersession chains, revocation
 * edges, promotion approvals, node types — so nothing depends on a label the arms
 * could not see.
 */
export function itemFactsFor(generated: GeneratedWorkloadItem): ItemFacts {
  const { item } = generated;
  const candidates = memoryCandidatesFor(generated);
  const byNodeId = new Map(candidates.map((candidate) => [candidate.nodeId, candidate]));

  const supersededNodeIds = new Set(
    item.groundTruth.edges.filter((edge) => edge.type === 'supersedes').map((edge) => edge.toNodeId)
  );
  // The subject chain is identified by its canonical-value attribute rather than by an
  // id prefix: an id-shaped convention would break silently if the generator renamed
  // a node, and this reads the same property the generator uses to define the chain.
  const revisionNodes = item.groundTruth.nodes.filter(
    (node) =>
      node.attributes.canonical_value !== undefined && byNodeId.get(node.id)?.scopeSide === 'own'
  );
  const head =
    revisionNodes.find((node) => !supersededNodeIds.has(node.id)) ??
    revisionNodes[revisionNodes.length - 1] ??
    null;

  const revokedNodeIds = new Set(
    item.groundTruth.edges.filter((edge) => edge.type === 'revokes').map((edge) => edge.toNodeId)
  );
  const revocationNoticeNodeIds = new Set(
    item.groundTruth.nodes
      .filter(
        (node) =>
          node.attributes.revocation_request === true || node.attributes.deletion_request === true
      )
      .map((node) => node.id)
  );
  const obsoleteNodeIds = new Set(
    revisionNodes
      .filter(
        (node) =>
          node.attributes.status === 'superseded' ||
          node.attributes.status === 'revoked' ||
          revokedNodeIds.has(node.id)
      )
      .map((node) => node.id)
  );
  const promotedNodeIds = new Set(
    candidates.filter((candidate) => candidate.promoted).map((candidate) => candidate.nodeId)
  );

  const queryTokens = new Set(wordTokens(item.task.query));
  const askedProjectTokens = [
    ...new Set(
      item.groundTruth.nodes
        .filter((node) => node.type === 'project')
        .flatMap((node) => [
          ...wordTokens(String(node.attributes.display_name ?? '')),
          ...wordTokens(node.label)
        ])
        .filter((token) => queryTokens.has(token) && token.length > 2)
    )
  ].sort();

  const contradictionPairs = item.groundTruth.edges
    .filter(
      (edge) =>
        (edge.type === 'contradicts' || edge.type === 'supersedes') &&
        byNodeId.has(edge.fromNodeId) &&
        byNodeId.has(edge.toNodeId)
    )
    .map((edge) => [edge.fromNodeId, edge.toNodeId] as const);

  return {
    item,
    candidates,
    byNodeId,
    headNodeId: head === null ? null : head.id,
    revisionNodeIds: revisionNodes.map((node) => node.id),
    revokedNodeIds,
    revocationNoticeNodeIds,
    obsoleteNodeIds,
    promotedNodeIds,
    subagentNodeIds: item.groundTruth.nodes
      .filter((node) => node.type === 'subagent')
      .map((node) => node.id),
    toolNodeIds: item.groundTruth.nodes
      .filter((node) => node.type === 'tool')
      .map((node) => node.id),
    askedProjectTokens,
    contradictionPairs
  };
}

// --- Physical placement -----------------------------------------------------

/**
 * The scopes and sleeves an item occupies in the real database.
 *
 * The workload's LOGICAL scope (`client:acme_corp` / `project:atlas`) cannot be used
 * verbatim: the access model derives a sleeve's kind from its namespace and requires
 * it to match its owner scope's kind, and two items may draw the same project name
 * under different clients, which a primary key cannot hold. Physical ids are therefore
 * namespaced per item, while the run log and the scoring alignments keep the LOGICAL
 * ids — those are what "the sleeve this content belongs to" means to a scope metric.
 */
interface ItemPlacement {
  readonly clientScopeId: string;
  readonly clientScopeKind: string;
  readonly clientScopeSubject: string;
  /** Where retrieval and compilation happen. */
  readonly retrievalScopeId: string;
  /** Where local writes land before promotion; equal to the retrieval sleeve unless gated. */
  readonly localScopeId: string;
  readonly neighbourScopeId: string;
  readonly logicalSleeveId: string;
  readonly logicalNeighbourSleeveId: string;
}

function placementFor(item: WorkloadItem, promotionGated: boolean): ItemPlacement {
  const [kind, subject] = item.ownerScopeId.split(':');
  if (kind === undefined || subject === undefined) {
    throw new BenchRunError(`Item '${item.itemId}' has an unparseable owner scope`, {
      ownerScopeId: item.ownerScopeId
    });
  }
  const retrievalScopeId = `project:${item.itemId}`;
  return {
    clientScopeId: item.ownerScopeId,
    clientScopeKind: kind,
    clientScopeSubject: subject,
    retrievalScopeId,
    localScopeId: promotionGated ? `project:${item.itemId}_local` : retrievalScopeId,
    neighbourScopeId: `project:${item.itemId}_nbr`,
    logicalSleeveId: item.sleeveId,
    logicalNeighbourSleeveId: `${item.sleeveId}-neighbour`
  };
}

// --- Write planning ---------------------------------------------------------

interface PlannedWrite {
  readonly candidate: MemoryCandidate;
  readonly memoryId: string;
  readonly physicalScopeId: string;
  readonly logicalSleeveId: string;
  readonly accepted: boolean;
  readonly rejectionReason: string | null;
  readonly storeClass: MemoryStoreClass | null;
  readonly validUntil: string | null;
  readonly supersedesMemoryId: string | null;
  /** True when this row lands in the sleeve retrieval reads from. */
  readonly retrievable: boolean;
  /** True when this row is an operator-approved upward promotion. */
  readonly promotion: boolean;
}

/** Whether the arm records validity windows and supersession links at write time. */
function armWritesTemporalEvents(spec: ArmSpec): boolean {
  return spec.forgettingPolicy === 'validity_expiry';
}

/** Whether the arm routes writes into CoALA store classes rather than one table. */
function armRoutesByStore(spec: ArmSpec): boolean {
  return spec.writePolicy !== 'single_table';
}

/**
 * Turns the shared candidate list into one arm's write plan.
 *
 * The provenance gate (ungrounded utterance, unprovenanced artifact) is applied by
 * every arm EXCEPT FlatTag. That asymmetry is the arm table's `single_table` write
 * policy taken literally: the control persists the history verbatim into one store
 * with no routing and no admission rule, which is exactly why it is the control the
 * typed arms have to beat, and exactly why injected utterances and uncountersigned
 * drafts become durable memory on it.
 */
function planWrites(
  spec: ArmSpec,
  candidates: readonly MemoryCandidate[],
  placement: ItemPlacement
): readonly PlannedWrite[] {
  const promotionGated = spec.scopePolicy === 'approved_bundles';
  const temporal = armWritesTemporalEvents(spec);
  const routed = armRoutesByStore(spec);
  const applyProvenanceGate = spec.writePolicy !== 'single_table';

  const plans: PlannedWrite[] = [];
  for (const candidate of candidates) {
    const neighbour = candidate.scopeSide === 'neighbour';
    const logicalSleeveId = neighbour
      ? placement.logicalNeighbourSleeveId
      : placement.logicalSleeveId;

    const rejection = ((): string | null => {
      if (candidate.refuseAlways) return 'secret_or_cast_node_never_persisted';
      if (applyProvenanceGate && !candidate.grounded) {
        return candidate.nodeType === 'artifact'
          ? 'unprovenanced_artifact_refused'
          : 'ungrounded_utterance_refused';
      }
      if (spec.writePolicy === 'episodes_only' && candidate.storeClass !== 'episodic') {
        return 'non_episodic_excluded_by_write_policy';
      }
      if (spec.writePolicy === 'extraction_only' && candidate.storeClass === 'episodic') {
        return 'episodic_excluded_by_extraction_policy';
      }
      return null;
    })();

    if (rejection !== null) {
      plans.push({
        candidate,
        memoryId: candidate.memoryId,
        physicalScopeId: neighbour ? placement.neighbourScopeId : placement.localScopeId,
        logicalSleeveId,
        accepted: false,
        rejectionReason: rejection,
        storeClass: routed ? candidate.storeClass : null,
        validUntil: null,
        supersedesMemoryId: null,
        retrievable: false,
        promotion: false
      });
      continue;
    }

    const validUntil = temporal ? candidate.validTo : null;
    const supersedesMemoryId =
      temporal && candidate.supersedesNodeId !== null ? `mem_${candidate.supersedesNodeId}` : null;
    const localScopeId = neighbour ? placement.neighbourScopeId : placement.localScopeId;
    // Under a promotion gate the LOCAL row is the subordinate copy and carries a
    // distinct id, so the parent sleeve's canonical id stays free for the approved
    // promotion. Without the gate the local sleeve IS the retrieval sleeve.
    const localMemoryId =
      promotionGated && !neighbour ? `${candidate.memoryId}.local` : candidate.memoryId;
    plans.push({
      candidate,
      memoryId: localMemoryId,
      physicalScopeId: localScopeId,
      logicalSleeveId,
      accepted: true,
      rejectionReason: null,
      storeClass: routed ? candidate.storeClass : null,
      validUntil,
      supersedesMemoryId:
        promotionGated && !neighbour && supersedesMemoryId !== null
          ? `${supersedesMemoryId}.local`
          : supersedesMemoryId,
      retrievable: !promotionGated && !neighbour,
      promotion: false
    });

    if (promotionGated && !neighbour && candidate.promoted) {
      plans.push({
        candidate,
        memoryId: candidate.memoryId,
        physicalScopeId: placement.retrievalScopeId,
        logicalSleeveId,
        accepted: true,
        rejectionReason: null,
        storeClass: routed ? candidate.storeClass : null,
        validUntil,
        supersedesMemoryId: null,
        retrievable: true,
        promotion: true
      });
    }
  }
  return plans;
}

// --- Deterministic latency model -------------------------------------------

interface StageWork {
  readonly acceptedWrites: number;
  readonly refusedWrites: number;
  readonly maintenanceEvents: number;
  readonly consolidationProposals: number;
  readonly retrievedCandidates: number;
  readonly indexQueries: number;
  readonly expansions: number;
  readonly compiledItems: number;
  readonly compiledTokens: number;
}

/**
 * The bench's latency measure: counted WORK UNITS, not wall-clock milliseconds.
 *
 * The program requires three reruns to replay byte-identically, and a wall-clock
 * reading cannot satisfy that on any machine. So latency is modelled from the work an
 * arm actually did — rows written, candidates ranked, items compiled, tokens
 * assembled — which is the part of cost that is a property of the ARCHITECTURE rather
 * than of which core the OS happened to schedule. Real elapsed time is measured
 * separately and reported outside every fingerprint.
 */
function latencyFor(work: StageWork): StageLatency {
  const writeMs = work.acceptedWrites * 2 + work.refusedWrites;
  // A consolidation proposal costs maintenance work even though it changes nothing:
  // proposal-only consolidation is not free, and an arm that pays for it must show
  // the cost next to whatever accuracy it buys.
  const maintenanceMs = work.maintenanceEvents + work.consolidationProposals;
  const retrievalMs = 4 * work.indexQueries + work.retrievedCandidates + work.expansions * 2;
  const compilationMs = 1 + work.compiledItems + Math.ceil(work.compiledTokens / 64);
  const generationMs = 0;
  return {
    writeMs,
    maintenanceMs,
    retrievalMs,
    compilationMs,
    generationMs,
    // One fixed unit of harness overhead keeps the total strictly above the staged
    // sum, which is what the contract's stage-latency invariant requires.
    totalMs: writeMs + maintenanceMs + retrievalMs + compilationMs + generationMs + 1
  };
}

// --- Answer resolution ------------------------------------------------------

export type BenchAbstentionReason =
  | 'revocation_notice_in_context'
  | 'no_subject_record_in_context'
  | 'decisive_record_revoked'
  | 'question_out_of_compiled_scope';

interface ResolvedOutput {
  readonly abstained: boolean;
  readonly abstentionReason: BenchAbstentionReason | null;
  readonly answerSha256: string | null;
  readonly actionTraceSha256: string | null;
  readonly decisiveNodeId: string | null;
  readonly correct: boolean;
}

const ABSTENTION_ANSWER_SHA256 = sha256('memory_bench:abstained');

function goldOutcomeHash(item: WorkloadItem): { answer: string | null; trace: string | null } {
  const expected = item.task.expected;
  switch (expected.mode) {
    case 'exact_answer':
      return { answer: expected.answerSha256, trace: null };
    case 'structured_state':
      return { answer: expected.stateSha256, trace: null };
    case 'action_trace':
      return { answer: null, trace: expected.actionTraceSha256 };
    case 'abstain':
      return { answer: null, trace: null };
  }
}

/**
 * The fixed answer function. Held identical across every arm, so the ONLY thing that
 * varies is what each arm's memory put into the compiled context.
 *
 * It abstains on four grounds, in order: a revocation notice reached the context; no
 * record of the subject reached it at all; the record it would have used was itself
 * revoked; or the question names a project the compiled evidence does not. Otherwise
 * it answers, and the answer is CORRECT exactly when the record it used is the
 * current one — a superseded revision produces a distinct, deterministic wrong hash.
 *
 * Reaching for the gold hash on success is the oracle-checker construction, not a
 * shortcut: the bench measures whether the right memory arrived, and inventing a
 * language model to re-derive a string the harness already knows would add noise to
 * the measurement without adding information.
 */
function resolveOutput(facts: ItemFacts, compiled: readonly MemoryCandidate[]): ResolvedOutput {
  const gold = goldOutcomeHash(facts.item);
  const abstain = (reason: BenchAbstentionReason): ResolvedOutput => ({
    abstained: true,
    abstentionReason: reason,
    answerSha256: ABSTENTION_ANSWER_SHA256,
    actionTraceSha256: null,
    decisiveNodeId: null,
    correct: facts.item.task.expected.mode === 'abstain'
  });

  if (compiled.some((candidate) => facts.revocationNoticeNodeIds.has(candidate.nodeId))) {
    return abstain('revocation_notice_in_context');
  }
  const decisive = compiled.find((candidate) => facts.revisionNodeIds.includes(candidate.nodeId));
  if (decisive === undefined) return abstain('no_subject_record_in_context');
  if (facts.revokedNodeIds.has(decisive.nodeId)) return abstain('decisive_record_revoked');
  if (facts.askedProjectTokens.length > 0) {
    const decisiveTokens = new Set(wordTokens(decisive.content));
    if (!facts.askedProjectTokens.some((token) => decisiveTokens.has(token))) {
      return abstain('question_out_of_compiled_scope');
    }
  }

  const compiledNodeIds = new Set(compiled.map((candidate) => candidate.nodeId));
  const mode = facts.item.task.expected.mode;
  const structuralSupport =
    mode === 'structured_state'
      ? facts.subagentNodeIds.some((nodeId) => compiledNodeIds.has(nodeId))
      : mode === 'action_trace'
        ? facts.toolNodeIds.every((nodeId) => compiledNodeIds.has(nodeId))
        : true;
  const correct = decisive.nodeId === facts.headNodeId && structuralSupport;
  const wrongHash = sha256(`memory_bench:stale_answer:${decisive.nodeId}`);

  if (mode === 'action_trace') {
    return {
      abstained: false,
      abstentionReason: null,
      answerSha256: null,
      actionTraceSha256: correct ? (gold.trace ?? wrongHash) : wrongHash,
      decisiveNodeId: decisive.nodeId,
      correct
    };
  }
  return {
    abstained: false,
    abstentionReason: null,
    answerSha256: correct ? (gold.answer ?? wrongHash) : wrongHash,
    actionTraceSha256: null,
    decisiveNodeId: decisive.nodeId,
    correct
  };
}

// --- Retrieval policy -------------------------------------------------------

interface RetrievalOutcome {
  readonly ordered: readonly LexicalRetrievalItem[];
  readonly reasonById: ReadonlyMap<string, RetrievalReason>;
  readonly indexQueries: number;
  readonly expansions: number;
}

function storeClassOfItem(item: LexicalRetrievalItem): Exclude<MemoryStoreClass, 'working'> {
  return storeClassForKind(item.kind);
}

/**
 * Applies one arm's retrieval policy on top of the audited retrieval path.
 *
 * Every branch either uses a REAL repo mechanism (the temporal layer, the per-store
 * re-ranker, a second authorized query for graph expansion) or applies a real
 * restriction (store-class filtering, mixture interleaving). None of them can widen
 * what the access gate already returned: the gate runs first, and everything here can
 * only reorder or remove.
 */
async function retrieveForArm(
  spec: ArmSpec,
  system: MemorySystem,
  authorization: Readonly<Record<string, unknown>>,
  queryText: string,
  limit: number,
  expansionNodeIds: ReadonlySet<string>
): Promise<RetrievalOutcome> {
  const base = await system.retrieve({ authorization, text: queryText, limit });
  const reasonById = new Map<string, RetrievalReason>();
  const mark = (items: readonly LexicalRetrievalItem[], reason: RetrievalReason): void => {
    for (const item of items) if (!reasonById.has(item.id)) reasonById.set(item.id, reason);
  };

  switch (spec.retrievalPolicy) {
    case 'hybrid_lexical': {
      mark(base.items, 'lexical_bm25');
      return { ordered: base.items, reasonById, indexQueries: 1, expansions: 0 };
    }
    case 'per_store_merged': {
      // The real per-store re-ranker: `store-classes.ts` declares distinct FTS column
      // weights per CoALA store, and this is the pass that honours them.
      const ranking = rerankByStorePolicy({
        normalizedTerms: base.manifest.normalizedTerms,
        candidates: base.items
      });
      const byId = new Map(base.items.map((item) => [item.id, item]));
      const ordered = ranking.ranked
        .map((entry) => byId.get(entry.fragmentId))
        .filter((item): item is LexicalRetrievalItem => item !== undefined);
      mark(ordered, 'hybrid_fusion');
      return { ordered, reasonById, indexQueries: 1, expansions: 0 };
    }
    case 'time_aware_suppressed': {
      if (!(system instanceof TemporalHybridMemorySystem)) {
        throw new BenchRunError('time-aware retrieval requires the temporal backend');
      }
      const outcome = await system.retrieveTemporal({ authorization, text: queryText, limit });
      mark(outcome.result.items, 'temporal_filter');
      return { ordered: outcome.result.items, reasonById, indexQueries: 1, expansions: 0 };
    }
    case 'approved_bundles_only': {
      // The restriction is enforced by the access gate, not here: this sleeve only
      // ever received operator-approved promotions, so nothing else can be returned.
      mark(base.items, 'scope_bundle');
      return { ordered: base.items, reasonById, indexQueries: 1, expansions: 0 };
    }
    case 'graph_expanded_1hop': {
      mark(base.items, 'scope_bundle');
      const present = new Set(base.items.map((item) => item.id));
      const wanted = [...expansionNodeIds].map((nodeId) => `mem_${nodeId}`);
      // Expansion runs as a SECOND AUTHORIZED retrieval rather than a raw table read:
      // a graph overlay must never become a way around the scope gate.
      const expansionText = [...expansionNodeIds].sort().join(' ').slice(0, 1_000);
      let expansions = 0;
      let indexQueries = 1;
      const expanded: LexicalRetrievalItem[] = [];
      if (expansionText.trim().length >= 2) {
        indexQueries += 1;
        const second = await system.retrieve({
          authorization,
          text: expansionText,
          limit
        });
        for (const item of second.items) {
          if (present.has(item.id) || !wanted.includes(item.id)) continue;
          present.add(item.id);
          expanded.push(item);
          reasonById.set(item.id, 'graph_expansion');
          expansions += 1;
        }
      }
      // Exact rerank back down to the shared cap so the budget stays identical.
      const ordered = [...base.items, ...expanded].slice(0, limit);
      return { ordered, reasonById, indexQueries, expansions };
    }
    case 'episodes_only': {
      const ordered = base.items.filter((item) => storeClassOfItem(item) === 'episodic');
      mark(ordered, 'lexical_bm25');
      return { ordered, reasonById, indexQueries: 1, expansions: 0 };
    }
    case 'facts_only': {
      const ordered = base.items.filter((item) => storeClassOfItem(item) !== 'episodic');
      mark(ordered, 'lexical_bm25');
      return { ordered, reasonById, indexQueries: 1, expansions: 0 };
    }
    case 'query_mixed': {
      // The dual store's mixture: episodes and extracted items alternate so neither
      // form can consume the whole shared candidate cap.
      const episodes = base.items.filter((item) => storeClassOfItem(item) === 'episodic');
      const facts = base.items.filter((item) => storeClassOfItem(item) !== 'episodic');
      const ordered: LexicalRetrievalItem[] = [];
      for (let index = 0; index < Math.max(episodes.length, facts.length); index += 1) {
        const episode = episodes[index];
        const fact = facts[index];
        if (episode !== undefined) ordered.push(episode);
        if (fact !== undefined) ordered.push(fact);
      }
      mark(ordered, 'hybrid_fusion');
      return { ordered: ordered.slice(0, limit), reasonById, indexQueries: 1, expansions: 0 };
    }
  }
}

// --- Item execution ---------------------------------------------------------

interface ArmContext {
  readonly spec: ArmSpec;
  readonly system: MemorySystem;
  readonly access: AccessControlRepository;
  readonly clock: { now: string };
  readonly grantVersionsBySleeve: Map<string, GrantVersionSet>;
  readonly phaseId: ExperimentPhaseId;
  readonly datasetSplit: DatasetSplit;
  readonly retrievalK: number;
}

interface ItemExecution {
  readonly log: ArmRunLog;
  /**
   * NULL until the aggregation stage exists. Metrics in this program are defined
   * over a COHORT (rates, bounds, paired deltas), not over one item, so there is
   * no honest single-item bundle to put here — the previous `{} as MetricBundle`
   * cast asserted one anyway, which would have satisfied the compiler and then
   * handed `ExperimentLogRepository` an empty bundle whose hard-gate metrics read
   * as absent rather than as never-measured.
   */
  readonly metrics: MetricBundle | null;
  readonly compiledNodeIds: readonly string[];
  readonly executedToolNodeIds: readonly string[];
  readonly output: ResolvedOutput;
  readonly digest: string;
}

function authorizationFor(context: ArmContext, sleeveId: string): Record<string, unknown> {
  const grantVersions = context.grantVersionsBySleeve.get(sleeveId);
  if (grantVersions === undefined) {
    throw new BenchRunError(`No read grant provisioned for sleeve '${sleeveId}'`, { sleeveId });
  }
  return {
    sleeveId,
    expectedSleeveVersion: 1,
    expectedOwnerScopeVersion: 1,
    permission: 'read',
    purpose: BENCH_PURPOSE,
    sensitivity: BENCH_SENSITIVITY,
    grantVersions
  };
}

function toContextCandidate(item: LexicalRetrievalItem, rank: number): Record<string, unknown> {
  return {
    id: item.id,
    ownerScopeId: item.ownerScopeId,
    sleeveId: item.sleeveId,
    sourceId: item.sourceId,
    sourceHash: item.sourceHash,
    content: item.content,
    required: false,
    priority: 50,
    relevancePermille: Math.max(0, 1_000 - (rank - 1) * 40),
    confidencePermille: item.confidencePermille,
    recordedAt: item.recordedAt,
    coverageKeys: item.tags,
    retrievalEligible: item.retrievalEligible,
    expiresAt: item.expiresAt,
    supersededByFragmentId: item.supersededByFragmentId
  };
}

/** Deterministic id for one arm's pass over one item under one phase and split. */
function runIdFor(
  phaseId: ExperimentPhaseId,
  datasetSplit: DatasetSplit,
  armId: ExperimentArmId,
  itemId: string
): string {
  return `run_${sha256(canonicalJson({ phaseId, datasetSplit, armId, itemId })).slice(0, 40)}`;
}

/**
 * Replays one item end to end on one arm: write, maintain, retrieve, compile, answer.
 *
 * `persist` distinguishes the scored pass from the determinism REPLAY. Both do the
 * identical work against the identical database — durable writes are idempotent, so
 * the second pass genuinely re-executes rather than being short-circuited — and the
 * replay's digest is what `behavior.deterministicReplayRate` is computed from.
 */
async function executeItem(
  context: ArmContext,
  generated: GeneratedWorkloadItem,
  facts: ItemFacts,
  placement: ItemPlacement
): Promise<ItemExecution> {
  const { item } = generated;
  const spec = context.spec;
  const budget = FROZEN_FAIRNESS_BUDGET;
  const limit = Math.min(budget.candidateCap, MAX_RETRIEVAL_LIMIT);

  // --- Write stage ---------------------------------------------------------
  const plans = planWrites(spec, facts.candidates, placement);
  const writes: WriteLogEntry[] = [];
  const writtenById = new Map<string, PlannedWrite>();
  const seenContentHashes = new Set<string>();
  const duplicateMemoryIds = new Set<string>();
  context.clock.now = item.queryTime;

  for (const plan of plans) {
    if (plan.accepted && plan.candidate.kind !== null) {
      const contentHash = sha256(plan.candidate.content);
      if (seenContentHashes.has(contentHash)) duplicateMemoryIds.add(plan.memoryId);
      seenContentHashes.add(contentHash);
      await context.system.write({
        id: plan.memoryId,
        ownerScopeId: plan.physicalScopeId,
        sleeveId: plan.physicalScopeId,
        sourceId: `bench/${item.itemId}/${plan.candidate.nodeId}`,
        sourceHash: sha256(`${item.historyHash}:${plan.candidate.nodeId}`),
        extractionVersion: BENCH_EXTRACTION_VERSION,
        kind: plan.candidate.kind,
        title: plan.candidate.title,
        content: plan.candidate.content,
        tags: [...plan.candidate.tags],
        validFrom: plan.candidate.validFrom,
        validUntil: plan.validUntil,
        recordedAt: plan.candidate.recordedAt,
        confidencePermille: 900,
        sensitivity: BENCH_SENSITIVITY,
        supersedesFragmentId: plan.supersedesMemoryId,
        reviewAt: null,
        expiresAt: null,
        retrievalEligible: true
      });
      writtenById.set(plan.memoryId, plan);
    }
    writes.push({
      candidateId: plan.memoryId,
      accepted: plan.accepted,
      storeClass: plan.storeClass,
      ownerScopeId: placement.clientScopeId,
      targetSleeveId: plan.logicalSleeveId,
      sensitivity: BENCH_SENSITIVITY,
      supportedBy: [...plan.candidate.supportedBy],
      validityStart: plan.accepted ? plan.candidate.validFrom : null,
      validityEnd: plan.validUntil,
      supersedesMemoryId: plan.supersedesMemoryId,
      rejectionReason: plan.rejectionReason
    });
  }

  // --- Maintenance stage ---------------------------------------------------
  // Emitted only by arms that record temporal events. Every event is REVERSIBLE:
  // this substrate suppresses and supersedes, it never destroys, so an irreversible
  // maintenance error is not merely rare here — it is unreachable, and the metric
  // says so honestly instead of claiming a defence the design did not implement.
  const maintenance: MaintenanceLogEntry[] = [];
  if (armWritesTemporalEvents(spec)) {
    for (const plan of plans) {
      if (!plan.accepted || !plan.retrievable) continue;
      if (plan.supersedesMemoryId !== null) {
        maintenance.push({
          eventId: `evt.supersede.${plan.memoryId}`,
          kind: 'supersede',
          targetMemoryIds: [plan.supersedesMemoryId],
          sourceMemoryIds: [plan.memoryId],
          occurredAt: plan.candidate.validFrom,
          appliedBy: 'policy',
          reversible: true
        });
      }
      if (facts.revokedNodeIds.has(plan.candidate.nodeId) && plan.validUntil !== null) {
        maintenance.push({
          eventId: `evt.expire.${plan.memoryId}`,
          kind: 'expire',
          targetMemoryIds: [plan.memoryId],
          sourceMemoryIds: [],
          occurredAt: plan.validUntil,
          appliedBy: 'policy',
          reversible: true
        });
      }
      if (plan.promotion) {
        maintenance.push({
          eventId: `evt.promote.${plan.memoryId}`,
          kind: 'promote',
          targetMemoryIds: [plan.memoryId],
          sourceMemoryIds: [`${plan.memoryId}.local`],
          occurredAt: plan.candidate.recordedAt,
          appliedBy: 'operator',
          reversible: true
        });
      }
    }
  }

  // --- Retrieval stage -----------------------------------------------------
  const expansionNodeIds = new Set(
    facts.candidates
      .filter((candidate) => candidate.scopeSide === 'own' && candidate.supportedBy.length > 0)
      .flatMap((candidate) => candidate.supportedBy)
  );
  const retrieval = await retrieveForArm(
    spec,
    context.system,
    authorizationFor(context, placement.retrievalScopeId),
    item.task.query,
    limit,
    expansionNodeIds
  );
  const ordered = retrieval.ordered.slice(0, budget.candidateCap);
  const candidates: RetrievalCandidate[] = ordered.map((entry, index) => ({
    memoryId: entry.id,
    rank: index + 1,
    // The recorded score is the arm's own final ordering position. BM25 and the
    // per-store score are not comparable across policies, so publishing one of them
    // as "the" score would invite a comparison the numbers cannot support.
    score: ordered.length - index,
    reason: retrieval.reasonById.get(entry.id) ?? 'lexical_bm25'
  }));

  // --- Compilation stage ---------------------------------------------------
  const compilation: ScopedContextCompilation | null =
    ordered.length === 0
      ? null
      : context.system.compileContext({
          ownerScopeId: placement.retrievalScopeId,
          sleeveId: placement.retrievalScopeId,
          totalCapacityTokens: budget.compiledContextTokenCap,
          reservations: CONTEXT_RESERVATIONS,
          maxFragmentsPerSource: MAX_FRAGMENTS_PER_SOURCE,
          evaluatedAt: item.queryTime,
          fragments: ordered.map((entry, index) => toContextCandidate(entry, index + 1))
        });
  const compiledIds = compilation === null ? [] : compilation.selected.map((entry) => entry.id);
  const compiledTokens =
    compilation === null
      ? 0
      : compilation.selected.reduce((total, entry) => total + entry.estimatedTokens, 0);
  const truncated =
    compilation !== null &&
    (compilation.status === 'blocked' ||
      compilation.manifest.omitted.some(
        (omission) =>
          omission.reason === 'evidence_budget_exceeded' ||
          omission.reason === 'required_budget_exceeded' ||
          omission.reason === 'reservation_capacity_unavailable'
      ));

  const nodeIdByMemoryId = new Map<string, string>(
    plans.map((plan) => [plan.memoryId, plan.candidate.nodeId])
  );
  const compiledCandidates = compiledIds
    .map((memoryId) => {
      const nodeId = nodeIdByMemoryId.get(memoryId);
      return nodeId === undefined ? undefined : facts.byNodeId.get(nodeId);
    })
    .filter((candidate): candidate is MemoryCandidate => candidate !== undefined);

  // --- Answer stage --------------------------------------------------------
  const output = resolveOutput(facts, compiledCandidates);
  const compiledNodeIds = compiledCandidates.map((candidate) => candidate.nodeId);
  const executedToolNodeIds = facts.toolNodeIds.filter((nodeId) =>
    compiledNodeIds.includes(nodeId)
  );

  const contextSha256 = sha256(
    canonicalJson({
      compiled: compiledIds.map((memoryId) => [memoryId, nodeIdByMemoryId.get(memoryId) ?? null]),
      tokens: compiledTokens
    })
  );
  const latencyMs = latencyFor({
    acceptedWrites: writes.filter((entry) => entry.accepted).length,
    refusedWrites: writes.filter((entry) => !entry.accepted).length,
    maintenanceEvents: maintenance.length,
    // Structurally zero, NOT measured-as-zero: this replay harness runs no
    // consolidation pass, so no arm can propose. An arm whose policy declares
    // consolidation therefore has its maintenance cost UNDERSTATED here, and must
    // not be scored on maintenance until the pass exists. See `runMemoryBench`'s
    // skip contract in the module header.
    consolidationProposals: 0,
    retrievedCandidates: candidates.length,
    indexQueries: retrieval.indexQueries,
    expansions: retrieval.expansions,
    compiledItems: compiledIds.length,
    compiledTokens
  });
  const promptTokens = compiledTokens + estimatedTokens(item.task.query) + 64;
  const completionTokens = output.abstained ? 8 : 16;

  const log: ArmRunLog = {
    runId: runIdFor(context.phaseId, context.datasetSplit, spec.armId, item.itemId),
    phaseId: context.phaseId,
    armId: spec.armId,
    datasetSplit: context.datasetSplit,
    itemId: item.itemId,
    historyHash: item.historyHash,
    groundTruthHash: sha256(canonicalJson(item.groundTruth)),
    budget,
    llmCalls: 0,
    writes,
    maintenance,
    retrieval: {
      queryTime: item.queryTime,
      candidates,
      compiledContextIds: compiledIds
    },
    compiledContext: {
      tokenCount: compiledTokens,
      itemCount: compiledIds.length,
      contextSha256,
      truncated
    },
    output: {
      answerSha256: output.answerSha256,
      actionTraceSha256: output.actionTraceSha256,
      abstained: output.abstained
    },
    latencyMs,
    tokens: {
      compiledContextTokens: compiledTokens,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens
    }
  };

  return {
    log,
    metrics: null,
    compiledNodeIds,
    executedToolNodeIds,
    output,
    digest: sha256(
      canonicalJson({
        accepted: writes.filter((entry) => entry.accepted).map((entry) => entry.candidateId),
        candidates: candidates.map((entry) => entry.memoryId),
        compiled: compiledIds,
        contextSha256,
        answerSha256: output.answerSha256,
        actionTraceSha256: output.actionTraceSha256,
        abstained: output.abstained
      })
    ),
    ...{ duplicateMemoryIds: [...duplicateMemoryIds].sort() }
  };
}

export {};
