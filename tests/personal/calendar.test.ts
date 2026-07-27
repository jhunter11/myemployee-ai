import { describe, expect, it } from 'vitest';

import {
  CalendarActionPolicy,
  CalendarPlanner,
  InMemoryCalendarReader
} from '../../src/personal/calendar';

const events = [
  {
    id: 'discovery-call',
    title: 'Discovery call',
    start: '2026-07-21T13:00:00.000Z',
    end: '2026-07-21T14:00:00.000Z',
    allDay: false,
    location: 'Video call',
    attendeeCount: 2,
    source: 'local_demo' as const
  },
  {
    id: 'proposal-review',
    title: 'Proposal review',
    start: '2026-07-21T13:30:00.000Z',
    end: '2026-07-21T14:30:00.000Z',
    allDay: false,
    location: null,
    attendeeCount: 0,
    source: 'local_demo' as const
  }
];

describe('personal calendar', () => {
  it('returns bounded events and detects overlapping intervals', async () => {
    const reader = new InMemoryCalendarReader(events);
    await expect(
      reader.read({
        from: '2026-07-21T00:00:00.000Z',
        to: '2026-07-22T00:00:00.000Z',
        limit: 10
      })
    ).resolves.toMatchObject({ events, truncated: false, conflicts: [[events[0], events[1]]] });
  });

  it('requires approval for external effects and only permits standing-policy private actions', () => {
    const policy = new CalendarActionPolicy();
    expect(policy.classify({ kind: 'create_private_hold', standingPolicy: true })).toMatchObject({
      verdict: 'autonomous',
      externalEffect: false
    });
    expect(policy.classify({ kind: 'create_private_hold', standingPolicy: false }).verdict).toBe(
      'approval_required'
    );
    expect(policy.classify({ kind: 'invite_attendees', standingPolicy: true })).toMatchObject({
      verdict: 'approval_required',
      externalEffect: true
    });
  });

  it('proposes the earliest conflict-free private focus block without writing a provider', () => {
    const proposal = new CalendarPlanner().proposePrivateHold({
      title: 'Focus block',
      from: '2026-07-21T13:00:00.000Z',
      to: '2026-07-21T16:00:00.000Z',
      durationMinutes: 60,
      events,
      standingPolicy: false
    });

    expect(proposal).toMatchObject({
      event: {
        title: 'Focus block',
        start: '2026-07-21T14:30:00.000Z',
        end: '2026-07-21T15:30:00.000Z'
      },
      policy: { verdict: 'approval_required', externalEffect: false },
      writePerformed: false
    });
  });
});
