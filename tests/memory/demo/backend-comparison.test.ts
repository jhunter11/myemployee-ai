import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  compareMemoryBackends,
  renderComparisonTable
} from '../../../src/memory/demo/backend-comparison';
import { renderReasoningTrace } from '../../../src/memory/demo/reasoning-trace';
import { SAMPLE_QUESTIONS } from '../../../src/memory/demo/sample-memory';

const PROJECT_ROOT = join(__dirname, '..', '..', '..');

describe('memory backend comparison', () => {
  it('runs the identical corpus through every backend and traces each answer', async () => {
    const comparison = await compareMemoryBackends({
      backends: ['flat', 'typed_hybrid', 'typed_temporal', 'ledger'],
      projectRoot: PROJECT_ROOT
    });

    expect(comparison.results).toHaveLength(4);
    for (const result of comparison.results) {
      expect(result.questionCount).toBe(SAMPLE_QUESTIONS.length);
      expect(result.traces).toHaveLength(SAMPLE_QUESTIONS.length);
    }
  }, 120_000);

  it('is deterministic: the same comparison twice yields the same fingerprint', async () => {
    const first = await compareMemoryBackends({
      backends: ['flat'],
      projectRoot: PROJECT_ROOT
    });
    const second = await compareMemoryBackends({
      backends: ['flat'],
      projectRoot: PROJECT_ROOT
    });
    expect(second.fingerprint).toBe(first.fingerprint);
  }, 120_000);

  it('never surfaces the neighbouring client sleeve into an Acme answer', async () => {
    const comparison = await compareMemoryBackends({
      backends: ['flat', 'typed_hybrid', 'typed_temporal', 'ledger'],
      projectRoot: PROJECT_ROOT
    });
    for (const result of comparison.results) {
      expect(result.leakCount, `${result.backend} leaked forbidden evidence`).toBe(0);
      for (const trace of result.traces) {
        const surfaced = trace.candidates
          .filter((candidate) => candidate.verdict === 'selected')
          .map((candidate) => candidate.fragmentId);
        expect(surfaced).not.toContain('northwind-launch-date');
      }
    }
  }, 120_000);

  it('suppresses the superseded launch date while surfacing its replacement', async () => {
    const comparison = await compareMemoryBackends({
      backends: ['flat'],
      questions: SAMPLE_QUESTIONS.filter((question) => question.id === 'launch_date'),
      projectRoot: PROJECT_ROOT
    });
    const trace = comparison.results[0]?.traces[0];
    expect(trace).toBeDefined();

    const selected = (trace?.candidates ?? []).filter(
      (candidate) => candidate.verdict === 'selected'
    );
    const omitted = (trace?.candidates ?? []).filter(
      (candidate) => candidate.verdict === 'omitted'
    );
    expect(selected.map((candidate) => candidate.fragmentId)).toContain('acme-launch-date-v2');

    const stale = omitted.find((candidate) => candidate.fragmentId === 'acme-launch-date-v1');
    expect(stale).toBeDefined();
    expect(stale?.reason).toContain('supersedes');
    expect(trace?.assessment.memoryCorrect).toBe(true);
  }, 120_000);

  it('never lets an operator-withdrawn fragment reach a compiled context', async () => {
    const comparison = await compareMemoryBackends({
      backends: ['flat', 'typed_hybrid'],
      projectRoot: PROJECT_ROOT
    });
    for (const result of comparison.results) {
      for (const trace of result.traces) {
        expect(trace.compilation?.selectedFragmentIds ?? []).not.toContain('acme-retired-vendor');
      }
    }
  }, 120_000);

  it('differentiates the untyped control from the temporally-filtered backends', async () => {
    const comparison = await compareMemoryBackends({
      backends: ['flat_untyped', 'flat'],
      projectRoot: PROJECT_ROOT
    });
    const control = comparison.results.find((result) => result.backend === 'flat_untyped');
    const flat = comparison.results.find((result) => result.backend === 'flat');
    expect(control).toBeDefined();
    expect(flat).toBeDefined();

    // The whole point of the control: it surfaces stale evidence, the real backend does not.
    expect(control?.leakCount ?? 0).toBeGreaterThan(0);
    expect(flat?.leakCount).toBe(0);
    expect(control?.memoryCorrectCount ?? 0).toBeLessThan(flat?.memoryCorrectCount ?? 0);
  }, 120_000);

  it('reports resolver abstention separately from retrieval and aggregate answer correctness', async () => {
    const comparison = await compareMemoryBackends({
      backends: ['flat_untyped', 'flat', 'typed_hybrid'],
      projectRoot: PROJECT_ROOT
    });
    const control = comparison.results.find((result) => result.backend === 'flat_untyped');
    const flat = comparison.results.find((result) => result.backend === 'flat');
    const typed = comparison.results.find((result) => result.backend === 'typed_hybrid');

    expect(control).toMatchObject({
      abstentionCorrectCount: 0,
      abstentionQuestionCount: 2
    });
    for (const safe of [flat, typed]) {
      expect(safe).toMatchObject({
        answerCorrectCount: SAMPLE_QUESTIONS.length,
        abstentionCorrectCount: 2,
        abstentionQuestionCount: 2,
        leakCount: 0
      });
    }
    expect(renderComparisonTable(comparison)).toContain('abstain');
  }, 120_000);

  it('keeps scope isolation intact even in the untyped control', async () => {
    // The control relaxes temporal correctness only. If it also leaked across
    // sleeves it would be measuring two variables at once — and be unsafe to run.
    const comparison = await compareMemoryBackends({
      backends: ['flat_untyped'],
      projectRoot: PROJECT_ROOT
    });
    for (const trace of comparison.results[0]?.traces ?? []) {
      for (const candidate of trace.candidates) {
        expect(candidate.fragmentId).not.toBe('northwind-launch-date');
      }
    }
  }, 120_000);

  it('shows the compiler catching stale evidence the control let through', async () => {
    const comparison = await compareMemoryBackends({
      backends: ['flat_untyped'],
      questions: SAMPLE_QUESTIONS.filter((question) => question.id === 'launch_date'),
      projectRoot: PROJECT_ROOT
    });
    const trace = comparison.results[0]?.traces[0];
    expect(trace).toBeDefined();

    // Retrieval surfaced the superseded revision...
    expect(trace?.assessment.leakedEvidence).toContain('acme-launch-date-v1');
    // ...but it never reached the compiled context, and the answer stayed correct.
    expect(trace?.compilation?.selectedFragmentIds ?? []).not.toContain('acme-launch-date-v1');
    expect(trace?.assessment.answerCorrect).toBe(true);
  }, 120_000);

  it('separates backends that only LOOK equivalent on the scoreboard', async () => {
    // Equal scores are not evidence of equal behaviour. The behaviour digest
    // excludes the backend's own name, so it can answer the question the score
    // columns cannot: did these two actually make the same decisions?
    const comparison = await compareMemoryBackends({
      backends: ['flat', 'typed_hybrid', 'ledger'],
      projectRoot: PROJECT_ROOT
    });
    const digest = (backend: string): string =>
      comparison.results.find((result) => result.backend === backend)?.behaviorFingerprint ?? '';

    // The ledger writes through the reducer but retrieves over the flat substrate,
    // so it is expected to decide identically. That equality is now assertable.
    expect(digest('ledger')).toBe(digest('flat'));
    // typed_hybrid re-ranks by store class, so it must NOT collapse into flat —
    // if it did, the FlatTag-vs-TypedBasic contrast would be measuring nothing.
    expect(digest('typed_hybrid')).not.toBe(digest('flat'));

    // ...while the plain fingerprint cannot express either fact: it embeds the
    // backend id, so every pair differs there no matter how they behaved.
    const plain = (backend: string): string =>
      comparison.results.find((result) => result.backend === backend)?.fingerprint ?? '';
    expect(plain('ledger')).not.toBe(plain('flat'));
  }, 120_000);

  it('renders a human-readable trace and scoreboard', async () => {
    const comparison = await compareMemoryBackends({
      backends: ['flat'],
      questions: SAMPLE_QUESTIONS.filter((question) => question.id === 'launch_date'),
      projectRoot: PROJECT_ROOT
    });
    const trace = comparison.results[0]?.traces[0];
    expect(trace).toBeDefined();

    const rendered = renderReasoningTrace(trace ?? (undefined as never));
    expect(rendered).toContain('1. authorize');
    expect(rendered).toContain('2. retrieve');
    expect(rendered).toContain('3. suppress');
    expect(rendered).toContain('5. resolve');
    expect(rendered).toContain('MEMORY:');
    expect(rendered).toContain('ANSWER:');

    const table = renderComparisonTable(comparison);
    expect(table).toContain('flat');
    expect(table).toContain('memory');
  }, 120_000);
});
