import { join } from 'node:path';

import { compareMemoryBackends, renderComparisonTable } from './demo/backend-comparison';
import { renderReasoningTrace } from './demo/reasoning-trace';
import { MemorySystemIdSchema, type MemorySystemId } from './system/contracts';
import { SAMPLE_MEMORY, SAMPLE_QUESTIONS } from './demo/sample-memory';

/**
 * `npm run memory:demo` — the memory-architecture proof of concept.
 *
 * It loads one hand-authored sample corpus into each requested backend, asks the
 * same questions of every one, and prints the full reasoning path behind each
 * answer: what was retrieved, what was suppressed and why, what survived the
 * shared context budget, and what was finally cited. Backends are swapped through
 * the same factory production uses, so the comparison exercises the real seam.
 *
 * Fully local and deterministic: temp databases, a frozen clock, no network, and
 * no model calls. Re-running prints byte-identical traces.
 */

interface CliOptions {
  backends: MemorySystemId[];
  questionIds: string[] | null;
  showTraces: boolean;
  json: boolean;
}

function parseArguments(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    // The control leads so the contrast is visible on a bare `npm run memory:demo`.
    backends: ['flat_untyped', 'flat', 'typed_hybrid', 'typed_temporal', 'ledger'],
    questionIds: null,
    showTraces: true,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === '--backends' && next !== undefined) {
      options.backends = next.split(',').map((raw) => {
        const parsed = MemorySystemIdSchema.safeParse(raw.trim());
        if (!parsed.success) {
          throw new Error(
            `Unknown backend '${raw.trim()}'. Valid: ${MemorySystemIdSchema.options.join(', ')}`
          );
        }
        return parsed.data;
      });
      index += 1;
    } else if (argument === '--questions' && next !== undefined) {
      options.questionIds = next.split(',').map((raw) => raw.trim());
      index += 1;
    } else if (argument === '--summary') {
      options.showTraces = false;
    } else if (argument === '--json') {
      options.json = true;
      options.showTraces = false;
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const projectRoot = join(__dirname, '..', '..');
  const questions =
    options.questionIds === null
      ? SAMPLE_QUESTIONS
      : SAMPLE_QUESTIONS.filter((question) => options.questionIds?.includes(question.id));
  if (questions.length === 0) {
    throw new Error(
      `No matching questions. Valid ids: ${SAMPLE_QUESTIONS.map((q) => q.id).join(', ')}`
    );
  }

  const comparison = await compareMemoryBackends({
    backends: options.backends,
    questions,
    projectRoot
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Memory backend comparison — ${SAMPLE_MEMORY.length} sample memories, ` +
        `${questions.length} question(s), evaluated at ${comparison.evaluatedAt}\n\n`
    );

    if (options.showTraces) {
      for (const result of comparison.results) {
        process.stdout.write(
          `${'='.repeat(78)}\nBACKEND: ${result.backend}\n${'='.repeat(78)}\n\n`
        );
        for (const trace of result.traces) {
          process.stdout.write(`${renderReasoningTrace(trace)}\n\n`);
        }
      }
    }

    process.stdout.write(`${renderComparisonTable(comparison)}\n`);
    process.stdout.write(`\ncomparison fingerprint: ${comparison.fingerprint.slice(0, 32)}\n`);
  }

  // `flat_untyped` is the experimental control: surfacing stale evidence is its
  // entire purpose, so it must not turn a healthy comparison into a failed run.
  // Any other backend doing the same is a genuine safety regression.
  const control: MemorySystemId = 'flat_untyped';
  const unsafe = comparison.results.filter(
    (result) => result.leakCount > 0 && result.backend !== control
  );
  const controlResult = comparison.results.find((result) => result.backend === control);
  if (controlResult !== undefined && !options.json) {
    process.stdout.write(
      `\ncontrol (${control}) surfaced forbidden evidence on ` +
        `${controlResult.leakCount}/${controlResult.questionCount} question(s) — expected, ` +
        'it is the untyped baseline the others are measured against.\n'
    );
  }
  if (unsafe.length > 0) {
    process.stderr.write(
      `\n${unsafe.length} production backend(s) surfaced forbidden evidence: ${unsafe
        .map((result) => result.backend)
        .join(', ')}\n`
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `memory:demo failed: ${error instanceof Error ? error.message : 'unknown error'}\n`
  );
  process.exitCode = 1;
});
