import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as waitForImmediate } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BasicWorker,
  FlowLogger,
  TransactionalWorker as TransactionalWorkerContract,
  Worker,
  WorkerContext
} from '../../src/agents/contracts';
import { EscalationPolicy } from '../../src/agents/escalation';
import { Supervisor } from '../../src/agents/supervisor';
import type { AgencyExecutionPosture } from '../../src/agency/execution-posture';
import { WorkerRegistry } from '../../src/agents/worker-registry';
import { PolicyService } from '../../src/config/policies';
import { ClientRepository } from '../../src/db/client-repository';
import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import { RunRepository } from '../../src/db/run-repository';
import { TaskFrequencyRepository } from '../../src/db/task-frequency-repository';
import { AuditRepository } from '../../src/db/audit-repository';
import { MarkdownGraph } from '../../src/memory/markdown-graph';
import { MermaidLogger } from '../../src/utils/mermaid-logger';

const projectRoot = join(__dirname, '..', '..');
const startedAt = '2026-07-18T12:00:00.000Z';
const completedAt = '2026-07-18T12:00:02.000Z';

interface ExecutionPostureCheckpoint {
  posture: 'active' | 'paused';
  version: number;
}

// The gateway hands the supervisor the full durable posture row, not a trimmed
// checkpoint. Typing this literal as AgencyExecutionPosture keeps the seam honest:
// if the durable record grows a field, this fixture fails to compile.
function durablePostureRecord(
  overrides: Partial<AgencyExecutionPosture> = {}
): AgencyExecutionPosture {
  return {
    posture: 'active',
    version: 1,
    updatedAt: '2026-07-18T11:59:00.000Z',
    updatedBy: 'principal:web_operator',
    reason: 'initialized by gateway startup',
    sourceProposalId: null,
    sourceProposalVersion: null,
    sourceConfirmationFingerprint: null,
    sourceDecisionId: null,
    ...overrides
  };
}

class RecordingWorker implements BasicWorker {
  readonly id = 'acme_daily_report';
  contexts: WorkerContext[] = [];

  constructor(
    private readonly runs: RunRepository,
    private readonly failure?: Error
  ) {}

  async execute(context: WorkerContext) {
    this.contexts.push(context);
    await expect(this.runs.findById(context.runId)).resolves.toMatchObject({
      status: 'running',
      workerId: this.id
    });
    if (this.failure !== undefined) throw this.failure;
    return { qualifiedCount: 4, generatedBy: this.id };
  }
}

class PrematureSaveWorker implements BasicWorker {
  readonly id = 'acme_daily_report';

  constructor(private readonly failure: Error) {}

  async execute(context: WorkerContext): Promise<never> {
    await context.logger.save();
    throw this.failure;
  }
}

class TransactionalWorker implements TransactionalWorkerContract {
  readonly id = 'acme_daily_report';
  commitCalls = 0;
  rollbackCalls = 0;
  releaseCalls = 0;
  published = false;

  execute(): Promise<{ qualifiedCount: number }> {
    return Promise.resolve({ qualifiedCount: 5 });
  }

  commit(): Promise<void> {
    this.commitCalls += 1;
    this.published = true;
    return Promise.resolve();
  }

  rollback(): Promise<void> {
    this.rollbackCalls += 1;
    this.published = false;
    return Promise.resolve();
  }

  release(): void {
    this.releaseCalls += 1;
  }
}

class DeferredReleaseWorker extends TransactionalWorker {
  releaseStarted = false;
  private resolveRelease = (): void => undefined;
  private readonly releaseGate = new Promise<void>((resolveRelease) => {
    this.resolveRelease = resolveRelease;
  });

  override async release(): Promise<void> {
    this.releaseCalls += 1;
    this.releaseStarted = true;
    await this.releaseGate;
  }

  finishRelease(): void {
    this.resolveRelease();
  }
}

class FailingReleaseWorker extends TransactionalWorker {
  override async release(): Promise<void> {
    this.releaseCalls += 1;
    await Promise.resolve();
    throw new Error('in-memory release failed');
  }
}

function failFirstSaveFactory(diagramsRoot: string, failure: Error): () => FlowLogger {
  let invocation = 0;
  return () => {
    const logger = new MermaidLogger({ diagramsRoot });
    invocation += 1;
    if (invocation !== 1) return logger;
    return {
      start: (taskId) => logger.start(taskId),
      log: (from, to, message) => logger.log(from, to, message),
      save: () => Promise.reject(failure)
    };
  };
}

describe('Supervisor', () => {
  let temporaryRoot: string;
  let database: GlobalDatabaseContext;
  let clients: ClientRepository;
  let runs: RunRepository;
  let audits: AuditRepository;
  let frequency: TaskFrequencyRepository;
  let policies: PolicyService;
  let escalation: EscalationPolicy;
  let graph: MarkdownGraph;
  let clientDirectory: string;
  let diagramsRoot: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-supervisor-'));
    database = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    clients = new ClientRepository(database.db);
    runs = new RunRepository(database.db);
    audits = new AuditRepository(database.db);
    frequency = new TaskFrequencyRepository(database.db);
    policies = await PolicyService.load({ projectRoot });
    escalation = await EscalationPolicy.load({ projectRoot });
    clientDirectory = join(temporaryRoot, 'clients', 'acme_corp');
    diagramsRoot = join(temporaryRoot, 'logs', 'diagrams');
    graph = new MarkdownGraph({
      graphRoot: join(temporaryRoot, 'memory', 'graph'),
      now: () => completedAt
    });
    await clients.create({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing',
      status: 'active',
      createdAt: startedAt
    });
    await graph.createClientNode({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing',
      createdAt: startedAt,
      clientDirectory
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await database.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  function createSupervisor(
    worker: Worker | undefined,
    runIds = ['run-001'],
    overrides: {
      memory?: Pick<MarkdownGraph, 'recordRun'>;
      loggerFactory?: () => FlowLogger;
      now?: () => string;
      executionPosture?: () =>
        | ExecutionPostureCheckpoint
        | AgencyExecutionPosture
        | Promise<ExecutionPostureCheckpoint | AgencyExecutionPosture>;
    } = {}
  ): Supervisor {
    const timestamps = [startedAt, completedAt];
    return new Supervisor({
      clients,
      policies,
      workers: new WorkerRegistry(
        worker === undefined ? [] : [{ clientId: 'acme_corp', automation: 'daily-report', worker }]
      ),
      runs,
      audits,
      frequency,
      escalation,
      memory: overrides.memory ?? graph,
      loggerFactory: overrides.loggerFactory ?? (() => new MermaidLogger({ diagramsRoot })),
      clientRoot: join(temporaryRoot, 'clients'),
      idFactory: () => {
        const id = runIds.shift();
        if (id === undefined) throw new Error('No test run id remains');
        return id;
      },
      now:
        overrides.now ??
        (() => {
          const timestamp = timestamps.shift();
          if (timestamp === undefined) throw new Error('No test timestamp remains');
          return timestamp;
        }),
      executionPosture:
        overrides.executionPosture ?? (() => ({ posture: 'active' as const, version: 1 }))
    });
  }

  it('executes a registered worker with running provenance and persists all success evidence', async () => {
    const worker = new RecordingWorker(runs);
    const supervisor = createSupervisor(worker);

    const result = await supervisor.run({
      clientId: 'acme_corp',
      automation: 'daily-report',
      input: { status: 'qualified' }
    });

    expect(result).toMatchObject({
      run: {
        id: 'run-001',
        clientId: 'acme_corp',
        automation: 'daily-report',
        status: 'succeeded',
        workerId: worker.id,
        completedAt
      },
      result: { qualifiedCount: 4, generatedBy: worker.id },
      diagramPath: join(diagramsRoot, 'flow_run-001.md')
    });
    expect(worker.contexts).toHaveLength(1);
    expect(worker.contexts[0]).toMatchObject({
      runId: 'run-001',
      clientRoot: join(temporaryRoot, 'clients'),
      clientDirectory,
      memoryDirectory: join(clientDirectory, 'memory'),
      input: { status: 'qualified' },
      toolPolicy: { tools_allow: ['read', 'write', 'exec'] },
      networkPolicy: { mode: 'none' }
    });
    await expect(runs.findById('run-001')).resolves.toMatchObject({
      status: 'succeeded',
      output: { qualifiedCount: 4, generatedBy: worker.id },
      parentRunId: null,
      workerId: worker.id
    });
    await expect(frequency.findBySignature('acme_corp:daily-report')).resolves.toMatchObject({
      executionCount: 1,
      avgDurationSeconds: 2,
      lastExecutedAt: completedAt
    });
    const diagram = await readFile(result.diagramPath, 'utf8');
    const handoffs = [
      'Gateway->>Supervisor: run daily-report',
      `Supervisor->>${worker.id}: execute daily-report`,
      `${worker.id}->>Supervisor: succeeded`,
      'Supervisor->>Gateway: completed'
    ];
    const positions = handoffs.map((handoff) => diagram.indexOf(handoff));
    for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);
    for (let index = 1; index < handoffs.length; index += 1) {
      expect(diagram.indexOf(handoffs[index] ?? '')).toBeGreaterThan(
        diagram.indexOf(handoffs[index - 1] ?? '')
      );
    }
    expect(
      await readFile(join(temporaryRoot, 'memory', 'graph', 'runs', 'run-001.md'), 'utf8')
    ).toContain('Status: `succeeded`');
  });

  it('fails before creating a run when the agency kill switch is engaged', async () => {
    const worker = new TransactionalWorker();
    const supervisor = createSupervisor(worker, ['unused-run'], {
      executionPosture: () => ({ posture: 'paused', version: 2 })
    });

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).rejects.toMatchObject({ statusCode: 503, code: 'AGENCY_KILL_SWITCH_ENGAGED' });
    expect(worker.commitCalls).toBe(0);
    expect(await runs.listRunning()).toEqual([]);
  });

  it('rolls back instead of committing when the kill switch engages during execution', async () => {
    const worker = new TransactionalWorker();
    const executionPosture = vi
      .fn()
      .mockReturnValueOnce({ posture: 'active', version: 1 })
      .mockReturnValue({ posture: 'paused', version: 2 });
    const supervisor = createSupervisor(worker, ['run-kill-switch'], { executionPosture });

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).rejects.toMatchObject({ statusCode: 500, code: 'AUTOMATION_FAILED' });
    expect(worker.commitCalls).toBe(0);
    expect(worker.rollbackCalls).toBe(1);
    await expect(runs.findById('run-kill-switch')).resolves.toMatchObject({ status: 'failed' });
  });

  it('rolls back when an active posture epoch changes before commit', async () => {
    const worker = new TransactionalWorker();
    const executionPosture = vi
      .fn()
      .mockReturnValueOnce({ posture: 'active', version: 4 })
      .mockReturnValue({ posture: 'active', version: 6 });
    const supervisor = createSupervisor(worker, ['run-posture-epoch'], { executionPosture });

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).rejects.toMatchObject({ statusCode: 500, code: 'AUTOMATION_FAILED' });
    expect(worker.commitCalls).toBe(0);
    expect(worker.rollbackCalls).toBe(1);
    await expect(runs.findById('run-posture-epoch')).resolves.toMatchObject({ status: 'failed' });
  });

  it('accepts the full durable posture record the gateway supplies', async () => {
    const worker = new RecordingWorker(runs);
    const supervisor = createSupervisor(worker, ['run-durable-posture'], {
      executionPosture: () => durablePostureRecord({ version: 3 })
    });

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).resolves.toMatchObject({ run: { status: 'succeeded' } });
  });

  it('honours the kill switch carried on a full durable posture record', async () => {
    const worker = new TransactionalWorker();
    const supervisor = createSupervisor(worker, ['unused-durable-run'], {
      executionPosture: () =>
        durablePostureRecord({
          posture: 'paused',
          version: 2,
          reason: 'operator engaged the kill switch'
        })
    });

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).rejects.toMatchObject({ statusCode: 503, code: 'AGENCY_KILL_SWITCH_ENGAGED' });
    expect(worker.commitCalls).toBe(0);
    expect(await runs.listRunning()).toEqual([]);
  });

  it('rejects a posture record whose safety fields are malformed', async () => {
    const worker = new TransactionalWorker();
    const supervisor = createSupervisor(worker, ['unused-malformed-run'], {
      executionPosture: () =>
        ({ posture: 'active', version: 0 }) as unknown as AgencyExecutionPosture
    });

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).rejects.toThrow();
    expect(worker.commitCalls).toBe(0);
    expect(await runs.listRunning()).toEqual([]);
  });

  it('commits a prepared worker artifact before success and releases its state afterward', async () => {
    const worker = new TransactionalWorker();
    let clockCalls = 0;
    const supervisor = createSupervisor(worker, ['run-transaction-success'], {
      now: () => {
        clockCalls += 1;
        if (clockCalls === 1) return startedAt;
        expect(worker.published).toBe(true);
        return completedAt;
      }
    });

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).resolves.toMatchObject({ run: { status: 'succeeded' } });

    expect(worker).toMatchObject({
      commitCalls: 1,
      rollbackCalls: 0,
      releaseCalls: 1,
      published: true
    });
  });

  it('uses a validated internal run id so queue retries share one durable execution key', async () => {
    const worker = new RecordingWorker(runs);
    const supervisor = createSupervisor(worker, []);
    const runId = 'queue_e995410c9252c25f97e7d06a7b488d06dff84afdf3b88f4f5ba688ad65664970';

    const result = await supervisor.run({
      clientId: 'acme_corp',
      automation: 'daily-report',
      runId
    });

    expect(result.run.id).toBe(runId);
    expect(worker.contexts[0]?.runId).toBe(runId);
    await expect(runs.findById(runId)).resolves.toMatchObject({
      id: runId,
      status: 'succeeded'
    });
  });

  it('awaits asynchronous transactional release before resolving success', async () => {
    const worker = new DeferredReleaseWorker();
    const supervisor = createSupervisor(worker, ['run-deferred-release']);
    let settled = false;
    const runPromise = supervisor
      .run({ clientId: 'acme_corp', automation: 'daily-report' })
      .then((result) => {
        settled = true;
        return result;
      });

    await vi.waitFor(() => expect(worker.releaseStarted).toBe(true));
    await waitForImmediate();
    expect(settled).toBe(false);

    worker.finishRelease();
    await expect(runPromise).resolves.toMatchObject({ run: { status: 'succeeded' } });
  });

  it('surfaces and audits release failure without reversing durable success', async () => {
    const worker = new FailingReleaseWorker();
    const supervisor = createSupervisor(worker, ['run-release-failure']);

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).resolves.toMatchObject({
      run: { status: 'succeeded' },
      warnings: [
        {
          code: 'WORKER_RELEASE_FAILED',
          message: 'Worker cleanup requires attention'
        }
      ]
    });
    await expect(runs.findById('run-release-failure')).resolves.toMatchObject({
      status: 'succeeded'
    });
    const audit = await database.db.selectFrom('audit_logs').selectAll().executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ severity: 'P2', client_id: 'acme_corp', resolved: 0 });
    expect(audit.event_description).toContain('cleanup failed after success');
  });

  it('rolls back staged state when the post-execute completion clock is invalid', async () => {
    const worker = new TransactionalWorker();
    let clockCalls = 0;
    const supervisor = createSupervisor(worker, ['run-invalid-completion-clock'], {
      now: () => {
        clockCalls += 1;
        return clockCalls === 1 ? startedAt : 'not-an-iso-timestamp';
      }
    });

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).rejects.toMatchObject({ code: 'AUTOMATION_FAILED' });

    expect(worker).toMatchObject({
      commitCalls: 1,
      rollbackCalls: 1,
      releaseCalls: 0,
      published: false
    });
    await expect(runs.findById('run-invalid-completion-clock')).resolves.toMatchObject({
      status: 'failed'
    });
  });

  it('rolls back a committed worker artifact when later success evidence fails', async () => {
    const secret = 'run completion failed after artifact commit';
    vi.spyOn(runs, 'markSucceeded').mockRejectedValueOnce(new Error(secret));
    const worker = new TransactionalWorker();
    const supervisor = createSupervisor(worker, ['run-transaction-rollback']);

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).rejects.toMatchObject({ code: 'AUTOMATION_FAILED' });

    expect(worker).toMatchObject({
      commitCalls: 1,
      rollbackCalls: 1,
      releaseCalls: 0,
      published: false
    });
    await expectFailureEvidence('run-transaction-rollback', secret);
  });

  it('persists failed run, P1 audit, trace, and safe memory before throwing a safe error', async () => {
    const secret = 'CSV password hunter2 must remain internal';
    const worker = new RecordingWorker(runs, new Error(secret));
    const supervisor = createSupervisor(worker, ['run-002']);

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).rejects.toMatchObject({
      statusCode: 500,
      code: 'AUTOMATION_FAILED',
      message: 'Automation daily-report failed'
    });

    await expect(runs.findById('run-002')).resolves.toMatchObject({
      status: 'failed',
      output: null,
      errorMessage: secret,
      workerId: worker.id,
      completedAt
    });
    const audit = await database.db.selectFrom('audit_logs').selectAll().executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ severity: 'P1', client_id: 'acme_corp', resolved: 0 });
    expect(audit.event_description).toContain('run-002');
    expect(audit.event_description).toContain(secret);
    await expect(frequency.findBySignature('acme_corp:daily-report')).resolves.toBeUndefined();
    const diagram = await readFile(join(diagramsRoot, 'flow_run-002.md'), 'utf8');
    expect(diagram).toContain(`${worker.id}->>Supervisor: failed`);
    expect(diagram).toContain('Supervisor->>Escalation: P1');
    const memory = await readFile(
      join(temporaryRoot, 'memory', 'graph', 'runs', 'run-002.md'),
      'utf8'
    );
    expect(memory).toContain('Status: `failed`');
    expect(memory).not.toContain(secret);
  });

  it('converts a success-memory evidence failure into a fully evidenced failed run', async () => {
    const secret = 'private memory write details must remain internal';
    const recordRun = graph.recordRun.bind(graph);
    const memory = {
      recordRun: vi.fn(async (input: Parameters<MarkdownGraph['recordRun']>[0]) => {
        if (input.run.status === 'succeeded') throw new Error(secret);
        return recordRun(input);
      })
    };
    const supervisor = createSupervisor(new RecordingWorker(runs), ['run-memory-failure'], {
      memory
    });

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).rejects.toMatchObject({
      statusCode: 500,
      code: 'AUTOMATION_FAILED',
      message: 'Automation daily-report failed'
    });

    await expectFailureEvidence('run-memory-failure', secret);
    expect(memory.recordRun).toHaveBeenCalledTimes(2);
  });

  it('surfaces and audits frequency failure without reversing durable success', async () => {
    const secret = 'frequency database internals must remain private';
    vi.spyOn(frequency, 'recordExecution').mockRejectedValueOnce(new Error(secret));
    const supervisor = createSupervisor(new RecordingWorker(runs), ['run-frequency-failure']);

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).resolves.toMatchObject({
      run: { status: 'succeeded' },
      warnings: [
        {
          code: 'FREQUENCY_RECORD_FAILED',
          message: 'Run frequency metrics require attention'
        }
      ]
    });

    await expect(runs.findById('run-frequency-failure')).resolves.toMatchObject({
      status: 'succeeded'
    });
    await expect(frequency.findBySignature('acme_corp:daily-report')).resolves.toBeUndefined();
    const audit = await database.db.selectFrom('audit_logs').selectAll().executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ severity: 'P2', client_id: 'acme_corp', resolved: 0 });
    expect(audit.event_description).toContain('frequency recording failed after success');
  });

  it('returns a closed client-not-found error before creating a run', async () => {
    await clients.delete('acme_corp');
    const supervisor = createSupervisor(new RecordingWorker(runs), ['unused-run']);

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).rejects.toMatchObject({ statusCode: 404, code: 'CLIENT_NOT_FOUND' });
    await expect(runs.findById('unused-run')).resolves.toBeUndefined();
  });

  it('normalizes a blank string worker rejection to an unknown safe failure record', async () => {
    const worker: BasicWorker = {
      id: 'acme_daily_report',
      // Deliberately exercise hostile third-party code that rejects with a non-Error value.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      execute: () => Promise.reject('   ')
    };
    const supervisor = createSupervisor(worker, ['run-blank-string-failure']);

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).rejects.toMatchObject({ code: 'AUTOMATION_FAILED' });
    await expect(runs.findById('run-blank-string-failure')).resolves.toMatchObject({
      status: 'failed',
      errorMessage: 'Unknown worker failure'
    });
  });

  it('normalizes a non-error worker rejection to an unknown safe failure record', async () => {
    const worker: BasicWorker = {
      id: 'acme_daily_report',
      // Deliberately exercise hostile third-party code that rejects with a non-Error value.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      execute: () => Promise.reject(null)
    };
    const supervisor = createSupervisor(worker, ['run-null-failure']);

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).rejects.toMatchObject({ code: 'AUTOMATION_FAILED' });
    await expect(runs.findById('run-null-failure')).resolves.toMatchObject({
      status: 'failed',
      errorMessage: 'Unknown worker failure'
    });
  });

  it('reports when automation failure evidence cannot be fully persisted', async () => {
    vi.spyOn(audits, 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    const supervisor = createSupervisor(new RecordingWorker(runs, new Error('worker failed')), [
      'run-evidence-recording-failure'
    ]);

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).rejects.toMatchObject({
      statusCode: 500,
      code: 'AUTOMATION_FAILURE_RECORDING_FAILED'
    });
    await expect(runs.findById('run-evidence-recording-failure')).resolves.toMatchObject({
      status: 'failed'
    });
  });

  it('returns a second warning when a post-success frequency audit also fails', async () => {
    vi.spyOn(frequency, 'recordExecution').mockRejectedValueOnce(
      new Error('frequency unavailable')
    );
    vi.spyOn(audits, 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    const supervisor = createSupervisor(new RecordingWorker(runs), ['run-warning-audit-failure']);

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).resolves.toMatchObject({
      run: { status: 'succeeded' },
      warnings: [{ code: 'FREQUENCY_RECORD_FAILED' }, { code: 'POST_SUCCESS_AUDIT_FAILED' }]
    });
  });

  it('turns a missing success transition row into a failed run', async () => {
    vi.spyOn(runs, 'markSucceeded').mockResolvedValueOnce(undefined);
    const supervisor = createSupervisor(new RecordingWorker(runs), ['run-missing-transition']);

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).rejects.toMatchObject({ code: 'AUTOMATION_FAILED' });
    await expect(runs.findById('run-missing-transition')).resolves.toMatchObject({
      status: 'failed',
      errorMessage: 'Agent run state transition failed'
    });
  });

  it('recovers from a success-trace save failure with a failure trace and evidence', async () => {
    const secret = 'diagram filesystem details must remain private';
    const supervisor = createSupervisor(new RecordingWorker(runs), ['run-trace-failure'], {
      loggerFactory: failFirstSaveFactory(diagramsRoot, new Error(secret))
    });

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).rejects.toMatchObject({
      statusCode: 500,
      code: 'AUTOMATION_FAILED',
      message: 'Automation daily-report failed'
    });

    await expectFailureEvidence('run-trace-failure', secret);
  });

  it('replaces a worker-saved partial trace when that worker later fails', async () => {
    const secret = 'worker failure after premature save must remain internal';
    const supervisor = createSupervisor(new PrematureSaveWorker(new Error(secret)), [
      'run-premature-save'
    ]);

    await expect(
      supervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).rejects.toMatchObject({
      statusCode: 500,
      code: 'AUTOMATION_FAILED',
      message: 'Automation daily-report failed'
    });

    await expectFailureEvidence('run-premature-save', secret);
  });

  it('rejects unknown automation and suspended clients before creating artifacts', async () => {
    const unknownSupervisor = createSupervisor(undefined, ['unused-run']);
    await expect(
      unknownSupervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).rejects.toMatchObject({ statusCode: 404, code: 'AUTOMATION_NOT_FOUND' });

    await clients.updateStatus('acme_corp', 'suspended');
    const suspendedSupervisor = createSupervisor(new RecordingWorker(runs), ['unused-run']);
    await expect(
      suspendedSupervisor.run({ clientId: 'acme_corp', automation: 'daily-report' })
    ).rejects.toMatchObject({ statusCode: 409, code: 'CLIENT_SUSPENDED' });

    const runCount = await database.db
      .selectFrom('agent_runs')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();
    expect(Number(runCount.count)).toBe(0);
    await expect(stat(diagramsRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  async function expectFailureEvidence(runId: string, secret: string): Promise<void> {
    await expect(runs.findById(runId)).resolves.toMatchObject({
      status: 'failed',
      output: null,
      errorMessage: secret,
      workerId: 'acme_daily_report',
      completedAt
    });
    const audit = await database.db.selectFrom('audit_logs').selectAll().executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ severity: 'P1', client_id: 'acme_corp', resolved: 0 });
    expect(audit.event_description).toContain(runId);
    expect(audit.event_description).toContain(secret);
    await expect(frequency.findBySignature('acme_corp:daily-report')).resolves.toBeUndefined();

    const diagram = await readFile(join(diagramsRoot, `flow_${runId}.md`), 'utf8');
    expect(diagram).toContain('Gateway->>Supervisor: run daily-report');
    expect(diagram).toContain('Supervisor->>acme_daily_report: execute daily-report');
    expect(diagram).toContain('acme_daily_report->>Supervisor: failed');
    expect(diagram).toContain('Supervisor->>Escalation: P1');
    expect(diagram).not.toContain('succeeded');
    expect(diagram).not.toContain(secret);

    const memory = await readFile(
      join(temporaryRoot, 'memory', 'graph', 'runs', `${runId}.md`),
      'utf8'
    );
    expect(memory).toContain('Status: `failed`');
    expect(memory).not.toContain(secret);
  }
});
