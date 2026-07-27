import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SQLite from 'better-sqlite3';

import { WorkerRegistry } from '../../src/agents/worker-registry';
import { pauseRuntimePayloadDigest } from '../../src/agency/execution-posture';
import { SqliteActionProposalRepository } from '../../src/commands/action-proposal-repository';
import { ActionProposalService } from '../../src/commands/action-proposal-service';
import type { WorkerContext } from '../../src/agents/contracts';
import { dailyReportWorker } from '../../clients/acme_corp/automations/daily-report';
import { ClientRepository } from '../../src/db/client-repository';
import { createDatabase } from '../../src/db/database';
import { RunRepository } from '../../src/db/run-repository';
import type { HealthProvider } from '../../src/gateway/app';
import {
  isLoopbackHost,
  startServer as startRuntimeServer,
  type StartedServer,
  type StartServerOptions
} from '../../src/gateway/server';
import { MarkdownGraph } from '../../src/memory/markdown-graph';

const projectRoot = join(__dirname, '..', '..');
const testHeartbeat: HealthProvider = {
  check: () =>
    Promise.resolve({
      timestamp: '2026-07-18T12:00:00.000Z',
      overall: 'healthy',
      severity: 'none',
      checks: { gateway: 'ok', database: 'ok' },
      failures: [],
      action: 'none'
    })
};

function startServer(options: StartServerOptions): Promise<StartedServer> {
  return startRuntimeServer({
    ...options,
    heartbeat: testHeartbeat,
    monitoring: false
  });
}

describe('gateway listener', () => {
  let temporaryRoot: string;
  let started: StartedServer | undefined;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-listener-test-'));
  });

  afterEach(async () => {
    await started?.stop();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('rejects non-loopback listener hosts before acquiring runtime dependencies', async () => {
    expect(['127.0.0.1', '::1', 'localhost'].every(isLoopbackHost)).toBe(true);
    expect(['0.0.0.0', '::', '192.168.1.20', 'jarvis.local'].some(isLoopbackHost)).toBe(false);
    const databaseFactory = vi.fn();

    await expect(
      startServer({
        projectRoot,
        databaseFile: join(temporaryRoot, 'jarvis.sqlite'),
        host: '0.0.0.0',
        databaseFactory
      })
    ).rejects.toThrow('Gateway host must be loopback-only');
    expect(databaseFactory).not.toHaveBeenCalled();
  });

  it('binds an ephemeral port and serves real HTTP requests', async () => {
    started = await startServer({
      projectRoot,
      databaseFile: join(temporaryRoot, 'jarvis.sqlite'),
      clientRoot: join(temporaryRoot, 'clients'),
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot: join(temporaryRoot, 'memory', 'graph'),
      workerRegistry: new WorkerRegistry(),
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });

    const response = await fetch(`http://127.0.0.1:${started.port}/health`);
    const body = (await response.json()) as { overall: string; checks: Record<string, string> };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      overall: 'healthy',
      checks: { gateway: 'ok', database: 'ok' }
    });

    const delegationEvents = await fetch(
      `http://127.0.0.1:${started.port}/api/v1/dashboard/delegation/events`
    );
    expect(delegationEvents.status).toBe(200);
    expect(delegationEvents.headers.get('content-type')).toContain('text/event-stream');
    await expect(delegationEvents.text()).resolves.toBe('retry: 5000\n\n');

    const createResponse = await fetch(`http://127.0.0.1:${started.port}/api/v1/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'acme_corp',
        name: 'Acme Corporation',
        profile: 'data_processing'
      })
    });

    expect(createResponse.status).toBe(201);
    await expect(
      stat(join(temporaryRoot, 'clients', 'acme_corp', 'client-config.json'))
    ).resolves.toMatchObject({});
    await expect(
      stat(join(temporaryRoot, 'memory', 'graph', 'clients', 'acme_corp.md'))
    ).resolves.toMatchObject({});

    const runResponse = await fetch(
      `http://127.0.0.1:${started.port}/api/v1/clients/acme_corp/run`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ automation: 'daily-report' })
      }
    );
    expect(runResponse.status).toBe(404);
    await expect(runResponse.json()).resolves.toEqual({
      error: {
        code: 'AUTOMATION_NOT_FOUND',
        message: 'Automation daily-report is not registered for client acme_corp'
      }
    });
  });

  it('terminates and drains the subscription login broker during shutdown', async () => {
    const stopSubscriptionRuntime = vi.fn(() => Promise.resolve());
    const subscriptionRuntime = {
      status: () =>
        Promise.resolve({
          provider: 'claude' as const,
          connectionState: 'disconnected' as const,
          loginAvailable: true,
          loginInProgress: false,
          detail: 'Claude subscription login required.'
        }),
      snapshot: () => Promise.resolve([]),
      startLogin: () =>
        Promise.resolve({
          provider: 'claude' as const,
          outcome: 'started' as const,
          detail: 'Claude subscription login started.'
        }),
      stop: stopSubscriptionRuntime
    };

    started = await startServer({
      projectRoot,
      databaseFile: join(temporaryRoot, 'jarvis.sqlite'),
      clientRoot: join(temporaryRoot, 'clients'),
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot: join(temporaryRoot, 'memory', 'graph'),
      workerRegistry: new WorkerRegistry(),
      subscriptionRuntime,
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });

    await started.stop();

    expect(stopSubscriptionRuntime).toHaveBeenCalledTimes(1);
  });

  it('uses an explicitly injected provider calendar without claiming one by default', async () => {
    const read = vi.fn().mockResolvedValue({
      events: [
        {
          id: 'provider-event-1',
          title: 'Connected read-only event',
          start: '2026-07-21T14:00:00.000Z',
          end: '2026-07-21T14:30:00.000Z',
          allDay: false,
          location: 'Private',
          attendeeCount: 0,
          source: 'provider'
        }
      ],
      conflicts: [],
      truncated: false
    });
    started = await startServer({
      projectRoot,
      databaseFile: join(temporaryRoot, 'jarvis.sqlite'),
      clientRoot: join(temporaryRoot, 'clients'),
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot: join(temporaryRoot, 'memory', 'graph'),
      personalMemoryRoot: join(temporaryRoot, 'memory', 'personal'),
      workerRegistry: new WorkerRegistry(),
      calendarConnection: { mode: 'provider', reader: { read } },
      automationCycling: false,
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });

    const response = await fetch(`http://127.0.0.1:${started.port}/api/v1/dashboard/personal`);
    const payload = (await response.json()) as {
      calendarMode: string;
      calendar: { events: Array<{ id: string }> };
    };
    expect(payload).toMatchObject({
      calendarMode: 'provider',
      calendar: { events: [{ id: 'provider-event-1' }] }
    });
    expect(read).toHaveBeenCalled();
  });

  it('projects and records an exact Telegram proposal decision on the local desktop', async () => {
    const now = '2026-07-21T18:00:00.000Z';
    const databaseFile = join(temporaryRoot, 'jarvis.sqlite');
    started = await startServer({
      projectRoot,
      databaseFile,
      clientRoot: join(temporaryRoot, 'clients'),
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot: join(temporaryRoot, 'memory', 'graph'),
      automationCycling: false,
      now: () => now,
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });
    const sqlite = new SQLite(databaseFile);
    try {
      const proposalRepository = new SqliteActionProposalRepository(sqlite);
      const proposals = new ActionProposalService({
        repository: proposalRepository,
        now: () => now
      });
      const proposal = await proposals.propose({
        principal: {
          version: 1,
          id: 'principal:telegram_operator',
          kind: 'operator',
          channel: 'telegram',
          authority: ['read', 'propose']
        },
        binding: {
          scopeId: 'personal:jarvis',
          trustDomain: 'personal',
          tenantId: null,
          policyVersion: 1
        },
        request: {
          sourceId: 'telegram:update:0000000000000999',
          kind: 'pause_runtime',
          payloadDigest: pauseRuntimePayloadDigest(),
          reversible: true,
          externalEffect: false,
          expiresInSeconds: 300
        }
      });
      const baseUrl = `http://127.0.0.1:${started.port}/api/v1/dashboard`;
      const createClient = await fetch(`http://127.0.0.1:${started.port}/api/v1/clients`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'acme_corp',
          name: 'Acme Corporation',
          profile: 'data_processing'
        })
      });
      expect(createClient.status).toBe(201);
      const before = (await (await fetch(`${baseUrl}/agency`)).json()) as {
        actionProposals: Array<{ id: string }>;
        posture: string;
        killSwitchEngaged: boolean;
      };
      expect(before.actionProposals).toEqual([expect.objectContaining({ id: proposal.id })]);
      expect(before).toMatchObject({ posture: 'active', killSwitchEngaged: false });

      const decision = await fetch(
        `${baseUrl}/action-proposals/${encodeURIComponent(proposal.id)}/decision`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            verdict: 'approved',
            expectedVersion: proposal.version,
            confirmationFingerprint: proposal.confirmationFingerprint
          })
        }
      );
      expect(decision.status).toBe(200);
      await expect(decision.json()).resolves.toMatchObject({
        decision: { proposalId: proposal.id, verdict: 'approved' },
        executionPosture: {
          posture: 'paused',
          sourceProposalId: proposal.id,
          sourceConfirmationFingerprint: proposal.confirmationFingerprint
        }
      });
      const after = (await (await fetch(`${baseUrl}/agency`)).json()) as {
        actionProposals: unknown[];
        posture: string;
        killSwitchEngaged: boolean;
      };
      expect(after.actionProposals).toEqual([]);
      expect(after).toMatchObject({ posture: 'paused', killSwitchEngaged: true });
      expect((await proposalRepository.findById(proposal.id))?.state).toBe('approved');
      const blockedRun = await fetch(
        `http://127.0.0.1:${started.port}/api/v1/clients/acme_corp/run`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ automation: 'daily-report' })
        }
      );
      expect(blockedRun.status).toBe(503);
      await expect(blockedRun.json()).resolves.toEqual({
        error: {
          code: 'AGENCY_KILL_SWITCH_ENGAGED',
          message: 'Agency execution is paused by the kill switch'
        }
      });
      sqlite.close();
      await started.stop();
      started = undefined;
      started = await startServer({
        projectRoot,
        databaseFile,
        clientRoot: join(temporaryRoot, 'clients'),
        workspaceRoot: join(temporaryRoot, 'workspaces'),
        graphRoot: join(temporaryRoot, 'memory', 'graph'),
        automationCycling: false,
        initialAgencyPosture: 'active',
        now: () => now,
        host: '127.0.0.1',
        port: 0,
        requestLog: () => undefined
      });
      const afterRestart = await fetch(`http://127.0.0.1:${started.port}/api/v1/dashboard/agency`);
      await expect(afterRestart.json()).resolves.toMatchObject({
        posture: 'paused',
        killSwitchEngaged: true,
        executionPosture: { version: 2, sourceProposalId: proposal.id }
      });
    } finally {
      if (sqlite.open) sqlite.close();
    }
  });

  it('executes the checked-in acme daily report through the production registry', async () => {
    const clientRoot = join(temporaryRoot, 'clients');
    const clientDirectory = join(clientRoot, 'acme_corp');
    const graphRoot = join(temporaryRoot, 'memory', 'graph');
    const diagramsRoot = join(temporaryRoot, 'logs', 'diagrams');
    started = await startServer({
      projectRoot,
      databaseFile: join(temporaryRoot, 'jarvis.sqlite'),
      clientRoot,
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot,
      diagramsRoot,
      idFactory: () => 'run-acme-e2e',
      now: () => '2026-07-18T12:00:00.000Z',
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });
    const baseUrl = `http://127.0.0.1:${started.port}`;

    const createResponse = await fetch(`${baseUrl}/api/v1/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'acme_corp',
        name: 'Acme Corporation',
        profile: 'data_processing'
      })
    });
    expect(createResponse.status).toBe(201);

    const runResponse = await fetch(`${baseUrl}/api/v1/clients/acme_corp/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ automation: 'daily-report' })
    });
    const body = (await runResponse.json()) as {
      run: { id: string; status: string; workerId: string };
      result: unknown;
      diagramPath: string;
    };
    expect(runResponse.status, JSON.stringify(body)).toBe(200);
    const report = JSON.parse(
      await readFile(join(clientDirectory, 'output', 'report.json'), 'utf8')
    ) as unknown;

    expect(body).toMatchObject({
      run: { id: 'run-acme-e2e', status: 'succeeded', workerId: 'acme_daily_report' },
      result: { sourceRows: 10, qualifiedCount: 5 }
    });
    expect(body.result).toEqual(report);
    expect(body.diagramPath).toBe(join(diagramsRoot, 'flow_run-acme-e2e.md'));
    expect(await readFile(body.diagramPath, 'utf8')).toContain(
      'acme_daily_report->>Supervisor: succeeded'
    );
    expect(await readFile(join(graphRoot, 'runs', 'run-acme-e2e.md'), 'utf8')).toContain(
      'Status: `succeeded`'
    );
  });

  it('reconciles an interrupted report transaction before binding the gateway', async () => {
    const clientRoot = join(temporaryRoot, 'clients');
    const clientDirectory = join(clientRoot, 'acme_corp');
    const databaseFile = join(temporaryRoot, 'jarvis.sqlite');
    const graphRoot = join(temporaryRoot, 'memory', 'graph');
    const diagramsRoot = join(temporaryRoot, 'logs', 'diagrams');
    await mkdir(join(clientDirectory, 'data'), { recursive: true });
    await writeFile(
      join(clientDirectory, 'data', 'sample-leads.csv'),
      await readFile(join(projectRoot, 'clients', 'acme_corp', 'data', 'sample-leads.csv'))
    );
    const database = await createDatabase({ projectRoot, filename: databaseFile });
    await new ClientRepository(database.db).create({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing',
      status: 'active',
      createdAt: '2026-07-18T12:00:00.000Z'
    });
    const runRepository = new RunRepository(database.db);
    await runRepository.createRunning({
      id: 'run-interrupted-startup',
      clientId: 'acme_corp',
      automation: 'daily-report',
      parentRunId: null,
      workerId: dailyReportWorker.id,
      startedAt: '2026-07-18T12:00:00.000Z'
    });
    await runRepository.createRunning({
      id: 'run-before-artifact',
      clientId: 'acme_corp',
      automation: 'daily-report',
      parentRunId: null,
      workerId: dailyReportWorker.id,
      startedAt: '2026-07-18T12:00:00.000Z'
    });
    await database.destroy();

    const workerContext: WorkerContext = {
      clientId: 'acme_corp',
      automation: 'daily-report',
      runId: 'run-interrupted-startup',
      clientRoot,
      clientDirectory,
      memoryDirectory: join(clientDirectory, 'memory'),
      toolPolicy: {
        description: 'startup recovery test',
        tools_allow: ['read', 'write'],
        tools_deny: [],
        requires_elevated_approval: false
      },
      networkPolicy: { mode: 'none' },
      logger: {
        start: () => undefined,
        log: () => undefined,
        save: () => Promise.resolve(join(temporaryRoot, 'unused.md'))
      }
    };
    const result = await dailyReportWorker.execute(workerContext);
    await dailyReportWorker.commit(workerContext, result);
    const staleGraph = new MarkdownGraph({
      graphRoot,
      clientRoot,
      now: () => '2026-07-18T12:00:02.000Z'
    });
    await staleGraph.initialize();
    await staleGraph.createClientNode({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing',
      createdAt: '2026-07-18T12:00:00.000Z',
      clientDirectory
    });
    await staleGraph.recordRun({
      clientDirectory,
      run: {
        id: 'run-interrupted-startup',
        clientId: 'acme_corp',
        automation: 'daily-report',
        status: 'succeeded',
        output: result,
        errorMessage: null,
        parentRunId: null,
        workerId: dailyReportWorker.id,
        startedAt: '2026-07-18T12:00:00.000Z',
        completedAt: '2026-07-18T12:00:02.000Z'
      }
    });
    await staleGraph.rebuild();
    await mkdir(diagramsRoot, { recursive: true });
    await writeFile(
      join(diagramsRoot, 'flow_run-interrupted-startup.md'),
      '```mermaid\nsequenceDiagram\n  acme_daily_report->>Supervisor: succeeded\n```\n'
    );

    started = await startServer({
      projectRoot,
      databaseFile,
      clientRoot,
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot,
      diagramsRoot,
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });

    expect(await readdir(join(clientDirectory, 'output'))).toEqual([]);
    expect(await readFile(join(graphRoot, 'runs', 'run-interrupted-startup.md'), 'utf8')).toContain(
      'Status: `failed`'
    );
    const recoveredTrace = await readFile(
      join(diagramsRoot, 'flow_run-interrupted-startup.md'),
      'utf8'
    );
    expect(recoveredTrace).toContain('acme_daily_report->>Supervisor: failed');
    expect(recoveredTrace).not.toContain('succeeded');
    await expect(fetch(`http://127.0.0.1:${started.port}/health`)).resolves.toMatchObject({
      status: 200
    });
    await started.stop();
    started = undefined;
    const recoveredDatabase = await createDatabase({ projectRoot, filename: databaseFile });
    await expect(
      new RunRepository(recoveredDatabase.db).findById('run-interrupted-startup')
    ).resolves.toMatchObject({
      status: 'failed',
      errorMessage: 'Interrupted artifact transaction recovered during gateway startup'
    });
    await expect(
      new RunRepository(recoveredDatabase.db).findById('run-before-artifact')
    ).resolves.toMatchObject({
      status: 'failed',
      errorMessage: 'Interrupted run recovered during gateway startup'
    });
    const recoveryAudits = await recoveredDatabase.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('severity', '=', 'P1')
      .execute();
    expect(recoveryAudits).toHaveLength(2);
    expect(recoveryAudits.map((audit) => audit.event_description).join('\n')).toContain(
      'run-interrupted-startup'
    );
    await recoveredDatabase.destroy();
  });

  it('retries partial startup recovery evidence until its durable marker clears', async () => {
    const databaseFile = join(temporaryRoot, 'jarvis.sqlite');
    const clientRoot = join(temporaryRoot, 'clients');
    const graphRoot = join(temporaryRoot, 'memory', 'graph');
    const diagramsRoot = join(temporaryRoot, 'logs', 'diagrams');
    const recoveredAt = '2026-07-18T12:00:03.000Z';
    const database = await createDatabase({ projectRoot, filename: databaseFile });
    await new ClientRepository(database.db).create({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing',
      status: 'active',
      createdAt: '2026-07-18T12:00:00.000Z'
    });
    await new RunRepository(database.db).createRunning({
      id: 'run-recovery-evidence-retry',
      clientId: 'acme_corp',
      automation: 'daily-report',
      parentRunId: null,
      workerId: dailyReportWorker.id,
      startedAt: '2026-07-18T12:00:00.000Z'
    });
    await database.destroy();
    await mkdir(join(temporaryRoot, 'logs'), { recursive: true });
    await writeFile(diagramsRoot, 'not a directory');

    await expect(
      startServer({
        projectRoot,
        databaseFile,
        clientRoot,
        workspaceRoot: join(temporaryRoot, 'workspaces'),
        graphRoot,
        diagramsRoot,
        now: () => recoveredAt,
        host: '127.0.0.1',
        port: 0,
        requestLog: () => undefined
      })
    ).rejects.toBeDefined();

    const interruptedDatabase = await createDatabase({ projectRoot, filename: databaseFile });
    const interruptedRuns = new RunRepository(interruptedDatabase.db);
    await expect(interruptedRuns.listPendingRecovery()).resolves.toMatchObject([
      { id: 'run-recovery-evidence-retry', status: 'failed', completedAt: recoveredAt }
    ]);
    expect(
      await interruptedDatabase.db
        .selectFrom('audit_logs')
        .selectAll()
        .where('severity', '=', 'P1')
        .execute()
    ).toHaveLength(1);
    await interruptedDatabase.destroy();

    await rm(diagramsRoot);
    started = await startServer({
      projectRoot,
      databaseFile,
      clientRoot,
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot,
      diagramsRoot,
      now: () => recoveredAt,
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });

    expect(
      await readFile(join(graphRoot, 'runs', 'run-recovery-evidence-retry.md'), 'utf8')
    ).toContain('Status: `failed`');
    expect(
      await readFile(join(diagramsRoot, 'flow_run-recovery-evidence-retry.md'), 'utf8')
    ).toContain('acme_daily_report->>Supervisor: failed');
    await started.stop();
    started = undefined;

    const recoveredDatabase = await createDatabase({ projectRoot, filename: databaseFile });
    await expect(new RunRepository(recoveredDatabase.db).listPendingRecovery()).resolves.toEqual(
      []
    );
    expect(
      await recoveredDatabase.db
        .selectFrom('audit_logs')
        .selectAll()
        .where('severity', '=', 'P1')
        .execute()
    ).toHaveLength(1);
    await recoveredDatabase.destroy();
  });

  it('closes the database when startup fails after opening it', async () => {
    const graphRoot = join(temporaryRoot, 'graph-root-file');
    await writeFile(graphRoot, 'not a directory');
    let destroyed = false;

    await expect(
      startServer({
        projectRoot,
        databaseFile: join(temporaryRoot, 'jarvis.sqlite'),
        graphRoot,
        databaseFactory: async (options) => {
          const database = await createDatabase(options);
          return {
            ...database,
            async destroy() {
              destroyed = true;
              await database.destroy();
            }
          };
        },
        host: '127.0.0.1',
        port: 0,
        requestLog: () => undefined
      })
    ).rejects.toBeDefined();

    expect(destroyed).toBe(true);
  });

  it('refuses a second gateway instance before it can recover live runs', async () => {
    const databaseFile = join(temporaryRoot, 'shared-jarvis.sqlite');
    const clientRoot = join(temporaryRoot, 'shared-clients');
    started = await startServer({
      projectRoot,
      databaseFile,
      clientRoot,
      workspaceRoot: join(temporaryRoot, 'shared-workspaces'),
      graphRoot: join(temporaryRoot, 'shared-graph'),
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });
    const database = await createDatabase({ projectRoot, filename: databaseFile });
    await new ClientRepository(database.db).create({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing',
      status: 'active',
      createdAt: '2026-07-18T12:00:00.000Z'
    });
    await new RunRepository(database.db).createRunning({
      id: 'run-owned-by-first-gateway',
      clientId: 'acme_corp',
      automation: 'daily-report',
      parentRunId: null,
      workerId: dailyReportWorker.id,
      startedAt: '2026-07-18T12:00:00.000Z'
    });
    await database.destroy();

    let secondDatabaseFactoryCalled = false;

    await expect(
      startServer({
        projectRoot,
        databaseFile,
        clientRoot,
        workspaceRoot: join(temporaryRoot, 'second-workspaces'),
        graphRoot: join(temporaryRoot, 'second-graph'),
        databaseFactory: async (options) => {
          secondDatabaseFactoryCalled = true;
          return createDatabase(options);
        },
        host: '127.0.0.1',
        port: started.port,
        requestLog: () => undefined
      })
    ).rejects.toMatchObject({ code: 'GATEWAY_INSTANCE_ACTIVE' });
    expect(secondDatabaseFactoryCalled).toBe(false);

    const verificationDatabase = await createDatabase({ projectRoot, filename: databaseFile });
    await expect(
      new RunRepository(verificationDatabase.db).findById('run-owned-by-first-gateway')
    ).resolves.toMatchObject({ status: 'running', completedAt: null });
    await verificationDatabase.destroy();
    await expect(fetch(`http://127.0.0.1:${started.port}/health`)).resolves.toMatchObject({
      status: 200
    });
  });

  it('shares shutdown work and its rejection across concurrent stop calls', async () => {
    const destroyError = new Error('database destroy failed');
    let destroyCalls = 0;
    started = await startServer({
      projectRoot,
      databaseFile: join(temporaryRoot, 'jarvis.sqlite'),
      clientRoot: join(temporaryRoot, 'clients'),
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot: join(temporaryRoot, 'memory', 'graph'),
      databaseFactory: async (options) => {
        const database = await createDatabase(options);
        return {
          ...database,
          async destroy() {
            destroyCalls += 1;
            await database.destroy();
            throw destroyError;
          }
        };
      },
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });
    const activeServer = started;
    const healthUrl = `http://127.0.0.1:${activeServer.port}/health`;
    await expect(fetch(healthUrl)).resolves.toMatchObject({ status: 200 });

    // Avoid asking afterEach to re-await the deliberately rejected stop promise.
    started = undefined;
    const firstStop = activeServer.stop();
    const secondStop = activeServer.stop();

    expect(secondStop).toBe(firstStop);
    const [firstResult, secondResult] = await Promise.allSettled([firstStop, secondStop]);
    expect(firstResult).toEqual({ status: 'rejected', reason: destroyError });
    expect(secondResult).toEqual({ status: 'rejected', reason: destroyError });
    expect(activeServer.stop()).toBe(firstStop);
    expect(destroyCalls).toBe(1);
    await expect(fetch(healthUrl)).rejects.toThrow();
  });

  it('composes the supervisor for a registered worker through real HTTP', async () => {
    const now = '2026-07-18T12:00:00.000Z';
    const graphRoot = join(temporaryRoot, 'memory', 'graph');
    const diagramsRoot = join(temporaryRoot, 'logs', 'diagrams');
    started = await startServer({
      projectRoot,
      databaseFile: join(temporaryRoot, 'jarvis.sqlite'),
      clientRoot: join(temporaryRoot, 'clients'),
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot,
      diagramsRoot,
      workerRegistry: new WorkerRegistry([
        {
          clientId: 'acme_corp',
          automation: 'daily-report',
          worker: {
            id: 'test_worker',
            execute: (context) => Promise.resolve({ runId: context.runId, qualifiedCount: 4 })
          }
        }
      ]),
      idFactory: () => 'run-http-001',
      now: () => now,
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });
    const baseUrl = `http://127.0.0.1:${started.port}`;

    await fetch(`${baseUrl}/api/v1/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'acme_corp',
        name: 'Acme Corporation',
        profile: 'data_processing'
      })
    });
    const response = await fetch(`${baseUrl}/api/v1/clients/acme_corp/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ automation: 'daily-report' })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      run: { id: 'run-http-001', status: 'succeeded', workerId: 'test_worker' },
      result: { runId: 'run-http-001', qualifiedCount: 4 },
      diagramPath: join(diagramsRoot, 'flow_run-http-001.md')
    });
    expect(await readFile(join(diagramsRoot, 'flow_run-http-001.md'), 'utf8')).toContain(
      'Supervisor->>Gateway: completed'
    );
    expect(await readFile(join(graphRoot, 'runs', 'run-http-001.md'), 'utf8')).toContain(
      'Status: `succeeded`'
    );
  });
});
