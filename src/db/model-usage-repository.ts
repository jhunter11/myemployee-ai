import { isDeepStrictEqual } from 'node:util';

import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';

import { ClientIdSchema } from '../config/schemas';
import type { JarvisDatabase, ModelUsageEventsTable } from './types';

const MAX_COUNTER = 2_147_483_647;
const MAX_COST_MICRO_USD = 1_000_000_000_000;
const OperationalIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);
const ProviderSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/);
const ModelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/);
const PricingVersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
const CounterSchema = z.number().int().min(0).max(MAX_COUNTER).nullable();
const CostMicroUsdSchema = z.number().int().min(0).max(MAX_COST_MICRO_USD);

export const ModelOperationSchema = z.enum([
  'classification',
  'extraction',
  'drafting',
  'summarization',
  'synthesis',
  'code',
  'review'
]);
export const ModelRouteSchema = z.enum(['local', 'economy', 'frontier']);
export const ModelUsageStatusSchema = z.enum(['succeeded', 'failed', 'timeout', 'cancelled']);

export const ModelUsageCostSchema = z.discriminatedUnion('basis', [
  // Cost is genuinely unknown; it is never converted to zero (SPEC §15).
  z.strictObject({ basis: z.literal('unknown') }),
  // A flat-rate subscription call (Claude Max, ChatGPT/Codex, Gemini): the
  // per-call dollar cost is genuinely unknown, so it is stored as NULL and
  // counted as unknown-cost coverage — never as $0 (ADR-003, SPEC §15).
  z.strictObject({ basis: z.literal('subscription') }),
  // A local runtime call (Ollama): no metered API charge is incurred, so the
  // cost is a genuine, known 0 — distinct from unknown (ADR-003).
  z.strictObject({ basis: z.literal('local') }),
  z.strictObject({
    basis: z.literal('observed'),
    microUsd: CostMicroUsdSchema,
    pricingVersion: PricingVersionSchema.optional()
  }),
  z.strictObject({
    basis: z.literal('estimated'),
    microUsd: CostMicroUsdSchema,
    pricingVersion: PricingVersionSchema
  })
]);

export type ModelUsageCost = z.infer<typeof ModelUsageCostSchema>;

/**
 * Maps a validated cost to its two persisted columns. Subscription and unknown
 * both persist NULL cost (genuinely unknown dollars); local persists an exact 0;
 * observed/estimated carry their micro-USD amount. The DB CHECK constraint on
 * `model_usage_events` enforces the same relationships as a second line of defence.
 */
function costColumns(cost: ModelUsageCost): {
  costMicroUsd: number | null;
  pricingVersion: string | null;
} {
  switch (cost.basis) {
    case 'unknown':
    case 'subscription':
      return { costMicroUsd: null, pricingVersion: null };
    case 'local':
      return { costMicroUsd: 0, pricingVersion: null };
    case 'observed':
      return { costMicroUsd: cost.microUsd, pricingVersion: cost.pricingVersion ?? null };
    case 'estimated':
      return { costMicroUsd: cost.microUsd, pricingVersion: cost.pricingVersion };
  }
}

export const ModelUsageEventInputSchema = z.strictObject({
  id: OperationalIdSchema,
  recordedAt: z.iso.datetime(),
  clientId: ClientIdSchema.nullable(),
  operation: ModelOperationSchema,
  provider: ProviderSchema,
  model: ModelSchema,
  route: ModelRouteSchema,
  inputTokens: CounterSchema,
  outputTokens: CounterSchema,
  cacheReadTokens: CounterSchema,
  cacheWriteTokens: CounterSchema,
  latencyMs: z.number().int().min(0).max(86_400_000),
  status: ModelUsageStatusSchema,
  cost: ModelUsageCostSchema
});

const DashboardSummaryQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(25),
  clientId: ClientIdSchema.optional()
});

export type ModelUsageEventInput = z.infer<typeof ModelUsageEventInputSchema>;
export type ModelUsageEvent = ModelUsageEventInput;
export type ModelRoute = z.infer<typeof ModelRouteSchema>;

export interface UnavailableModelUsageSummary {
  status: 'unavailable';
  reason: string;
}

export interface AvailableModelUsageSummary {
  status: 'available';
  period: { startsAt: string; endsAt: string };
  usage: {
    requestCount: number;
    succeededCount: number;
    failedCount: number;
    timeoutCount: number;
    cancelledCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    unknownTokenEvents: number;
  };
  latency: { averageMs: number };
  cost: {
    currency: 'USD';
    // Known-dollar coverage: observed/estimated/local count as known (local is a
    // genuine 0); unknown/subscription count as not-known (SPEC §15, ADR-003).
    coverage: 'none' | 'partial' | 'complete';
    knownMicroUsd: number;
    observedMicroUsd: number;
    estimatedMicroUsd: number;
    observedCostEvents: number;
    estimatedCostEvents: number;
    unknownCostEvents: number;
    subscriptionCostEvents: number;
    localCostEvents: number;
  };
  routing: Array<{ route: ModelRoute; requestCount: number }>;
  models: Array<{
    provider: string;
    model: string;
    route: ModelRoute;
    requestCount: number;
    succeededCount: number;
    inputTokens: number;
    outputTokens: number;
    averageLatencyMs: number;
    knownMicroUsd: number;
    unknownCostEvents: number;
  }>;
}

export type DashboardModelUsageSummary = UnavailableModelUsageSummary | AvailableModelUsageSummary;

export interface SleeveExpenseTotals {
  requestCount: number;
  knownMicroUsd: number;
  coveredEvents: number;
  uncoveredEvents: number;
  coverage: 'none' | 'partial' | 'complete';
}

export interface SleeveExpenseRollup {
  sleeves: Array<SleeveExpenseTotals & { sleeveId: string }>;
  system: SleeveExpenseTotals;
}

function costFromRow(row: Selectable<ModelUsageEventsTable>): ModelUsageCost {
  switch (row.cost_basis) {
    case 'unknown':
      return { basis: 'unknown' };
    case 'subscription':
      return { basis: 'subscription' };
    case 'local':
      return { basis: 'local' };
    case 'estimated':
      return {
        basis: 'estimated',
        microUsd: row.cost_microusd as number,
        pricingVersion: row.pricing_version as string
      };
    case 'observed':
      return {
        basis: 'observed',
        microUsd: row.cost_microusd as number,
        ...(row.pricing_version === null ? {} : { pricingVersion: row.pricing_version })
      };
    default:
      throw new Error(`Unexpected model-usage cost basis: ${row.cost_basis}`);
  }
}

function toEvent(row: Selectable<ModelUsageEventsTable>): ModelUsageEvent {
  const cost = costFromRow(row);

  return ModelUsageEventInputSchema.parse({
    id: row.id,
    recordedAt: row.recorded_at,
    clientId: row.client_id,
    operation: row.operation,
    provider: row.provider,
    model: row.model,
    route: row.route,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    latencyMs: row.latency_ms,
    status: row.status,
    cost
  });
}

function integer(value: unknown, label: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Unsafe ${label} aggregate`);
  }
  return parsed;
}

function average(value: unknown, label: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Unsafe ${label} aggregate`);
  }
  return integer(Math.round(parsed), label);
}

function coverage(known: number, unknown: number): 'none' | 'partial' | 'complete' {
  if (known === 0) return 'none';
  return unknown === 0 ? 'complete' : 'partial';
}

const aggregateSelections = [
  sql<number>`COUNT(*)`.as('requestCount'),
  sql<number>`SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END)`.as('succeededCount'),
  sql<number>`SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)`.as('failedCount'),
  sql<number>`SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END)`.as('timeoutCount'),
  sql<number>`SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END)`.as('cancelledCount'),
  sql<number>`COALESCE(SUM(input_tokens), 0)`.as('inputTokens'),
  sql<number>`COALESCE(SUM(output_tokens), 0)`.as('outputTokens'),
  sql<number>`COALESCE(SUM(cache_read_tokens), 0)`.as('cacheReadTokens'),
  sql<number>`COALESCE(SUM(cache_write_tokens), 0)`.as('cacheWriteTokens'),
  sql<number>`SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END)`.as(
    'unknownTokenEvents'
  ),
  sql<number>`AVG(latency_ms)`.as('averageLatencyMs'),
  sql<number>`COALESCE(SUM(CASE WHEN cost_basis = 'observed' THEN cost_microusd ELSE 0 END), 0)`.as(
    'observedMicroUsd'
  ),
  sql<number>`COALESCE(SUM(CASE WHEN cost_basis = 'estimated' THEN cost_microusd ELSE 0 END), 0)`.as(
    'estimatedMicroUsd'
  ),
  sql<number>`SUM(CASE WHEN cost_basis = 'observed' THEN 1 ELSE 0 END)`.as('observedCostEvents'),
  sql<number>`SUM(CASE WHEN cost_basis = 'estimated' THEN 1 ELSE 0 END)`.as('estimatedCostEvents'),
  sql<number>`SUM(CASE WHEN cost_basis = 'unknown' THEN 1 ELSE 0 END)`.as('unknownCostEvents'),
  sql<number>`SUM(CASE WHEN cost_basis = 'subscription' THEN 1 ELSE 0 END)`.as(
    'subscriptionCostEvents'
  ),
  sql<number>`SUM(CASE WHEN cost_basis = 'local' THEN 1 ELSE 0 END)`.as('localCostEvents'),
  sql<string>`MIN(recorded_at)`.as('startsAt'),
  sql<string>`MAX(recorded_at)`.as('endsAt')
] as const;

/**
 * Stores only normalized operational metadata for actual model calls. Prompt,
 * response, error, URL, and arbitrary metadata fields do not exist here.
 */
export class ModelUsageRepository {
  constructor(private readonly db: Kysely<JarvisDatabase>) {}

  async record(input: ModelUsageEventInput): Promise<ModelUsageEvent> {
    const event = ModelUsageEventInputSchema.parse(input);
    const { costMicroUsd, pricingVersion } = costColumns(event.cost);
    const inserted = await this.db
      .insertInto('model_usage_events')
      .values({
        id: event.id,
        recorded_at: event.recordedAt,
        client_id: event.clientId,
        operation: event.operation,
        provider: event.provider,
        model: event.model,
        route: event.route,
        input_tokens: event.inputTokens,
        output_tokens: event.outputTokens,
        cache_read_tokens: event.cacheReadTokens,
        cache_write_tokens: event.cacheWriteTokens,
        latency_ms: event.latencyMs,
        status: event.status,
        cost_basis: event.cost.basis,
        cost_microusd: costMicroUsd,
        pricing_version: pricingVersion
      })
      .onConflict((conflict) => conflict.column('id').doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted !== undefined) return toEvent(inserted);
    const existing = await this.db
      .selectFrom('model_usage_events')
      .selectAll()
      .where('id', '=', event.id)
      .executeTakeFirstOrThrow();
    const stored = toEvent(existing);
    if (!isDeepStrictEqual(stored, event)) {
      throw new Error(`Model usage event ${event.id} already exists with different telemetry`);
    }
    return stored;
  }

  /**
   * Metered spend grouped by the sleeve that incurred it, for operator P&L.
   *
   * Known dollars follow ADR-003: observed and estimated carry a real amount and
   * `local` is a genuine zero, while `unknown` and `subscription` are counted as
   * uncovered rather than folded in as $0. A sleeve whose spend is entirely on a
   * flat-rate subscription therefore reports coverage `none`, not a $0 expense.
   */
  async sleeveExpenseRollup(): Promise<SleeveExpenseRollup> {
    const rows = await this.db
      .selectFrom('model_usage_events')
      .select([
        sql<string>`COALESCE(NULLIF(TRIM(client_id), ''), 'system')`.as('sleeveId'),
        sql<number>`COUNT(*)`.as('requestCount'),
        sql<number>`COALESCE(SUM(CASE WHEN cost_basis IN ('observed', 'estimated') THEN cost_microusd ELSE 0 END), 0)`.as(
          'knownMicroUsd'
        ),
        sql<number>`SUM(CASE WHEN cost_basis IN ('observed', 'estimated', 'local') THEN 1 ELSE 0 END)`.as(
          'coveredEvents'
        ),
        sql<number>`SUM(CASE WHEN cost_basis IN ('unknown', 'subscription') THEN 1 ELSE 0 END)`.as(
          'uncoveredEvents'
        )
      ])
      .groupBy('sleeveId')
      .orderBy('knownMicroUsd', 'desc')
      .orderBy('sleeveId', 'asc')
      .execute();

    const sleeves = rows.map((row) => {
      const coveredEvents = integer(row.coveredEvents, 'covered cost count');
      const uncoveredEvents = integer(row.uncoveredEvents, 'uncovered cost count');
      return {
        sleeveId: row.sleeveId,
        requestCount: integer(row.requestCount, 'request count'),
        knownMicroUsd: integer(row.knownMicroUsd, 'known cost'),
        coveredEvents,
        uncoveredEvents,
        coverage: coverage(coveredEvents, uncoveredEvents)
      };
    });

    const totals = sleeves.reduce(
      (accumulator, sleeve) => ({
        requestCount: accumulator.requestCount + sleeve.requestCount,
        knownMicroUsd: accumulator.knownMicroUsd + sleeve.knownMicroUsd,
        coveredEvents: accumulator.coveredEvents + sleeve.coveredEvents,
        uncoveredEvents: accumulator.uncoveredEvents + sleeve.uncoveredEvents
      }),
      { requestCount: 0, knownMicroUsd: 0, coveredEvents: 0, uncoveredEvents: 0 }
    );

    return {
      sleeves,
      system: {
        ...totals,
        coverage: coverage(totals.coveredEvents, totals.uncoveredEvents)
      }
    };
  }

  async dashboardSummary(input: {
    limit: number;
    clientId?: string;
  }): Promise<DashboardModelUsageSummary> {
    const query = DashboardSummaryQuerySchema.parse(input);
    let aggregateQuery = this.db.selectFrom('model_usage_events').select(aggregateSelections);
    let routingQuery = this.db
      .selectFrom('model_usage_events')
      .select(['route', sql<number>`COUNT(*)`.as('requestCount')])
      .groupBy('route');
    let modelQuery = this.db
      .selectFrom('model_usage_events')
      .select([
        'provider',
        'model',
        'route',
        sql<number>`COUNT(*)`.as('requestCount'),
        sql<number>`SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END)`.as('succeededCount'),
        sql<number>`COALESCE(SUM(input_tokens), 0)`.as('inputTokens'),
        sql<number>`COALESCE(SUM(output_tokens), 0)`.as('outputTokens'),
        sql<number>`AVG(latency_ms)`.as('averageLatencyMs'),
        sql<number>`COALESCE(SUM(cost_microusd), 0)`.as('knownMicroUsd'),
        sql<number>`SUM(CASE WHEN cost_basis IN ('unknown', 'subscription') THEN 1 ELSE 0 END)`.as(
          'unknownCostEvents'
        )
      ])
      .groupBy(['provider', 'model', 'route'])
      .orderBy(sql`COUNT(*)`, 'desc')
      .orderBy('provider', 'asc')
      .orderBy('model', 'asc')
      .limit(query.limit);

    if (query.clientId !== undefined) {
      aggregateQuery = aggregateQuery.where('client_id', '=', query.clientId);
      routingQuery = routingQuery.where('client_id', '=', query.clientId);
      modelQuery = modelQuery.where('client_id', '=', query.clientId);
    }
    const [totals, routeRows, modelRows] = await Promise.all([
      aggregateQuery.executeTakeFirstOrThrow(),
      routingQuery.execute(),
      modelQuery.execute()
    ]);
    const requestCount = integer(totals.requestCount, 'request count');
    if (requestCount === 0) {
      return {
        status: 'unavailable',
        reason: 'No model-usage telemetry has been recorded.'
      };
    }

    const observedCostEvents = integer(totals.observedCostEvents, 'observed cost count');
    const estimatedCostEvents = integer(totals.estimatedCostEvents, 'estimated cost count');
    const unknownCostEvents = integer(totals.unknownCostEvents, 'unknown cost count');
    const subscriptionCostEvents = integer(
      totals.subscriptionCostEvents,
      'subscription cost count'
    );
    const localCostEvents = integer(totals.localCostEvents, 'local cost count');
    const observedMicroUsd = integer(totals.observedMicroUsd, 'observed cost');
    const estimatedMicroUsd = integer(totals.estimatedMicroUsd, 'estimated cost');
    const routeCounts = new Map(
      routeRows.map((row) => [
        ModelRouteSchema.parse(row.route),
        integer(row.requestCount, 'route count')
      ])
    );

    return {
      status: 'available',
      period: { startsAt: totals.startsAt, endsAt: totals.endsAt },
      usage: {
        requestCount,
        succeededCount: integer(totals.succeededCount, 'succeeded count'),
        failedCount: integer(totals.failedCount, 'failed count'),
        timeoutCount: integer(totals.timeoutCount, 'timeout count'),
        cancelledCount: integer(totals.cancelledCount, 'cancelled count'),
        inputTokens: integer(totals.inputTokens, 'input tokens'),
        outputTokens: integer(totals.outputTokens, 'output tokens'),
        cacheReadTokens: integer(totals.cacheReadTokens, 'cache-read tokens'),
        cacheWriteTokens: integer(totals.cacheWriteTokens, 'cache-write tokens'),
        unknownTokenEvents: integer(totals.unknownTokenEvents, 'unknown-token count')
      },
      latency: { averageMs: average(totals.averageLatencyMs, 'latency') },
      cost: {
        currency: 'USD',
        coverage: coverage(
          observedCostEvents + estimatedCostEvents + localCostEvents,
          unknownCostEvents + subscriptionCostEvents
        ),
        knownMicroUsd: integer(observedMicroUsd + estimatedMicroUsd, 'known cost'),
        observedMicroUsd,
        estimatedMicroUsd,
        observedCostEvents,
        estimatedCostEvents,
        unknownCostEvents,
        subscriptionCostEvents,
        localCostEvents
      },
      routing: (['local', 'economy', 'frontier'] as const).flatMap((route) => {
        const count = routeCounts.get(route);
        return count === undefined ? [] : [{ route, requestCount: count }];
      }),
      models: modelRows.map((row) => ({
        provider: row.provider,
        model: row.model,
        route: ModelRouteSchema.parse(row.route),
        requestCount: integer(row.requestCount, 'model request count'),
        succeededCount: integer(row.succeededCount, 'model succeeded count'),
        inputTokens: integer(row.inputTokens, 'model input tokens'),
        outputTokens: integer(row.outputTokens, 'model output tokens'),
        averageLatencyMs: average(row.averageLatencyMs, 'model latency'),
        knownMicroUsd: integer(row.knownMicroUsd, 'model known cost'),
        unknownCostEvents: integer(row.unknownCostEvents, 'model unknown cost count')
      }))
    };
  }
}
