import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { JarvisDashboardService } from '../../src/dashboard/jarvis-dashboard-service';
import type {
  DashboardQueueSnapshot,
  DashboardRevenueSnapshot
} from '../../src/dashboard/dashboard-service';
import { DailyBriefingService } from '../../src/personal/briefing';
import { InMemoryCalendarReader } from '../../src/personal/calendar';
import { MarkdownPersonalMemoryRepository } from '../../src/personal/memory-repository';
import { REVENUE_PIPELINE_SAFETY } from '../../src/revenue/contracts';

const now = '2026-07-21T12:00:00.000Z';

function executionPosture(posture: 'active' | 'paused' = 'active') {
  return {
    current: () =>
      Promise.resolve({
        posture,
        version: 1,
        updatedAt: now,
        updatedBy: 'system:test',
        reason: 'test_fixture',
        sourceProposalId: null,
        sourceProposalVersion: null,
        sourceConfirmationFingerprint: null,
        sourceDecisionId: null
      })
  };
}

function queue(): DashboardQueueSnapshot {
  return {
    generatedAt: now,
    tenantId: 'jarvis',
    returnedTaskCount: 2,
    truncated: false,
    lanes: [
      {
        lane: 'agency',
        ready: [
          {
            id: 'verify-delivery',
            lane: 'agency',
            payloadKind: 'project_task',
            band: 'P2',
            state: 'queued',
            version: 1,
            dependencyCount: 0,
            blockedDependencyCount: 0,
            createdAt: now,
            availableAt: now,
            ready: true
          }
        ],
        blocked: [
          {
            id: 'approve-outbound',
            lane: 'agency',
            payloadKind: 'operator_gate',
            band: 'P1',
            state: 'queued',
            version: 1,
            dependencyCount: 1,
            blockedDependencyCount: 1,
            createdAt: now,
            availableAt: now,
            ready: false
          }
        ]
      }
    ]
  };
}

function revenue(): DashboardRevenueSnapshot {
  const lane = (name: 'agency' | 'task_market') => ({
    lane: name,
    counts: { prospects: 0, offers: 0, outreachDrafts: 0, simulations: 0 },
    prospects: [],
    offers: [],
    outreachDrafts: [],
    simulations: [],
    activation: null,
    safety: REVENUE_PIPELINE_SAFETY
  });
  return { generatedAt: now, lanes: { agency: lane('agency'), task_market: lane('task_market') } };
}

describe('JarvisDashboardService', () => {
  it('projects personal memory and calendar without exposing the agency graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-dashboard-personal-'));
    const memory = new MarkdownPersonalMemoryRepository(root);
    await memory.save({
      version: 1,
      id: 'daily-focus',
      branch: 'preferences',
      title: 'Daily focus',
      summary: 'Protect the first work block.',
      provenance: 'operator_statement',
      confidence: 1,
      sensitivity: 'private',
      scope: 'personal',
      createdAt: now,
      updatedAt: now,
      reviewAt: now,
      expiresAt: null,
      corrections: []
    });
    const calendar = new InMemoryCalendarReader([
      {
        id: 'daily-briefing',
        title: 'Daily briefing',
        start: '2026-07-21T13:00:00.000Z',
        end: '2026-07-21T13:30:00.000Z',
        allDay: false,
        location: null,
        attendeeCount: 0,
        source: 'local_demo'
      }
    ]);
    const briefing = new DailyBriefingService({
      calendar,
      memory,
      agency: { approvalCount: () => Promise.resolve(1) },
      now: () => now
    });
    const service = new JarvisDashboardService({
      memory,
      calendar,
      briefing,
      queue: { queueSnapshot: () => Promise.resolve(queue()) },
      revenue: { revenueSnapshot: () => Promise.resolve(revenue()) },
      calendarMode: 'local_demo',
      executionPosture: executionPosture(),
      now: () => now
    });

    await expect(service.personalSnapshot()).resolves.toMatchObject({
      generatedAt: now,
      calendarMode: 'local_demo',
      availability: {
        briefing: 'available',
        calendar: 'available',
        memoryRecords: 'available',
        memoryReviews: 'available'
      },
      briefing: { eventCount: 1, agencyApprovalCount: 1 },
      memory: {
        records: [
          {
            id: 'daily-focus',
            source: 'personal-memory:daily-focus'
          }
        ]
      }
    });
  });

  it.each([
    ['briefing', 'briefing'],
    ['calendar', 'calendar'],
    ['memory records', 'memoryRecords'],
    ['memory reviews', 'memoryReviews']
  ] as const)(
    'keeps successful personal sources when %s is unavailable',
    async (_failedLabel, failedSource) => {
      const root = await mkdtemp(join(tmpdir(), `jarvis-dashboard-${failedSource}-`));
      const memory = new MarkdownPersonalMemoryRepository(root);
      await memory.save({
        version: 1,
        id: 'bounded-memory',
        branch: 'preferences',
        title: 'Bounded memory',
        summary: 'This safe summary must survive an unrelated source failure.',
        provenance: 'operator_statement',
        confidence: 1,
        sensitivity: 'private',
        scope: 'personal',
        createdAt: now,
        updatedAt: now,
        reviewAt: now,
        expiresAt: null,
        corrections: []
      });
      const calendar = new InMemoryCalendarReader([
        {
          id: 'bounded-event',
          title: 'Bounded event',
          start: '2026-07-21T13:00:00.000Z',
          end: '2026-07-21T13:30:00.000Z',
          allDay: false,
          location: null,
          attendeeCount: 0,
          source: 'local_demo'
        }
      ]);
      const briefing = new DailyBriefingService({
        calendar,
        memory,
        agency: { approvalCount: () => Promise.resolve(1) },
        now: () => now
      });
      const briefingRead = vi.spyOn(briefing, 'read').mockResolvedValue({
        generatedAt: now,
        headline: '1 event today · 1 agency approval needs you',
        eventCount: 1,
        conflictCount: 0,
        memoryReviewCount: 1,
        agencyApprovalCount: 1,
        nextEvents: [
          {
            id: 'bounded-event',
            title: 'Bounded event',
            start: '2026-07-21T13:00:00.000Z',
            end: '2026-07-21T13:30:00.000Z',
            location: null
          }
        ],
        memoryReviews: [
          {
            id: 'bounded-memory',
            branch: 'preferences',
            title: 'Bounded memory',
            summary: 'This safe summary must survive an unrelated source failure.',
            confidence: 1,
            sensitivity: 'private',
            reviewAt: now,
            source: 'personal-memory:bounded-memory'
          }
        ],
        sources: ['calendar:bounded-event', 'personal-memory:bounded-memory']
      });

      if (failedSource === 'briefing') {
        briefingRead.mockRejectedValue(new Error('RAW_UPSTREAM_SECRET:briefing'));
      } else if (failedSource === 'calendar') {
        vi.spyOn(calendar, 'read').mockRejectedValue(new Error('RAW_UPSTREAM_SECRET:calendar'));
      } else if (failedSource === 'memoryRecords') {
        vi.spyOn(memory, 'reviewDue').mockResolvedValue([
          {
            id: 'bounded-memory',
            branch: 'preferences',
            title: 'Bounded memory',
            summary: 'This safe summary must survive an unrelated source failure.',
            confidence: 1,
            sensitivity: 'private',
            reviewAt: now,
            source: 'personal-memory:bounded-memory'
          }
        ]);
        vi.spyOn(memory, 'list').mockRejectedValue(new Error('RAW_UPSTREAM_SECRET:memory-records'));
      } else {
        vi.spyOn(memory, 'reviewDue').mockRejectedValue(
          new Error('RAW_UPSTREAM_SECRET:memory-reviews')
        );
      }

      const service = new JarvisDashboardService({
        memory,
        calendar,
        briefing,
        queue: { queueSnapshot: () => Promise.resolve(queue()) },
        revenue: { revenueSnapshot: () => Promise.resolve(revenue()) },
        calendarMode: 'local_demo',
        executionPosture: executionPosture(),
        now: () => now
      });

      const snapshot = await service.personalSnapshot();
      expect(snapshot.availability).toEqual({
        briefing: failedSource === 'briefing' ? 'unavailable' : 'available',
        calendar: failedSource === 'calendar' ? 'unavailable' : 'available',
        memoryRecords: failedSource === 'memoryRecords' ? 'unavailable' : 'available',
        memoryReviews: failedSource === 'memoryReviews' ? 'unavailable' : 'available'
      });
      if (failedSource !== 'briefing') expect(snapshot.briefing.eventCount).toBe(1);
      if (failedSource !== 'calendar') expect(snapshot.calendar.events).toHaveLength(1);
      if (failedSource !== 'memoryRecords') expect(snapshot.memory.records).toHaveLength(1);
      if (failedSource !== 'memoryReviews') expect(snapshot.memory.reviewDue).toHaveLength(1);
      expect(JSON.stringify(snapshot)).not.toContain('RAW_UPSTREAM_SECRET');
    }
  );

  it('keeps unbound queue work proposal-only and operator gates under approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-dashboard-agency-'));
    const memory = new MarkdownPersonalMemoryRepository(root);
    const calendar = new InMemoryCalendarReader([]);
    const service = new JarvisDashboardService({
      memory,
      calendar,
      briefing: new DailyBriefingService({
        calendar,
        memory,
        agency: { approvalCount: () => Promise.resolve(0) },
        now: () => now
      }),
      queue: { queueSnapshot: () => Promise.resolve(queue()) },
      revenue: { revenueSnapshot: () => Promise.resolve(revenue()) },
      calendarMode: 'local_demo',
      executionPosture: executionPosture(),
      now: () => now
    });

    await expect(service.agencyControlSnapshot()).resolves.toMatchObject({
      posture: 'active',
      autonomous: [],
      approvalRequired: [
        { id: 'verify-delivery', approvalState: 'approval_required' },
        { id: 'approve-outbound', approvalState: 'approval_required' }
      ]
    });
  });

  it('marks only a queue automation with a verified binding autonomous', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-dashboard-bound-worker-'));
    const memory = new MarkdownPersonalMemoryRepository(root);
    const calendar = new InMemoryCalendarReader([]);
    const boundQueue: DashboardQueueSnapshot = {
      generatedAt: now,
      tenantId: 'jarvis',
      tenantIds: ['acme_corp', 'jarvis'],
      returnedTaskCount: 1,
      truncated: false,
      lanes: [
        {
          lane: 'delivery',
          ready: [
            {
              id: 'acme-daily-report',
              tenantId: 'acme_corp',
              lane: 'delivery',
              payloadKind: 'automation',
              executionEligibility: 'bound',
              band: 'P2',
              state: 'queued',
              version: 1,
              dependencyCount: 0,
              blockedDependencyCount: 0,
              createdAt: now,
              availableAt: now,
              ready: true
            }
          ],
          blocked: []
        }
      ]
    };
    const service = new JarvisDashboardService({
      memory,
      calendar,
      briefing: new DailyBriefingService({
        calendar,
        memory,
        agency: { approvalCount: () => Promise.resolve(0) },
        now: () => now
      }),
      queue: { queueSnapshot: () => Promise.resolve(boundQueue) },
      revenue: { revenueSnapshot: () => Promise.resolve(revenue()) },
      calendarMode: 'local_demo',
      executionPosture: executionPosture(),
      now: () => now
    });

    await expect(service.agencyControlSnapshot()).resolves.toMatchObject({
      autonomous: [{ id: 'acme-daily-report', approvalState: 'autonomous' }],
      approvalRequired: []
    });
  });

  it('reads the durable execution posture for every agency projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-dashboard-live-posture-'));
    const memory = new MarkdownPersonalMemoryRepository(root);
    const calendar = new InMemoryCalendarReader([]);
    let currentPosture: 'active' | 'paused' = 'active';
    const service = new JarvisDashboardService({
      memory,
      calendar,
      briefing: new DailyBriefingService({
        calendar,
        memory,
        agency: { approvalCount: () => Promise.resolve(0) },
        now: () => now
      }),
      queue: { queueSnapshot: () => Promise.resolve(queue()) },
      revenue: { revenueSnapshot: () => Promise.resolve(revenue()) },
      calendarMode: 'local_demo',
      executionPosture: {
        current: () => executionPosture(currentPosture).current()
      },
      now: () => now
    });

    await expect(service.agencyControlSnapshot()).resolves.toMatchObject({
      posture: 'active',
      killSwitchEngaged: false,
      executionPosture: { posture: 'active', version: 1 }
    });
    currentPosture = 'paused';
    await expect(service.agencyControlSnapshot()).resolves.toMatchObject({
      posture: 'paused',
      killSwitchEngaged: true,
      executionPosture: { posture: 'paused', version: 1 }
    });
  });
});
