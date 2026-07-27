import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { z } from 'zod';

import type { ClientRecord } from '../db/client-repository';
import type { AuditRepository } from '../db/audit-repository';
import type { RunRepository } from '../db/run-repository';
import type { TaskFrequencyRepository } from '../db/task-frequency-repository';
import type { MarkdownGraph } from '../memory/markdown-graph';
import { AppError } from '../utils/errors';
import {
  AgentRunSchema,
  AutomationIdSchema,
  ClientIdSchema,
  EscalationEventSchema,
  RunIdSchema,
  type AgentRun,
  type JsonValue
} from '../config/schemas';
import type { PolicyService } from '../config/policies';
import type { EscalationPolicy } from './escalation';
import type { FlowLogger, Worker, WorkerContext } from './contracts';
import type { WorkerRegistry } from './worker-registry';

const JsonValueSchema = z.json();
const TimestampSchema = z.iso.datetime();
// The supervisor depends on a subset of the agency execution posture record: the
// callers supply the full durable row, so unknown keys are stripped rather than
// rejected. The two safety-critical fields stay strictly validated.
const ExecutionPostureCheckpointSchema = z.object({
  posture: z.enum(['active', 'paused']),
  version: z.number().int().min(1)
});

export interface SupervisorRunInput {
  clientId: string;
  automation: string;
  runId?: string;
  input?: JsonValue;
}

export type CompletedAgentRun = AgentRun & {
  status: 'succeeded' | 'failed';
  completedAt: string;
};

export interface SupervisorRunResult {
  run: CompletedAgentRun;
  result: JsonValue;
  diagramPath: string;
  warnings?: SupervisorWarning[];
}

export interface SupervisorWarning {
  code: 'WORKER_RELEASE_FAILED' | 'FREQUENCY_RECORD_FAILED' | 'POST_SUCCESS_AUDIT_FAILED';
  message: string;
}

interface ClientLookup {
  findById(id: string): Promise<ClientRecord | undefined>;
}

export interface SupervisorOptions {
  clients: ClientLookup;
  policies: PolicyService;
  workers: WorkerRegistry;
  runs: RunRepository;
  audits: AuditRepository;
  frequency: TaskFrequencyRepository;
  escalation: EscalationPolicy;
  memory: Pick<MarkdownGraph, 'recordRun'>;
  loggerFactory: () => FlowLogger;
  clientRoot: string;
  idFactory?: () => string;
  now?: () => string;
  executionPosture: () =>
    | { posture: 'active' | 'paused'; version: number }
    | Promise<{ posture: 'active' | 'paused'; version: number }>;
}

function failureMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown worker failure';
  return message.trim().slice(0, 4000) || 'Unknown worker failure';
}

function completedRun(
  run: AgentRun | undefined,
  expectedStatus: 'succeeded' | 'failed'
): CompletedAgentRun {
  if (run === undefined || run.status !== expectedStatus || run.completedAt === null) {
    throw new AppError(500, 'RUN_STATE_ERROR', 'Agent run state transition failed');
  }
  return run as CompletedAgentRun;
}

function durationSeconds(startedAt: string, completedAt: string): number {
  return Math.max(0, (Date.parse(completedAt) - Date.parse(startedAt)) / 1000);
}

export class Supervisor {
  private readonly idFactory: () => string;
  private readonly now: () => string;

  constructor(private readonly options: SupervisorOptions) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async run(input: SupervisorRunInput): Promise<SupervisorRunResult> {
    const executionPostureVersion = await this.assertExecutionAllowed();
    const clientId = ClientIdSchema.parse(input.clientId);
    const automation = AutomationIdSchema.parse(input.automation);
    const client = await this.options.clients.findById(clientId);
    if (client === undefined) {
      throw new AppError(404, 'CLIENT_NOT_FOUND', `Client ${clientId} was not found`);
    }
    if (client.status !== 'active') {
      throw new AppError(409, 'CLIENT_SUSPENDED', `Client ${clientId} is suspended`);
    }

    const toolPolicy = this.options.policies.resolveToolPolicy(client.profile);
    const networkPolicy = this.options.policies.resolveNetworkPolicy(clientId);
    const worker = this.options.workers.resolve(clientId, automation);
    const runId = RunIdSchema.parse(input.runId ?? this.idFactory());
    const startedAt = TimestampSchema.parse(this.now());
    const clientDirectory = join(this.options.clientRoot, clientId);
    const logger = this.options.loggerFactory();
    logger.start(runId);
    logger.log('Gateway', 'Supervisor', `run ${automation}`);

    const runningRun = await this.options.runs.createRunning({
      id: runId,
      clientId,
      automation,
      ...(input.input === undefined ? {} : { input: input.input }),
      parentRunId: null,
      workerId: worker.id,
      startedAt
    });
    logger.log('Supervisor', worker.id, `execute ${automation}`);

    const workerContext: WorkerContext = {
      clientId,
      automation,
      runId,
      clientRoot: this.options.clientRoot,
      clientDirectory,
      memoryDirectory: join(clientDirectory, 'memory'),
      ...(input.input === undefined ? {} : { input: input.input }),
      toolPolicy,
      networkPolicy,
      logger
    };

    let result: JsonValue;
    try {
      result = JsonValueSchema.parse(await worker.execute(workerContext));
    } catch (error) {
      return this.handleRunFailure({
        error,
        runningRun,
        clientId,
        automation,
        startedAt,
        clientDirectory,
        worker,
        workerContext
      });
    }

    let completedAt: string | undefined;
    try {
      // Re-check immediately before the worker's externally visible commit so
      // a kill switch engaged during execution forces rollback and a failed run.
      await this.assertExecutionAllowed(executionPostureVersion);
      await worker.commit?.(workerContext, result);
      completedAt = TimestampSchema.parse(this.now());
      const succeededRun = completedRun(
        AgentRunSchema.parse({
          ...runningRun,
          status: 'succeeded',
          output: result,
          errorMessage: null,
          completedAt
        }),
        'succeeded'
      );
      await this.options.memory.recordRun({ run: succeededRun, clientDirectory });
      logger.log(worker.id, 'Supervisor', 'succeeded');
      logger.log('Supervisor', 'Gateway', 'completed');
      const diagramPath = await logger.save();
      const run = completedRun(
        await this.options.runs.markSucceeded(runId, { output: result, completedAt }),
        'succeeded'
      );
      const warnings = await this.recordFrequencyAfterSuccess({
        clientId,
        automation,
        runId,
        startedAt,
        completedAt
      });
      warnings.push(
        ...(await this.releaseAfterSuccess({
          worker,
          workerContext,
          clientId,
          automation,
          runId,
          completedAt
        }))
      );

      return {
        run,
        result,
        diagramPath,
        ...(warnings.length === 0 ? {} : { warnings })
      };
    } catch (error) {
      return this.handleRunFailure({
        error,
        runningRun,
        worker,
        clientId,
        automation,
        startedAt,
        clientDirectory,
        workerContext,
        completedAt
      });
    }
  }

  private async assertExecutionAllowed(expectedVersion?: number): Promise<number> {
    const posture = ExecutionPostureCheckpointSchema.parse(await this.options.executionPosture());
    if (posture.posture === 'paused') {
      throw new AppError(
        503,
        'AGENCY_KILL_SWITCH_ENGAGED',
        'Agency execution is paused by the kill switch'
      );
    }
    if (expectedVersion !== undefined && posture.version !== expectedVersion) {
      throw new AppError(
        503,
        'AGENCY_EXECUTION_POSTURE_CHANGED',
        'Agency execution posture changed during the run'
      );
    }
    return posture.version;
  }

  private async handleRunFailure(input: {
    error: unknown;
    runningRun: AgentRun;
    clientId: string;
    automation: string;
    startedAt: string;
    clientDirectory: string;
    worker: Worker;
    workerContext: WorkerContext;
    completedAt?: string;
  }): Promise<never> {
    const completedAt = input.completedAt ?? this.safeCompletionTimestamp(input.startedAt);
    const message = failureMessage(input.error);
    const failedRun = completedRun(
      AgentRunSchema.parse({
        ...input.runningRun,
        status: 'failed',
        output: null,
        errorMessage: message,
        completedAt
      }),
      'failed'
    );
    const event = this.options.escalation.classifyAutomationFailure({
      clientId: input.clientId,
      runId: input.runningRun.id,
      automation: input.automation,
      error: message,
      timestamp: completedAt
    });

    const recordingErrors: unknown[] = [];
    try {
      await input.worker.rollback?.(input.workerContext);
    } catch (error) {
      recordingErrors.push(error);
    }
    try {
      completedRun(
        await this.options.runs.markFailed(input.runningRun.id, {
          errorMessage: message,
          completedAt
        }),
        'failed'
      );
    } catch (error) {
      recordingErrors.push(error);
    }
    try {
      await this.options.audits.record(event);
    } catch (error) {
      recordingErrors.push(error);
    }
    try {
      await this.options.memory.recordRun({
        run: failedRun,
        clientDirectory: input.clientDirectory
      });
    } catch (error) {
      recordingErrors.push(error);
    }
    try {
      const logger = this.options.loggerFactory();
      logger.start(input.runningRun.id);
      logger.log('Gateway', 'Supervisor', `run ${input.automation}`);
      logger.log('Supervisor', input.worker.id, `execute ${input.automation}`);
      logger.log(input.worker.id, 'Supervisor', 'failed');
      logger.log('Supervisor', 'Escalation', 'P1');
      await logger.save();
    } catch (error) {
      recordingErrors.push(error);
    }
    if (recordingErrors.length > 0) {
      throw new AppError(
        500,
        'AUTOMATION_FAILURE_RECORDING_FAILED',
        'Automation failed and its evidence could not be fully recorded'
      );
    }

    throw new AppError(500, 'AUTOMATION_FAILED', `Automation ${input.automation} failed`);
  }

  private safeCompletionTimestamp(startedAt: string): string {
    try {
      return TimestampSchema.parse(this.now());
    } catch {
      return new Date(Math.max(Date.now(), Date.parse(startedAt))).toISOString();
    }
  }

  private async releaseAfterSuccess(input: {
    worker: Worker;
    workerContext: WorkerContext;
    clientId: string;
    automation: string;
    runId: string;
    completedAt: string;
  }): Promise<SupervisorWarning[]> {
    try {
      await input.worker.release?.(input.workerContext);
      return [];
    } catch (error) {
      const warnings: SupervisorWarning[] = [
        {
          code: 'WORKER_RELEASE_FAILED',
          message: 'Worker cleanup requires attention'
        }
      ];
      const event = EscalationEventSchema.parse({
        severity: 'P2',
        clientId: input.clientId,
        runId: input.runId,
        eventDescription: `Automation ${input.automation} cleanup failed after success: ${failureMessage(error)}`,
        actions: ['Inspect worker cleanup state', 'Retry bounded cleanup if safe'],
        resolved: false,
        timestamp: input.completedAt
      });
      try {
        await this.options.audits.record(event);
      } catch {
        warnings.push({
          code: 'POST_SUCCESS_AUDIT_FAILED',
          message: 'Post-success warning could not be persisted'
        });
      }
      return warnings;
    }
  }

  private async recordFrequencyAfterSuccess(input: {
    clientId: string;
    automation: string;
    runId: string;
    startedAt: string;
    completedAt: string;
  }): Promise<SupervisorWarning[]> {
    try {
      await this.options.frequency.recordExecution({
        taskSignature: `${input.clientId}:${input.automation}`,
        durationSeconds: durationSeconds(input.startedAt, input.completedAt),
        executedAt: input.completedAt
      });
      return [];
    } catch (error) {
      const warnings: SupervisorWarning[] = [
        {
          code: 'FREQUENCY_RECORD_FAILED',
          message: 'Run frequency metrics require attention'
        }
      ];
      const event = EscalationEventSchema.parse({
        severity: 'P2',
        clientId: input.clientId,
        runId: input.runId,
        eventDescription: `Automation ${input.automation} frequency recording failed after success: ${failureMessage(error)}`,
        actions: ['Inspect task frequency metrics', 'Rebuild derived metrics if needed'],
        resolved: false,
        timestamp: input.completedAt
      });
      try {
        await this.options.audits.record(event);
      } catch {
        warnings.push({
          code: 'POST_SUCCESS_AUDIT_FAILED',
          message: 'Post-success warning could not be persisted'
        });
      }
      return warnings;
    }
  }
}
