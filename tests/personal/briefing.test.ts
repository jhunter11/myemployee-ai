import { describe, expect, it } from 'vitest';

import { DailyBriefingService } from '../../src/personal/briefing';

describe('DailyBriefingService', () => {
  it('deterministically combines events, conflicts, memory reviews, and agency approvals', async () => {
    const service = new DailyBriefingService({
      calendar: {
        read: () =>
          Promise.resolve({
            events: [
              {
                id: 'call',
                title: 'Client call',
                start: '2026-07-21T15:00:00.000Z',
                end: '2026-07-21T16:00:00.000Z',
                allDay: false,
                location: null,
                attendeeCount: 1,
                source: 'local_demo'
              }
            ],
            conflicts: [],
            truncated: false
          })
      },
      memory: {
        reviewDue: () =>
          Promise.resolve([
            {
              id: 'focus',
              branch: 'preferences',
              title: 'Focus window',
              summary: 'Keep mornings clear.',
              confidence: 1,
              sensitivity: 'private',
              reviewAt: '2026-07-21T12:00:00.000Z',
              source: 'personal-memory:focus'
            }
          ])
      },
      agency: { approvalCount: () => Promise.resolve(2) },
      now: () => '2026-07-21T12:00:00.000Z'
    });

    const briefing = await service.read();
    expect(briefing).toMatchObject({
      generatedAt: '2026-07-21T12:00:00.000Z',
      eventCount: 1,
      conflictCount: 0,
      memoryReviewCount: 1,
      agencyApprovalCount: 2,
      headline: '1 event today · 2 agency approvals need you'
    });
    expect(briefing.sources).toEqual(['calendar:call', 'personal-memory:focus']);
  });
});
