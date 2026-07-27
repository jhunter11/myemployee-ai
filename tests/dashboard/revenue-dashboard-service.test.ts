import { describe, expect, it, vi } from 'vitest';

import { DashboardService } from '../../src/dashboard/dashboard-service';
import {
  MICRO_USD_PER_USD,
  REVENUE_PIPELINE_SAFETY,
  type RevenueLane,
  type RevenueLaneSnapshot
} from '../../src/revenue/contracts';

const now = '2026-07-18T22:00:00.000Z';

function snapshot(lane: RevenueLane): RevenueLaneSnapshot {
  if (lane === 'agency') {
    return {
      lane,
      counts: { prospects: 1, offers: 1, outreachDrafts: 1, simulations: 0 },
      prospects: [
        {
          id: 'prospect_alpha',
          lane,
          publicLabel: 'Alpha Operations',
          contactChannel: 'email',
          hasContactReference: true,
          source: 'operator_research',
          need: 'agency_workflow_pilot',
          status: 'qualified',
          version: 2,
          createdAt: now,
          updatedAt: now,
          contactReference: 'contact:must-not-cross-dashboard',
          actorId: 'operator:private'
        }
      ],
      offers: [
        {
          id: 'offer_alpha',
          prospectId: 'prospect_alpha',
          lane,
          title: 'Workflow pilot',
          deliverable: 'workflow_pilot',
          quote: {
            basis: 'proposed',
            currency: 'USD',
            amountMicrousd: 1_500 * MICRO_USD_PER_USD
          },
          turnaroundHours: 72,
          revisionLimit: 1,
          status: 'reviewed',
          version: 3,
          externalPayment: 'blocked',
          createdAt: now,
          updatedAt: now,
          paymentAction: 'charge-now'
        }
      ],
      outreachDrafts: [
        {
          id: 'draft_alpha',
          prospectId: 'prospect_alpha',
          offerId: 'offer_alpha',
          lane,
          channel: 'email',
          status: 'review_ready',
          version: 2,
          subjectLength: 12,
          bodyLength: 40,
          contentDigest: 'a'.repeat(64),
          externalDelivery: 'blocked',
          createdAt: now,
          updatedAt: now,
          subject: 'private subject',
          body: 'private outreach body'
        }
      ],
      simulations: [],
      activation: null,
      safety: REVENUE_PIPELINE_SAFETY,
      actorId: 'operator:private'
    } as unknown as RevenueLaneSnapshot;
  }

  return {
    lane,
    counts: { prospects: 0, offers: 0, outreachDrafts: 0, simulations: 1 },
    prospects: [],
    offers: [],
    outreachDrafts: [],
    simulations: [
      {
        id: 'simulation_accept',
        activationVersion: 2,
        scenario: 'authorization_accepted',
        outcome: 'pass',
        requestDigest: 'b'.repeat(64),
        evidenceDigest: 'c'.repeat(64),
        quote: {
          basis: 'simulation',
          currency: 'USD',
          amountMicrousd: MICRO_USD_PER_USD / 2
        },
        externalPayment: 'blocked',
        revenueRecognition: 'none',
        recordedAt: now,
        settlementAction: 'capture'
      }
    ],
    activation: {
      lane: 'task_market',
      productId: 'edge-validation-v1',
      state: 'simulation',
      version: 2,
      contractDigest: 'd'.repeat(64),
      a2a: {
        version: '0.3.0',
        skillId: 'edge_validation',
        inputContract: 'bounded_numeric_series',
        outputContract: 'validation_verdict'
      },
      x402: {
        scheme: 'exact',
        quote: {
          basis: 'simulation',
          currency: 'USD',
          amountMicrousd: MICRO_USD_PER_USD / 2
        },
        paymentMode: 'simulated',
        pay: { wallet: 'private-wallet-material' }
      },
      safety: REVENUE_PIPELINE_SAFETY,
      createdAt: now,
      updatedAt: now,
      sellerWalletAddress: 'private-wallet-address'
    },
    safety: REVENUE_PIPELINE_SAFETY
  } as unknown as RevenueLaneSnapshot;
}

function createService(
  readLaneSnapshot:
    ((input: { lane: RevenueLane; limit: number }) => Promise<RevenueLaneSnapshot>) | undefined,
  revenueItemLimit = 3
) {
  const emptySummary = () => Promise.resolve({ counts: {}, items: [], recent: [] });
  return new DashboardService({
    clients: { dashboardSummary: emptySummary },
    runs: { dashboardSummary: emptySummary },
    audits: { dashboardSummary: () => Promise.resolve({ unresolvedCount: 0, recent: [] }) },
    economics: {
      dashboardSummary: () =>
        Promise.resolve({
          status: 'unavailable' as const,
          reason: 'No model-usage telemetry has been recorded.'
        })
    },
    queue: {
      readTenantQueue: () =>
        Promise.resolve({
          tenantId: 'jarvis',
          returnedTaskCount: 0,
          truncated: false,
          lanes: []
        })
    },
    queueTenantId: 'jarvis',
    ...(readLaneSnapshot === undefined ? {} : { revenue: { readLaneSnapshot } }),
    health: {
      check: () =>
        Promise.resolve({
          timestamp: now,
          overall: 'healthy' as const,
          severity: 'none' as const,
          checks: { gateway: 'ok' },
          failures: [],
          action: 'none' as const
        })
    },
    metrics: { snapshot: () => ({ totalRequests: 0, errors: 0, lastRunAtByClient: {} }) },
    toolsmith: { analyze: () => Promise.resolve([]) },
    graph: {
      readIndex: () => Promise.resolve({ generatedAt: now, nodes: [], edges: [] }),
      listOperatorPages: () => Promise.resolve([])
    },
    now: () => now,
    revenueItemLimit
  });
}

describe('DashboardService revenue snapshot', () => {
  it('queries both fixed lanes at a bounded limit and re-allowlists every redacted DTO', async () => {
    const readLaneSnapshot = vi.fn(({ lane }: { lane: RevenueLane; limit: number }) =>
      Promise.resolve(snapshot(lane))
    );
    const service = createService(readLaneSnapshot);

    const result = await service.revenueSnapshot();

    expect(readLaneSnapshot.mock.calls).toEqual([
      [{ lane: 'agency', limit: 3 }],
      [{ lane: 'task_market', limit: 3 }]
    ]);
    expect(result).toMatchObject({
      generatedAt: now,
      lanes: {
        agency: {
          lane: 'agency',
          counts: { prospects: 1, offers: 1, outreachDrafts: 1, simulations: 0 },
          prospects: [{ id: 'prospect_alpha', hasContactReference: true }],
          offers: [
            {
              id: 'offer_alpha',
              quote: { basis: 'proposed', amountMicrousd: 1_500 * MICRO_USD_PER_USD },
              externalPayment: 'blocked'
            }
          ],
          outreachDrafts: [
            { id: 'draft_alpha', contentDigest: 'a'.repeat(64), externalDelivery: 'blocked' }
          ],
          activation: null
        },
        task_market: {
          lane: 'task_market',
          counts: { simulations: 1 },
          activation: {
            state: 'simulation',
            x402: { paymentMode: 'simulated' },
            safety: { externalPayment: 'blocked', walletMaterial: 'forbidden' }
          }
        }
      }
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'contact:must-not-cross-dashboard',
      'operator:private',
      'private subject',
      'private outreach body',
      'charge-now',
      'capture',
      'private-wallet'
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('fails closed on a wrong-lane reader result or an unbounded result', async () => {
    const wrongLane = createService(() => Promise.resolve(snapshot('task_market')));
    await expect(wrongLane.revenueSnapshot()).rejects.toThrow(/expected agency/i);

    const tooMany = snapshot('agency');
    tooMany.prospects = Array.from({ length: 4 }, (_, index) => ({
      ...tooMany.prospects[0]!,
      id: `prospect_${index}`
    }));
    const unbounded = createService(({ lane }) =>
      Promise.resolve(lane === 'agency' ? tooMany : snapshot(lane))
    );
    await expect(unbounded.revenueSnapshot()).rejects.toThrow(/bounded limit/i);
  });

  it('fails closed on misplaced task-market data, child lanes, payment modes, or a missing reader', async () => {
    const taskDataInAgency = snapshot('agency');
    taskDataInAgency.activation = snapshot('task_market').activation;
    const misplacedActivation = createService(({ lane }) =>
      Promise.resolve(lane === 'agency' ? taskDataInAgency : snapshot(lane))
    );
    await expect(misplacedActivation.revenueSnapshot()).rejects.toThrow(
      /task-market data in the agency lane/i
    );

    const simulationInAgency = snapshot('agency');
    simulationInAgency.simulations = snapshot('task_market').simulations;
    const misplacedSimulation = createService(({ lane }) =>
      Promise.resolve(lane === 'agency' ? simulationInAgency : snapshot(lane))
    );
    await expect(misplacedSimulation.revenueSnapshot()).rejects.toThrow(
      /task-market data in the agency lane/i
    );

    const wrongChildLane = snapshot('agency');
    wrongChildLane.prospects[0]!.lane = 'task_market';
    const misplacedProspect = createService(({ lane }) =>
      Promise.resolve(lane === 'agency' ? wrongChildLane : snapshot(lane))
    );
    await expect(misplacedProspect.revenueSnapshot()).rejects.toThrow(/prospect.*expected agency/i);

    const inconsistentPayment = snapshot('task_market');
    inconsistentPayment.activation!.x402.paymentMode = 'blocked';
    const invalidPaymentMode = createService(({ lane }) =>
      Promise.resolve(lane === 'task_market' ? inconsistentPayment : snapshot(lane))
    );
    await expect(invalidPaymentMode.revenueSnapshot()).rejects.toThrow(
      /inconsistent task-market payment mode/i
    );

    await expect(createService(undefined).revenueSnapshot()).rejects.toThrow(/not configured/i);
  });

  it.each([0, -1, 51, 1.5])('rejects invalid revenue item limit %s', (revenueItemLimit) => {
    expect(() =>
      createService(({ lane }) => Promise.resolve(snapshot(lane)), revenueItemLimit)
    ).toThrow(RangeError);
  });
});
