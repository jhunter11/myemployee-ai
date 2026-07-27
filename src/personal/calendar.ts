import { z } from 'zod';

import { type PersonalCalendarEvent, PersonalCalendarEventSchema } from './contracts';

const CalendarReadQuerySchema = z
  .strictObject({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    limit: z.number().int().min(1).max(50)
  })
  .refine((query) => Date.parse(query.to) > Date.parse(query.from), {
    message: 'to must follow from',
    path: ['to']
  });

export interface CalendarSnapshot {
  events: PersonalCalendarEvent[];
  conflicts: Array<[PersonalCalendarEvent, PersonalCalendarEvent]>;
  truncated: boolean;
}

export interface PersonalCalendarReader {
  read(input: { from: string; to: string; limit: number }): Promise<CalendarSnapshot>;
}

export function calendarConflicts(
  events: PersonalCalendarEvent[]
): Array<[PersonalCalendarEvent, PersonalCalendarEvent]> {
  const pairs: Array<[PersonalCalendarEvent, PersonalCalendarEvent]> = [];
  events.forEach((left, index) => {
    events.slice(index + 1).forEach((right) => {
      if (
        Date.parse(left.start) < Date.parse(right.end) &&
        Date.parse(right.start) < Date.parse(left.end)
      ) {
        pairs.push([left, right]);
      }
    });
  });
  return pairs;
}

export class InMemoryCalendarReader implements PersonalCalendarReader {
  private readonly events: PersonalCalendarEvent[];

  constructor(events: unknown[]) {
    this.events = events.map((event) => PersonalCalendarEventSchema.parse(event));
  }

  read(input: { from: string; to: string; limit: number }): Promise<CalendarSnapshot> {
    const query = CalendarReadQuerySchema.parse(input);
    const matching = this.events
      .filter(
        (event) =>
          Date.parse(event.end) > Date.parse(query.from) &&
          Date.parse(event.start) < Date.parse(query.to)
      )
      .sort((left, right) => left.start.localeCompare(right.start));
    const events = matching.slice(0, query.limit);
    return Promise.resolve({
      events,
      conflicts: calendarConflicts(events),
      truncated: matching.length > events.length
    });
  }
}

const CalendarActionSchema = z.strictObject({
  kind: z.enum([
    'create_private_hold',
    'set_reminder',
    'invite_attendees',
    'change_attendees',
    'cancel_event',
    'send_message',
    'provider_write'
  ]),
  standingPolicy: z.boolean()
});

export class CalendarActionPolicy {
  classify(input: unknown): {
    verdict: 'autonomous' | 'approval_required';
    externalEffect: boolean;
    reason: string;
  } {
    const action = CalendarActionSchema.parse(input);
    const internal = action.kind === 'create_private_hold' || action.kind === 'set_reminder';
    const autonomous = internal && action.standingPolicy;
    return {
      verdict: autonomous ? 'autonomous' : 'approval_required',
      externalEffect: !internal,
      reason: autonomous
        ? 'A standing policy permits this reversible private calendar action.'
        : 'Calendar changes without a private standing policy require operator approval.'
    };
  }
}

const PrivateHoldProposalSchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  durationMinutes: z.number().int().min(15).max(240),
  events: z.array(PersonalCalendarEventSchema).max(50),
  standingPolicy: z.boolean()
});

export class CalendarPlanner {
  constructor(private readonly policy = new CalendarActionPolicy()) {}

  proposePrivateHold(input: unknown): {
    event: { title: string; start: string; end: string };
    policy: ReturnType<CalendarActionPolicy['classify']>;
    writePerformed: false;
  } | null {
    const request = PrivateHoldProposalSchema.parse(input);
    const windowEnd = Date.parse(request.to);
    let start = Date.parse(request.from);
    const durationMs = request.durationMinutes * 60_000;
    for (const event of [...request.events].sort((left, right) =>
      left.start.localeCompare(right.start)
    )) {
      if (Date.parse(event.end) <= start) continue;
      if (Date.parse(event.start) >= start + durationMs) break;
      start = Math.max(start, Date.parse(event.end));
    }
    if (start + durationMs > windowEnd) return null;
    return {
      event: {
        title: request.title,
        start: new Date(start).toISOString(),
        end: new Date(start + durationMs).toISOString()
      },
      policy: this.policy.classify({
        kind: 'create_private_hold',
        standingPolicy: request.standingPolicy
      }),
      writePerformed: false
    };
  }
}
