import type SQLite from 'better-sqlite3';
import { z } from 'zod';

import { AppError } from '../../utils/errors';
import { MemorySystemIdSchema } from '../system/contracts';
import { sha256 } from '../system/hashing';
import {
  ArmRunLogSchema,
  DatasetSplitSchema,
  DifficultyTierSchema,
  ExperimentArmIdSchema,
  ExperimentPhaseIdSchema,
  METRIC_PATHS,
  Sha256HexSchema,
  WorkloadFamilySchema,
  readMetric,
  type ArmRunLog,
  type DatasetSplit,
  type ExperimentArmId,
  type ExperimentPhaseId,
  type MetricBundle,
  type MetricPath
} from './contracts';

/**
 * Durable persistence for the program's machine-readable run log.
 *
 * Two things happen here that nowhere else in the experiment module can do. First,
 * the report's refusal rule is ENFORCED rather than described: a run that cannot
 * name its environment, its budget, its seeds, its simulated clock, and every stage
 * hash is rejected before a single metric is written, because a half-manifested run
 * silently poisons every aggregate computed over it. Second, a whole run SET gets a
 * fingerprint, which is what makes "two bench executions reproduced each other" a
 * checkable claim instead of an assertion.
 *
 * The store itself is append-only and fully immutable (migration 025 aborts every
 * UPDATE and DELETE). Re-recording a byte-identical run is idempotent; re-recording
 * a DIVERGENT run under the same id is a conflict, which is the only honest reading
 * — one of the two executions is wrong and the store must not choose between them.
 */

const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const versionPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/** Raised when a run cannot be stored or scored honestly. Always fails closed. */
export class ExperimentLogError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(422, code, message, details);
  }
}

/**
 * Raised when the manifest is incomplete. Separate from a schema parse failure on
 * purpose: "you sent the wrong shape" and "this run is not scorable" are different
 * operator problems, and only the second one is a finding about the experiment.
 */
export class ExperimentManifestIncompleteError extends ExperimentLogError {
  constructor(
    readonly runId: string,
    reason: string,
    details?: unknown
  ) {
    super('EXPERIMENT_MANIFEST_INCOMPLETE', `Run '${runId}' is not scorable: ${reason}`, details);
  }
}

/** Raised when a run id is already bound to a different execution. */
export class ExperimentRunConflictError extends AppError {
  constructor(readonly runId: string) {
    super(
      409,
      'EXPERIMENT_RUN_CONFLICT',
      `Run '${runId}' is already recorded with a different execution`,
      { runId }
    );
  }
}

// --- Manifest ---------------------------------------------------------------

/**
 * The model/environment identity of one execution.
 *
 * The report treats the environment as part of the experiment: the same arm on two
 * runtimes is two experiments, and a comparison across them is not admissible. Every
 * field is required — `answerModel` included, even when the replay makes zero model
 * calls, because "retrieval-only replay" is itself a manifest fact a reader needs.
 */
export const ExperimentRunManifestSchema = z.strictObject({
  /** Version of the bench harness that produced the run. */
  harnessVersion: z.string().regex(versionPattern),
  /** The repo memory backend the arm was bound to. */
  backendId: MemorySystemIdSchema,
  runtimeName: z.string().trim().min(1).max(64),
  runtimeVersion: z.string().trim().min(1).max(64),
  platform: z.string().trim().min(1).max(64),
  /** The answer model, or an explicit sentinel when the replay calls none. */
  answerModel: z.string().trim().min(1).max(96),
  /** The `k` the retrieval metrics were computed at. */
  retrievalK: z.number().int().min(1).max(1_000),
  workloadSeed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  attackSeed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  workloadFingerprint: Sha256HexSchema,
  /** The simulated instant the item was evaluated at. Never a wall clock. */
  simulatedTime: z.iso.datetime(),
  /** When the row was written. Explicit input so a rerun records identical bytes. */
  recordedAt: z.iso.datetime()
});
export type ExperimentRunManifest = z.infer<typeof ExperimentRunManifestSchema>;

// --- Metric bundle ----------------------------------------------------------

const Rate = z.number().finite();

/**
 * The five staged metric groups as a parseable shape.
 *
 * The contract declares them as interfaces, which is right for pure scoring but
 * useless at a persistence boundary: a bundle arriving from a caller has to be
 * validated, not trusted. Spelled out field by field rather than derived, so that
 * adding a metric to the contract without adding it here fails the type check in
 * {@link METRIC_PATHS} instead of silently persisting a shorter scorecard.
 */
export const MetricBundleSchema = z.strictObject({
  write: z.strictObject({
    writePrecision: Rate,
    writeRecall: Rate,
    duplicateMemoryRate: Rate,
    incorrectInferenceRate: Rate,
    wrongSleeveWriteRate: Rate,
    unsupportedMemoryRate: Rate,
    consolidationDistortion: Rate,
    procedureExtractionPrecision: Rate
  }),
  maintenance: z.strictObject({
    correctUpdateRate: Rate,
    supersessionAccuracy: Rate,
    deletionCompletion: Rate,
    conflictDetectionRecall: Rate,
    staleMemorySurvival: Rate,
    promotionPrecision: Rate,
    promotionRecall: Rate,
    provenancePreservation: Rate,
    severeIrreversibleErrorRate: Rate
  }),
  retrieval: z.strictObject({
    recallAtK: Rate,
    precisionAtK: Rate,
    meanReciprocalRank: Rate,
    ndcgAtK: Rate,
    scopeFilterCorrectness: Rate,
    temporalFilterCorrectness: Rate,
    distractorRetrievalRate: Rate,
    unsupportedGraphExpansionRate: Rate
  }),
  compilation: z.strictObject({
    evidenceCoverage: Rate,
    redundancy: Rate,
    contradictionRate: Rate,
    tokenUtilization: Rate,
    relevantTokenDensity: Rate,
    positionEffect: Rate.nullable(),
    overflowFrequency: Rate
  }),
  behavior: z.strictObject({
    taskSuccess: Rate,
    answerAccuracy: Rate,
    toolExecutionAccuracy: Rate,
    toolCallsPerSolvedTask: Rate,
    policyCompliance: Rate,
    abstentionCorrectness: Rate,
    operatorCorrectionRate: Rate,
    crossSleeveLeakage: Rate,
    secretLeakage: Rate,
    deterministicReplayRate: Rate,
    latencyP50Ms: Rate,
    latencyP95Ms: Rate,
    costModelTokens: Rate,
    costEmbeddingCalls: Rate,
    costIndexQueries: Rate,
    costGpuSeconds: Rate,
    energyJoules: Rate.nullable()
  })
});

/**
 * Metrics that must be present and finite before ANY metric is stored.
 *
 * These are the five hard gates. A gate reads a missing metric as a violation, so a
 * run that never measured one is not merely under-instrumented — it is a run whose
 * safety claim was never made. Storing it would let it be averaged into an arm's
 * scorecard as if the property had been checked.
 */
const REQUIRED_MANIFEST_METRICS: readonly MetricPath[] = [
  'behavior.crossSleeveLeakage',
  'behavior.deterministicReplayRate',
  'behavior.secretLeakage',
  'maintenance.severeIrreversibleErrorRate',
  'write.wrongSleeveWriteRate'
];

// --- Entry ------------------------------------------------------------------

export const ExperimentRunEntrySchema = z.strictObject({
  manifest: ExperimentRunManifestSchema,
  /** The staged run log. Its own `runId` is the row identity; there is no second one. */
  log: ArmRunLogSchema,
  itemFamily: WorkloadFamilySchema,
  itemTier: DifficultyTierSchema,
  groundTruthHash: Sha256HexSchema,
  metrics: MetricBundleSchema
});
export type ExperimentRunEntry = z.infer<typeof ExperimentRunEntrySchema>;

export interface ExperimentRunRecord {
  readonly runId: string;
  readonly phaseId: ExperimentPhaseId;
  readonly armId: ExperimentArmId;
  readonly datasetSplit: DatasetSplit;
  readonly itemId: string;
  readonly backendId: string;
  readonly historyHash: string;
  readonly groundTruthHash: string;
  readonly simulatedTime: string;
  readonly compiledContextHash: string;
  readonly answerSha256: string | null;
  readonly actionTraceSha256: string | null;
  readonly abstained: boolean;
  /** Canonical digest of the whole {@link ArmRunLog}; the unit of bit-identity. */
  readonly runLogSha256: string;
}

export interface ExperimentScoreRow {
  readonly metricPath: MetricPath;
  readonly value: number | null;
}

export const ExperimentRunQuerySchema = z.strictObject({
  phaseId: ExperimentPhaseIdSchema.nullable(),
  datasetSplit: DatasetSplitSchema.nullable(),
  armId: ExperimentArmIdSchema.nullable(),
  itemId: z.string().min(3).max(128).nullable()
});
export type ExperimentRunQuery = z.infer<typeof ExperimentRunQuerySchema>;

interface RunRow {
  run_id: string;
  phase_id: string;
  arm_id: string;
  dataset_split: string;
  item_id: string;
  backend_id: string;
  history_hash: string;
  ground_truth_hash: string;
  simulated_time: string;
  compiled_context_hash: string;
  answer_sha256: string | null;
  action_trace_sha256: string | null;
  abstained: number;
  run_log_sha256: string;
}

interface ScoreRow {
  metric_path: string;
  metric_value: number | null;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Key-sorted serialization so a digest depends on content, never on insertion order. */
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(',')}}`;
}

/**
 * The canonical digest of a run log.
 *
 * Computed over the parsed log rather than over the caller's object so that key
 * order, absent optional fields, and JSON whitespace cannot make two identical
 * executions look different — which would turn every reproducibility check into a
 * serialization test.
 */
export function runLogDigest(log: ArmRunLog): string {
  return sha256(canonicalJson(log));
}

function toRecord(row: RunRow): ExperimentRunRecord {
  return {
    runId: row.run_id,
    phaseId: ExperimentPhaseIdSchema.parse(row.phase_id),
    armId: ExperimentArmIdSchema.parse(row.arm_id),
    datasetSplit: DatasetSplitSchema.parse(row.dataset_split),
    itemId: row.item_id,
    backendId: row.backend_id,
    historyHash: row.history_hash,
    groundTruthHash: row.ground_truth_hash,
    simulatedTime: row.simulated_time,
    compiledContextHash: row.compiled_context_hash,
    answerSha256: row.answer_sha256,
    actionTraceSha256: row.action_trace_sha256,
    abstained: row.abstained === 1,
    runLogSha256: row.run_log_sha256
  };
}

export class ExperimentLogRepository {
  constructor(private readonly sqlite: SQLite.Database) {}

  /**
   * Records one arm's pass over one item, plus every metric it was scored on.
   *
   * The manifest check runs BEFORE the transaction opens: refusing early means an
   * unscorable run never touches the store at all, so a later reader cannot find a
   * run row with no scores and mistake it for "scored zero".
   */
  record(rawEntry: unknown): ExperimentRunRecord {
    const entry = ExperimentRunEntrySchema.parse(rawEntry);
    this.assertScorable(entry);

    const digest = runLogDigest(entry.log);
    const write = this.sqlite.transaction((): ExperimentRunRecord => {
      const existing = this.sqlite
        .prepare(
          `SELECT run_id, phase_id, arm_id, dataset_split, item_id, backend_id, history_hash,
                  ground_truth_hash, simulated_time, compiled_context_hash, answer_sha256,
                  action_trace_sha256, abstained, run_log_sha256
             FROM memory_experiment_runs WHERE run_id = ?`
        )
        .get(entry.log.runId) as RunRow | undefined;
      if (existing !== undefined) {
        // Idempotent on a byte-identical replay; loud on a divergent one. The store
        // cannot adjudicate which of two disagreeing executions is the real result.
        if (existing.run_log_sha256 !== digest) {
          throw new ExperimentRunConflictError(entry.log.runId);
        }
        return toRecord(existing);
      }

      this.sqlite
        .prepare(
          `INSERT INTO memory_experiment_runs (
             run_id, phase_id, arm_id, dataset_split, item_id, item_family, item_tier,
             history_hash, ground_truth_hash, workload_fingerprint,
             harness_version, backend_id, runtime_name, runtime_version, platform, answer_model,
             candidate_cap, compiled_context_token_cap, store_bytes_cap, llm_call_cap, retrieval_k,
             workload_seed, attack_seed, simulated_time, recorded_at,
             llm_calls, write_count, accepted_write_count, maintenance_count, candidate_count,
             compiled_context_hash, compiled_context_tokens, compiled_context_items,
             compiled_context_truncated, answer_sha256, action_trace_sha256, abstained,
             run_log_sha256
           ) VALUES (
             @runId, @phaseId, @armId, @datasetSplit, @itemId, @itemFamily, @itemTier,
             @historyHash, @groundTruthHash, @workloadFingerprint,
             @harnessVersion, @backendId, @runtimeName, @runtimeVersion, @platform, @answerModel,
             @candidateCap, @compiledContextTokenCap, @storeBytesCap, @llmCallCap, @retrievalK,
             @workloadSeed, @attackSeed, @simulatedTime, @recordedAt,
             @llmCalls, @writeCount, @acceptedWriteCount, @maintenanceCount, @candidateCount,
             @compiledContextHash, @compiledContextTokens, @compiledContextItems,
             @compiledContextTruncated, @answerSha256, @actionTraceSha256, @abstained,
             @runLogSha256
           )`
        )
        .run({
          runId: entry.log.runId,
          phaseId: entry.log.phaseId,
          armId: entry.log.armId,
          datasetSplit: entry.log.datasetSplit,
          itemId: entry.log.itemId,
          itemFamily: entry.itemFamily,
          itemTier: entry.itemTier,
          historyHash: entry.log.historyHash,
          groundTruthHash: entry.groundTruthHash,
          workloadFingerprint: entry.manifest.workloadFingerprint,
          harnessVersion: entry.manifest.harnessVersion,
          backendId: entry.manifest.backendId,
          runtimeName: entry.manifest.runtimeName,
          runtimeVersion: entry.manifest.runtimeVersion,
          platform: entry.manifest.platform,
          answerModel: entry.manifest.answerModel,
          candidateCap: entry.log.budget.candidateCap,
          compiledContextTokenCap: entry.log.budget.compiledContextTokenCap,
          storeBytesCap: entry.log.budget.storeBytesCap,
          llmCallCap: entry.log.budget.llmCallCap,
          retrievalK: entry.manifest.retrievalK,
          workloadSeed: entry.manifest.workloadSeed,
          attackSeed: entry.manifest.attackSeed,
          simulatedTime: entry.manifest.simulatedTime,
          recordedAt: entry.manifest.recordedAt,
          llmCalls: entry.log.llmCalls,
          writeCount: entry.log.writes.length,
          acceptedWriteCount: entry.log.writes.filter((write) => write.accepted).length,
          maintenanceCount: entry.log.maintenance.length,
          candidateCount: entry.log.retrieval.candidates.length,
          compiledContextHash: entry.log.compiledContext.contextSha256,
          compiledContextTokens: entry.log.compiledContext.tokenCount,
          compiledContextItems: entry.log.compiledContext.itemCount,
          compiledContextTruncated: entry.log.compiledContext.truncated ? 1 : 0,
          answerSha256: entry.log.output.answerSha256,
          actionTraceSha256: entry.log.output.actionTraceSha256,
          abstained: entry.log.output.abstained ? 1 : 0,
          runLogSha256: digest
        });

      const insertScore = this.sqlite.prepare(
        `INSERT INTO memory_experiment_scores (run_id, metric_path, metric_value)
         VALUES (@runId, @metricPath, @metricValue)`
      );
      // Written in the contract's frozen METRIC_PATHS order so the stored rows —
      // and therefore the run-set fingerprint — depend on the metrics, not on
      // object-key enumeration order.
      for (const metricPath of METRIC_PATHS) {
        insertScore.run({
          runId: entry.log.runId,
          metricPath,
          metricValue: readMetric(entry.metrics, metricPath)
        });
      }

      const inserted = this.sqlite
        .prepare(
          `SELECT run_id, phase_id, arm_id, dataset_split, item_id, backend_id, history_hash,
                  ground_truth_hash, simulated_time, compiled_context_hash, answer_sha256,
                  action_trace_sha256, abstained, run_log_sha256
             FROM memory_experiment_runs WHERE run_id = ?`
        )
        .get(entry.log.runId) as RunRow;
      return toRecord(inserted);
    });
    return write();
  }

  /** One run by id, or `undefined`. */
  findRun(rawRunId: unknown): ExperimentRunRecord | undefined {
    const runId = z.string().regex(runIdPattern).parse(rawRunId);
    const row = this.sqlite
      .prepare(
        `SELECT run_id, phase_id, arm_id, dataset_split, item_id, backend_id, history_hash,
                ground_truth_hash, simulated_time, compiled_context_hash, answer_sha256,
                action_trace_sha256, abstained, run_log_sha256
           FROM memory_experiment_runs WHERE run_id = ?`
      )
      .get(runId) as RunRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * Runs matching a partial key, always in `(phase, split, arm, item)` order.
   *
   * Ordering is not cosmetic: {@link runSetFingerprint} hashes this sequence, so a
   * query that returned rows in insertion order would make the fingerprint depend on
   * which arm happened to finish first.
   */
  listRuns(rawQuery: unknown): ExperimentRunRecord[] {
    const query = ExperimentRunQuerySchema.parse(rawQuery);
    const rows = this.sqlite
      .prepare(
        `SELECT run_id, phase_id, arm_id, dataset_split, item_id, backend_id, history_hash,
                ground_truth_hash, simulated_time, compiled_context_hash, answer_sha256,
                action_trace_sha256, abstained, run_log_sha256
           FROM memory_experiment_runs
          WHERE (@phaseId IS NULL OR phase_id = @phaseId)
            AND (@datasetSplit IS NULL OR dataset_split = @datasetSplit)
            AND (@armId IS NULL OR arm_id = @armId)
            AND (@itemId IS NULL OR item_id = @itemId)
          ORDER BY phase_id ASC, dataset_split ASC, arm_id ASC, item_id ASC, run_id ASC`
      )
      .all(query) as RunRow[];
    return rows.map(toRecord);
  }

  /** Every stored metric for one run, in the contract's frozen metric order. */
  scoresFor(rawRunId: unknown): ExperimentScoreRow[] {
    const runId = z.string().regex(runIdPattern).parse(rawRunId);
    const rows = this.sqlite
      .prepare(`SELECT metric_path, metric_value FROM memory_experiment_scores WHERE run_id = ?`)
      .all(runId) as ScoreRow[];
    const byPath = new Map(rows.map((row) => [row.metric_path, row.metric_value]));
    return METRIC_PATHS.filter((metricPath) => byPath.has(metricPath)).map((metricPath) => ({
      metricPath,
      value: byPath.get(metricPath) ?? null
    }));
  }

  /**
   * A single digest over a whole run set: every matching run's identity, its run-log
   * digest, and every metric it was scored on.
   *
   * This is the reproducibility instrument. Two bench executions of the same manifest
   * are bit-identical exactly when this value agrees; when it does not, the per-run
   * digests localize the divergence to one arm and one item, which is the difference
   * between a debuggable regression and "the numbers moved".
   */
  runSetFingerprint(rawQuery: unknown): string {
    const runs = this.listRuns(rawQuery);
    return sha256(
      canonicalJson({
        runs: runs.map((run) => ({
          runId: run.runId,
          phaseId: run.phaseId,
          armId: run.armId,
          datasetSplit: run.datasetSplit,
          itemId: run.itemId,
          backendId: run.backendId,
          historyHash: run.historyHash,
          groundTruthHash: run.groundTruthHash,
          runLogSha256: run.runLogSha256,
          scores: this.scoresFor(run.runId).map((score) => [score.metricPath, score.value])
        }))
      })
    );
  }

  /**
   * The report's refusal rule, applied before storage.
   *
   * Three refusals, each a case where storing would produce a plausible number from
   * material that never justified it: a manifest whose simulated clock disagrees with
   * the run it claims to describe, a `k` the frozen budget never permitted, and a
   * hard-gate metric that was never measured.
   */
  private assertScorable(entry: ExperimentRunEntry): void {
    const runId = entry.log.runId;
    if (entry.manifest.retrievalK > entry.log.budget.candidateCap) {
      throw new ExperimentManifestIncompleteError(
        runId,
        'the manifest retrievalK exceeds the frozen candidate cap',
        { retrievalK: entry.manifest.retrievalK, candidateCap: entry.log.budget.candidateCap }
      );
    }
    if (entry.manifest.simulatedTime !== entry.log.retrieval.queryTime) {
      throw new ExperimentManifestIncompleteError(
        runId,
        'the manifest simulated time disagrees with the retrieval query time',
        {
          simulatedTime: entry.manifest.simulatedTime,
          queryTime: entry.log.retrieval.queryTime
        }
      );
    }
    for (const metricPath of REQUIRED_MANIFEST_METRICS) {
      const value = readMetric(entry.metrics, metricPath);
      if (value === null || !Number.isFinite(value)) {
        throw new ExperimentManifestIncompleteError(
          runId,
          `hard-gate metric '${metricPath}' was never measured`,
          { metricPath }
        );
      }
    }
  }
}

/** Re-exported so a caller can assert a bundle's shape without importing the schema path. */
export type PersistedMetricBundle = MetricBundle;
