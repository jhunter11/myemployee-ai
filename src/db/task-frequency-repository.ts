import { sql, type Kysely, type Selectable } from 'kysely';

import type { JarvisDatabase, TaskFrequencyLogTable } from './types';

export interface RecordExecutionInput {
  taskSignature: string;
  durationSeconds: number;
  executedAt: string;
  manualIntervention?: boolean;
}

export interface TaskFrequencyRecord {
  id: number;
  taskSignature: string;
  executionCount: number;
  avgDurationSeconds: number | null;
  lastExecutedAt: string;
  manualInterventionCount: number;
}

const DEFAULT_RESULT_LIMIT = 100;

function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('limit must be an integer between 1 and 100');
  }
  return limit;
}

function toTaskFrequencyRecord(row: Selectable<TaskFrequencyLogTable>): TaskFrequencyRecord {
  return {
    id: row.id,
    taskSignature: row.task_signature,
    executionCount: row.execution_count,
    avgDurationSeconds: row.avg_duration_seconds,
    lastExecutedAt: row.last_executed_at,
    manualInterventionCount: row.manual_intervention_count
  };
}

export class TaskFrequencyRepository {
  constructor(private readonly db: Kysely<JarvisDatabase>) {}

  async recordExecution(input: RecordExecutionInput): Promise<TaskFrequencyRecord> {
    if (!Number.isFinite(input.durationSeconds) || input.durationSeconds < 0) {
      throw new RangeError('durationSeconds must be a finite non-negative number');
    }

    const row = await this.db
      .insertInto('task_frequency_log')
      .values({
        task_signature: input.taskSignature,
        execution_count: 1,
        avg_duration_seconds: input.durationSeconds,
        last_executed_at: input.executedAt,
        manual_intervention_count: input.manualIntervention === true ? 1 : 0
      })
      .onConflict((conflict) =>
        conflict.column('task_signature').doUpdateSet({
          execution_count: sql<number>`task_frequency_log.execution_count + 1`,
          avg_duration_seconds: sql<number>`
            ((coalesce(task_frequency_log.avg_duration_seconds, 0) * task_frequency_log.execution_count)
              + ${input.durationSeconds}) / (task_frequency_log.execution_count + 1)
          `,
          last_executed_at: sql<string>`
            CASE
              WHEN task_frequency_log.last_executed_at IS NULL
                OR excluded.last_executed_at > task_frequency_log.last_executed_at
              THEN excluded.last_executed_at
              ELSE task_frequency_log.last_executed_at
            END
          `,
          manual_intervention_count: sql<number>`
            task_frequency_log.manual_intervention_count + excluded.manual_intervention_count
          `
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return toTaskFrequencyRecord(row);
  }

  async findBySignature(taskSignature: string): Promise<TaskFrequencyRecord | undefined> {
    const row = await this.db
      .selectFrom('task_frequency_log')
      .selectAll()
      .where('task_signature', '=', taskSignature)
      .executeTakeFirst();

    return row === undefined ? undefined : toTaskFrequencyRecord(row);
  }

  async findAtOrAbove(
    minimumExecutionCount: number,
    limit: number = DEFAULT_RESULT_LIMIT
  ): Promise<TaskFrequencyRecord[]> {
    const safeLimit = validateLimit(limit);
    const rows = await this.db
      .selectFrom('task_frequency_log')
      .selectAll()
      .where('execution_count', '>=', minimumExecutionCount)
      .orderBy('execution_count', 'desc')
      .orderBy('task_signature', 'asc')
      .limit(safeLimit)
      .execute();

    return rows.map(toTaskFrequencyRecord);
  }
}
