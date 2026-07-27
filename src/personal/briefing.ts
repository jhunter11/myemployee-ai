import type { PersonalMemoryReader } from './memory-repository';
import type { PersonalCalendarReader } from './calendar';

export interface AgencyApprovalReader {
  approvalCount(): Promise<number>;
}

export interface DailyBriefing {
  generatedAt: string;
  headline: string;
  eventCount: number;
  conflictCount: number;
  memoryReviewCount: number;
  agencyApprovalCount: number;
  nextEvents: Array<{
    id: string;
    title: string;
    start: string;
    end: string;
    location: string | null;
  }>;
  memoryReviews: Awaited<ReturnType<PersonalMemoryReader['reviewDue']>>;
  sources: string[];
}

export class DailyBriefingService {
  constructor(
    private readonly options: {
      calendar: PersonalCalendarReader;
      memory: PersonalMemoryReader;
      agency: AgencyApprovalReader;
      now?: () => string;
    }
  ) {}

  async read(): Promise<DailyBriefing> {
    const generatedAt = (this.options.now ?? (() => new Date().toISOString()))();
    const from = new Date(generatedAt);
    from.setUTCHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 1);
    const [calendar, memoryReviews, agencyApprovalCount] = await Promise.all([
      this.options.calendar.read({ from: from.toISOString(), to: to.toISOString(), limit: 12 }),
      this.options.memory.reviewDue({ now: generatedAt, limit: 8 }),
      this.options.agency.approvalCount()
    ]);
    const eventLabel = `${calendar.events.length} event${calendar.events.length === 1 ? '' : 's'} today`;
    const approvalLabel = `${agencyApprovalCount} agency approval${agencyApprovalCount === 1 ? '' : 's'} need you`;
    return {
      generatedAt,
      headline: `${eventLabel} · ${approvalLabel}`,
      eventCount: calendar.events.length,
      conflictCount: calendar.conflicts.length,
      memoryReviewCount: memoryReviews.length,
      agencyApprovalCount,
      nextEvents: calendar.events
        .slice(0, 5)
        .map(({ id, title, start, end, location }) => ({ id, title, start, end, location })),
      memoryReviews,
      sources: [
        ...calendar.events.map((event) => `calendar:${event.id}`),
        ...memoryReviews.map((memory) => memory.source)
      ]
    };
  }
}
