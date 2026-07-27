import process from 'node:process';

import { z } from 'zod';

import { TaskmarketInspector, type TaskmarketSubmissionInspection } from './taskmarket-inspector';

const MAX_CLI_OUTPUT_BYTES = 32 * 1_024;
const TaskIdSchema = z.string().regex(/^0x[a-f0-9]{64}$/);
const TimestampSchema = z.iso.datetime({ offset: true });
const TaskStatusSchema = z.enum([
  'open',
  'claimed',
  'worker_selected',
  'pending_approval',
  'review',
  'appealing',
  'disputed',
  'completed',
  'expired',
  'cancelled'
]);

const CliInspectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: TaskIdSchema,
  taskDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: TaskStatusSchema,
  submissionWindowOpen: z.boolean(),
  expiresAt: TimestampSchema,
  pendingActions: z
    .array(
      z.strictObject({
        role: z.literal('worker'),
        action: z.literal('submit'),
        eligibleAddress: z
          .string()
          .regex(/^0x[a-f0-9]{40}$/)
          .nullable(),
        requiresPayment: z.literal(false),
        paymentAmount: z.union([z.literal('0'), z.null()]),
        availableAfter: TimestampSchema.nullable(),
        availableUntil: TimestampSchema.nullable()
      })
    )
    .max(50)
});

export const TASKMARKET_INSPECTOR_CLI_ERROR_CODE = 'TASKMARKET_INSPECTION_FAILED' as const;

interface RunnableTaskmarketInspector {
  inspect(taskId: string): Promise<TaskmarketSubmissionInspection>;
}

export interface TaskmarketInspectorCliDependencies {
  inspector: RunnableTaskmarketInspector;
  writeLine: (line: string) => void;
}

function fixedErrorLine(): string {
  return JSON.stringify({
    schemaVersion: 1,
    status: 'operational_error',
    errorCode: TASKMARKET_INSPECTOR_CLI_ERROR_CODE
  });
}

function productionInspector(): RunnableTaskmarketInspector {
  return new TaskmarketInspector({ fetch: globalThis.fetch });
}

export async function runTaskmarketInspectorCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies?: TaskmarketInspectorCliDependencies
): Promise<number> {
  const writeLine =
    dependencies?.writeLine ??
    ((line: string): void => {
      void process.stdout.write(`${line}\n`);
    });
  let output = fixedErrorLine();
  let exitCode = 1;

  try {
    if (argv.length !== 1) {
      throw new Error('Invalid CLI arguments');
    }
    const parsedTaskId = TaskIdSchema.safeParse(argv[0]?.toLowerCase());
    if (!parsedTaskId.success) {
      throw new Error('Invalid CLI arguments');
    }

    const inspector = dependencies?.inspector ?? productionInspector();
    const rawInspection = await inspector.inspect(parsedTaskId.data);
    const parsedInspection = CliInspectionSchema.safeParse(rawInspection);
    if (!parsedInspection.success || parsedInspection.data.taskId !== parsedTaskId.data) {
      throw new Error('Invalid inspection result');
    }

    const serialized = JSON.stringify(parsedInspection.data);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_CLI_OUTPUT_BYTES) {
      throw new Error('Inspection output exceeded its boundary');
    }
    output = serialized;
    exitCode = 0;
  } catch {
    output = fixedErrorLine();
    exitCode = 1;
  }

  writeLine(output);
  return exitCode;
}

if (require.main === module) {
  void runTaskmarketInspectorCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
