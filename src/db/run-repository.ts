import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';

import type { AgentRun, JsonValue } from '../config/schemas';
import { AgentRunSchema } from '../config/schemas';
import type { RunSupervisor } from '../dashboard/run-supervision';
import { deriveRunSupervisor } from '../dashboard/run-supervision';
import {
  enqueueMemoryMaintenance,
  type MemoryMaintenanceBinding
} from '../memory/system/memory-maintenance-outbox';
import type { AgentRunsTable, JarvisDatabase } from './types';

export interface CreateRunningRunInput {
  id: string;
  clientId: string;
  automation: string;
  input?: JsonValue;
  parentRunId?: string | null;
  workerId: string;
  startedAt: string;
}

export interface CompleteRunInput {
  output: JsonValue;
  completedAt: string;
  memoryMaintenance?: MemoryMaintenanceBinding;
}

export interface FailRunInput {
  errorMessage: string;
  completedAt: string;
  memoryMaintenance?: MemoryMaintenanceBinding;
}

export interface DashboardRunSummary {
  counts: Record<'pending' | 'running' | 'succeeded' | 'failed', number>;
  recent: Array<{
    id: string;
    clientId: string;
    automation: string;
    status: 'pending' | 'running' | 'succeeded' | 'failed';
    workerId: string | null;
    startedAt: string;
    completedAt: string | null;
    parentRunId: string | null;
    /** Derived from recorded edges only; see dashboard/run-supervision.ts. */
    supervisor: RunSupervisor;
  }>;
}

const JsonValueSchema = z.json();
const CompletionTimestampSchema = z.iso.datetime();
const ErrorMessageSchema = z.string().min(1).max(4000);

function validateDashboardLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('dashboard limit must be an integer between 1 and 100');
  }
  return limit;
}

function serializeJson(value: JsonValue | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value: string | null): JsonValue | undefined {
  if (value === null) {
    return undefined;
  }

  const parsed: unknown = JSON.parse(value);
  return JsonValueSchema.parse(parsed);
}

function toAgentRun(row: Selectable<AgentRunsTable>): AgentRun {
  return AgentRunSchema.parse({
    id: row.id,
    clientId: row.client_id,
    automation: row.automation,
    status: row.status,
    input: parseJson(row.input_json),
    output: row.output_json === null ? null : parseJson(row.output_json),
    errorMessage: row.error_message,
    parentRunId: row.parent_run_id,
    workerId: row.worker_id,
    startedAt: row.started_at,
    completedAt: row.completed_at
  });
}

export class RunRepository {
  constructor(private readonly db: Kysely<JarvisDatabase>) {}

  async createRunning(input: CreateRunningRunInput): Promise<AgentRun> {
    const run = AgentRunSchema.parse({
      id: input.id,
      clientId: input.clientId,
      automation: input.automation,
      status: 'running',
      ...(input.input === undefined ? {} : { input: input.input }),
      output: null,
      errorMessage: null,
      parentRunId: input.parentRunId ?? null,
      workerId: input.workerId,
      startedAt: input.startedAt,
      completedAt: null
    });
    const row = await this.db
      .insertInto('agent_runs')
      .values({
        id: run.id,
        client_id: run.clientId,
        automation: run.automation,
        status: 'running',
        input_json: serializeJson(run.input),
        output_json: null,
        error_message: null,
        parent_run_id: run.parentRunId,
        worker_id: run.workerId,
        started_at: run.startedAt,
        completed_at: null
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toAgentRun(row);
  }

  async findById(id: string): Promise<AgentRun | undefined> {
    const row = await this.db
      .selectFrom('agent_runs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : toAgentRun(row);
  }

  async listRunning(): Promise<AgentRun[]> {
    const rows = await this.db
      .selectFrom('agent_runs')
      .selectAll()
      .where('status', '=', 'running')
      .orderBy('started_at', 'asc')
      .orderBy('id', 'asc')
      .execute();

    return rows.map(toAgentRun);
  }

  async listPendingRecovery(): Promise<AgentRun[]> {
    const rows = await this.db
      .selectFrom('run_recovery_queue')
      .innerJoin('agent_runs', 'agent_runs.id', 'run_recovery_queue.run_id')
      .selectAll('agent_runs')
      .orderBy('run_recovery_queue.queued_at', 'asc')
      .orderBy('run_recovery_queue.run_id', 'asc')
      .execute();

    return rows.map(toAgentRun);
  }

  /**
   * A deliberately redacted read model for the operator dashboard. In
   * particular, this query never selects input, output, or error columns.
   */
  async dashboardSummary(limit: number): Promise<DashboardRunSummary> {
    const safeLimit = validateDashboardLimit(limit);
    const [statusRows, recent] = await Promise.all([
      this.db
        .selectFrom('agent_runs')
        .select(['status', (expression) => expression.fn.countAll<number>().as('count')])
        .groupBy('status')
        .execute(),
      // The self-join resolves only the delegating run's automation name, which
      // the supervisor label needs. It still selects no input/output/error column.
      this.db
        .selectFrom('agent_runs as run')
        .leftJoin('agent_runs as parent', 'parent.id', 'run.parent_run_id')
        .select([
          'run.id as id',
          'run.client_id as clientId',
          'run.automation as automation',
          'run.status as status',
          'run.worker_id as workerId',
          'run.started_at as startedAt',
          'run.completed_at as completedAt',
          'run.parent_run_id as parentRunId',
          'parent.automation as parentAutomation'
        ])
        .orderBy('run.started_at', 'desc')
        .orderBy('run.id', 'asc')
        .limit(safeLimit)
        .execute()
    ]);
    const counts: DashboardRunSummary['counts'] = {
      pending: 0,
      running: 0,
      succeeded: 0,
      failed: 0
    };
    for (const row of statusRows) {
      counts[row.status] = Number(row.count);
    }

    return {
      counts,
      recent: recent.map(({ parentAutomation, ...run }) => ({
        ...run,
        supervisor: deriveRunSupervisor({ ...run, parentAutomation })
      }))
    };
  }

  async markSucceeded(id: string, input: CompleteRunInput): Promise<AgentRun | undefined> {
    const output = JsonValueSchema.parse(input.output);
    const completedAt = CompletionTimestampSchema.parse(input.completedAt);
    return this.db.transaction().execute(async (transaction) => {
      const row = await transaction
        .updateTable('agent_runs')
        .set({
          status: 'succeeded',
          output_json: serializeJson(output),
          error_message: null,
          completed_at: completedAt
        })
        .where('id', '=', id)
        .where('status', '=', 'running')
        .returningAll()
        .executeTakeFirst();
      if (row === undefined) return undefined;
      if (input.memoryMaintenance !== undefined) {
        await enqueueMemoryMaintenance(transaction, input.memoryMaintenance, id, completedAt);
      }
      return toAgentRun(row);
    });
  }

  async markFailed(id: string, input: FailRunInput): Promise<AgentRun | undefined> {
    const errorMessage = ErrorMessageSchema.parse(input.errorMessage);
    const completedAt = CompletionTimestampSchema.parse(input.completedAt);
    return this.db.transaction().execute(async (transaction) => {
      const row = await transaction
        .updateTable('agent_runs')
        .set({
          status: 'failed',
          output_json: null,
          error_message: errorMessage,
          completed_at: completedAt
        })
        .where('id', '=', id)
        .where('status', '=', 'running')
        .returningAll()
        .executeTakeFirst();
      if (row === undefined) return undefined;
      if (input.memoryMaintenance !== undefined) {
        await enqueueMemoryMaintenance(transaction, input.memoryMaintenance, id, completedAt);
      }
      return toAgentRun(row);
    });
  }

  async markInterruptedForRecovery(id: string, input: FailRunInput): Promise<AgentRun | undefined> {
    const errorMessage = ErrorMessageSchema.parse(input.errorMessage);
    const completedAt = CompletionTimestampSchema.parse(input.completedAt);

    return this.db.transaction().execute(async (transaction) => {
      let row = await transaction
        .selectFrom('agent_runs')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (row === undefined || !['running', 'failed'].includes(row.status)) {
        return undefined;
      }

      if (row.status === 'running') {
        row = await transaction
          .updateTable('agent_runs')
          .set({
            status: 'failed',
            output_json: null,
            error_message: errorMessage,
            completed_at: completedAt
          })
          .where('id', '=', id)
          .where('status', '=', 'running')
          .returningAll()
          .executeTakeFirst();
        if (row === undefined) return undefined;
      }

      if (input.memoryMaintenance !== undefined) {
        await enqueueMemoryMaintenance(
          transaction,
          input.memoryMaintenance,
          id,
          row.completed_at ?? completedAt
        );
      }

      await transaction
        .insertInto('run_recovery_queue')
        .values({
          run_id: id,
          queued_at: row.completed_at ?? completedAt,
          audit_id: null
        })
        .onConflict((conflict) => conflict.column('run_id').doNothing())
        .execute();

      return toAgentRun(row);
    });
  }

  async clearPendingRecovery(id: string): Promise<boolean> {
    const removed = await this.db
      .deleteFrom('run_recovery_queue')
      .where('run_id', '=', id)
      .returning('run_id')
      .executeTakeFirst();
    return removed !== undefined;
  }
}
