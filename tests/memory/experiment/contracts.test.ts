import { describe, expect, it } from 'vitest';

import {
  ArmRunLogSchema,
  ArmSpecSchema,
  DIFFICULTY_TIERS,
  DIFFICULTY_TIER_BANDS,
  DifficultyVectorSchema,
  EXPERIMENT_ARMS,
  EXPERIMENT_ARM_IDS,
  EXPERIMENT_PHASES,
  EXPERIMENT_PHASE_IDS,
  ExperimentArmIdSchema,
  ExperimentBudgetMismatchError,
  ExperimentPhaseIdSchema,
  FROZEN_FAIRNESS_BUDGET,
  FROZEN_SAFETY_GATES,
  FROZEN_UTILITY_WEIGHTS_PERMILLE,
  GroundTruthGraphSchema,
  GroundTruthNodeSchema,
  METRIC_PATHS,
  METRIC_PATHS_ARE_EXHAUSTIVE,
  MVE_ARM_IDS,
  MemoryBudgetSchema,
  SafetyGateSetSchema,
  WORKLOAD_FAMILIES,
  WorkloadFamilySchema,
  WorkloadItemSchema,
  assertArmsShareBudget,
  difficultyTierForVector,
  difficultyVectorMatchesTier,
  evaluateSafetyGate,
  evaluateSafetyGates,
  findGroundTruthLeak,
  gateStatusFor,
  memoryBudgetMismatchFields,
  phaseAllowsDatasetSplit,
  readMetric,
  type ArmBudgetBinding,
  type DifficultyVector,
  type MemoryBudget,
  type MetricBundle,
  type SafetyGate
} from '../../../src/memory/experiment/contracts';

const OWNER_SCOPE_ID = 'client:acme_corp';
const SLEEVE_ID = 'client:acme_corp';
const ANSWER_HASH = 'b'.repeat(64);
const HISTORY_HASH = 'c'.repeat(64);
const GROUND_TRUTH_HASH = 'd'.repeat(64);
const CONTEXT_HASH = 'e'.repeat(64);
const ARGS_HASH = '1'.repeat(64);
const RESPONSE_HASH = '2'.repeat(64);

// --- fixtures ---------------------------------------------------------------

function groundTruthGraph(overrides: Record<string, unknown> = {}) {
  return {
    nodes: [
      { id: 'user_1', type: 'user', label: 'Primary user', attributes: {} },
      { id: 'op_1', type: 'operator', label: 'Reviewing operator', attributes: {} },
      { id: 'proj_alpha', type: 'project', label: 'Alpha migration', attributes: { active: true } },
      { id: 'evt_88', type: 'event', label: 'Budget agreed', attributes: { amount: 12000 } }
    ],
    edges: [
      {
        id: 'edge_1',
        type: 'scoped_in',
        fromNodeId: 'evt_88',
        toNodeId: 'proj_alpha',
        validFrom: '2026-03-01T00:00:00.000Z',
        validTo: null
      }
    ],
    ...overrides
  };
}

function workloadItem(overrides: Record<string, unknown> = {}) {
  return {
    itemId: 'hist_00421_task_07',
    family: 'project_state',
    tier: 'easy',
    ownerScopeId: OWNER_SCOPE_ID,
    sleeveId: SLEEVE_ID,
    sessions: [
      {
        sessionId: 'sess_1',
        ordinal: 0,
        startedAt: '2026-03-01T09:00:00.000Z',
        messages: [
          {
            messageId: 'msg_1',
            role: 'user',
            sentAt: '2026-03-01T09:00:00.000Z',
            text: 'We agreed the migration budget in the review call.',
            realizesNodeId: 'evt_88'
          }
        ]
      },
      {
        sessionId: 'sess_2',
        ordinal: 1,
        startedAt: '2026-03-04T09:00:00.000Z',
        messages: [
          {
            messageId: 'msg_2',
            role: 'assistant',
            sentAt: '2026-03-04T09:00:00.000Z',
            text: 'Noted. I will hold that figure for the migration.',
            realizesNodeId: null
          }
        ]
      }
    ],
    toolTrace: [
      {
        eventId: 'tev_1',
        sessionId: 'sess_1',
        ordinal: 0,
        toolId: 'calendar.search',
        argsSha256: ARGS_HASH,
        responseSha256: RESPONSE_HASH,
        occurredAt: '2026-03-01T09:05:00.000Z'
      }
    ],
    task: {
      query: 'What budget was agreed for the migration?',
      expected: {
        mode: 'exact_answer',
        answerSha256: ANSWER_HASH,
        evidence: [{ nodeId: 'evt_88', grade: 'primary' }]
      }
    },
    groundTruth: groundTruthGraph(),
    attackLabels: [
      {
        labelId: 'atk_1',
        family: 'similar_sleeve_distractor',
        injectedInSessionId: 'sess_2',
        targetNodeIds: ['evt_88'],
        mustNotSurfaceNodeIds: ['proj_alpha']
      }
    ],
    queryTime: '2026-03-18T14:00:00.000Z',
    historyHash: HISTORY_HASH,
    ...overrides
  };
}

function armRunLog(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run_0001',
    phaseId: 'representation_screening',
    armId: 'TypedTemporal',
    datasetSplit: 'synthetic_dev',
    itemId: 'hist_00421_task_07',
    historyHash: HISTORY_HASH,
    groundTruthHash: GROUND_TRUTH_HASH,
    budget: FROZEN_FAIRNESS_BUDGET,
    llmCalls: 1,
    writes: [
      {
        candidateId: 'w_001',
        accepted: true,
        storeClass: 'semantic',
        ownerScopeId: OWNER_SCOPE_ID,
        targetSleeveId: SLEEVE_ID,
        sensitivity: 'confidential',
        supportedBy: ['evt_88'],
        validityStart: '2026-03-01T00:00:00.000Z',
        validityEnd: null,
        supersedesMemoryId: null,
        rejectionReason: null
      }
    ],
    maintenance: [
      {
        eventId: 'mnt_1',
        kind: 'supersede',
        targetMemoryIds: ['m_12'],
        sourceMemoryIds: ['m_44'],
        occurredAt: '2026-03-04T09:10:00.000Z',
        appliedBy: 'policy',
        reversible: true
      }
    ],
    retrieval: {
      queryTime: '2026-03-18T14:00:00.000Z',
      candidates: [
        { memoryId: 'm_44', rank: 1, score: 0.92, reason: 'hybrid_fusion' },
        { memoryId: 'm_12', rank: 2, score: 0.51, reason: 'lexical_bm25' }
      ],
      compiledContextIds: ['m_44', 'm_12']
    },
    compiledContext: {
      tokenCount: 900,
      itemCount: 2,
      contextSha256: CONTEXT_HASH,
      truncated: false
    },
    output: { answerSha256: ANSWER_HASH, actionTraceSha256: null, abstained: false },
    latencyMs: {
      writeMs: 10,
      maintenanceMs: 5,
      retrievalMs: 40,
      compilationMs: 15,
      generationMs: 400,
      totalMs: 500
    },
    tokens: {
      compiledContextTokens: 900,
      promptTokens: 1_000,
      completionTokens: 100,
      totalTokens: 1_100
    },
    ...overrides
  };
}

function difficultyVector(overrides: Partial<DifficultyVector> = {}): DifficultyVector {
  return {
    sessionCount: 4,
    memoryAgeDays: 3,
    updateCount: 1,
    distractorCount: 2,
    sleeveCount: 1,
    agentCount: 1,
    reasoningDepth: 1,
    evidenceDispersion: 1,
    toolComplexity: 0,
    ...overrides
  };
}

function metricBundle(
  overrides: { energyJoules?: number | null; positionEffect?: number | null } = {}
): MetricBundle {
  return {
    write: {
      writePrecision: 0.9,
      writeRecall: 0.8,
      duplicateMemoryRate: 0.02,
      incorrectInferenceRate: 0.01,
      wrongSleeveWriteRate: 0,
      unsupportedMemoryRate: 0.03,
      consolidationDistortion: 0.05,
      procedureExtractionPrecision: 0.77
    },
    maintenance: {
      correctUpdateRate: 0.88,
      supersessionAccuracy: 0.85,
      deletionCompletion: 1,
      conflictDetectionRecall: 0.7,
      staleMemorySurvival: 0.04,
      promotionPrecision: 0.9,
      promotionRecall: 0.6,
      provenancePreservation: 0.98,
      severeIrreversibleErrorRate: 0
    },
    retrieval: {
      recallAtK: 0.75,
      precisionAtK: 0.4,
      meanReciprocalRank: 0.66,
      ndcgAtK: 0.71,
      scopeFilterCorrectness: 1,
      temporalFilterCorrectness: 0.93,
      distractorRetrievalRate: 0.12,
      unsupportedGraphExpansionRate: 0.05
    },
    compilation: {
      evidenceCoverage: 0.82,
      redundancy: 0.09,
      contradictionRate: 0.01,
      tokenUtilization: 0.64,
      relevantTokenDensity: 0.58,
      positionEffect: overrides.positionEffect ?? null,
      overflowFrequency: 0.03
    },
    behavior: {
      taskSuccess: 0.786,
      answerAccuracy: 0.79,
      toolExecutionAccuracy: 0.91,
      toolCallsPerSolvedTask: 2.4,
      policyCompliance: 1,
      abstentionCorrectness: 0.8,
      operatorCorrectionRate: 0.04,
      crossSleeveLeakage: 0.001,
      secretLeakage: 0,
      deterministicReplayRate: 1,
      latencyP50Ms: 620,
      latencyP95Ms: 1_400,
      costModelTokens: 1_820,
      costEmbeddingCalls: 12,
      costIndexQueries: 4,
      costGpuSeconds: 3.1,
      energyJoules: overrides.energyJoules ?? null
    }
  };
}

// --- arms -------------------------------------------------------------------

describe('experiment arms', () => {
  it('enumerates exactly the eight report arms and nothing else', () => {
    expect(EXPERIMENT_ARM_IDS).toEqual([
      'FlatTag',
      'TypedBasic',
      'TypedTemporal',
      'Hierarchical',
      'GraphAssist',
      'EpisodeOnly',
      'FactOnly',
      'HybridLedger'
    ]);
    expect(Object.keys(EXPERIMENT_ARMS).sort()).toEqual([...EXPERIMENT_ARM_IDS].sort());
    expect(ExperimentArmIdSchema.safeParse('GraphAssist').success).toBe(true);
    expect(ExperimentArmIdSchema.safeParse('Graph').success).toBe(false);
    expect(ExperimentArmIdSchema.safeParse('flatTag').success).toBe(false);
  });

  it('binds every arm spec to its key and to a real backend', () => {
    for (const armId of EXPERIMENT_ARM_IDS) {
      const spec = EXPERIMENT_ARMS[armId];
      expect(spec.armId).toBe(armId);
      expect(ArmSpecSchema.safeParse(spec).success).toBe(true);
    }
    expect(EXPERIMENT_ARMS.FlatTag.backend).toBe('flat');
    expect(EXPERIMENT_ARMS.TypedTemporal.backend).toBe('typed_temporal');
    expect(EXPERIMENT_ARMS.HybridLedger.backend).toBe('ledger');
  });

  it('gives every arm a distinct representation so an effect is attributable', () => {
    const representations = EXPERIMENT_ARM_IDS.map(
      (armId) => EXPERIMENT_ARMS[armId].representation
    );
    expect(new Set(representations).size).toBe(EXPERIMENT_ARM_IDS.length);
  });

  it('keeps automatic consolidation out of every screening arm', () => {
    for (const armId of EXPERIMENT_ARM_IDS) {
      expect(EXPERIMENT_ARMS[armId].consolidationPolicy).not.toBe('automatic');
    }
  });

  it('restricts the MVE to the four arms the report scopes for a solo developer', () => {
    expect(MVE_ARM_IDS).toEqual(['FlatTag', 'TypedBasic', 'TypedTemporal', 'Hierarchical']);
    for (const armId of MVE_ARM_IDS) {
      expect(EXPERIMENT_ARMS[armId]).toBeDefined();
    }
  });

  it('rejects an arm spec with an unknown policy value or an extra key', () => {
    const spec = { ...EXPERIMENT_ARMS.TypedBasic };
    expect(ArmSpecSchema.safeParse({ ...spec, retrievalPolicy: 'vibes' }).success).toBe(false);
    expect(ArmSpecSchema.safeParse({ ...spec, scopePolicy: 'allow_all' }).success).toBe(false);
    expect(ArmSpecSchema.safeParse({ ...spec, extraAxis: 'nope' }).success).toBe(false);
  });
});

// --- fairness budget --------------------------------------------------------

describe('fairness budget', () => {
  it('freezes the report MVE budget', () => {
    expect(FROZEN_FAIRNESS_BUDGET.candidateCap).toBe(24);
    expect(FROZEN_FAIRNESS_BUDGET.compiledContextTokenCap).toBe(1_200);
    expect(FROZEN_FAIRNESS_BUDGET.llmCallCap).toBe(1);
    expect(MemoryBudgetSchema.safeParse(FROZEN_FAIRNESS_BUDGET).success).toBe(true);
  });

  it('rejects malformed budgets', () => {
    expect(
      MemoryBudgetSchema.safeParse({ ...FROZEN_FAIRNESS_BUDGET, candidateCap: 0 }).success
    ).toBe(false);
    expect(
      MemoryBudgetSchema.safeParse({ ...FROZEN_FAIRNESS_BUDGET, candidateCap: 24.5 }).success
    ).toBe(false);
    expect(
      MemoryBudgetSchema.safeParse({ ...FROZEN_FAIRNESS_BUDGET, llmCallCap: -1 }).success
    ).toBe(false);
    expect(MemoryBudgetSchema.safeParse({ ...FROZEN_FAIRNESS_BUDGET, retryCap: 3 }).success).toBe(
      false
    );
  });

  it('accepts two arms that share a budget and reports no mismatch', () => {
    const left: ArmBudgetBinding = { armId: 'TypedBasic', budget: { ...FROZEN_FAIRNESS_BUDGET } };
    const right: ArmBudgetBinding = { armId: 'FlatTag', budget: { ...FROZEN_FAIRNESS_BUDGET } };
    expect(memoryBudgetMismatchFields(left.budget, right.budget)).toEqual([]);
    expect(() => assertArmsShareBudget(left, right)).not.toThrow();
  });

  it('fails closed when an arm was given a bigger budget, naming every differing field', () => {
    const generous: MemoryBudget = {
      ...FROZEN_FAIRNESS_BUDGET,
      candidateCap: 48,
      compiledContextTokenCap: 4_000
    };
    expect(memoryBudgetMismatchFields(FROZEN_FAIRNESS_BUDGET, generous)).toEqual([
      'candidateCap',
      'compiledContextTokenCap'
    ]);

    let thrown: unknown = null;
    try {
      assertArmsShareBudget(
        { armId: 'FlatTag', budget: FROZEN_FAIRNESS_BUDGET },
        { armId: 'GraphAssist', budget: generous }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExperimentBudgetMismatchError);
    expect(thrown).toMatchObject({
      code: 'EXPERIMENT_BUDGET_MISMATCH',
      statusCode: 409,
      mismatchedFields: ['candidateCap', 'compiledContextTokenCap']
    });
  });

  it('reports mismatches in a stable order regardless of argument order', () => {
    const other: MemoryBudget = {
      ...FROZEN_FAIRNESS_BUDGET,
      storeBytesCap: 1_048_576,
      llmCallCap: 2
    };
    expect(memoryBudgetMismatchFields(FROZEN_FAIRNESS_BUDGET, other)).toEqual([
      'llmCallCap',
      'storeBytesCap'
    ]);
    expect(memoryBudgetMismatchFields(other, FROZEN_FAIRNESS_BUDGET)).toEqual([
      'llmCallCap',
      'storeBytesCap'
    ]);
  });
});

// --- workload taxonomy ------------------------------------------------------

describe('workload taxonomy', () => {
  it('enumerates exactly the eight workload families', () => {
    expect(WORKLOAD_FAMILIES).toEqual([
      'person_state',
      'project_state',
      'cross_project',
      'tool_procedure',
      'update_control',
      'reasoning',
      'multi_agent',
      'adversarial'
    ]);
    for (const family of WORKLOAD_FAMILIES) {
      expect(WorkloadFamilySchema.safeParse(family).success).toBe(true);
    }
    expect(WorkloadFamilySchema.safeParse('personal_state').success).toBe(false);
  });

  it('rejects impossible difficulty vectors', () => {
    expect(DifficultyVectorSchema.safeParse(difficultyVector()).success).toBe(true);
    expect(DifficultyVectorSchema.safeParse(difficultyVector({ sleeveCount: 0 })).success).toBe(
      false
    );
    expect(DifficultyVectorSchema.safeParse(difficultyVector({ agentCount: 0 })).success).toBe(
      false
    );
    expect(DifficultyVectorSchema.safeParse(difficultyVector({ reasoningDepth: 0 })).success).toBe(
      false
    );
    expect(
      DifficultyVectorSchema.safeParse({ ...difficultyVector(), sessionCount: 4.5 }).success
    ).toBe(false);
  });

  it('classifies each tier from the same knob vector', () => {
    expect(difficultyTierForVector(difficultyVector())).toBe('easy');
    expect(
      difficultyTierForVector(
        difficultyVector({
          sessionCount: 10,
          sleeveCount: 2,
          updateCount: 3,
          distractorCount: 12,
          reasoningDepth: 2
        })
      )
    ).toBe('medium');
    expect(
      difficultyTierForVector(
        difficultyVector({
          sessionCount: 20,
          sleeveCount: 3,
          updateCount: 5,
          distractorCount: 60,
          agentCount: 2,
          reasoningDepth: 3
        })
      )
    ).toBe('hard');
    expect(
      difficultyTierForVector(
        difficultyVector({
          sessionCount: 40,
          sleeveCount: 5,
          updateCount: 9,
          distractorCount: 400,
          agentCount: 3,
          reasoningDepth: 5
        })
      )
    ).toBe('very_hard');
  });

  it('returns null for a vector that falls in a gap between tier bands', () => {
    // 6 sessions sits between the easy band (3-5) and the medium band (8-12).
    const gapVector = difficultyVector({ sessionCount: 6 });
    expect(difficultyTierForVector(gapVector)).toBeNull();
    for (const tier of DIFFICULTY_TIERS) {
      expect(difficultyVectorMatchesTier(gapVector, tier)).toBe(false);
    }
  });

  it('keeps the four tier bands disjoint on session count', () => {
    const bands = DIFFICULTY_TIERS.map((tier) => DIFFICULTY_TIER_BANDS[tier].sessionCount);
    for (let index = 1; index < bands.length; index += 1) {
      const previous = bands[index - 1];
      const current = bands[index];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      if (previous === undefined || current === undefined) continue;
      expect(current.min).toBeGreaterThan(previous.max);
    }
  });
});

// --- ground-truth graph -----------------------------------------------------

describe('ground-truth graph', () => {
  it('accepts a well-formed graph', () => {
    expect(GroundTruthGraphSchema.safeParse(groundTruthGraph()).success).toBe(true);
  });

  it('rejects an edge whose endpoint does not resolve to a node', () => {
    const danglingSource = groundTruthGraph({
      edges: [
        {
          id: 'edge_1',
          type: 'scoped_in',
          fromNodeId: 'evt_ghost',
          toNodeId: 'proj_alpha',
          validFrom: null,
          validTo: null
        }
      ]
    });
    const danglingTarget = groundTruthGraph({
      edges: [
        {
          id: 'edge_1',
          type: 'scoped_in',
          fromNodeId: 'evt_88',
          toNodeId: 'proj_ghost',
          validFrom: null,
          validTo: null
        }
      ]
    });
    const sourceResult = GroundTruthGraphSchema.safeParse(danglingSource);
    expect(sourceResult.success).toBe(false);
    if (!sourceResult.success) {
      expect(sourceResult.error.issues[0]?.message).toContain('evt_ghost');
    }
    expect(GroundTruthGraphSchema.safeParse(danglingTarget).success).toBe(false);
  });

  it('rejects duplicate node ids, duplicate edge ids, and self-edges', () => {
    const duplicateNode = groundTruthGraph();
    duplicateNode.nodes.push({
      id: 'evt_88',
      type: 'event',
      label: 'Duplicate',
      attributes: {}
    });
    expect(GroundTruthGraphSchema.safeParse(duplicateNode).success).toBe(false);

    const duplicateEdge = groundTruthGraph({
      edges: [
        {
          id: 'edge_1',
          type: 'scoped_in',
          fromNodeId: 'evt_88',
          toNodeId: 'proj_alpha',
          validFrom: null,
          validTo: null
        },
        {
          id: 'edge_1',
          type: 'observes',
          fromNodeId: 'user_1',
          toNodeId: 'evt_88',
          validFrom: null,
          validTo: null
        }
      ]
    });
    expect(GroundTruthGraphSchema.safeParse(duplicateEdge).success).toBe(false);

    const selfEdge = groundTruthGraph({
      edges: [
        {
          id: 'edge_1',
          type: 'supersedes',
          fromNodeId: 'evt_88',
          toNodeId: 'evt_88',
          validFrom: null,
          validTo: null
        }
      ]
    });
    expect(GroundTruthGraphSchema.safeParse(selfEdge).success).toBe(false);
  });

  it('forbids an approval that terminates anywhere but a human authority', () => {
    const laundered = groundTruthGraph({
      nodes: [
        ...groundTruthGraph().nodes,
        { id: 'agent_scout', type: 'subagent', label: 'Scout', attributes: {} }
      ],
      edges: [
        {
          id: 'edge_1',
          type: 'approved_by',
          fromNodeId: 'evt_88',
          toNodeId: 'agent_scout',
          validFrom: null,
          validTo: null
        }
      ]
    });
    expect(GroundTruthGraphSchema.safeParse(laundered).success).toBe(false);

    const operatorApproved = groundTruthGraph({
      edges: [
        {
          id: 'edge_1',
          type: 'approved_by',
          fromNodeId: 'evt_88',
          toNodeId: 'op_1',
          validFrom: null,
          validTo: null
        }
      ]
    });
    expect(GroundTruthGraphSchema.safeParse(operatorApproved).success).toBe(true);
  });

  it('requires a validity window on valid_during edges and forbids inverted intervals', () => {
    const missingStart = groundTruthGraph({
      edges: [
        {
          id: 'edge_1',
          type: 'valid_during',
          fromNodeId: 'evt_88',
          toNodeId: 'proj_alpha',
          validFrom: null,
          validTo: '2026-04-01T00:00:00.000Z'
        }
      ]
    });
    expect(GroundTruthGraphSchema.safeParse(missingStart).success).toBe(false);

    const inverted = groundTruthGraph({
      edges: [
        {
          id: 'edge_1',
          type: 'valid_during',
          fromNodeId: 'evt_88',
          toNodeId: 'proj_alpha',
          validFrom: '2026-04-01T00:00:00.000Z',
          validTo: '2026-03-01T00:00:00.000Z'
        }
      ]
    });
    expect(GroundTruthGraphSchema.safeParse(inverted).success).toBe(false);
  });

  it('keeps secret material out of secret nodes', () => {
    expect(
      GroundTruthNodeSchema.safeParse({
        id: 'sec_1',
        type: 'secret',
        label: 'CRM API token',
        attributes: { placeholder: 'TOKEN_SECRET_REDACTED' }
      }).success
    ).toBe(true);
    expect(
      GroundTruthNodeSchema.safeParse({
        id: 'sec_1',
        type: 'secret',
        label: 'CRM API token',
        attributes: {}
      }).success
    ).toBe(false);
    expect(
      GroundTruthNodeSchema.safeParse({
        id: 'sec_1',
        type: 'secret',
        label: 'CRM API token',
        attributes: { placeholder: 'TOKEN_SECRET_REDACTED', token: 'sk-live-1234' }
      }).success
    ).toBe(false);
  });

  it('rejects ground-truth ids that could collide with ordinary prose', () => {
    expect(
      GroundTruthNodeSchema.safeParse({
        id: 'budget',
        type: 'event',
        label: 'Budget',
        attributes: {}
      }).success
    ).toBe(false);
  });
});

// --- workload items ---------------------------------------------------------

describe('workload items', () => {
  it('accepts a complete item and parses deterministically', () => {
    const raw = workloadItem();
    const first = WorkloadItemSchema.parse(raw);
    const second = WorkloadItemSchema.parse(workloadItem());
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('rejects gold evidence that does not resolve to a ground-truth node', () => {
    const item = workloadItem({
      task: {
        query: 'What budget was agreed?',
        expected: {
          mode: 'exact_answer',
          answerSha256: ANSWER_HASH,
          evidence: [{ nodeId: 'evt_ghost', grade: 'primary' }]
        }
      }
    });
    const result = WorkloadItemSchema.safeParse(item);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('evt_ghost'))).toBe(true);
    }
  });

  it('rejects non-dense session ordinals and unknown tool-trace sessions', () => {
    const shuffled = workloadItem();
    const sessions = shuffled.sessions;
    const first = sessions[0];
    expect(first).toBeDefined();
    if (first !== undefined) first.ordinal = 5;
    expect(WorkloadItemSchema.safeParse(shuffled).success).toBe(false);

    expect(
      WorkloadItemSchema.safeParse(
        workloadItem({
          toolTrace: [
            {
              eventId: 'tev_1',
              sessionId: 'sess_missing',
              ordinal: 0,
              toolId: 'calendar.search',
              argsSha256: ARGS_HASH,
              responseSha256: RESPONSE_HASH,
              occurredAt: '2026-03-01T09:05:00.000Z'
            }
          ]
        })
      ).success
    ).toBe(false);
  });

  it('rejects tool-trace ordinals that do not strictly increase', () => {
    expect(
      WorkloadItemSchema.safeParse(
        workloadItem({
          toolTrace: [
            {
              eventId: 'tev_1',
              sessionId: 'sess_1',
              ordinal: 1,
              toolId: 'calendar.search',
              argsSha256: ARGS_HASH,
              responseSha256: RESPONSE_HASH,
              occurredAt: '2026-03-01T09:05:00.000Z'
            },
            {
              eventId: 'tev_2',
              sessionId: 'sess_1',
              ordinal: 1,
              toolId: 'calendar.search',
              argsSha256: ARGS_HASH,
              responseSha256: RESPONSE_HASH,
              occurredAt: '2026-03-01T09:06:00.000Z'
            }
          ]
        })
      ).success
    ).toBe(false);
  });

  it('refuses an item whose prompt text leaks a gold node id', () => {
    const leaky = workloadItem();
    const session = leaky.sessions[0];
    const message = session?.messages[0];
    expect(message).toBeDefined();
    if (message !== undefined) {
      message.text = 'We agreed the budget in evt_88, per the review call.';
    }
    const result = WorkloadItemSchema.safeParse(leaky);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('evt_88'))).toBe(true);
    }
  });

  it('refuses an item whose query leaks the gold answer hash', () => {
    expect(
      WorkloadItemSchema.safeParse(
        workloadItem({
          task: {
            query: `What budget was agreed? (answer ${ANSWER_HASH})`,
            expected: {
              mode: 'exact_answer',
              answerSha256: ANSWER_HASH,
              evidence: [{ nodeId: 'evt_88', grade: 'primary' }]
            }
          }
        })
      ).success
    ).toBe(false);
  });

  it('detects leaks only on whole id tokens, not on incidental substrings', () => {
    const forbidden = new Set(['evt_88', 'proj_alpha']);
    expect(findGroundTruthLeak('the budget was agreed', forbidden, [])).toBeNull();
    expect(findGroundTruthLeak('see evt_880 for context', forbidden, [])).toBeNull();
    expect(findGroundTruthLeak('see evt_88, then stop', forbidden, [])).toBe('evt_88');
    expect(findGroundTruthLeak(`hash ${ANSWER_HASH}`, forbidden, [ANSWER_HASH])).toBe(ANSWER_HASH);
  });

  it('rejects an abstention task that still claims primary evidence', () => {
    expect(
      WorkloadItemSchema.safeParse(
        workloadItem({
          task: {
            query: 'What is the neighbouring client budget?',
            expected: {
              mode: 'abstain',
              reason: 'out_of_scope',
              evidence: [{ nodeId: 'evt_88', grade: 'primary' }]
            }
          }
        })
      ).success
    ).toBe(false);

    expect(
      WorkloadItemSchema.safeParse(
        workloadItem({
          task: {
            query: 'What is the neighbouring client budget?',
            expected: { mode: 'abstain', reason: 'out_of_scope', evidence: [] }
          }
        })
      ).success
    ).toBe(true);
  });

  it('rejects duplicate gold evidence and attack labels pointing at unknown nodes', () => {
    expect(
      WorkloadItemSchema.safeParse(
        workloadItem({
          task: {
            query: 'What budget was agreed?',
            expected: {
              mode: 'exact_answer',
              answerSha256: ANSWER_HASH,
              evidence: [
                { nodeId: 'evt_88', grade: 'primary' },
                { nodeId: 'evt_88', grade: 'secondary' }
              ]
            }
          }
        })
      ).success
    ).toBe(false);

    expect(
      WorkloadItemSchema.safeParse(
        workloadItem({
          attackLabels: [
            {
              labelId: 'atk_1',
              family: 'memory_injection',
              injectedInSessionId: null,
              targetNodeIds: ['evt_ghost'],
              mustNotSurfaceNodeIds: []
            }
          ]
        })
      ).success
    ).toBe(false);
  });
});

// --- phases -----------------------------------------------------------------

describe('experiment phases', () => {
  it('enumerates exactly the six gated phases', () => {
    expect(EXPERIMENT_PHASE_IDS).toEqual([
      'harness_validation',
      'representation_screening',
      'confirmatory_comparison',
      'budget_ablation',
      'consolidation_forgetting',
      'hierarchy_privacy'
    ]);
    expect(Object.keys(EXPERIMENT_PHASES).sort()).toEqual([...EXPERIMENT_PHASE_IDS].sort());
    for (const phaseId of EXPERIMENT_PHASE_IDS) {
      const phase = EXPERIMENT_PHASES[phaseId];
      expect(phase.phaseId).toBe(phaseId);
      expect(phase.datasetSplits.length).toBeGreaterThan(0);
      expect(ExperimentPhaseIdSchema.safeParse(phaseId).success).toBe(true);
    }
    expect(ExperimentPhaseIdSchema.safeParse('pilot').success).toBe(false);
  });

  it('denies split pairings by default so screening cannot touch a holdout', () => {
    expect(phaseAllowsDatasetSplit('representation_screening', 'synthetic_dev')).toBe(true);
    expect(phaseAllowsDatasetSplit('representation_screening', 'synthetic_holdout')).toBe(false);
    expect(phaseAllowsDatasetSplit('representation_screening', 'real_shadow_holdout')).toBe(false);
    expect(phaseAllowsDatasetSplit('harness_validation', 'synthetic_micro')).toBe(true);
    expect(phaseAllowsDatasetSplit('harness_validation', 'synthetic_dev')).toBe(false);
    expect(phaseAllowsDatasetSplit('confirmatory_comparison', 'real_shadow_holdout')).toBe(true);
  });
});

// --- run logs ---------------------------------------------------------------

describe('arm run logs', () => {
  it('accepts a fully instrumented run and parses deterministically', () => {
    const first = ArmRunLogSchema.parse(armRunLog());
    const second = ArmRunLogSchema.parse(armRunLog());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('refuses a run that scored a split its phase may not touch', () => {
    expect(
      ArmRunLogSchema.safeParse(armRunLog({ datasetSplit: 'real_shadow_holdout' })).success
    ).toBe(false);
  });

  it('refuses a run that exceeded any frozen budget', () => {
    const overCandidates = armRunLog({
      budget: { ...FROZEN_FAIRNESS_BUDGET, candidateCap: 1 }
    });
    expect(ArmRunLogSchema.safeParse(overCandidates).success).toBe(false);

    expect(
      ArmRunLogSchema.safeParse(
        armRunLog({
          compiledContext: {
            tokenCount: 5_000,
            itemCount: 2,
            contextSha256: CONTEXT_HASH,
            truncated: false
          },
          tokens: {
            compiledContextTokens: 5_000,
            promptTokens: 6_000,
            completionTokens: 100,
            totalTokens: 6_100
          }
        })
      ).success
    ).toBe(false);

    expect(ArmRunLogSchema.safeParse(armRunLog({ llmCalls: 2 })).success).toBe(false);
  });

  it('refuses a compiled context that cites an item retrieval never returned', () => {
    const fabricated = armRunLog({
      retrieval: {
        queryTime: '2026-03-18T14:00:00.000Z',
        candidates: [{ memoryId: 'm_44', rank: 1, score: 0.92, reason: 'hybrid_fusion' }],
        compiledContextIds: ['m_44', 'm_99']
      },
      compiledContext: {
        tokenCount: 900,
        itemCount: 2,
        contextSha256: CONTEXT_HASH,
        truncated: false
      }
    });
    const result = ArmRunLogSchema.safeParse(fabricated);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('m_99'))).toBe(true);
    }
  });

  it('refuses candidate lists that violate the frozen rank/tie-break ordering', () => {
    expect(
      ArmRunLogSchema.safeParse(
        armRunLog({
          retrieval: {
            queryTime: '2026-03-18T14:00:00.000Z',
            candidates: [
              { memoryId: 'm_44', rank: 1, score: 0.4, reason: 'hybrid_fusion' },
              { memoryId: 'm_12', rank: 2, score: 0.9, reason: 'lexical_bm25' }
            ],
            compiledContextIds: []
          },
          compiledContext: {
            tokenCount: 0,
            itemCount: 0,
            contextSha256: CONTEXT_HASH,
            truncated: false
          },
          tokens: {
            compiledContextTokens: 0,
            promptTokens: 100,
            completionTokens: 10,
            totalTokens: 110
          }
        })
      ).success
    ).toBe(false);

    expect(
      ArmRunLogSchema.safeParse(
        armRunLog({
          retrieval: {
            queryTime: '2026-03-18T14:00:00.000Z',
            candidates: [
              { memoryId: 'm_44', rank: 1, score: 0.9, reason: 'hybrid_fusion' },
              { memoryId: 'm_44', rank: 2, score: 0.4, reason: 'lexical_bm25' }
            ],
            compiledContextIds: []
          },
          compiledContext: {
            tokenCount: 0,
            itemCount: 0,
            contextSha256: CONTEXT_HASH,
            truncated: false
          },
          tokens: {
            compiledContextTokens: 0,
            promptTokens: 100,
            completionTokens: 10,
            totalTokens: 110
          }
        })
      ).success
    ).toBe(false);
  });

  it('keeps stage accounting honest for latency, tokens, and context size', () => {
    expect(
      ArmRunLogSchema.safeParse(
        armRunLog({
          latencyMs: {
            writeMs: 10,
            maintenanceMs: 5,
            retrievalMs: 40,
            compilationMs: 15,
            generationMs: 400,
            totalMs: 100
          }
        })
      ).success
    ).toBe(false);

    expect(
      ArmRunLogSchema.safeParse(
        armRunLog({
          tokens: {
            compiledContextTokens: 900,
            promptTokens: 1_000,
            completionTokens: 100,
            totalTokens: 9_999
          }
        })
      ).success
    ).toBe(false);

    expect(
      ArmRunLogSchema.safeParse(
        armRunLog({
          compiledContext: {
            tokenCount: 900,
            itemCount: 7,
            contextSha256: CONTEXT_HASH,
            truncated: false
          }
        })
      ).success
    ).toBe(false);
  });

  it('refuses an abstention that still executed an action trace', () => {
    expect(
      ArmRunLogSchema.safeParse(
        armRunLog({
          output: { answerSha256: ANSWER_HASH, actionTraceSha256: ARGS_HASH, abstained: true }
        })
      ).success
    ).toBe(false);

    expect(
      ArmRunLogSchema.safeParse(
        armRunLog({ output: { answerSha256: null, actionTraceSha256: null, abstained: true } })
      ).success
    ).toBe(false);
  });

  it('records rejected writes with a reason but still allows unsupported accepted writes', () => {
    const rejectedWithoutReason = armRunLog({
      writes: [
        {
          candidateId: 'w_001',
          accepted: false,
          storeClass: 'semantic',
          ownerScopeId: OWNER_SCOPE_ID,
          targetSleeveId: SLEEVE_ID,
          sensitivity: 'confidential',
          supportedBy: ['evt_88'],
          validityStart: null,
          validityEnd: null,
          supersedesMemoryId: null,
          rejectionReason: null
        }
      ]
    });
    expect(ArmRunLogSchema.safeParse(rejectedWithoutReason).success).toBe(false);

    // An accepted write with no supporting evidence is a MEASURED failure mode
    // (unsupported-memory rate), so the log must be able to represent it.
    const unsupported = armRunLog({
      writes: [
        {
          candidateId: 'w_001',
          accepted: true,
          storeClass: null,
          ownerScopeId: OWNER_SCOPE_ID,
          targetSleeveId: SLEEVE_ID,
          sensitivity: 'confidential',
          supportedBy: [],
          validityStart: null,
          validityEnd: null,
          supersedesMemoryId: null,
          rejectionReason: null
        }
      ]
    });
    expect(ArmRunLogSchema.safeParse(unsupported).success).toBe(true);
  });
});

// --- metrics and gates ------------------------------------------------------

describe('metric surface', () => {
  it('addresses every declared metric exactly once', () => {
    expect(METRIC_PATHS_ARE_EXHAUSTIVE).toBe(true);
    expect(new Set(METRIC_PATHS).size).toBe(METRIC_PATHS.length);
    expect(METRIC_PATHS.length).toBe(49);
  });

  it('resolves every metric path against a fully filled bundle', () => {
    const bundle = metricBundle({ energyJoules: 42, positionEffect: -0.03 });
    for (const path of METRIC_PATHS) {
      const value = readMetric(bundle, path);
      expect(value).not.toBeNull();
      expect(Number.isFinite(value ?? Number.NaN)).toBe(true);
    }
    expect(readMetric(bundle, 'behavior.taskSuccess')).toBe(0.786);
    expect(readMetric(bundle, 'compilation.positionEffect')).toBe(-0.03);
  });

  it('reports an uncomputed optional metric as null rather than as zero', () => {
    const sparse = metricBundle();
    expect(readMetric(sparse, 'compilation.positionEffect')).toBeNull();
    expect(readMetric(sparse, 'behavior.energyJoules')).toBeNull();
    expect(readMetric(sparse, 'behavior.secretLeakage')).toBe(0);
  });
});

describe('safety gates', () => {
  it('freezes a valid, unique gate set covering leakage, integrity, and replay', () => {
    expect(SafetyGateSetSchema.safeParse(FROZEN_SAFETY_GATES).success).toBe(true);
    expect(FROZEN_SAFETY_GATES.map((gate) => gate.metric)).toContain('behavior.secretLeakage');
    expect(FROZEN_SAFETY_GATES.map((gate) => gate.metric)).toContain('write.wrongSleeveWriteRate');
    expect(SafetyGateSetSchema.safeParse([]).success).toBe(false);
    expect(
      SafetyGateSetSchema.safeParse([...FROZEN_SAFETY_GATES, FROZEN_SAFETY_GATES[0]]).success
    ).toBe(false);
  });

  it('passes an arm inside every bound and fails one that exceeds a bound', () => {
    const outcomes = evaluateSafetyGates(FROZEN_SAFETY_GATES, 'TypedTemporal', metricBundle());
    expect(outcomes.every((outcome) => outcome.passed)).toBe(true);
    expect(gateStatusFor(outcomes)).toBe('pass');

    const leaky = metricBundle();
    const breached: MetricBundle = {
      ...leaky,
      behavior: { ...leaky.behavior, crossSleeveLeakage: 0.02 }
    };
    const failedOutcomes = evaluateSafetyGates(FROZEN_SAFETY_GATES, 'FlatTag', breached);
    expect(gateStatusFor(failedOutcomes)).toBe('fail');
    const leakageOutcome = failedOutcomes.find(
      (outcome) => outcome.gateId === 'gate:cross_sleeve_leakage'
    );
    expect(leakageOutcome).toMatchObject({
      passed: false,
      reason: 'bound_exceeded',
      observed: 0.02
    });
  });

  it('fails a gate whose metric was never computed', () => {
    const gate: SafetyGate = {
      id: 'gate:energy_budget',
      metric: 'behavior.energyJoules',
      bound: 500,
      comparator: 'lte'
    };
    const outcome = evaluateSafetyGate(gate, 'TypedBasic', metricBundle());
    expect(outcome).toMatchObject({ passed: false, reason: 'metric_missing', observed: null });

    const measured = evaluateSafetyGate(gate, 'TypedBasic', metricBundle({ energyJoules: 100 }));
    expect(measured).toMatchObject({ passed: true, reason: 'within_bound', observed: 100 });
  });

  it('honors the gte comparator on the deterministic-replay gate', () => {
    const bundle = metricBundle();
    const flaky: MetricBundle = {
      ...bundle,
      behavior: { ...bundle.behavior, deterministicReplayRate: 0.99 }
    };
    const outcomes = evaluateSafetyGates(FROZEN_SAFETY_GATES, 'GraphAssist', flaky);
    const replay = outcomes.find((outcome) => outcome.gateId === 'gate:deterministic_replay');
    expect(replay).toMatchObject({ passed: false, reason: 'bound_exceeded' });
    expect(gateStatusFor(outcomes)).toBe('fail');
  });

  it('evaluates gates in a stable order regardless of input order', () => {
    const bundle = metricBundle();
    const forward = evaluateSafetyGates(FROZEN_SAFETY_GATES, 'TypedTemporal', bundle);
    const reversed = evaluateSafetyGates(
      [...FROZEN_SAFETY_GATES].reverse(),
      'TypedTemporal',
      bundle
    );
    expect(forward).toEqual(reversed);
    expect(forward.map((outcome) => outcome.gateId)).toEqual(
      [...forward.map((outcome) => outcome.gateId)].sort()
    );
  });

  it('treats an empty gate set as a failure rather than as safety', () => {
    expect(gateStatusFor([])).toBe('fail');
  });
});

describe('utility weights', () => {
  it('sums the frozen weights to exactly one in permille arithmetic', () => {
    const total = Object.values(FROZEN_UTILITY_WEIGHTS_PERMILLE).reduce(
      (sum, weight) => sum + weight,
      0
    );
    expect(total).toBe(1_000);
    expect(FROZEN_UTILITY_WEIGHTS_PERMILLE.task_success).toBe(350);
  });
});
