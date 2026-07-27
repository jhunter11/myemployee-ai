import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import SQLite from 'better-sqlite3';
import { z } from 'zod';

import {
  AUTHORITY_LAYERS,
  type AuthorityLayer,
  type GrantVersionSet
} from '../agents/access-control-contracts';
import {
  AccessControlRepository,
  type BoundAgentAccess
} from '../agents/access-control-repository';
import { createDatabase, type GlobalDatabaseContext } from '../db/database';
import type { ScopedContextCompilation } from '../knowledge/context-compiler';
import { MemoryFragmentRepository } from '../knowledge/memory-fragment-repository';
import type {
  LexicalRetrievalItem,
  LexicalRetrievalResult,
  RetrievalOmissionReason
} from '../knowledge/retrieval-contracts';
import { resolveEvidence, type EvidenceResolutionReason } from '../memory/demo/evidence-resolver';
import type { MemorySystem } from '../memory/system/contracts';
import { createMemorySystem } from '../memory/system/factory';
import { sha256 } from '../memory/system/hashing';
import {
  FACELESS_SHADOW_AGENT_ID,
  FACELESS_SHADOW_EVALUATED_AT,
  FACELESS_SHADOW_FRAGMENTS,
  FACELESS_SHADOW_NEIGHBOR_SCOPE_ID,
  FACELESS_SHADOW_NEIGHBOR_SLEEVE_ID,
  FACELESS_SHADOW_OWNER_SCOPE_ID,
  FACELESS_SHADOW_PURPOSE,
  FACELESS_SHADOW_QUESTIONS,
  FACELESS_SHADOW_RECORDED_AT,
  FACELESS_SHADOW_SLEEVE_ID,
  type FacelessShadowQuestion
} from './faceless-memory-shadow-fixture';

const FacelessMemoryShadowPilotInputSchema = z.strictObject({
  projectRoot: z.string().min(1).max(4_096)
});

type ShadowBackend = 'flat' | 'typed_hybrid';

/**
 * The shadow runner receives only these two operations. In particular, it cannot
 * call MemorySystem.write(), consolidation(), procedures(), or workingMemory().
 */
interface ShadowMemoryReadPort {
  readonly id: ShadowBackend;
  retrieve(query: unknown): Promise<LexicalRetrievalResult>;
  compileContext(input: unknown): ScopedContextCompilation;
}

export interface FacelessMemoryShadowCaseResult {
  readonly caseId: string;
  readonly category: FacelessShadowQuestion['category'];
  readonly retrievedFragmentIds: readonly string[];
  readonly omitted: readonly {
    fragmentId: string;
    reason: RetrievalOmissionReason;
  }[];
  readonly compiledFragmentIds: readonly string[];
  readonly outcome: 'answered' | 'abstained';
  readonly resolverReason: EvidenceResolutionReason;
  readonly selectedFragmentId: string | null;
  readonly recallCorrect: boolean;
  readonly answerCorrect: boolean;
  readonly expectedSuppressionsObserved: boolean;
  readonly scopeLeakageCount: number;
  readonly forbiddenSelectionCount: number;
}

export interface FacelessMemoryShadowArmResult {
  readonly backend: ShadowBackend;
  readonly cases: readonly FacelessMemoryShadowCaseResult[];
  readonly metrics: {
    readonly questionCount: number;
    readonly recallCorrectCount: number;
    readonly answerCorrectCount: number;
    readonly temporalCorrectCount: number;
    readonly temporalQuestionCount: number;
    readonly abstentionCorrectCount: number;
    readonly abstentionQuestionCount: number;
    readonly scopeLeakageCount: number;
    readonly forbiddenSelectionCount: number;
  };
  readonly fingerprint: string;
}

export interface FacelessMemoryShadowPilotReport {
  readonly fixtureStatus: 'scaffold';
  readonly livePromotionAuthorized: false;
  readonly evaluatedAt: string;
  readonly binding: {
    readonly agentId: string;
    readonly ownerScopeId: string;
    readonly sleeveId: string;
    readonly purpose: string;
    readonly sensitivity: 'confidential';
  };
  readonly storage: {
    readonly mode: 'ephemeral_temp_database';
    readonly controlReadOnly: boolean;
    readonly treatmentReadOnly: boolean;
    readonly exposedCapabilities: readonly ['retrieve', 'compileContext'];
  };
  readonly workingIsolation: {
    readonly runAEntryIds: readonly string[];
    readonly runBEntryIds: readonly string[];
    readonly passed: boolean;
  };
  readonly mutations: {
    readonly durableFingerprintBefore: string;
    readonly durableFingerprintAfter: string;
    readonly durableUnchanged: boolean;
    readonly consolidationCandidatesBefore: number;
    readonly consolidationCandidatesAfter: number;
    readonly procedureCandidatesBefore: number;
    readonly procedureCandidatesAfter: number;
    readonly sharedBundlesBefore: number;
    readonly sharedBundlesAfter: number;
    readonly workingRowsBefore: number;
    readonly workingRowsAfter: number;
  };
  readonly arms: readonly FacelessMemoryShadowArmResult[];
  readonly gates: {
    readonly retrievalConnectionsReadOnly: boolean;
    readonly zeroLeakage: boolean;
    readonly recallNonRegressed: boolean;
    readonly temporalNonRegressed: boolean;
    readonly abstentionNonRegressed: boolean;
    readonly durableMutationFree: boolean;
    readonly workingMemoryRunIsolated: boolean;
    readonly passed: boolean;
  };
  readonly fingerprint: string;
}

const CONTEXT_BUDGET = {
  totalCapacityTokens: 1_200,
  reservations: {
    output: 200,
    policy: 80,
    toolSchema: 60,
    workingState: 60,
    safety: 40
  },
  maxFragmentsPerSource: 2
} as const;

const DURABLE_TABLES = [
  'memory_fragments',
  'memory_consolidation_candidates',
  'memory_procedure_candidates',
  'shared_approved_bundles'
] as const;

interface DurableSnapshot {
  readonly fingerprint: string;
  readonly counts: Readonly<Record<(typeof DURABLE_TABLES)[number], number>>;
}

function createReadPort(system: MemorySystem): ShadowMemoryReadPort {
  if (system.id !== 'flat' && system.id !== 'typed_hybrid') {
    throw new Error(`Unsupported faceless shadow backend: ${system.id}`);
  }
  return Object.freeze({
    id: system.id,
    retrieve: (query: unknown) => system.retrieve(query),
    compileContext: (input: unknown) => system.compileContext(input)
  });
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

function durableSnapshot(sqlite: SQLite.Database): DurableSnapshot {
  const rows = Object.fromEntries(
    DURABLE_TABLES.map((table) => [
      table,
      sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid ASC`).all()
    ])
  ) as Record<(typeof DURABLE_TABLES)[number], unknown[]>;
  const counts = Object.fromEntries(
    DURABLE_TABLES.map((table) => [table, rows[table].length])
  ) as Record<(typeof DURABLE_TABLES)[number], number>;
  return {
    fingerprint: sha256(JSON.stringify(rows)),
    counts
  };
}

function rowCount(sqlite: SQLite.Database, table: 'working_memory'): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function openReadOnlyDatabase(filename: string): {
  sqlite: SQLite.Database;
  queryOnly: boolean;
} {
  const sqlite = new SQLite(filename, { readonly: true, fileMustExist: true });
  sqlite.pragma('query_only = ON');
  return {
    sqlite,
    queryOnly: Number(sqlite.pragma('query_only', { simple: true })) === 1
  };
}

async function provisionExactBinding(access: AccessControlRepository): Promise<{
  boundAccess: BoundAgentAccess;
  grantVersions: GrantVersionSet;
}> {
  await access.registerScope({
    id: 'agency:agency',
    kind: 'agency',
    subjectId: 'agency',
    parentScopeId: null,
    trustDomain: 'agency',
    createdAt: FACELESS_SHADOW_RECORDED_AT
  });
  await access.registerScope({
    id: FACELESS_SHADOW_OWNER_SCOPE_ID,
    kind: 'client',
    subjectId: 'creator_lab',
    parentScopeId: 'agency:agency',
    trustDomain: 'agency',
    createdAt: FACELESS_SHADOW_RECORDED_AT
  });
  await access.registerScope({
    id: FACELESS_SHADOW_NEIGHBOR_SCOPE_ID,
    kind: 'client',
    subjectId: 'neighbor_lab',
    parentScopeId: 'agency:agency',
    trustDomain: 'agency',
    createdAt: FACELESS_SHADOW_RECORDED_AT
  });
  await access.registerAgent({
    id: FACELESS_SHADOW_AGENT_ID,
    homeScopeId: FACELESS_SHADOW_OWNER_SCOPE_ID,
    trustDomain: 'agency',
    profileRevision: 1,
    createdAt: FACELESS_SHADOW_RECORDED_AT
  });
  await access.registerSleeve({
    id: FACELESS_SHADOW_SLEEVE_ID,
    ownerScopeId: FACELESS_SHADOW_OWNER_SCOPE_ID,
    maxSensitivity: 'confidential',
    expiresAt: null,
    createdAt: FACELESS_SHADOW_RECORDED_AT
  });
  await access.registerSleeve({
    id: FACELESS_SHADOW_NEIGHBOR_SLEEVE_ID,
    ownerScopeId: FACELESS_SHADOW_NEIGHBOR_SCOPE_ID,
    maxSensitivity: 'confidential',
    expiresAt: null,
    createdAt: FACELESS_SHADOW_RECORDED_AT
  });

  const versions = {} as Record<AuthorityLayer, number>;
  for (const layer of AUTHORITY_LAYERS) {
    const grant = await access.issueSleeveGrant({
      id: `sleeve-grant:faceless-content-shadow-read-${layer}`,
      agentId: FACELESS_SHADOW_AGENT_ID,
      sleeveId: FACELESS_SHADOW_SLEEVE_ID,
      authorityLayer: layer,
      permission: 'read',
      purpose: FACELESS_SHADOW_PURPOSE,
      sensitivityCap: 'confidential',
      expiresAt: '2027-07-25T18:00:00.000Z',
      expectedAgentVersion: 1,
      expectedScopeVersion: 1,
      expectedSleeveVersion: 1,
      issuedAt: FACELESS_SHADOW_RECORDED_AT
    });
    versions[layer] = grant.version;
  }
  return {
    grantVersions: versions,
    boundAccess: access.bindAgent({
      agentId: FACELESS_SHADOW_AGENT_ID,
      expectedAgentVersion: 1
    })
  };
}

function expectedSuppressionsObserved(
  question: FacelessShadowQuestion,
  retrieval: LexicalRetrievalResult
): boolean {
  return Object.entries(question.expectedSuppressions).every(([fragmentId, reason]) =>
    retrieval.manifest.omitted.some(
      (entry) => entry.fragmentId === fragmentId && entry.reason === reason
    )
  );
}

async function runArm(
  port: ShadowMemoryReadPort,
  grantVersions: GrantVersionSet
): Promise<FacelessMemoryShadowArmResult> {
  const cases: FacelessMemoryShadowCaseResult[] = [];
  for (const question of FACELESS_SHADOW_QUESTIONS) {
    const retrieval = await port.retrieve({
      authorization: {
        sleeveId: FACELESS_SHADOW_SLEEVE_ID,
        expectedSleeveVersion: 1,
        expectedOwnerScopeVersion: 1,
        permission: 'read',
        purpose: FACELESS_SHADOW_PURPOSE,
        sensitivity: 'confidential',
        grantVersions
      },
      text: question.text,
      limit: 5
    });
    const compilation =
      retrieval.items.length === 0
        ? null
        : port.compileContext({
            ownerScopeId: FACELESS_SHADOW_OWNER_SCOPE_ID,
            sleeveId: FACELESS_SHADOW_SLEEVE_ID,
            totalCapacityTokens: CONTEXT_BUDGET.totalCapacityTokens,
            reservations: CONTEXT_BUDGET.reservations,
            maxFragmentsPerSource: CONTEXT_BUDGET.maxFragmentsPerSource,
            evaluatedAt: FACELESS_SHADOW_EVALUATED_AT,
            fragments: retrieval.items.map(toContextCandidate)
          });
    const compiledFragmentIds =
      compilation?.selected.flatMap((fragment) => fragment.fragmentIds) ?? [];
    const resolution = resolveEvidence({
      normalizedTerms: retrieval.manifest.normalizedTerms,
      retrievedItems: retrieval.items,
      survivingFragmentIds: compiledFragmentIds
    });
    const retrievedIds = new Set(retrieval.items.map(({ id }) => id));
    const selectedFragmentId = resolution.selectedItem?.id ?? null;
    const scopeLeakageCount = retrieval.items.filter(
      (item) =>
        item.ownerScopeId !== FACELESS_SHADOW_OWNER_SCOPE_ID ||
        item.sleeveId !== FACELESS_SHADOW_SLEEVE_ID
    ).length;
    const forbiddenSelectionCount = question.forbiddenFragmentIds.filter((id) =>
      retrievedIds.has(id)
    ).length;
    const recallCorrect = question.expectedFragmentIds.every((id) => retrievedIds.has(id));
    const suppressionsObserved = expectedSuppressionsObserved(question, retrieval);
    const answerCorrect = question.expectAbstention
      ? selectedFragmentId === null
      : selectedFragmentId !== null && question.expectedFragmentIds.includes(selectedFragmentId);

    cases.push({
      caseId: question.id,
      category: question.category,
      retrievedFragmentIds: retrieval.items.map(({ id }) => id),
      omitted: retrieval.manifest.omitted.map(({ fragmentId, reason }) => ({
        fragmentId,
        reason
      })),
      compiledFragmentIds,
      outcome: selectedFragmentId === null ? 'abstained' : 'answered',
      resolverReason: resolution.reason,
      selectedFragmentId,
      recallCorrect,
      answerCorrect,
      expectedSuppressionsObserved: suppressionsObserved,
      scopeLeakageCount,
      forbiddenSelectionCount
    });
  }

  const temporalCases = cases.filter(({ category }) => category === 'temporal');
  const abstentionCaseIds = new Set(
    FACELESS_SHADOW_QUESTIONS.filter(({ expectAbstention }) => expectAbstention).map(({ id }) => id)
  );
  const metrics = {
    questionCount: cases.length,
    recallCorrectCount: cases.filter(
      (entry) =>
        entry.recallCorrect && entry.scopeLeakageCount === 0 && entry.forbiddenSelectionCount === 0
    ).length,
    answerCorrectCount: cases.filter(({ answerCorrect }) => answerCorrect).length,
    temporalCorrectCount: temporalCases.filter(
      (entry) =>
        entry.recallCorrect &&
        entry.answerCorrect &&
        entry.expectedSuppressionsObserved &&
        entry.scopeLeakageCount === 0 &&
        entry.forbiddenSelectionCount === 0
    ).length,
    temporalQuestionCount: temporalCases.length,
    abstentionCorrectCount: cases.filter(
      (entry) => abstentionCaseIds.has(entry.caseId) && entry.outcome === 'abstained'
    ).length,
    abstentionQuestionCount: abstentionCaseIds.size,
    scopeLeakageCount: cases.reduce((total, entry) => total + entry.scopeLeakageCount, 0),
    forbiddenSelectionCount: cases.reduce(
      (total, entry) => total + entry.forbiddenSelectionCount,
      0
    )
  };
  return {
    backend: port.id,
    cases,
    metrics,
    fingerprint: sha256(JSON.stringify({ backend: port.id, cases, metrics }))
  };
}

function nonRegressed(
  control: FacelessMemoryShadowArmResult,
  treatment: FacelessMemoryShadowArmResult,
  metric: 'recallCorrectCount' | 'temporalCorrectCount' | 'abstentionCorrectCount'
): boolean {
  return treatment.metrics[metric] >= control.metrics[metric];
}

/**
 * Runs the faceless pilot entirely against a synthetic temporary database. Corpus
 * setup is the only durable-fragment write. Retrieval arms use separate read-only
 * connections, and the typed arm is narrowed to retrieve/compile operations before
 * any evaluation code receives it.
 */
export async function runFacelessMemoryShadowPilot(
  rawInput: unknown
): Promise<FacelessMemoryShadowPilotReport> {
  const input = FacelessMemoryShadowPilotInputSchema.parse(rawInput);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-faceless-memory-shadow-'));
  const databaseFile = join(temporaryRoot, 'shadow.sqlite');
  let context: GlobalDatabaseContext | undefined;
  let controlSqlite: SQLite.Database | undefined;
  let treatmentSqlite: SQLite.Database | undefined;

  try {
    context = await createDatabase({ projectRoot: input.projectRoot, filename: databaseFile });
    const access = new AccessControlRepository(
      context.db,
      () => new Date(FACELESS_SHADOW_EVALUATED_AT)
    );
    const { boundAccess, grantVersions } = await provisionExactBinding(access);
    const fragments = new MemoryFragmentRepository(context.sqlite);
    for (const fragment of FACELESS_SHADOW_FRAGMENTS) await fragments.put(fragment);

    const durableBefore = durableSnapshot(context.sqlite);
    const workingRowsBefore = rowCount(context.sqlite, 'working_memory');
    const workingSystem = createMemorySystem({
      sqlite: context.sqlite,
      access: boundAccess,
      backend: 'typed_hybrid'
    });
    const working = workingSystem.workingMemory();
    if (working === null)
      throw new Error('Typed shadow treatment requires run-local working memory');
    await working.record({
      id: 'faceless-shadow-working-run-a',
      ownerScopeId: FACELESS_SHADOW_OWNER_SCOPE_ID,
      sleeveId: FACELESS_SHADOW_SLEEVE_ID,
      runId: 'faceless-run-a',
      slotKey: 'active_story',
      content: 'Run A is evaluating the Midnight Memo short story.',
      sensitivity: 'confidential',
      recordedAt: FACELESS_SHADOW_RECORDED_AT,
      expiresAt: '2026-07-26T18:00:00.000Z',
      supersedesEntryId: null
    });
    const runAWorking = await working.read({
      ownerScopeId: FACELESS_SHADOW_OWNER_SCOPE_ID,
      sleeveId: FACELESS_SHADOW_SLEEVE_ID,
      runId: 'faceless-run-a',
      slotKey: null,
      evaluatedAt: FACELESS_SHADOW_EVALUATED_AT,
      limit: 10
    });
    const runBWorking = await working.read({
      ownerScopeId: FACELESS_SHADOW_OWNER_SCOPE_ID,
      sleeveId: FACELESS_SHADOW_SLEEVE_ID,
      runId: 'faceless-run-b',
      slotKey: null,
      evaluatedAt: FACELESS_SHADOW_EVALUATED_AT,
      limit: 10
    });

    const controlReadOnly = openReadOnlyDatabase(databaseFile);
    const treatmentReadOnly = openReadOnlyDatabase(databaseFile);
    controlSqlite = controlReadOnly.sqlite;
    treatmentSqlite = treatmentReadOnly.sqlite;
    const controlPort = createReadPort(
      createMemorySystem({
        sqlite: controlSqlite,
        access: boundAccess,
        backend: 'flat'
      })
    );
    const treatmentPort = createReadPort(
      createMemorySystem({
        sqlite: treatmentSqlite,
        access: boundAccess,
        backend: 'typed_hybrid'
      })
    );
    const control = await runArm(controlPort, grantVersions);
    const treatment = await runArm(treatmentPort, grantVersions);
    const arms = [control, treatment] as const;

    const durableAfter = durableSnapshot(context.sqlite);
    const workingRowsAfter = rowCount(context.sqlite, 'working_memory');
    const durableUnchanged = durableAfter.fingerprint === durableBefore.fingerprint;
    const workingIsolation = {
      runAEntryIds: runAWorking.map(({ id }) => id),
      runBEntryIds: runBWorking.map(({ id }) => id),
      passed: runAWorking.length === 1 && runBWorking.length === 0
    };
    const zeroLeakage = arms.every(
      ({ metrics }) => metrics.scopeLeakageCount === 0 && metrics.forbiddenSelectionCount === 0
    );
    const gates = {
      retrievalConnectionsReadOnly: controlReadOnly.queryOnly && treatmentReadOnly.queryOnly,
      zeroLeakage,
      recallNonRegressed: nonRegressed(control, treatment, 'recallCorrectCount'),
      temporalNonRegressed: nonRegressed(control, treatment, 'temporalCorrectCount'),
      abstentionNonRegressed: nonRegressed(control, treatment, 'abstentionCorrectCount'),
      durableMutationFree: durableUnchanged,
      workingMemoryRunIsolated: workingIsolation.passed,
      passed: false
    };
    gates.passed =
      gates.retrievalConnectionsReadOnly &&
      gates.zeroLeakage &&
      gates.recallNonRegressed &&
      gates.temporalNonRegressed &&
      gates.abstentionNonRegressed &&
      gates.durableMutationFree &&
      gates.workingMemoryRunIsolated;

    const payload = {
      fixtureStatus: 'scaffold' as const,
      livePromotionAuthorized: false as const,
      evaluatedAt: FACELESS_SHADOW_EVALUATED_AT,
      binding: {
        agentId: FACELESS_SHADOW_AGENT_ID,
        ownerScopeId: FACELESS_SHADOW_OWNER_SCOPE_ID,
        sleeveId: FACELESS_SHADOW_SLEEVE_ID,
        purpose: FACELESS_SHADOW_PURPOSE,
        sensitivity: 'confidential' as const
      },
      storage: {
        mode: 'ephemeral_temp_database' as const,
        controlReadOnly: controlReadOnly.queryOnly,
        treatmentReadOnly: treatmentReadOnly.queryOnly,
        exposedCapabilities: ['retrieve', 'compileContext'] as const
      },
      workingIsolation,
      mutations: {
        durableFingerprintBefore: durableBefore.fingerprint,
        durableFingerprintAfter: durableAfter.fingerprint,
        durableUnchanged,
        consolidationCandidatesBefore: durableBefore.counts.memory_consolidation_candidates,
        consolidationCandidatesAfter: durableAfter.counts.memory_consolidation_candidates,
        procedureCandidatesBefore: durableBefore.counts.memory_procedure_candidates,
        procedureCandidatesAfter: durableAfter.counts.memory_procedure_candidates,
        sharedBundlesBefore: durableBefore.counts.shared_approved_bundles,
        sharedBundlesAfter: durableAfter.counts.shared_approved_bundles,
        workingRowsBefore,
        workingRowsAfter
      },
      arms,
      gates
    };
    return {
      ...payload,
      fingerprint: sha256(JSON.stringify(payload))
    };
  } finally {
    try {
      controlSqlite?.close();
    } finally {
      try {
        treatmentSqlite?.close();
      } finally {
        try {
          await context?.destroy();
        } finally {
          await rm(temporaryRoot, { recursive: true, force: true });
        }
      }
    }
  }
}
