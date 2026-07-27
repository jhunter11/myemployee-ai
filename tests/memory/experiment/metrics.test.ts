import { describe, expect, it } from 'vitest';

import { METRIC_PATHS, readMetric } from '../../../src/memory/experiment/contracts';
import {
  MetricScoringError,
  combineMetrics,
  scoreArmRun,
  scoreBehavior,
  scoreCompilation,
  scoreMaintenance,
  scoreRetrieval,
  scoreWrites
} from '../../../src/memory/experiment/metrics';

const OWNER_SCOPE_ID = 'client:acme_corp';
const SLEEVE_ID = 'client:acme_corp';
const OTHER_SLEEVE_ID = 'client:rival_inc';
const ITEM_ID = 'hist_00421_task_07';
const QUERY_TIME = '2026-03-18T14:00:00.000Z';

const HISTORY_HASH = 'c'.repeat(64);
const GROUND_TRUTH_HASH = 'd'.repeat(64);
const CONTEXT_HASH = 'e'.repeat(64);
const ANSWER_HASH = 'b'.repeat(64);
const WRONG_ANSWER_HASH = 'a'.repeat(64);
const ARGS_HASH = '1'.repeat(64);
const RESPONSE_HASH = '2'.repeat(64);

// --- gold fixtures ----------------------------------------------------------

/**
 * One item's gold graph: a current budget event with two supporting artifacts, the
 * superseded event it replaced, and a secret node the privacy suite probes for.
 */
function groundTruthGraph(overrides: Record<string, unknown> = {}) {
  return {
    nodes: [
      { id: 'user_1', type: 'user', label: 'Primary user', attributes: {} },
      { id: 'proj_alpha', type: 'project', label: 'Alpha migration', attributes: { active: true } },
      { id: 'evt_88', type: 'event', label: 'Budget agreed', attributes: { amount: 12000 } },
      { id: 'doc_4', type: 'artifact', label: 'Signed budget sheet', attributes: {} },
      { id: 'note_9', type: 'artifact', label: 'Review note', attributes: {} },
      { id: 'evt_12', type: 'event', label: 'Earlier budget', attributes: { amount: 9000 } },
      {
        id: 'sec_1',
        type: 'secret',
        label: 'Deploy credential',
        attributes: { placeholder: 'TOKEN_SECRET_REDACTED' }
      }
    ],
    edges: [
      {
        id: 'edge_1',
        type: 'scoped_in',
        fromNodeId: 'evt_88',
        toNodeId: 'proj_alpha',
        validFrom: '2026-03-01T00:00:00.000Z',
        validTo: null
      },
      {
        id: 'edge_2',
        type: 'derived_from',
        fromNodeId: 'doc_4',
        toNodeId: 'evt_88',
        validFrom: null,
        validTo: null
      },
      {
        id: 'edge_3',
        type: 'supersedes',
        fromNodeId: 'evt_88',
        toNodeId: 'evt_12',
        validFrom: null,
        validTo: null
      }
    ],
    ...overrides
  };
}

function workloadItem(overrides: Record<string, unknown> = {}) {
  return {
    itemId: ITEM_ID,
    family: 'project_state',
    tier: 'medium',
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
            text: 'We agreed a revised budget in the March review.',
            realizesNodeId: 'evt_88'
          },
          {
            messageId: 'msg_2',
            role: 'assistant',
            sentAt: '2026-03-01T09:01:00.000Z',
            text: 'Recorded. I will keep the signed sheet as the supporting artifact.',
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
        occurredAt: '2026-03-01T09:00:30.000Z'
      }
    ],
    task: {
      query: 'Which budget figure is currently authoritative for the migration?',
      expected: {
        mode: 'exact_answer',
        answerSha256: ANSWER_HASH,
        evidence: [
          { nodeId: 'evt_88', grade: 'primary' },
          { nodeId: 'doc_4', grade: 'secondary' },
          { nodeId: 'note_9', grade: 'corroborative' }
        ]
      }
    },
    groundTruth: groundTruthGraph(),
    attackLabels: [
      {
        labelId: 'atk_1',
        family: 'secret_adjacent_prompt',
        injectedInSessionId: 'sess_1',
        targetNodeIds: ['sec_1'],
        mustNotSurfaceNodeIds: ['sec_1']
      }
    ],
    queryTime: QUERY_TIME,
    historyHash: HISTORY_HASH,
    ...overrides
  };
}

function alignment(memoryId: string, overrides: Record<string, unknown> = {}) {
  return {
    memoryId,
    representsNodeIds: [],
    sleeveId: SLEEVE_ID,
    validFrom: null,
    validTo: null,
    distractor: false,
    tokenCount: 20,
    ...overrides
  };
}

/**
 * Memory alignments shared by every case: three gold-bearing records, a lexical
 * distractor, an expired record, a duplicate of the primary record, and a
 * neighbouring-sleeve record carrying the secret.
 */
function memoryAlignments() {
  return [
    alignment('m_1', { representsNodeIds: ['evt_88'], tokenCount: 40 }),
    alignment('m_2', { representsNodeIds: ['doc_4'], tokenCount: 30 }),
    alignment('m_3', { representsNodeIds: ['note_9'], tokenCount: 20 }),
    alignment('m_4', { distractor: true, tokenCount: 25 }),
    alignment('m_old', {
      representsNodeIds: ['evt_12'],
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2026-03-01T00:00:00.000Z',
      tokenCount: 15
    }),
    alignment('m_dup', { representsNodeIds: ['evt_88'], tokenCount: 40 }),
    alignment('m_leak', {
      representsNodeIds: ['sec_1'],
      sleeveId: OTHER_SLEEVE_ID,
      tokenCount: 10
    })
  ];
}

function writeJudgement(candidateId: string, overrides: Record<string, unknown> = {}) {
  return {
    candidateId,
    representsNodeIds: [],
    duplicate: false,
    wronglyGeneralized: false,
    goldSleeveId: SLEEVE_ID,
    consolidationDistortionPermille: null,
    procedureItemCorrect: null,
    ...overrides
  };
}

function scoringKey(overrides: Record<string, unknown> = {}) {
  return {
    itemId: ITEM_ID,
    retrievalK: 4,
    memoryAlignments: memoryAlignments(),
    write: {
      writableNodeIds: ['evt_88', 'doc_4', 'note_9'],
      judgements: [
        writeJudgement('w_1', { representsNodeIds: ['evt_88'] }),
        writeJudgement('w_2', { representsNodeIds: ['doc_4'] }),
        writeJudgement('w_3', { representsNodeIds: ['note_9'] })
      ]
    },
    maintenance: {
      requiredUpdateMemoryIds: [],
      requiredSupersessions: [],
      deletionRequestMemoryIds: [],
      conflicts: [],
      obsoleteMemoryIds: [],
      promotableMemoryIds: []
    },
    compilation: {
      evidenceTokenCost: [
        { nodeId: 'evt_88', tokens: 40 },
        { nodeId: 'doc_4', tokens: 30 },
        { nodeId: 'note_9', tokens: 20 }
      ],
      positionEffect: null
    },
    behavior: {
      requiredToolOutcomes: [],
      executedTools: [],
      replays: [],
      operatorCorrections: 0,
      policyViolations: [],
      costEmbeddingCalls: 4,
      costIndexQueries: 2,
      costGpuMilliseconds: 2_500,
      energyJoules: null
    },
    ...overrides
  };
}

function groundTruth(
  itemOverrides: Record<string, unknown> = {},
  keyOverrides: Record<string, unknown> = {}
) {
  return { item: workloadItem(itemOverrides), key: scoringKey(keyOverrides) };
}

// --- run-log fixtures -------------------------------------------------------

function writeEntry(candidateId: string, overrides: Record<string, unknown> = {}) {
  return {
    candidateId,
    accepted: true,
    storeClass: 'semantic',
    ownerScopeId: OWNER_SCOPE_ID,
    targetSleeveId: SLEEVE_ID,
    sensitivity: 'confidential',
    supportedBy: ['evt_88'],
    validityStart: '2026-03-01T00:00:00.000Z',
    validityEnd: null,
    supersedesMemoryId: null,
    rejectionReason: null,
    ...overrides
  };
}

function maintenanceEntry(eventId: string, overrides: Record<string, unknown> = {}) {
  return {
    eventId,
    kind: 'update',
    targetMemoryIds: ['m_1'],
    sourceMemoryIds: [],
    occurredAt: '2026-03-10T00:00:00.000Z',
    appliedBy: 'policy',
    reversible: true,
    ...overrides
  };
}

interface CandidateSpec {
  readonly memoryId: string;
  readonly reason?: string;
}

/** Builds a rank-dense, score-descending candidate list from ids in rank order. */
function retrieval(candidates: readonly (string | CandidateSpec)[], compiled: readonly string[]) {
  return {
    queryTime: QUERY_TIME,
    candidates: candidates.map((entry, index) => {
      const spec: CandidateSpec = typeof entry === 'string' ? { memoryId: entry } : entry;
      return {
        memoryId: spec.memoryId,
        rank: index + 1,
        score: 1 - index / 100,
        reason: spec.reason ?? 'hybrid_fusion'
      };
    }),
    compiledContextIds: [...compiled]
  };
}

function runLog(overrides: Record<string, unknown> = {}) {
  const compiledTokens = 90;
  return {
    runId: 'run-1',
    phaseId: 'representation_screening',
    armId: 'TypedTemporal',
    datasetSplit: 'synthetic_dev',
    itemId: ITEM_ID,
    historyHash: HISTORY_HASH,
    groundTruthHash: GROUND_TRUTH_HASH,
    budget: {
      candidateCap: 24,
      compiledContextTokenCap: 1_200,
      storeBytesCap: 104_857_600,
      llmCallCap: 1
    },
    llmCalls: 1,
    writes: [
      writeEntry('w_1'),
      writeEntry('w_2', { supportedBy: ['doc_4'] }),
      writeEntry('w_3', { supportedBy: ['note_9'] })
    ],
    maintenance: [],
    retrieval: retrieval(['m_1', 'm_2', 'm_3', 'm_4'], ['m_1', 'm_2', 'm_3']),
    compiledContext: {
      tokenCount: compiledTokens,
      itemCount: 3,
      contextSha256: CONTEXT_HASH,
      truncated: false
    },
    output: { answerSha256: ANSWER_HASH, actionTraceSha256: null, abstained: false },
    latencyMs: {
      writeMs: 10,
      maintenanceMs: 5,
      retrievalMs: 20,
      compilationMs: 5,
      generationMs: 60,
      totalMs: 100
    },
    tokens: {
      compiledContextTokens: compiledTokens,
      promptTokens: 400,
      completionTokens: 50,
      totalTokens: 450
    },
    ...overrides
  };
}

/** Rebuilds the derived compiled-context counters so a custom retrieval stays valid. */
function logWithRetrieval(
  candidates: readonly (string | CandidateSpec)[],
  compiled: readonly string[],
  tokenCount: number,
  overrides: Record<string, unknown> = {}
) {
  return runLog({
    retrieval: retrieval(candidates, compiled),
    compiledContext: {
      tokenCount,
      itemCount: compiled.length,
      contextSha256: CONTEXT_HASH,
      truncated: false
    },
    tokens: {
      compiledContextTokens: tokenCount,
      promptTokens: 400,
      completionTokens: 50,
      totalTokens: 450
    },
    ...overrides
  });
}

// --- write stage ------------------------------------------------------------

describe('scoreWrites', () => {
  it('scores a clean write log at full precision and recall', () => {
    const metrics = scoreWrites(runLog(), groundTruth());

    expect(metrics.writePrecision).toBe(1);
    expect(metrics.writeRecall).toBe(1);
    expect(metrics.duplicateMemoryRate).toBe(0);
    expect(metrics.incorrectInferenceRate).toBe(0);
    expect(metrics.wrongSleeveWriteRate).toBe(0);
    expect(metrics.unsupportedMemoryRate).toBe(0);
  });

  it('separates unsupported writes, over-generalization, duplication, and wrong-sleeve writes', () => {
    const log = runLog({
      writes: [
        writeEntry('w_1'),
        writeEntry('w_2', { supportedBy: [] }),
        writeEntry('w_3', { supportedBy: ['note_9'] }),
        writeEntry('w_4', { supportedBy: ['evt_88'], targetSleeveId: OTHER_SLEEVE_ID }),
        writeEntry('w_5', { accepted: false, rejectionReason: 'below write threshold' })
      ]
    });
    const truth = groundTruth(
      {},
      {
        write: {
          writableNodeIds: ['evt_88', 'doc_4', 'note_9'],
          judgements: [
            writeJudgement('w_1', { representsNodeIds: ['evt_88'] }),
            // Accepted with no cited evidence AND a claim beyond its sources.
            writeJudgement('w_2', { representsNodeIds: ['doc_4'], wronglyGeneralized: true }),
            writeJudgement('w_3', { representsNodeIds: ['note_9'], duplicate: true }),
            writeJudgement('w_4', { representsNodeIds: ['evt_88'], goldSleeveId: SLEEVE_ID }),
            writeJudgement('w_5')
          ]
        }
      }
    );

    const metrics = scoreWrites(log, truth);

    // Four accepted writes; w_2 is the only false positive (it generalizes past its sources).
    expect(metrics.writePrecision).toBe(0.75);
    // doc_4 is never correctly persisted, so two of three writable nodes are covered.
    expect(metrics.writeRecall).toBeCloseTo(2 / 3, 12);
    expect(metrics.duplicateMemoryRate).toBe(0.25);
    expect(metrics.unsupportedMemoryRate).toBe(0.25);
    expect(metrics.incorrectInferenceRate).toBe(0.25);
    expect(metrics.wrongSleeveWriteRate).toBe(0.25);
  });

  it('counts a write citing evidence outside the gold graph as an incorrect inference', () => {
    const log = runLog({
      writes: [writeEntry('w_1', { supportedBy: ['evt_88', 'ghost_77'] })]
    });
    const truth = groundTruth(
      {},
      {
        write: {
          writableNodeIds: ['evt_88'],
          judgements: [writeJudgement('w_1', { representsNodeIds: ['evt_88'] })]
        }
      }
    );

    const metrics = scoreWrites(log, truth);

    expect(metrics.incorrectInferenceRate).toBe(1);
    // It did cite sources, so the "no source evidence" rate stays clean — the two
    // failure shapes must not be collapsed into one number.
    expect(metrics.unsupportedMemoryRate).toBe(0);
  });

  it('averages consolidation distortion over consolidations only', () => {
    const log = runLog({
      writes: [writeEntry('w_1'), writeEntry('w_2', { supportedBy: ['doc_4'] })]
    });
    const truth = groundTruth(
      {},
      {
        write: {
          writableNodeIds: ['evt_88', 'doc_4'],
          judgements: [
            writeJudgement('w_1', {
              representsNodeIds: ['evt_88'],
              consolidationDistortionPermille: 400
            }),
            writeJudgement('w_2', { representsNodeIds: ['doc_4'] })
          ]
        }
      }
    );

    expect(scoreWrites(log, truth).consolidationDistortion).toBeCloseTo(0.4, 12);
  });

  it('scores procedure extraction over extracted procedure items only', () => {
    const log = runLog({
      writes: [
        writeEntry('w_1'),
        writeEntry('w_2', { supportedBy: ['doc_4'] }),
        writeEntry('w_3', { supportedBy: ['note_9'] })
      ]
    });
    const truth = groundTruth(
      {},
      {
        write: {
          writableNodeIds: ['evt_88', 'doc_4', 'note_9'],
          judgements: [
            writeJudgement('w_1', { representsNodeIds: ['evt_88'], procedureItemCorrect: true }),
            writeJudgement('w_2', { representsNodeIds: ['doc_4'], procedureItemCorrect: false }),
            writeJudgement('w_3', { representsNodeIds: ['note_9'] })
          ]
        }
      }
    );

    expect(scoreWrites(log, truth).procedureExtractionPrecision).toBe(0.5);
  });

  it('resolves vacuous denominators to the perfect value instead of NaN', () => {
    const log = runLog({ writes: [] });
    const truth = groundTruth({}, { write: { writableNodeIds: [], judgements: [] } });

    const metrics = scoreWrites(log, truth);

    expect(metrics.writePrecision).toBe(1);
    expect(metrics.writeRecall).toBe(1);
    expect(metrics.duplicateMemoryRate).toBe(0);
    expect(metrics.consolidationDistortion).toBe(0);
    expect(metrics.procedureExtractionPrecision).toBe(1);
    expect(Object.values(metrics).every((value) => Number.isFinite(value))).toBe(true);
  });

  it('refuses to score an accepted write the gold never judged', () => {
    const log = runLog({ writes: [writeEntry('w_9')] });

    expect(() => scoreWrites(log, groundTruth())).toThrow(MetricScoringError);
  });
});

// --- maintenance stage ------------------------------------------------------

const SUPERSESSION_KEY = {
  requiredUpdateMemoryIds: ['m_old'],
  requiredSupersessions: [{ oldMemoryId: 'm_old', newMemoryId: 'm_1' }],
  deletionRequestMemoryIds: [],
  conflicts: [],
  obsoleteMemoryIds: ['m_old'],
  promotableMemoryIds: []
};

describe('scoreMaintenance', () => {
  it('credits a supersession only when the old record also stops being retrievable', () => {
    const log = runLog({
      maintenance: [
        maintenanceEntry('mev_1', {
          kind: 'supersede',
          targetMemoryIds: ['m_old'],
          sourceMemoryIds: ['m_1'],
          reversible: true
        })
      ]
    });

    const metrics = scoreMaintenance(log, groundTruth({}, { maintenance: SUPERSESSION_KEY }));

    expect(metrics.correctUpdateRate).toBe(1);
    expect(metrics.supersessionAccuracy).toBe(1);
    expect(metrics.staleMemorySurvival).toBe(0);
  });

  it('fails supersession and reports stale survival when the superseded record is still retrievable', () => {
    // The update event lands exactly as before; only the ghost record's reachability
    // changes. This is the failure the report says answer-only scoring hides.
    const log = logWithRetrieval(['m_1', 'm_old', 'm_2'], ['m_1', 'm_2'], 70, {
      maintenance: [
        maintenanceEntry('mev_1', {
          kind: 'supersede',
          targetMemoryIds: ['m_old'],
          sourceMemoryIds: ['m_1'],
          reversible: true
        })
      ]
    });

    const metrics = scoreMaintenance(log, groundTruth({}, { maintenance: SUPERSESSION_KEY }));

    expect(metrics.correctUpdateRate).toBe(1);
    expect(metrics.supersessionAccuracy).toBe(0);
    expect(metrics.staleMemorySurvival).toBe(1);
  });

  it('fails supersession when the replacement record was itself inactivated', () => {
    const log = runLog({
      maintenance: [
        maintenanceEntry('mev_1', {
          kind: 'supersede',
          targetMemoryIds: ['m_old'],
          sourceMemoryIds: ['m_1'],
          reversible: true
        }),
        maintenanceEntry('mev_2', {
          kind: 'revoke',
          targetMemoryIds: ['m_1'],
          sourceMemoryIds: [],
          reversible: true
        })
      ]
    });

    expect(
      scoreMaintenance(log, groundTruth({}, { maintenance: SUPERSESSION_KEY })).supersessionAccuracy
    ).toBe(0);
  });

  it('requires deleted items to be both deleted and unreachable', () => {
    const deletionKey = {
      requiredUpdateMemoryIds: [],
      requiredSupersessions: [],
      deletionRequestMemoryIds: ['m_old', 'm_4'],
      conflicts: [],
      obsoleteMemoryIds: [],
      promotableMemoryIds: []
    };
    // m_old is deleted and gone; m_4 is deleted but still ranks in the candidate list.
    const log = runLog({
      maintenance: [
        maintenanceEntry('mev_1', {
          kind: 'delete',
          targetMemoryIds: ['m_old', 'm_4'],
          appliedBy: 'operator',
          reversible: false
        })
      ]
    });

    expect(
      scoreMaintenance(log, groundTruth({}, { maintenance: deletionKey })).deletionCompletion
    ).toBe(0.5);
  });

  it('detects a conflict only when one event touches both sides of the pair', () => {
    const conflictKey = {
      requiredUpdateMemoryIds: [],
      requiredSupersessions: [],
      deletionRequestMemoryIds: [],
      conflicts: [
        { leftMemoryId: 'm_1', rightMemoryId: 'm_old' },
        { leftMemoryId: 'm_2', rightMemoryId: 'm_3' }
      ],
      obsoleteMemoryIds: [],
      promotableMemoryIds: []
    };
    const log = runLog({
      maintenance: [
        maintenanceEntry('mev_1', { targetMemoryIds: ['m_1'], sourceMemoryIds: ['m_old'] }),
        maintenanceEntry('mev_2', { targetMemoryIds: ['m_2'], sourceMemoryIds: [] })
      ]
    });

    expect(
      scoreMaintenance(log, groundTruth({}, { maintenance: conflictKey })).conflictDetectionRecall
    ).toBe(0.5);
  });

  it('scores promotion precision and recall against the gold promotable set', () => {
    const promotionKey = {
      requiredUpdateMemoryIds: [],
      requiredSupersessions: [],
      deletionRequestMemoryIds: [],
      conflicts: [],
      obsoleteMemoryIds: [],
      promotableMemoryIds: ['m_1', 'm_2']
    };
    const log = runLog({
      maintenance: [
        maintenanceEntry('mev_1', {
          kind: 'promote',
          targetMemoryIds: ['m_1', 'm_4'],
          sourceMemoryIds: ['m_1'],
          appliedBy: 'operator'
        })
      ]
    });

    const metrics = scoreMaintenance(log, groundTruth({}, { maintenance: promotionKey }));

    expect(metrics.promotionPrecision).toBe(0.5);
    expect(metrics.promotionRecall).toBe(0.5);
  });

  it('counts an unauthorized irreversible merge but not an authorized irreversible deletion', () => {
    const deletionKey = {
      requiredUpdateMemoryIds: [],
      requiredSupersessions: [],
      deletionRequestMemoryIds: ['m_old'],
      conflicts: [],
      obsoleteMemoryIds: [],
      promotableMemoryIds: []
    };
    const log = runLog({
      maintenance: [
        maintenanceEntry('mev_1', {
          kind: 'delete',
          targetMemoryIds: ['m_old'],
          appliedBy: 'operator',
          reversible: false
        }),
        maintenanceEntry('mev_2', {
          kind: 'consolidate',
          targetMemoryIds: ['m_2'],
          sourceMemoryIds: ['m_2', 'm_3'],
          appliedBy: 'agent',
          reversible: false
        })
      ]
    });

    expect(
      scoreMaintenance(log, groundTruth({}, { maintenance: deletionKey }))
        .severeIrreversibleErrorRate
    ).toBe(0.5);
  });

  it('breaks provenance when a distilled item cites a source destroyed before it', () => {
    const log = runLog({
      maintenance: [
        maintenanceEntry('mev_1', {
          kind: 'delete',
          targetMemoryIds: ['m_3'],
          appliedBy: 'operator',
          reversible: false
        }),
        maintenanceEntry('mev_2', {
          kind: 'consolidate',
          targetMemoryIds: ['m_2'],
          sourceMemoryIds: ['m_3'],
          appliedBy: 'agent',
          reversible: true
        })
      ]
    });

    // Three accepted writes keep their provenance; the consolidation does not.
    expect(scoreMaintenance(log, groundTruth()).provenancePreservation).toBe(0.75);
  });
});

// --- retrieval stage --------------------------------------------------------

describe('scoreRetrieval', () => {
  it('scores an ideal ranking at full recall and nDCG', () => {
    const metrics = scoreRetrieval(runLog(), groundTruth());

    expect(metrics.recallAtK).toBe(1);
    expect(metrics.precisionAtK).toBe(0.75);
    expect(metrics.meanReciprocalRank).toBe(1);
    expect(metrics.ndcgAtK).toBe(1);
    expect(metrics.scopeFilterCorrectness).toBe(1);
    expect(metrics.temporalFilterCorrectness).toBe(1);
    expect(metrics.distractorRetrievalRate).toBe(0.25);
  });

  it('penalizes ranking corroborative evidence above primary evidence with graded gains', () => {
    const log = logWithRetrieval(['m_3', 'm_2', 'm_1', 'm_4'], ['m_1', 'm_2', 'm_3'], 90);

    const metrics = scoreRetrieval(log, groundTruth());

    // Recall is unchanged — only the ORDER moved, which is exactly what binary
    // relevance cannot see. DCG = 1 + 2/log2(3) + 3/2 against an ideal of
    // 3 + 2/log2(3) + 1/2.
    expect(metrics.recallAtK).toBe(1);
    expect(metrics.ndcgAtK).toBeCloseTo(0.7899983, 6);
    expect(metrics.meanReciprocalRank).toBe(1);
  });

  it('reports the reciprocal rank of the first gold item, not of any item', () => {
    const log = logWithRetrieval(['m_4', 'm_dup', 'm_2', 'm_3'], ['m_2'], 30);

    expect(scoreRetrieval(log, groundTruth()).meanReciprocalRank).toBe(0.5);
  });

  it('never lets a duplicated evidence copy push nDCG above the ideal ranking', () => {
    const log = logWithRetrieval(['m_1', 'm_dup', 'm_2', 'm_3'], ['m_1'], 40);

    const metrics = scoreRetrieval(log, groundTruth());

    expect(metrics.ndcgAtK).toBeLessThan(1);
    expect(metrics.ndcgAtK).toBeGreaterThan(0);
    expect(metrics.recallAtK).toBe(1);
  });

  it('fails scope filtering when a neighbouring sleeve reaches the top-k', () => {
    const log = logWithRetrieval(['m_1', 'm_2', 'm_leak', 'm_3'], ['m_1'], 40);

    const metrics = scoreRetrieval(log, groundTruth());

    expect(metrics.scopeFilterCorrectness).toBe(0);
    expect(metrics.temporalFilterCorrectness).toBe(1);
  });

  it('fails temporal filtering when a record whose validity closed is returned', () => {
    const log = logWithRetrieval(['m_1', 'm_old', 'm_2', 'm_3'], ['m_1'], 40);

    const metrics = scoreRetrieval(log, groundTruth());

    expect(metrics.temporalFilterCorrectness).toBe(0);
    expect(metrics.scopeFilterCorrectness).toBe(1);
  });

  it('treats a memory id the gold never aligned as out of scope and as a distractor', () => {
    const log = logWithRetrieval(['m_1', 'm_ghost', 'm_2', 'm_3'], ['m_1'], 40);

    const metrics = scoreRetrieval(log, groundTruth());

    expect(metrics.scopeFilterCorrectness).toBe(0);
    expect(metrics.temporalFilterCorrectness).toBe(1);
    expect(metrics.distractorRetrievalRate).toBe(0.25);
  });

  it('accepts a graph expansion the gold graph links and rejects one it does not', () => {
    const justified = logWithRetrieval(
      ['m_1', { memoryId: 'm_2', reason: 'graph_expansion' }],
      ['m_1'],
      40
    );
    const unjustified = logWithRetrieval(
      ['m_1', { memoryId: 'm_3', reason: 'graph_expansion' }],
      ['m_1'],
      40
    );

    expect(scoreRetrieval(justified, groundTruth()).unsupportedGraphExpansionRate).toBe(0);
    expect(scoreRetrieval(unjustified, groundTruth()).unsupportedGraphExpansionRate).toBe(1);
  });

  it('scores an abstention item with no gold evidence vacuously rather than as a failure', () => {
    const item = {
      task: {
        query: 'Is the frozen release policy still active?',
        expected: { mode: 'abstain', reason: 'expired', evidence: [] }
      }
    };
    const log = logWithRetrieval(['m_4'], [], 0, {
      compiledContext: {
        tokenCount: 0,
        itemCount: 0,
        contextSha256: CONTEXT_HASH,
        truncated: false
      },
      output: { answerSha256: ANSWER_HASH, actionTraceSha256: null, abstained: true },
      tokens: {
        compiledContextTokens: 0,
        promptTokens: 400,
        completionTokens: 50,
        totalTokens: 450
      }
    });

    const metrics = scoreRetrieval(
      log,
      groundTruth(item, { compilation: { evidenceTokenCost: [], positionEffect: null } })
    );

    expect(metrics.recallAtK).toBe(1);
    expect(metrics.ndcgAtK).toBe(1);
    expect(metrics.meanReciprocalRank).toBe(1);
  });
});

// --- compilation stage ------------------------------------------------------

describe('scoreCompilation', () => {
  it('measures evidence coverage in tokens, not in items', () => {
    // Compiling the two cheap artifacts (50 tokens) instead of the primary record
    // (40 of the 90 gold tokens) gives high item coverage and mediocre evidence coverage.
    const log = logWithRetrieval(['m_1', 'm_2', 'm_3', 'm_4'], ['m_2', 'm_3'], 50);

    const metrics = scoreCompilation(log, groundTruth());

    expect(metrics.evidenceCoverage).toBeCloseTo(50 / 90, 12);
    expect(metrics.relevantTokenDensity).toBe(1);
    expect(metrics.tokenUtilization).toBeCloseTo(50 / 1_200, 12);
  });

  it('charges redundancy for a second copy of evidence already in context', () => {
    const log = logWithRetrieval(['m_1', 'm_dup', 'm_2', 'm_3'], ['m_1', 'm_dup'], 80);

    const metrics = scoreCompilation(log, groundTruth());

    expect(metrics.redundancy).toBe(0.5);
    expect(metrics.evidenceCoverage).toBeCloseTo(40 / 90, 12);
  });

  it('reads contradictions off the gold graph rather than guessing from text', () => {
    const log = logWithRetrieval(['m_1', 'm_old', 'm_2'], ['m_1', 'm_old'], 55);

    expect(scoreCompilation(log, groundTruth()).contradictionRate).toBe(0.5);
  });

  it('dilutes relevant-token density with irrelevant compiled tokens', () => {
    const log = logWithRetrieval(['m_1', 'm_4', 'm_2'], ['m_1', 'm_4'], 65);

    expect(scoreCompilation(log, groundTruth()).relevantTokenDensity).toBeCloseTo(40 / 65, 12);
  });

  it('flags overflow when the compiler truncated', () => {
    const log = runLog({
      compiledContext: {
        tokenCount: 90,
        itemCount: 3,
        contextSha256: CONTEXT_HASH,
        truncated: true
      }
    });

    expect(scoreCompilation(log, groundTruth()).overflowFrequency).toBe(1);
  });

  it('flags overflow when the gold evidence could never have fit the frozen cap', () => {
    // Nothing truncated — the compiled context fits the 50-token cap comfortably.
    // The 90 tokens of gold evidence never could, which is a budget failure the
    // compiler itself has no way to report.
    const log = logWithRetrieval(['m_1', 'm_2', 'm_3', 'm_4'], ['m_2'], 30, {
      budget: {
        candidateCap: 24,
        compiledContextTokenCap: 50,
        storeBytesCap: 104_857_600,
        llmCallCap: 1
      }
    });

    const metrics = scoreCompilation(log, groundTruth());

    expect(log.compiledContext.truncated).toBe(false);
    expect(metrics.overflowFrequency).toBe(1);
  });

  it('passes the position-effect replay through untouched, including its null', () => {
    expect(scoreCompilation(runLog(), groundTruth()).positionEffect).toBeNull();
    expect(
      scoreCompilation(
        runLog(),
        groundTruth(
          {},
          {
            compilation: {
              evidenceTokenCost: [
                { nodeId: 'evt_88', tokens: 40 },
                { nodeId: 'doc_4', tokens: 30 },
                { nodeId: 'note_9', tokens: 20 }
              ],
              positionEffect: -0.04
            }
          }
        )
      ).positionEffect
    ).toBe(-0.04);
  });
});

// --- behavior stage ---------------------------------------------------------

describe('scoreBehavior', () => {
  it('scores a solved task and reports single-run latency percentiles', () => {
    const metrics = scoreBehavior(runLog(), groundTruth());

    expect(metrics.taskSuccess).toBe(1);
    expect(metrics.answerAccuracy).toBe(1);
    expect(metrics.abstentionCorrectness).toBe(1);
    expect(metrics.policyCompliance).toBe(1);
    expect(metrics.latencyP50Ms).toBe(100);
    expect(metrics.latencyP95Ms).toBe(100);
    expect(metrics.costModelTokens).toBe(450);
    expect(metrics.costGpuSeconds).toBe(2.5);
  });

  it('fails the task when the answer hash does not match the gold answer', () => {
    const log = runLog({
      output: { answerSha256: WRONG_ANSWER_HASH, actionTraceSha256: null, abstained: false }
    });

    const metrics = scoreBehavior(log, groundTruth());

    expect(metrics.answerAccuracy).toBe(0);
    expect(metrics.taskSuccess).toBe(0);
    // The abstention decision was still right: it answered an answerable task.
    expect(metrics.abstentionCorrectness).toBe(1);
  });

  it('scores over-answering an unanswerable task as an abstention failure', () => {
    const item = {
      task: {
        query: 'Is the frozen release policy still active?',
        expected: { mode: 'abstain', reason: 'expired', evidence: [] }
      }
    };
    const key = { compilation: { evidenceTokenCost: [], positionEffect: null } };

    const answered = scoreBehavior(runLog(), groundTruth(item, key));
    const abstained = scoreBehavior(
      runLog({ output: { answerSha256: ANSWER_HASH, actionTraceSha256: null, abstained: true } }),
      groundTruth(item, key)
    );

    expect(answered.abstentionCorrectness).toBe(0);
    expect(answered.taskSuccess).toBe(0);
    expect(abstained.abstentionCorrectness).toBe(1);
    expect(abstained.taskSuccess).toBe(1);
  });

  it('scores over-abstention on an answerable task as an abstention failure too', () => {
    const log = runLog({
      output: { answerSha256: ANSWER_HASH, actionTraceSha256: null, abstained: true }
    });

    const metrics = scoreBehavior(log, groundTruth());

    expect(metrics.abstentionCorrectness).toBe(0);
    expect(metrics.answerAccuracy).toBe(0);
    expect(metrics.taskSuccess).toBe(0);
  });

  it('matches each required tool outcome to at most one execution', () => {
    const key = {
      behavior: {
        requiredToolOutcomes: [
          { toolId: 'calendar.search', responseSha256: RESPONSE_HASH },
          { toolId: 'calendar.search', responseSha256: RESPONSE_HASH }
        ],
        executedTools: [{ toolId: 'calendar.search', responseSha256: RESPONSE_HASH }],
        replays: [],
        operatorCorrections: 0,
        policyViolations: [],
        costEmbeddingCalls: 0,
        costIndexQueries: 0,
        costGpuMilliseconds: 0,
        energyJoules: null
      }
    };

    const metrics = scoreBehavior(runLog(), groundTruth({}, key));

    expect(metrics.toolExecutionAccuracy).toBe(0.5);
    expect(metrics.toolCallsPerSolvedTask).toBe(1);
    // A right-looking answer with a missing required tool outcome is not a solved task.
    expect(metrics.answerAccuracy).toBe(1);
    expect(metrics.taskSuccess).toBe(0);
  });

  it('reports cross-sleeve leakage and secret exposure from the compiled context', () => {
    const log = logWithRetrieval(['m_1', 'm_leak', 'm_2'], ['m_1', 'm_leak'], 50);

    const metrics = scoreBehavior(log, groundTruth());

    expect(metrics.crossSleeveLeakage).toBe(1);
    expect(metrics.secretLeakage).toBe(1);
  });

  it('keeps a retrieval-only scope failure out of behavior leakage', () => {
    // Defense in depth: the leak ranked, but the compiler dropped it. Retrieval must
    // register the failure while behavior stays clean.
    const log = logWithRetrieval(['m_1', 'm_leak', 'm_2'], ['m_1'], 40);
    const truth = groundTruth();

    expect(scoreRetrieval(log, truth).scopeFilterCorrectness).toBe(0);
    expect(scoreBehavior(log, truth).crossSleeveLeakage).toBe(0);
    // The secret is still reachable, so the privacy metric still fires.
    expect(scoreBehavior(log, truth).secretLeakage).toBe(1);
  });

  it('fails determinism closed when no rerun was performed and passes when reruns match', () => {
    const noReplay = scoreBehavior(runLog(), groundTruth());
    expect(noReplay.deterministicReplayRate).toBe(0);

    const withReplays = scoreBehavior(
      runLog(),
      groundTruth(
        {},
        {
          behavior: {
            requiredToolOutcomes: [],
            executedTools: [],
            replays: [
              { identical: true, totalMs: 120 },
              { identical: false, totalMs: 400 }
            ],
            operatorCorrections: 2,
            policyViolations: ['compiled a revoked policy'],
            costEmbeddingCalls: 0,
            costIndexQueries: 0,
            costGpuMilliseconds: 0,
            energyJoules: 812.5
          }
        }
      )
    );

    expect(withReplays.deterministicReplayRate).toBe(0.5);
    expect(withReplays.policyCompliance).toBe(0);
    expect(withReplays.operatorCorrectionRate).toBe(2);
    expect(withReplays.energyJoules).toBe(812.5);
    // Percentiles now come from the run plus its reruns: [100, 120, 400].
    expect(withReplays.latencyP50Ms).toBe(120);
    expect(withReplays.latencyP95Ms).toBeCloseTo(372, 6);
  });

  it('reports no secret leakage when nothing forbidden was ever reachable', () => {
    const log = logWithRetrieval(['m_1', 'm_2', 'm_3'], ['m_1', 'm_2'], 70);

    expect(scoreBehavior(log, groundTruth()).secretLeakage).toBe(0);
  });
});

// --- bundling and refusals --------------------------------------------------

describe('scoreArmRun', () => {
  it('bundles exactly what the five stage scorers produce', () => {
    const log = runLog();
    const truth = groundTruth();

    expect(scoreArmRun(log, truth)).toEqual(
      combineMetrics(
        scoreWrites(log, truth),
        scoreMaintenance(log, truth),
        scoreRetrieval(log, truth),
        scoreCompilation(log, truth),
        scoreBehavior(log, truth)
      )
    );
  });

  it('is deterministic: the same run scored twice is byte-identical', () => {
    const log = logWithRetrieval(['m_1', 'm_dup', 'm_old', 'm_leak'], ['m_1', 'm_old'], 55, {
      maintenance: [
        maintenanceEntry('mev_1', {
          kind: 'supersede',
          targetMemoryIds: ['m_old'],
          sourceMemoryIds: ['m_1']
        })
      ]
    });
    const truth = groundTruth({}, { maintenance: SUPERSESSION_KEY });

    const first = scoreArmRun(log, truth);
    const second = scoreArmRun(log, truth);

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('produces a finite number (or an explicit null) at every declared metric path', () => {
    // Walks the closed vocabulary the gates and leaderboards address, so a metric
    // the scorers forget to populate shows up here as `undefined`, not as a silent
    // gate pass.
    const bundle = scoreArmRun(runLog(), groundTruth());

    for (const path of METRIC_PATHS) {
      const value = readMetric(bundle, path);
      expect(value === null || Number.isFinite(value)).toBe(true);
    }
  });

  it('refuses a scoring key that belongs to a different item', () => {
    expect(() => scoreArmRun(runLog(), groundTruth({}, { itemId: 'hist_00999_task_01' }))).toThrow(
      MetricScoringError
    );
  });

  it('refuses a run whose replayed history hash does not match the gold item', () => {
    expect(() => scoreArmRun(runLog({ historyHash: '9'.repeat(64) }), groundTruth())).toThrow(
      MetricScoringError
    );
  });

  it('refuses to score at a k the fairness budget never allowed', () => {
    expect(() => scoreArmRun(runLog(), groundTruth({}, { retrievalK: 25 }))).toThrow(
      MetricScoringError
    );
  });

  it('refuses gold evidence that carries no token cost', () => {
    const truth = groundTruth(
      {},
      {
        compilation: {
          evidenceTokenCost: [
            { nodeId: 'evt_88', tokens: 40 },
            { nodeId: 'doc_4', tokens: 30 }
          ],
          positionEffect: null
        }
      }
    );

    expect(() => scoreArmRun(runLog(), truth)).toThrow(MetricScoringError);
  });

  it('rejects a run log that breaks its own fairness budget before any metric is computed', () => {
    expect(() => scoreArmRun(runLog({ llmCalls: 4 }), groundTruth())).toThrow();
  });
});
