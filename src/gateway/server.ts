import type { Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

import {
  dailyReportWorker,
  recoverDailyReportArtifacts
} from '../../clients/acme_corp/automations/daily-report';
import { EscalationPolicy } from '../agents/escalation';
import { AccessControlRepository } from '../agents/access-control-repository';
import { AgentConversationService } from '../agents/agent-conversation-service';
import { AgentConversationRepository } from '../agents/conversation-repository';
import { Supervisor } from '../agents/supervisor';
import { ToolSmith } from '../agents/toolsmith';
import { WorkerRegistry } from '../agents/worker-registry';
import { ProfileAccessBootstrap } from '../agents/profile-access-bootstrap';
import { ProfileInstanceRepository } from '../agents/profile-instance-repository';
import { ProfileInstanceService } from '../agents/profile-instance-service';
import {
  AgencyExecutionPostureService,
  SqliteAgencyExecutionPostureRepository,
  parseAgencyInitialPosture,
  type AgencyPosture
} from '../agency/execution-posture';
import {
  ModelExecutionEnablementService,
  SqliteModelExecutionEnablementRepository
} from '../economics/model-execution-enablement';
import { ClientScaffolder } from '../clients/scaffold';
import { JarvisModelChatService } from '../chat/jarvis-model-chat';
import { JarvisChatService } from '../chat/jarvis-chat';
import {
  createTelegramChannelRuntime,
  telegramServerOptionsFromEnvironment,
  type CreateTelegramChannelRuntimeOptions,
  type TelegramChannelRuntime,
  type TelegramServerOptions
} from '../channels/telegram/runtime';
import { LifecycleClientService } from '../clients/service';
import { SqliteActionProposalRepository } from '../commands/action-proposal-repository';
import { ActionProposalService } from '../commands/action-proposal-service';
import type { CommandPrincipal } from '../commands/contracts';
import { PolicyService } from '../config/policies';
import { DashboardCodeGraphReader } from '../dashboard/code-graph-reader';
import { DashboardService } from '../dashboard/dashboard-service';
import { JarvisDashboardService } from '../dashboard/jarvis-dashboard-service';
import { DashboardModelRuntimeService } from '../dashboard/model-runtime-service';
import { PagePlanner } from '../dashboard/page-planner';
import { PageService } from '../dashboard/page-service';
import { AuditRepository } from '../db/audit-repository';
import { ClientRepository } from '../db/client-repository';
import { createDatabase, type DatabaseOptions, type GlobalDatabaseContext } from '../db/database';
import { RunRepository } from '../db/run-repository';
import { DelegationEventStream, createDelegationSseHandler } from '../delegation/delegation-sse';
import { SqliteDelegationRepository } from '../delegation/delegation-repository';
import { ModelUsageRepository } from '../db/model-usage-repository';
import { PnlService } from '../dashboard/pnl-service';
import { PriorityQueueRepository } from '../db/priority-queue-repository';
import { RevenuePipelineRepository } from '../db/revenue-pipeline-repository';
import { TaskFrequencyRepository } from '../db/task-frequency-repository';
import { MarkdownGraph } from '../memory/markdown-graph';
import { KnowledgeScopeRepository } from '../knowledge/scope-repository';
import { DailyBriefingService } from '../personal/briefing';
import { InMemoryCalendarReader, type PersonalCalendarReader } from '../personal/calendar';
import { MarkdownPersonalMemoryRepository } from '../personal/memory-repository';
import { ProviderRateLimitCircuit } from '../models/provider-rate-limit-circuit';
import { createModelTurnCoordinator, type ModelStackOptions } from '../models/factory';
import {
  ProviderRecoveryScheduler,
  type ProviderRecoveryRecord
} from '../models/provider-recovery-scheduler';
import {
  resolveSubscriptionExecutable,
  SubscriptionRuntimeService,
  type SubscriptionRuntimePort
} from '../models/subscription-runtime';
import { createProductionHeartbeat } from '../monitoring/heartbeat';
import { MonitoringScheduler, type MonitoringCycleResult } from '../monitoring/scheduler';
import { AutomationQueueCycle, type AutomationCycleResult } from '../queue/automation-cycle';
import { AutomationCycleScheduler } from '../queue/automation-cycle-scheduler';
import { PriorityQueueService } from '../queue/priority-queue-service';
import { MermaidLogger } from '../utils/mermaid-logger';
import { createApp, type HealthProvider } from './app';
import { acquireGatewayInstanceLease, type GatewayInstanceLease } from './instance-lease';
import { RequestMetrics } from './metrics';
import type { RequestLogSink } from './middleware';

export interface ServerMonitoringOptions {
  intervalMs?: number;
  cycleTimeoutMs?: number;
  onCycle?: (result: MonitoringCycleResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

export interface ServerAutomationCyclingOptions {
  intervalMs?: number;
  cycleTimeoutMs?: number;
  leaseDurationMs?: number;
  maxTenantsPerCycle?: number;
  onCycle?: (result: AutomationCycleResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

export interface ServerProviderRecoveryOptions {
  onDue?: (record: ProviderRecoveryRecord) => void | Promise<void>;
  /**
   * Shared durable instance for model execution and gateway scheduling. Supplying
   * the same instance to a future executor makes its writes reschedule immediately.
   */
  rateLimitCircuit?: ProviderRateLimitCircuit;
}

export interface StartServerOptions {
  projectRoot: string;
  databaseFile: string;
  clientRoot?: string;
  workspaceRoot?: string;
  graphRoot?: string;
  personalMemoryRoot?: string;
  calendarConnection?: {
    mode: 'provider';
    reader: PersonalCalendarReader;
  };
  dashboardRoot?: string;
  diagramsRoot?: string;
  workerRegistry?: WorkerRegistry;
  idFactory?: () => string;
  now?: () => string;
  databaseFactory?: (options: DatabaseOptions) => Promise<GlobalDatabaseContext>;
  host?: string;
  port?: number;
  requestLog?: RequestLogSink;
  heartbeat?: HealthProvider;
  monitoring?: ServerMonitoringOptions | false;
  automationCycling?: ServerAutomationCyclingOptions | false;
  providerRecovery?: ServerProviderRecoveryOptions | false;
  modelStack?: Omit<ModelStackOptions, 'rateLimitCircuit'>;
  subscriptionRuntime?: SubscriptionRuntimePort;
  telegram?: TelegramServerOptions | false;
  telegramRuntimeFactory?: (
    options: CreateTelegramChannelRuntimeOptions
  ) => Promise<TelegramChannelRuntime>;
  initialAgencyPosture?: AgencyPosture;
}

export interface StartedServer {
  port: number;
  stop(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
  });
}

function normalizeShutdownError(error: unknown, operation: string): Error {
  return error instanceof Error
    ? error
    : new Error(`${operation} failed with a non-Error value`, { cause: error });
}

function createDefaultWorkerRegistry(): WorkerRegistry {
  return new WorkerRegistry([
    {
      clientId: 'acme_corp',
      automation: 'daily-report',
      worker: dailyReportWorker
    }
  ]);
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host.toLowerCase() === 'localhost';
}

export async function startServer(options: StartServerOptions): Promise<StartedServer> {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHost(host)) {
    throw new Error('Gateway host must be loopback-only (127.0.0.1, ::1, or localhost)');
  }
  const instanceLease: GatewayInstanceLease = await acquireGatewayInstanceLease(
    options.databaseFile
  );
  let database: GlobalDatabaseContext | undefined;
  let server: Server | undefined;
  let monitoringScheduler: MonitoringScheduler | undefined;
  let automationCycleScheduler: AutomationCycleScheduler | undefined;
  let providerRecoveryScheduler: ProviderRecoveryScheduler | undefined;
  let telegramRuntime: TelegramChannelRuntime | undefined;
  let subscriptionRuntime: SubscriptionRuntimePort | undefined;
  try {
    const activeDatabase = await (options.databaseFactory ?? createDatabase)({
      projectRoot: options.projectRoot,
      filename: options.databaseFile
    });
    database = activeDatabase;
    const now = options.now ?? (() => new Date().toISOString());
    const accessControl = new AccessControlRepository(activeDatabase.db);
    const knowledgeScopes = new KnowledgeScopeRepository(activeDatabase.db);
    await new ProfileAccessBootstrap(activeDatabase.db, accessControl, knowledgeScopes).install();
    const profileInstances = new ProfileInstanceRepository(activeDatabase.db, now);
    await new ProfileInstanceService({
      db: activeDatabase.db,
      access: accessControl,
      knowledgeScopes,
      instances: profileInstances,
      now
    }).initialize();
    const agencyExecutionPosture = new AgencyExecutionPostureService({
      repository: new SqliteAgencyExecutionPostureRepository(activeDatabase.sqlite),
      now
    });
    await agencyExecutionPosture.initialize(options.initialAgencyPosture ?? 'active');
    const modelExecutionEnablement = new ModelExecutionEnablementService({
      repository: new SqliteModelExecutionEnablementRepository(activeDatabase.sqlite),
      now
    });
    await modelExecutionEnablement.initialize();
    const providerRateLimits =
      options.providerRecovery !== false && options.providerRecovery?.rateLimitCircuit !== undefined
        ? options.providerRecovery.rateLimitCircuit
        : new ProviderRateLimitCircuit(activeDatabase.sqlite);
    if (options.providerRecovery !== false) {
      const recoveryOptions = options.providerRecovery ?? {};
      providerRecoveryScheduler = new ProviderRecoveryScheduler({
        source: {
          listDue: () =>
            Promise.resolve(
              providerRateLimits
                .listDue()
                .map(({ provider, state, notBefore, claimExpiresAt }): ProviderRecoveryRecord => ({
                  provider,
                  notBefore:
                    state === 'half_open' && claimExpiresAt !== null ? claimExpiresAt : notBefore
                }))
            ),
          nextNotBefore: () => Promise.resolve(providerRateLimits.nextNotBefore()),
          subscribe: (listener) => providerRateLimits.subscribe(listener)
        },
        onDue:
          recoveryOptions.onDue ??
          (({ provider, notBefore }) =>
            console.log(
              JSON.stringify({
                event: 'provider_rate_limit_recovery_due',
                provider,
                notBefore: new Date(notBefore).toISOString()
              })
            ))
      });
    }
    const policies = await PolicyService.load({ projectRoot: options.projectRoot });
    const escalation = await EscalationPolicy.load({ projectRoot: options.projectRoot });
    const clientRoot = options.clientRoot ?? join(options.projectRoot, 'clients');
    const graphRoot = options.graphRoot ?? join(options.projectRoot, 'memory', 'graph');
    const diagramsRoot =
      options.diagramsRoot ?? join(dirname(dirname(graphRoot)), 'logs', 'diagrams');
    const runs = new RunRepository(activeDatabase.db);
    await recoverDailyReportArtifacts({
      clientRoot,
      findRunStatus: async (runId) => (await runs.findById(runId))?.status,
      markRunInterrupted: async (runId) => {
        await runs.markInterruptedForRecovery(runId, {
          errorMessage: 'Interrupted artifact transaction recovered during gateway startup',
          completedAt: now()
        });
      }
    });
    for (const interruptedRun of await runs.listRunning()) {
      await runs.markInterruptedForRecovery(interruptedRun.id, {
        errorMessage: 'Interrupted run recovered during gateway startup',
        completedAt: now()
      });
    }
    const graph = new MarkdownGraph({
      graphRoot,
      clientRoot,
      now
    });
    await graph.initialize();
    await graph.rebuild();
    const clientRepository = new ClientRepository(activeDatabase.db);
    const audits = new AuditRepository(activeDatabase.db);
    for (const run of await runs.listPendingRecovery()) {
      const runId = run.id;
      if (run.status !== 'failed' || run.completedAt === null) {
        throw new Error(`Pending recovery run ${runId} is not a completed failure`);
      }
      const client = await clientRepository.findById(run.clientId);
      if (client === undefined) {
        throw new Error(`Interrupted run ${runId} references a missing client`);
      }
      const clientDirectory = join(clientRoot, run.clientId);
      await graph.createClientNode({ ...client, clientDirectory });
      await graph.recordRun({ run, clientDirectory });
      await audits.recordRecoveryOnce(
        runId,
        escalation.classifyAutomationFailure({
          clientId: run.clientId,
          runId,
          automation: run.automation,
          error: run.errorMessage ?? 'Interrupted run recovered during gateway startup',
          timestamp: run.completedAt
        })
      );
      const recoveryLogger = new MermaidLogger({ diagramsRoot });
      recoveryLogger.start(runId);
      recoveryLogger.log('Gateway', 'Supervisor', `run ${run.automation}`);
      recoveryLogger.log('Supervisor', run.workerId ?? 'Worker', `execute ${run.automation}`);
      recoveryLogger.log(run.workerId ?? 'Worker', 'Supervisor', 'failed');
      recoveryLogger.log('Supervisor', 'Escalation', 'P1');
      await recoveryLogger.save();
      if (!(await runs.clearPendingRecovery(runId))) {
        throw new Error(`Pending recovery marker ${runId} disappeared before completion`);
      }
    }
    const requestLog: RequestLogSink =
      options.requestLog ?? ((entry) => console.log(JSON.stringify(entry)));
    const clients = new LifecycleClientService({
      registry: new ClientRepository(activeDatabase.db),
      scaffolder: new ClientScaffolder({
        projectRoot: options.projectRoot,
        clientRoot,
        workspaceRoot: options.workspaceRoot ?? join(options.projectRoot, 'workspaces')
      }),
      policies,
      graph,
      now
    });
    const agencyExecutionAllowed = () => agencyExecutionPosture.executionAllowed();
    const workerRegistry = options.workerRegistry ?? createDefaultWorkerRegistry();
    const frequency = new TaskFrequencyRepository(activeDatabase.db);
    const supervisor = new Supervisor({
      clients,
      policies,
      workers: workerRegistry,
      runs,
      audits,
      frequency,
      escalation,
      memory: graph,
      loggerFactory: () => new MermaidLogger({ diagramsRoot }),
      clientRoot,
      idFactory: options.idFactory,
      now,
      executionPosture: () => agencyExecutionPosture.current()
    });
    const heartbeat =
      options.heartbeat ??
      createProductionHeartbeat({
        projectRoot: options.projectRoot,
        databaseCheck: async () => {
          await activeDatabase.db.selectFrom('client_registry').select('id').limit(1).execute();
        },
        now
      });
    const toolsmith = new ToolSmith({ frequency });
    const metrics = new RequestMetrics();
    const economics = new ModelUsageRepository(activeDatabase.db);
    subscriptionRuntime = options.subscriptionRuntime ?? new SubscriptionRuntimeService();
    const claudeCommand =
      options.modelStack?.claude?.command ?? (await resolveSubscriptionExecutable('claude'));
    const modelStack =
      claudeCommand === undefined
        ? options.modelStack
        : {
            ...options.modelStack,
            claude: {
              ...options.modelStack?.claude,
              command: claudeCommand
            }
          };
    const modelTurnCoordinator = createModelTurnCoordinator({
      ...modelStack,
      usage: economics,
      enablement: modelExecutionEnablement,
      surface: 'web',
      clientId: null,
      rateLimitCircuit: providerRateLimits
    });
    const dashboardModelRuntime = new DashboardModelRuntimeService({
      enablement: modelExecutionEnablement,
      subscriptions: subscriptionRuntime
    });
    const queue = new PriorityQueueRepository(activeDatabase.db);
    const revenue = new RevenuePipelineRepository(activeDatabase.db);
    const actionProposals = new ActionProposalService({
      repository: new SqliteActionProposalRepository(activeDatabase.sqlite),
      now,
      onApproved: (input) => agencyExecutionPosture.applyApprovedProposal(input)
    });
    const webOperatorPrincipal: CommandPrincipal = {
      version: 1,
      id: 'principal:web_operator',
      kind: 'operator',
      channel: 'web',
      authority: ['read', 'approve']
    };
    const personalJarvisBinding = {
      scopeId: 'personal:jarvis',
      trustDomain: 'personal' as const,
      tenantId: null,
      policyVersion: 1
    };
    const agencyDelegationBinding = {
      scopeId: 'agency:agency',
      trustDomain: 'agency' as const,
      tenantId: null,
      policyVersion: 1
    };
    const delegationEvents = createDelegationSseHandler({
      stream: new DelegationEventStream({
        repository: new SqliteDelegationRepository(activeDatabase.sqlite)
      }),
      authorize: () =>
        Promise.resolve({
          principal: webOperatorPrincipal,
          binding: agencyDelegationBinding
        }),
      maxEvents: 50
    });
    if (options.automationCycling !== false) {
      const cyclingOptions = options.automationCycling ?? {};
      const queueService = new PriorityQueueService(queue, () => new Date(now()));
      const automationCycle = new AutomationQueueCycle({
        queue: queueService,
        runner: supervisor,
        findRunById: (runId) => runs.findById(runId),
        listActiveTenantIds: async () =>
          (await clientRepository.list())
            .filter(({ status }) => status === 'active')
            .map(({ id }) => id),
        executionAllowed: agencyExecutionAllowed,
        now: () => new Date(now()),
        ...(cyclingOptions.leaseDurationMs === undefined
          ? {}
          : { leaseDurationMs: cyclingOptions.leaseDurationMs }),
        ...(cyclingOptions.maxTenantsPerCycle === undefined
          ? {}
          : { maxTenantsPerCycle: cyclingOptions.maxTenantsPerCycle })
      });
      automationCycleScheduler = new AutomationCycleScheduler({
        cycle: automationCycle,
        ...(cyclingOptions.intervalMs === undefined
          ? {}
          : { intervalMs: cyclingOptions.intervalMs }),
        ...(cyclingOptions.cycleTimeoutMs === undefined
          ? {}
          : { cycleTimeoutMs: cyclingOptions.cycleTimeoutMs }),
        onCycle:
          cyclingOptions.onCycle ??
          ((result) =>
            console.log(
              JSON.stringify({
                event: 'automation_queue_cycle_completed',
                inspectedTenantCount: result.inspectedTenantCount,
                claimedTaskCount: result.claimedTaskCount,
                succeededTaskCount: result.succeededTaskCount,
                failedTaskCount: result.failedTaskCount
              })
            )),
        onError:
          cyclingOptions.onError ??
          (() => console.error(JSON.stringify({ event: 'automation_queue_cycle_failed' })))
      });
    }
    const pageService = new PageService({ planner: new PagePlanner(), graph, now });
    const codeGraphReader = new DashboardCodeGraphReader({ projectRoot: options.projectRoot });
    const dashboardService = new DashboardService({
      clients: clientRepository,
      runs,
      audits,
      economics,
      queue,
      queueTenantId: 'jarvis',
      queueTenantIds: async () =>
        (await clientRepository.list())
          .filter(({ status }) => status === 'active')
          .map(({ id }) => id),
      queueExecutionEligibility: (task) =>
        task.payloadKind === 'automation' &&
        task.automationId !== undefined &&
        workerRegistry.has(task.tenantId, task.automationId)
          ? 'bound'
          : 'proposal_only',
      revenue,
      health: heartbeat,
      metrics,
      toolsmith,
      graph,
      now
    });
    // Pipeline counts stay counts: an unrecognized pipeline has no defensible
    // dollar value, so P&L never converts them into revenue (see pnl-service.ts).
    const operatorPnl = new PnlService({
      expenses: economics,
      revenue:
        revenue === undefined
          ? undefined
          : {
              pipelineCounts: async () => {
                const snapshot = await dashboardService.revenueSnapshot();
                return {
                  agency: snapshot.lanes.agency.counts.prospects,
                  taskMarket: snapshot.lanes.task_market.counts.prospects
                };
              }
            },
      now
    });
    const personalMemory = new MarkdownPersonalMemoryRepository(
      options.personalMemoryRoot ?? join(options.projectRoot, 'memory', 'personal')
    );
    const demoDay = new Date(now());
    demoDay.setUTCHours(14, 0, 0, 0);
    const demoEnd = new Date(demoDay);
    demoEnd.setUTCHours(14, 30, 0, 0);
    const reviewStart = new Date(demoDay);
    reviewStart.setUTCHours(16, 0, 0, 0);
    const reviewEnd = new Date(reviewStart);
    reviewEnd.setUTCHours(16, 45, 0, 0);
    const demoCalendar = new InMemoryCalendarReader([
      {
        id: 'jarvis-daily-briefing',
        title: 'Jarvis daily briefing',
        start: demoDay.toISOString(),
        end: demoEnd.toISOString(),
        allDay: false,
        location: 'Local demo calendar',
        attendeeCount: 0,
        source: 'local_demo'
      },
      {
        id: 'agency-pipeline-review',
        title: 'Agency pipeline review',
        start: reviewStart.toISOString(),
        end: reviewEnd.toISOString(),
        allDay: false,
        location: 'Jarvis Control Room',
        attendeeCount: 0,
        source: 'local_demo'
      }
    ]);
    const personalCalendar = options.calendarConnection?.reader ?? demoCalendar;
    const calendarMode = options.calendarConnection?.mode ?? 'local_demo';
    const jarvisReference: { current?: JarvisDashboardService } = {};
    const briefing = new DailyBriefingService({
      calendar: personalCalendar,
      memory: personalMemory,
      agency: {
        approvalCount: async () => {
          if (jarvisReference.current === undefined) return 0;
          const [agencySnapshot, pendingActionProposals] = await Promise.all([
            jarvisReference.current.agencyControlSnapshot(),
            actionProposals.listPending({
              principal: webOperatorPrincipal,
              binding: personalJarvisBinding
            })
          ]);
          return agencySnapshot.approvalRequired.length + pendingActionProposals.length;
        }
      },
      now
    });
    const jarvisDashboardService = new JarvisDashboardService({
      memory: personalMemory,
      calendar: personalCalendar,
      briefing,
      queue: dashboardService,
      revenue: dashboardService,
      calendarMode,
      executionPosture: agencyExecutionPosture,
      now
    });
    jarvisReference.current = jarvisDashboardService;
    const deterministicJarvisChat = new JarvisChatService({
      personal: jarvisDashboardService,
      agency: jarvisDashboardService,
      pages: pageService
    });
    const webJarvisChat = new JarvisModelChatService({
      deterministic: deterministicJarvisChat,
      coordinator: modelTurnCoordinator
    });
    if (options.telegram !== undefined && options.telegram !== false) {
      telegramRuntime = await (options.telegramRuntimeFactory ?? createTelegramChannelRuntime)({
        sqlite: activeDatabase.sqlite,
        allowlist: options.telegram.allowlist,
        keychain: options.telegram.keychain,
        responder: deterministicJarvisChat,
        now,
        onCycle: (result) =>
          console.log(
            JSON.stringify({
              event: 'telegram_poll_completed',
              received: result.received,
              processed: result.processed
            })
          ),
        onError: () => console.error(JSON.stringify({ event: 'telegram_poll_failed' }))
      });
    }
    const agentConversations = new AgentConversationService({
      repository: new AgentConversationRepository(activeDatabase.db),
      jarvisResponder: webJarvisChat,
      profileResolver: profileInstances,
      now
    });
    if (options.monitoring !== false) {
      const monitoringOptions = options.monitoring ?? {};
      monitoringScheduler = new MonitoringScheduler({
        heartbeat,
        toolsmith,
        ...(monitoringOptions.intervalMs === undefined
          ? {}
          : { intervalMs: monitoringOptions.intervalMs }),
        ...(monitoringOptions.cycleTimeoutMs === undefined
          ? {}
          : { cycleTimeoutMs: monitoringOptions.cycleTimeoutMs }),
        onCycle:
          monitoringOptions.onCycle ??
          ((result) =>
            console.log(
              JSON.stringify({
                event: 'monitoring_cycle_completed',
                overall: result.health.overall,
                failures: result.health.failures,
                proposalCount: result.proposals.length
              })
            )),
        onError:
          monitoringOptions.onError ??
          (() => console.error(JSON.stringify({ event: 'monitoring_cycle_failed' })))
      });
    }
    const app = createApp({
      clients,
      runner: supervisor,
      metrics,
      health: heartbeat,
      requestLog,
      dashboard: {
        overview: () => dashboardService.overview(),
        queueSnapshot: () => dashboardService.queueSnapshot(),
        revenueSnapshot: () => dashboardService.revenueSnapshot(),
        pnlSnapshot: () => operatorPnl.snapshot(),
        personalSnapshot: () => jarvisDashboardService.personalSnapshot(),
        agencyControlSnapshot: async () => ({
          ...(await jarvisDashboardService.agencyControlSnapshot()),
          actionProposals: await actionProposals.listPending({
            principal: webOperatorPrincipal,
            binding: personalJarvisBinding
          })
        }),
        chat: (input) => webJarvisChat.respond(input),
        modelRuntimeSnapshot: () => dashboardModelRuntime.snapshot(),
        startModelProviderLogin: (provider) => dashboardModelRuntime.startLogin(provider),
        selectModelRuntime: (input) => dashboardModelRuntime.select(input),
        disableModelRuntime: (input) => dashboardModelRuntime.disable(input),
        decideActionProposal: async (input) => ({
          decision: await actionProposals.decide({
            principal: webOperatorPrincipal,
            binding: personalJarvisBinding,
            request: input
          }),
          executionPosture: await agencyExecutionPosture.current()
        }),
        agentCatalog: () => Promise.resolve(agentConversations.directorySnapshot()),
        listAgentConversations: async (agentId) => ({
          conversations: await agentConversations.listConversations(agentId)
        }),
        createAgentConversation: async (agentId, input) => ({
          conversation: await agentConversations.createConversation(agentId, input)
        }),
        listAgentMessages: async (agentId, conversationId) => ({
          messages: await agentConversations.listMessages(agentId, conversationId)
        }),
        sendAgentMessage: async (agentId, conversationId, input) => {
          const exchange = await agentConversations.sendMessage(agentId, conversationId, input);
          return {
            conversation: exchange.conversation,
            messages: [exchange.operatorMessage, exchange.agentMessage],
            reply: exchange.reply
          };
        },
        codeGraphIndex: () => codeGraphReader.read(),
        graphIndex: () => dashboardService.graphIndex(),
        listPages: () => pageService.list(),
        previewPage: (input) => pageService.preview(input),
        createPage: (input) => pageService.create(input)
      },
      dashboardDelegationEvents: delegationEvents,
      dashboardRoot: options.dashboardRoot ?? join(options.projectRoot, 'public', 'dashboard')
    });

    server = await new Promise<Server>((resolveListening, rejectListening) => {
      const candidate = app.listen(options.port ?? 3000, host, () => {
        candidate.off('error', rejectListening);
        resolveListening(candidate);
      });
      candidate.once('error', rejectListening);
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Gateway did not bind a TCP port');
    }
    monitoringScheduler?.start();
    automationCycleScheduler?.start();
    providerRecoveryScheduler?.start();
    telegramRuntime?.start();

    const activeServer = server;
    const activeMonitoringScheduler = monitoringScheduler;
    const activeAutomationCycleScheduler = automationCycleScheduler;
    const activeProviderRecoveryScheduler = providerRecoveryScheduler;
    const activeTelegramRuntime = telegramRuntime;
    const activeSubscriptionRuntime = subscriptionRuntime;
    let stopPromise: Promise<void> | undefined;
    return {
      port: address.port,
      stop() {
        if (stopPromise !== undefined) {
          return stopPromise;
        }

        stopPromise = (async () => {
          const shutdownErrors: Error[] = [];
          activeMonitoringScheduler?.stop();
          activeAutomationCycleScheduler?.stop();
          const providerRecoveryStop = activeProviderRecoveryScheduler?.stop();
          activeTelegramRuntime?.stop();
          try {
            await closeServer(activeServer);
          } catch (error) {
            shutdownErrors.push(normalizeShutdownError(error, 'Gateway server close'));
          }

          try {
            await activeMonitoringScheduler?.settled();
          } catch (error) {
            shutdownErrors.push(normalizeShutdownError(error, 'Monitoring scheduler drain'));
          }

          try {
            await activeAutomationCycleScheduler?.settled();
          } catch (error) {
            shutdownErrors.push(normalizeShutdownError(error, 'Automation cycle scheduler drain'));
          }

          try {
            await providerRecoveryStop;
          } catch (error) {
            shutdownErrors.push(normalizeShutdownError(error, 'Provider recovery scheduler drain'));
          }

          try {
            await activeTelegramRuntime?.settled();
          } catch (error) {
            shutdownErrors.push(normalizeShutdownError(error, 'Telegram runtime drain'));
          }

          try {
            await activeSubscriptionRuntime?.stop?.();
          } catch (error) {
            shutdownErrors.push(normalizeShutdownError(error, 'Subscription runtime drain'));
          }

          try {
            await activeDatabase.destroy();
          } catch (error) {
            shutdownErrors.push(normalizeShutdownError(error, 'Gateway database destroy'));
          }

          try {
            await instanceLease.release();
          } catch (error) {
            shutdownErrors.push(normalizeShutdownError(error, 'Gateway instance lease release'));
          }

          if (shutdownErrors.length === 1) {
            const shutdownError = shutdownErrors[0];
            if (shutdownError === undefined) {
              throw new Error('Gateway shutdown failed without an error');
            }
            throw shutdownError;
          }
          if (shutdownErrors.length > 1) {
            throw new AggregateError(shutdownErrors, 'Gateway shutdown operations failed');
          }
        })();
        return stopPromise;
      }
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    monitoringScheduler?.stop();
    automationCycleScheduler?.stop();
    const providerRecoveryStop = providerRecoveryScheduler?.stop();
    telegramRuntime?.stop();
    try {
      await monitoringScheduler?.settled();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await automationCycleScheduler?.settled();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await providerRecoveryStop;
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await telegramRuntime?.settled();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await subscriptionRuntime?.stop?.();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      if (server !== undefined) {
        await closeServer(server);
      }
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await database?.destroy();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await instanceLease.release();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'Gateway startup cleanup failed');
    }
    throw error;
  }
}

async function runMain(): Promise<void> {
  const projectRoot = resolve(process.env.JARVIS_ROOT ?? process.cwd());
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const started = await startServer({
    projectRoot,
    databaseFile: resolve(process.env.DB_PATH ?? join(projectRoot, 'data', 'jarvis.sqlite')),
    clientRoot: resolve(process.env.JARVIS_CLIENT_ROOT ?? join(projectRoot, 'clients')),
    workspaceRoot: resolve(process.env.JARVIS_WORKSPACE_ROOT ?? join(projectRoot, 'workspaces')),
    graphRoot: resolve(process.env.JARVIS_GRAPH_ROOT ?? join(projectRoot, 'memory', 'graph')),
    personalMemoryRoot: resolve(
      process.env.JARVIS_PERSONAL_MEMORY_ROOT ?? join(projectRoot, 'memory', 'personal')
    ),
    initialAgencyPosture: parseAgencyInitialPosture(
      process.env.JARVIS_AGENCY_INITIAL_POSTURE ?? 'paused'
    ),
    telegram: telegramServerOptionsFromEnvironment(process.env),
    host: process.env.HOST ?? '127.0.0.1',
    port
  });

  console.log(JSON.stringify({ event: 'gateway_listening', port: started.port }));

  const shutdown = async (): Promise<void> => {
    await started.stop();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

if (require.main === module) {
  void runMain().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
