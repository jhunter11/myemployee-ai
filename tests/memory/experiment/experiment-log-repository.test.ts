import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type GlobalDatabaseContext } from '../../../src/db/database';
import { FROZEN_FAIRNESS_BUDGET, METRIC_PATHS } from '../../../src/memory/experiment/contracts';
import {
  ExperimentLogRepository,
  ExperimentManifestIncompleteError,
  ExperimentRunConflictError,
  MetricBundleSchema,
  runLogDigest
} from '../../../src/memory/experiment/experiment-log-repository';
import { sha256 } from '../../../src/memory/system/hashing';

const SIMULATED_TIME = '2026-07-24T12:00:00.000Z';
const RECORDED_AT = '2026-07-24T12:00:05.000Z';
const HASH = sha256('fixture');

/**
 * A complete bundle built by walking the frozen metric vocabulary, rather than by
 * hand. Hand-listing the fields would drift the moment a metric is added, and the
 * drift would look like a passing test over a shorter scorecard.
 */
function fullMetricBundle(overrides: Record<string, number> = {}): unknown {
  const bundle: Record<string, Record<string, number>> = {};
  for (const path of METRIC_PATHS) {
    const [group, field] = path.split('.');
    if (group === undefined || field === undefined) continue;
    bundle[group] ??= {};
    bundle[group][field] = overrides[path] ?? 0;
  }
  return bundle;
}

function armRunLog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'run_screen_dev_FlatTag_item0001',
    phaseId: 'representation_screening',
    armId: 'FlatTag',
    datasetSplit: 'synthetic_dev',
    itemId: 'item0001',
    historyHash: HASH,
    groundTruthHash: HASH,
    budget: FROZEN_FAIRNESS_BUDGET,
    llmCalls: 0,
    writes: [],
    maintenance: [],
    retrieval: { queryTime: SIMULATED_TIME, candidates: [], compiledContextIds: [] },
    compiledContext: { tokenCount: 0, itemCount: 0, contextSha256: HASH, truncated: false },
    output: { answerSha256: HASH, actionTraceSha256: null, abstained: false },
    latencyMs: {
      writeMs: 1,
      maintenanceMs: 0,
      retrievalMs: 2,
      compilationMs: 1,
      generationMs: 0,
      totalMs: 5
    },
    tokens: { compiledContextTokens: 0, promptTokens: 64, completionTokens: 8, totalTokens: 72 },
    ...overrides
  };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    harnessVersion: 'memory_bench_v1',
    backendId: 'flat',
    runtimeName: 'node',
    runtimeVersion: '22.0.0',
    platform: 'darwin',
    answerModel: 'none:retrieval_only_replay',
    retrievalK: 8,
    workloadSeed: 17,
    attackSeed: 18,
    workloadFingerprint: HASH,
    simulatedTime: SIMULATED_TIME,
    recordedAt: RECORDED_AT,
    ...overrides
  };
}

function entry(overrides: Record<string, unknown> = {}): unknown {
  return {
    log: armRunLog(),
    manifest: manifest(),
    itemFamily: 'update_control',
    itemTier: 'medium',
    groundTruthHash: HASH,
    metrics: fullMetricBundle(),
    ...overrides
  };
}

describe('experiment log repository', () => {
  let context: GlobalDatabaseContext;
  let temporaryRoot: string;
  let log: ExperimentLogRepository;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-experiment-log-'));
    context = await createDatabase({
      projectRoot: join(__dirname, '..', '..', '..'),
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    log = new ExperimentLogRepository(context.sqlite);
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('accepts a complete entry and reads it back', () => {
    const record = log.record(entry());
    expect(record.runId).toBe('run_screen_dev_FlatTag_item0001');
    expect(record.armId).toBe('FlatTag');
    expect(record.abstained).toBe(false);

    const found = log.findRun(record.runId);
    expect(found?.runLogSha256).toBe(record.runLogSha256);
    expect(found?.runLogSha256).toBe(runLogDigest(armRunLog() as never));
  });

  it('refuses an entry whose hard-gate metric was never measured', () => {
    // The gate metrics decide whether an arm is disqualified. A bundle that simply
    // omits one must not persist as though the arm had passed it — "not measured"
    // and "measured as zero" are the difference between a safe arm and an unknown one.
    const partial = fullMetricBundle() as Record<string, Record<string, number>>;
    delete partial.behavior?.crossSleeveLeakage;

    expect(() => log.record(entry({ metrics: partial }))).toThrow();
  });

  it('refuses a manifest whose retrievalK exceeds the frozen candidate cap', () => {
    expect(() =>
      log.record(
        entry({ manifest: manifest({ retrievalK: FROZEN_FAIRNESS_BUDGET.candidateCap + 1 }) })
      )
    ).toThrow(ExperimentManifestIncompleteError);
  });

  it('refuses a manifest whose simulated time disagrees with the query time', () => {
    // Two clocks in one record means the replay cannot be reconstructed: you would
    // not know which instant the retrieval was actually evaluated at.
    expect(() =>
      log.record(entry({ manifest: manifest({ simulatedTime: '2020-01-01T00:00:00.000Z' }) }))
    ).toThrow(ExperimentManifestIncompleteError);
  });

  it('refuses to overwrite a run id with different content', () => {
    log.record(entry());
    const different = entry({
      log: armRunLog({
        output: { answerSha256: sha256('other'), actionTraceSha256: null, abstained: true }
      })
    });
    expect(() => log.record(different)).toThrow(ExperimentRunConflictError);
  });

  it('is idempotent for a byte-identical re-record', () => {
    const first = log.record(entry());
    const second = log.record(entry());
    expect(second.runLogSha256).toBe(first.runLogSha256);
    expect(
      log.listRuns({ phaseId: null, datasetSplit: null, armId: null, itemId: null })
    ).toHaveLength(1);
  });

  it('stores one score row per frozen metric path, in vocabulary order', () => {
    const record = log.record(entry());
    const scores = log.scoresFor(record.runId);
    expect(scores.map((row) => row.metricPath)).toEqual([...METRIC_PATHS]);
  });

  it('filters runs by phase, split, and arm', () => {
    log.record(entry());
    expect(
      log.listRuns({
        phaseId: 'representation_screening',
        datasetSplit: 'synthetic_dev',
        armId: 'FlatTag',
        itemId: null
      })
    ).toHaveLength(1);
    expect(
      log.listRuns({
        phaseId: 'representation_screening',
        datasetSplit: 'synthetic_dev',
        armId: 'TypedBasic',
        itemId: null
      })
    ).toHaveLength(0);
  });

  it('fingerprints a run set identically across two reads and differently across content', () => {
    log.record(entry());
    const query = { phaseId: null, datasetSplit: null, armId: null, itemId: null };
    expect(log.runSetFingerprint(query)).toBe(log.runSetFingerprint(query));

    log.record(
      entry({
        log: armRunLog({ runId: 'run_screen_dev_FlatTag_item0002', itemId: 'item0002' })
      })
    );
    expect(log.runSetFingerprint(query)).not.toBe(
      log.runSetFingerprint({ ...query, itemId: 'item0001' })
    );
  });

  it('validates a bundle shape at the persistence boundary', () => {
    expect(() => MetricBundleSchema.parse(fullMetricBundle())).not.toThrow();
    expect(() => MetricBundleSchema.parse({ write: {} })).toThrow();
  });
});
