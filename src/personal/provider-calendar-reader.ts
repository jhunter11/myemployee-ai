import { z } from 'zod';

import { calendarConflicts, type CalendarSnapshot, type PersonalCalendarReader } from './calendar';
import {
  CalendarConnectionUnavailableError,
  CalendarScopeBindingSchema,
  type CalendarConnectionRecord,
  type CalendarScopeBinding
} from './calendar-provider-contracts';
import type { SqliteCalendarProviderRepository } from './calendar-provider-repository';

const ProviderCalendarReadQuerySchema = z
  .strictObject({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    limit: z.number().int().min(1).max(50)
  })
  .refine((query) => Date.parse(query.to) > Date.parse(query.from), {
    message: 'to must follow from',
    path: ['to']
  });

export class ProviderCalendarReader implements PersonalCalendarReader {
  private readonly binding: CalendarScopeBinding;
  private readonly connectionId: string;
  private readonly now: () => string;

  constructor(
    private readonly repository: SqliteCalendarProviderRepository,
    options: {
      binding: CalendarScopeBinding;
      connectionId: string;
      now?: () => string;
    }
  ) {
    this.binding = CalendarScopeBindingSchema.parse(options.binding);
    this.connectionId = options.connectionId;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  connectionState(): Promise<CalendarConnectionRecord | null> {
    return this.repository.findExact(this.binding, this.connectionId);
  }

  async read(rawInput: { from: string; to: string; limit: number }): Promise<CalendarSnapshot> {
    const input = ProviderCalendarReadQuerySchema.parse(rawInput);
    const connection = await this.repository.findExact(this.binding, this.connectionId);
    const now = Date.parse(new Date(this.now()).toISOString());
    if (
      connection === null ||
      connection.state !== 'active' ||
      connection.lastSyncedAt === null ||
      connection.lastErrorCode !== null ||
      (connection.credentialExpiresAt !== null && Date.parse(connection.credentialExpiresAt) <= now)
    ) {
      throw new CalendarConnectionUnavailableError();
    }

    const matching = await this.repository.readEvents({
      binding: this.binding,
      connectionId: this.connectionId,
      from: input.from,
      to: input.to,
      limit: input.limit + 1
    });
    const events = matching.slice(0, input.limit);
    return {
      events,
      conflicts: calendarConflicts(events),
      truncated: matching.length > events.length
    };
  }
}
