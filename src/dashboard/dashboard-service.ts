import type { ToolSmithProposal } from '../agents/toolsmith';
import { ClientIdSchema } from '../config/schemas';
import type { DashboardAuditSummary } from '../db/audit-repository';
import type { DashboardClientSummary } from '../db/client-repository';
import type { DashboardModelUsageSummary } from '../db/model-usage-repository';
import type { DashboardRunSummary } from '../db/run-repository';
import type { HealthProvider, HealthResult } from '../gateway/app';
import type { MetricsSnapshot } from '../gateway/metrics';
import type { GraphIndex } from '../memory/markdown-graph';
import type { RedactedQueueTask, TenantQueueView } from '../queue/contracts';
import {
  REVENUE_PIPELINE_SAFETY,
  type RedactedOffer,
  type RedactedOutreachDraft,
  type RedactedProspect,
  type RedactedTaskMarketActivation,
  type RedactedTaskMarketSimulation,
  type RevenueLane,
  type RevenueLaneSnapshot
} from '../revenue/contracts';

import type { OperatorPageSpec } from './contracts';

export interface DashboardClientReader<TSummary = DashboardClientSummary> {
  dashboardSummary(limit: number): Promise<TSummary>;
}

export interface DashboardRunReader<TSummary = DashboardRunSummary> {
  dashboardSummary(limit: number): Promise<TSummary>;
}

export interface DashboardAuditReader<TSummary = DashboardAuditSummary> {
  dashboardSummary(limit: number): Promise<TSummary>;
}

export interface DashboardEconomicsReader {
  dashboardSummary(input: { limit: number }): Promise<DashboardModelUsageSummary>;
}

export interface DashboardQueueReader {
  readTenantQueue(input: {
    tenantId: string;
    limit: number;
    now: string;
  }): Promise<TenantQueueView>;
}

export interface DashboardRevenueReader {
  readLaneSnapshot(input: { lane: RevenueLane; limit: number }): Promise<RevenueLaneSnapshot>;
}

export interface DashboardMetricsReader {
  snapshot(): MetricsSnapshot;
}

export interface DashboardToolSmith {
  analyze(): Promise<ToolSmithProposal[]>;
}

export interface DashboardGraphReader {
  readIndex(): Promise<GraphIndex>;
  listOperatorPages(): Promise<OperatorPageSpec[]>;
}

export interface DashboardOverview {
  generatedAt: string;
  health: HealthResult;
  metrics: MetricsSnapshot & { scope: 'current_process' };
  clients: DashboardClientSummary;
  runs: DashboardRunSummary;
  attention: DashboardAuditSummary;
  economics: DashboardModelUsageSummary;
  improvements: {
    mode: 'proposal_only';
    proposals: ToolSmithProposal[];
  };
  memory: {
    nodeCount: number;
    edgeCount: number;
    pageCount: number;
  };
}

export interface DashboardQueueTask {
  id: string;
  tenantId?: string;
  lane: string;
  payloadKind: RedactedQueueTask['payloadKind'];
  executionEligibility?: 'bound' | 'proposal_only';
  band: RedactedQueueTask['band'];
  state: RedactedQueueTask['state'];
  version: number;
  dependencyCount: number;
  blockedDependencyCount: number;
  createdAt: string;
  availableAt: string;
  ready: boolean;
}

export interface DashboardQueueSnapshot {
  generatedAt: string;
  tenantId: string;
  tenantIds?: string[];
  returnedTaskCount: number;
  truncated: boolean;
  lanes: Array<{
    lane: string;
    ready: DashboardQueueTask[];
    blocked: DashboardQueueTask[];
  }>;
}

export interface DashboardRevenueSnapshot {
  generatedAt: string;
  lanes: {
    agency: RevenueLaneSnapshot;
    task_market: RevenueLaneSnapshot;
  };
}

export interface DashboardServiceOptions<
  TClients = DashboardClientSummary,
  TRuns = DashboardRunSummary,
  TAudits = DashboardAuditSummary
> {
  clients: DashboardClientReader<TClients>;
  runs: DashboardRunReader<TRuns>;
  audits: DashboardAuditReader<TAudits>;
  economics: DashboardEconomicsReader;
  queue: DashboardQueueReader;
  queueTenantId: string;
  queueTenantIds?: () => Promise<string[]>;
  queueExecutionEligibility?: (task: RedactedQueueTask) => 'bound' | 'proposal_only';
  revenue?: DashboardRevenueReader;
  health: HealthProvider;
  metrics: DashboardMetricsReader;
  toolsmith: DashboardToolSmith;
  graph: DashboardGraphReader;
  now?: () => string;
  itemLimit?: number;
  queueItemLimit?: number;
  revenueItemLimit?: number;
}

const DEFAULT_ITEM_LIMIT = 8;
const MIN_ITEM_LIMIT = 1;
const MAX_ITEM_LIMIT = 25;
const DEFAULT_QUEUE_ITEM_LIMIT = 25;
const MAX_QUEUE_ITEM_LIMIT = 50;
const DEFAULT_REVENUE_ITEM_LIMIT = 25;
const MAX_REVENUE_ITEM_LIMIT = 50;

function validateItemLimit(value: number): number {
  if (!Number.isInteger(value) || value < MIN_ITEM_LIMIT || value > MAX_ITEM_LIMIT) {
    throw new RangeError(
      `itemLimit must be an integer between ${MIN_ITEM_LIMIT} and ${MAX_ITEM_LIMIT}`
    );
  }
  return value;
}

function validateQueueItemLimit(value: number): number {
  if (!Number.isInteger(value) || value < MIN_ITEM_LIMIT || value > MAX_QUEUE_ITEM_LIMIT) {
    throw new RangeError(
      `queueItemLimit must be an integer between ${MIN_ITEM_LIMIT} and ${MAX_QUEUE_ITEM_LIMIT}`
    );
  }
  return value;
}

function validateRevenueItemLimit(value: number): number {
  if (!Number.isInteger(value) || value < MIN_ITEM_LIMIT || value > MAX_REVENUE_ITEM_LIMIT) {
    throw new RangeError(
      `revenueItemLimit must be an integer between ${MIN_ITEM_LIMIT} and ${MAX_REVENUE_ITEM_LIMIT}`
    );
  }
  return value;
}

function validateQueueTenantId(value: string): string {
  const parsed = ClientIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new RangeError('queueTenantId must be a valid tenant identifier');
  }
  return parsed.data;
}

function allowlistedQueueTask(
  task: RedactedQueueTask,
  configuredTenantId: string,
  lane: string,
  executionEligibility?: (task: RedactedQueueTask) => 'bound' | 'proposal_only'
): DashboardQueueTask {
  if (task.tenantId !== configuredTenantId) {
    throw new Error(
      `Queue read model returned data outside configured tenant ${configuredTenantId}`
    );
  }
  if (task.lane !== lane) {
    throw new Error(`Queue read model returned task ${task.id} under the wrong lane`);
  }
  return {
    id: task.id,
    ...(executionEligibility === undefined ? {} : { tenantId: task.tenantId }),
    lane: task.lane,
    payloadKind: task.payloadKind,
    ...(executionEligibility === undefined
      ? {}
      : { executionEligibility: executionEligibility(task) }),
    band: task.band,
    state: task.state,
    version: task.version,
    dependencyCount: task.dependencyCount,
    blockedDependencyCount: task.blockedDependencyCount,
    createdAt: task.createdAt,
    availableAt: task.availableAt,
    ready: task.ready
  };
}

function assertRevenueLane(actual: RevenueLane, expected: RevenueLane, label: string): void {
  if (actual !== expected) {
    throw new Error(`Revenue read model returned ${label} for ${actual}; expected ${expected}`);
  }
}

function assertBoundedRevenueList(length: number, limit: number, label: string): void {
  if (length > limit) {
    throw new Error(`Revenue read model exceeded the bounded limit for ${label}`);
  }
}

function allowlistedProspect(item: RedactedProspect, lane: RevenueLane): RedactedProspect {
  assertRevenueLane(item.lane, lane, `prospect ${item.id}`);
  return {
    id: item.id,
    lane: item.lane,
    publicLabel: item.publicLabel,
    contactChannel: item.contactChannel,
    hasContactReference: item.hasContactReference,
    source: item.source,
    need: item.need,
    status: item.status,
    version: item.version,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function allowlistedOffer(item: RedactedOffer, lane: RevenueLane): RedactedOffer {
  assertRevenueLane(item.lane, lane, `offer ${item.id}`);
  return {
    id: item.id,
    prospectId: item.prospectId,
    lane: item.lane,
    title: item.title,
    deliverable: item.deliverable,
    quote: {
      basis: 'proposed',
      currency: 'USD',
      amountMicrousd: item.quote.amountMicrousd
    },
    turnaroundHours: item.turnaroundHours,
    revisionLimit: item.revisionLimit,
    status: item.status,
    version: item.version,
    externalPayment: 'blocked',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function allowlistedOutreachDraft(
  item: RedactedOutreachDraft,
  lane: RevenueLane
): RedactedOutreachDraft {
  assertRevenueLane(item.lane, lane, `outreach draft ${item.id}`);
  return {
    id: item.id,
    prospectId: item.prospectId,
    offerId: item.offerId,
    lane: item.lane,
    channel: item.channel,
    status: item.status,
    version: item.version,
    subjectLength: item.subjectLength,
    bodyLength: item.bodyLength,
    contentDigest: item.contentDigest,
    externalDelivery: 'blocked',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function allowlistedSimulation(item: RedactedTaskMarketSimulation): RedactedTaskMarketSimulation {
  return {
    id: item.id,
    activationVersion: item.activationVersion,
    scenario: item.scenario,
    outcome: item.outcome,
    requestDigest: item.requestDigest,
    evidenceDigest: item.evidenceDigest,
    quote: {
      basis: 'simulation',
      currency: 'USD',
      amountMicrousd: item.quote.amountMicrousd
    },
    externalPayment: 'blocked',
    revenueRecognition: 'none',
    recordedAt: item.recordedAt
  };
}

function allowlistedActivation(item: RedactedTaskMarketActivation): RedactedTaskMarketActivation {
  assertRevenueLane(item.lane, 'task_market', 'task-market activation');
  const expectedPaymentMode = item.state === 'simulation' ? 'simulated' : 'blocked';
  if (item.x402.paymentMode !== expectedPaymentMode) {
    throw new Error('Revenue read model returned an inconsistent task-market payment mode');
  }
  return {
    lane: 'task_market',
    productId: item.productId,
    state: item.state,
    version: item.version,
    contractDigest: item.contractDigest,
    a2a: {
      version: item.a2a.version,
      skillId: item.a2a.skillId,
      inputContract: 'bounded_numeric_series',
      outputContract: 'validation_verdict'
    },
    x402: {
      scheme: 'exact',
      quote: {
        basis: 'simulation',
        currency: 'USD',
        amountMicrousd: item.x402.quote.amountMicrousd
      },
      paymentMode: expectedPaymentMode
    },
    safety: REVENUE_PIPELINE_SAFETY,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function allowlistedRevenueLane(
  raw: RevenueLaneSnapshot,
  expectedLane: RevenueLane,
  limit: number
): RevenueLaneSnapshot {
  assertRevenueLane(raw.lane, expectedLane, 'lane snapshot');
  assertBoundedRevenueList(raw.prospects.length, limit, `${expectedLane} prospects`);
  assertBoundedRevenueList(raw.offers.length, limit, `${expectedLane} offers`);
  assertBoundedRevenueList(raw.outreachDrafts.length, limit, `${expectedLane} outreach drafts`);
  assertBoundedRevenueList(raw.simulations.length, limit, `${expectedLane} simulations`);
  if (expectedLane === 'agency' && (raw.activation !== null || raw.simulations.length !== 0)) {
    throw new Error('Revenue read model returned task-market data in the agency lane');
  }

  return {
    lane: expectedLane,
    counts: {
      prospects: raw.counts.prospects,
      offers: raw.counts.offers,
      outreachDrafts: raw.counts.outreachDrafts,
      simulations: raw.counts.simulations
    },
    prospects: raw.prospects.map((item) => allowlistedProspect(item, expectedLane)),
    offers: raw.offers.map((item) => allowlistedOffer(item, expectedLane)),
    outreachDrafts: raw.outreachDrafts.map((item) => allowlistedOutreachDraft(item, expectedLane)),
    simulations: expectedLane === 'task_market' ? raw.simulations.map(allowlistedSimulation) : [],
    activation: raw.activation === null ? null : allowlistedActivation(raw.activation),
    safety: REVENUE_PIPELINE_SAFETY
  };
}

/**
 * A deliberately redacted, bounded operator read model. It takes only the
 * small repository and service capabilities needed by the dashboard rather
 * than giving the browser access to persistence or the Markdown filesystem.
 */
export class DashboardService<
  TClients = DashboardClientSummary,
  TRuns = DashboardRunSummary,
  TAudits = DashboardAuditSummary
> {
  private readonly itemLimit: number;
  private readonly queueItemLimit: number;
  private readonly revenueItemLimit: number;
  private readonly queueTenantId: string;
  private readonly now: () => string;

  constructor(private readonly options: DashboardServiceOptions<TClients, TRuns, TAudits>) {
    this.itemLimit = validateItemLimit(options.itemLimit ?? DEFAULT_ITEM_LIMIT);
    this.queueItemLimit = validateQueueItemLimit(
      options.queueItemLimit ?? DEFAULT_QUEUE_ITEM_LIMIT
    );
    this.revenueItemLimit = validateRevenueItemLimit(
      options.revenueItemLimit ?? DEFAULT_REVENUE_ITEM_LIMIT
    );
    this.queueTenantId = validateQueueTenantId(options.queueTenantId);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async overview(): Promise<DashboardOverview> {
    const [health, rawClients, rawRuns, rawAttention, economics, proposals, graph, pages] =
      await Promise.all([
        this.options.health.check(),
        this.options.clients.dashboardSummary(this.itemLimit),
        this.options.runs.dashboardSummary(this.itemLimit),
        this.options.audits.dashboardSummary(this.itemLimit),
        this.options.economics.dashboardSummary({ limit: this.itemLimit }),
        this.options.toolsmith.analyze(),
        this.options.graph.readIndex(),
        this.options.graph.listOperatorPages()
      ]);
    const metrics = this.options.metrics.snapshot();
    // Each repository owns its redacted dashboard DTO. The generic structural
    // ports let callers construct the service with only that one capability;
    // production wires the concrete repository summaries shown in this DTO.
    const clients = rawClients as DashboardClientSummary;
    const runs = rawRuns as DashboardRunSummary;
    const attention = rawAttention as DashboardAuditSummary;

    return {
      generatedAt: this.now(),
      health,
      metrics: { ...metrics, scope: 'current_process' },
      clients,
      runs,
      attention,
      economics,
      improvements: { mode: 'proposal_only', proposals },
      memory: {
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        pageCount: pages.length
      }
    };
  }

  graphIndex(): Promise<GraphIndex> {
    return this.options.graph.readIndex();
  }

  async queueSnapshot(): Promise<DashboardQueueSnapshot> {
    const generatedAt = this.now();
    const discoveredTenantIds = this.options.queueTenantIds
      ? await this.options.queueTenantIds()
      : [];
    const discoveredUniqueTenantIds = [
      ...new Set(discoveredTenantIds.map((tenantId) => ClientIdSchema.parse(tenantId)))
    ]
      .filter((tenantId) => tenantId !== this.queueTenantId)
      .sort();
    const allTenantIds = [...discoveredUniqueTenantIds, this.queueTenantId];
    // The configured harness tenant is never displaced by portfolio growth.
    const tenantIds = [
      ...discoveredUniqueTenantIds.slice(0, MAX_ITEM_LIMIT - 1),
      this.queueTenantId
    ];
    const perTenantLimit = Math.max(1, Math.floor(this.queueItemLimit / tenantIds.length));
    const rawViews = await Promise.all(
      tenantIds.map((tenantId) =>
        this.options.queue.readTenantQueue({
          tenantId,
          limit: perTenantLimit,
          now: generatedAt
        })
      )
    );
    const lanesByName = new Map<string, DashboardQueueSnapshot['lanes'][number]>();
    for (let viewIndex = 0; viewIndex < rawViews.length; viewIndex += 1) {
      const raw = rawViews[viewIndex];
      const expectedTenantId = tenantIds[viewIndex];
      if (
        raw === undefined ||
        expectedTenantId === undefined ||
        raw.tenantId !== expectedTenantId
      ) {
        throw new Error(
          `Queue read model returned data outside configured tenant ${expectedTenantId ?? this.queueTenantId}`
        );
      }
      for (const rawLane of raw.lanes) {
        const lane = lanesByName.get(rawLane.lane) ?? {
          lane: rawLane.lane,
          ready: [],
          blocked: []
        };
        lane.ready.push(
          ...rawLane.ready.map((task) =>
            allowlistedQueueTask(
              task,
              expectedTenantId,
              rawLane.lane,
              this.options.queueExecutionEligibility
            )
          )
        );
        lane.blocked.push(
          ...rawLane.blocked.map((task) =>
            allowlistedQueueTask(
              task,
              expectedTenantId,
              rawLane.lane,
              this.options.queueExecutionEligibility
            )
          )
        );
        lanesByName.set(rawLane.lane, lane);
      }
    }
    const lanes = [...lanesByName.values()];
    const returnedTaskCount = lanes.reduce(
      (count, lane) => count + lane.ready.length + lane.blocked.length,
      0
    );
    const rawReturnedTaskCount = rawViews.reduce(
      (count, view) => count + view.returnedTaskCount,
      0
    );
    if (rawReturnedTaskCount !== returnedTaskCount) {
      throw new Error('Queue read model returned an inconsistent task count');
    }

    return {
      generatedAt,
      tenantId: this.queueTenantId,
      ...(this.options.queueTenantIds === undefined ? {} : { tenantIds }),
      returnedTaskCount,
      truncated: allTenantIds.length > tenantIds.length || rawViews.some((view) => view.truncated),
      lanes
    };
  }

  async revenueSnapshot(): Promise<DashboardRevenueSnapshot> {
    const reader = this.options.revenue;
    if (reader === undefined) {
      throw new Error('Revenue dashboard reader is not configured');
    }
    const generatedAt = this.now();
    const [agency, taskMarket] = await Promise.all([
      reader.readLaneSnapshot({ lane: 'agency', limit: this.revenueItemLimit }),
      reader.readLaneSnapshot({ lane: 'task_market', limit: this.revenueItemLimit })
    ]);
    return {
      generatedAt,
      lanes: {
        agency: allowlistedRevenueLane(agency, 'agency', this.revenueItemLimit),
        task_market: allowlistedRevenueLane(taskMarket, 'task_market', this.revenueItemLimit)
      }
    };
  }

  listPages(): Promise<OperatorPageSpec[]> {
    return this.options.graph.listOperatorPages();
  }
}
