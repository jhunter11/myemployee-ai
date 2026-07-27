import type { AgencyControlSnapshot } from '../agency/control-center';
import { AgencyControlCenter, type AgencyCandidate } from '../agency/control-center';
import type { AgencyExecutionPosture } from '../agency/execution-posture';
import type { DashboardQueueSnapshot, DashboardRevenueSnapshot } from './dashboard-service';
import type { DailyBriefingService } from '../personal/briefing';
import type { PersonalCalendarReader } from '../personal/calendar';
import { CalendarPlanner } from '../personal/calendar';
import type { MarkdownPersonalMemoryRepository } from '../personal/memory-repository';

export interface PersonalDashboardSnapshot {
  generatedAt: string;
  calendarMode: 'local_demo' | 'provider';
  availability: {
    briefing: 'available' | 'unavailable';
    calendar: 'available' | 'unavailable';
    memoryRecords: 'available' | 'unavailable';
    memoryReviews: 'available' | 'unavailable';
  };
  briefing: Awaited<ReturnType<DailyBriefingService['read']>>;
  calendar: Awaited<ReturnType<PersonalCalendarReader['read']>> & {
    proposedFocusBlock: ReturnType<CalendarPlanner['proposePrivateHold']>;
  };
  memory: {
    records: Array<{
      id: string;
      branch: string;
      title: string;
      summary: string;
      confidence: number;
      sensitivity: string;
      reviewAt: string | null;
      source: string;
    }>;
    reviewDue: Awaited<ReturnType<MarkdownPersonalMemoryRepository['reviewDue']>>;
  };
}

export interface AgencyDashboardSnapshot extends AgencyControlSnapshot {
  generatedAt: string;
  executionPosture: AgencyExecutionPosture;
}

function queueCandidates(queue: DashboardQueueSnapshot): AgencyCandidate[] {
  return queue.lanes.flatMap((lane) =>
    [...lane.ready, ...lane.blocked].map((task): AgencyCandidate => {
      if (task.payloadKind === 'operator_gate') {
        return {
          id: task.id,
          category: 'policy_change',
          label: `Review ${lane.lane} operator gate`,
          reversible: false,
          externalEffect: false,
          executionEligibility: 'proposal_only',
          sourceRef: `queue:${task.id}`
        };
      }
      return {
        id: task.id,
        category: task.payloadKind === 'automation' ? 'schedule_worker' : 'verification',
        label:
          task.payloadKind === 'automation'
            ? `Run approved ${lane.lane} automation`
            : `Verify ${lane.lane} project evidence`,
        reversible: true,
        externalEffect: false,
        executionEligibility: task.executionEligibility ?? 'proposal_only',
        sourceRef: `queue:${task.id}`
      };
    })
  );
}

function revenueCandidates(revenue: DashboardRevenueSnapshot): AgencyCandidate[] {
  return revenue.lanes.agency.outreachDrafts
    .filter((draft) => draft.status === 'review_ready' || draft.status === 'reviewed')
    .map((draft) => ({
      id: draft.id,
      category: 'outbound_message' as const,
      label: 'Approve an agency outreach draft',
      reversible: false,
      externalEffect: true,
      sourceRef: `revenue:${draft.id}`
    }));
}

export class JarvisDashboardService {
  private readonly now: () => string;

  constructor(
    private readonly options: {
      memory: MarkdownPersonalMemoryRepository;
      calendar: PersonalCalendarReader;
      briefing: DailyBriefingService;
      queue: { queueSnapshot(): Promise<DashboardQueueSnapshot> };
      revenue: { revenueSnapshot(): Promise<DashboardRevenueSnapshot> };
      calendarMode: 'local_demo' | 'provider';
      executionPosture: { current(): Promise<AgencyExecutionPosture> };
      now?: () => string;
    }
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async personalSnapshot(): Promise<PersonalDashboardSnapshot> {
    const generatedAt = this.now();
    const from = new Date(generatedAt);
    from.setUTCHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 1);
    const [briefingResult, calendarResult, recordsResult, reviewDueResult] =
      await Promise.allSettled([
        this.options.briefing.read(),
        this.options.calendar
          .read({ from: from.toISOString(), to: to.toISOString(), limit: 25 })
          .then((calendar) => ({
            ...calendar,
            proposedFocusBlock: new CalendarPlanner().proposePrivateHold({
              title: 'Jarvis focus block',
              from: generatedAt,
              to: to.toISOString(),
              durationMinutes: 60,
              events: calendar.events,
              standingPolicy: false
            })
          })),
        this.options.memory.list({ limit: 25 }).then((records) =>
          records.map(({ id, branch, title, summary, confidence, sensitivity, reviewAt }) => ({
            id,
            branch,
            title,
            summary,
            confidence,
            sensitivity,
            reviewAt,
            source: `personal-memory:${id}`
          }))
        ),
        this.options.memory.reviewDue({ now: generatedAt, limit: 8 })
      ]);
    const briefing =
      briefingResult.status === 'fulfilled'
        ? briefingResult.value
        : {
            generatedAt,
            headline: 'Daily briefing unavailable.',
            eventCount: 0,
            conflictCount: 0,
            memoryReviewCount: 0,
            agencyApprovalCount: 0,
            nextEvents: [],
            memoryReviews: [],
            sources: []
          };
    const calendar =
      calendarResult.status === 'fulfilled'
        ? calendarResult.value
        : { events: [], conflicts: [], truncated: false, proposedFocusBlock: null };
    const records = recordsResult.status === 'fulfilled' ? recordsResult.value : [];
    const reviewDue = reviewDueResult.status === 'fulfilled' ? reviewDueResult.value : [];
    return {
      generatedAt,
      calendarMode: this.options.calendarMode,
      availability: {
        briefing: briefingResult.status === 'fulfilled' ? 'available' : 'unavailable',
        calendar: calendarResult.status === 'fulfilled' ? 'available' : 'unavailable',
        memoryRecords: recordsResult.status === 'fulfilled' ? 'available' : 'unavailable',
        memoryReviews: reviewDueResult.status === 'fulfilled' ? 'available' : 'unavailable'
      },
      briefing,
      calendar,
      memory: {
        records,
        reviewDue
      }
    };
  }

  async agencyControlSnapshot(): Promise<AgencyDashboardSnapshot> {
    const [queue, revenue, executionPosture] = await Promise.all([
      this.options.queue.queueSnapshot(),
      this.options.revenue.revenueSnapshot(),
      this.options.executionPosture.current()
    ]);
    return {
      generatedAt: this.now(),
      executionPosture,
      ...new AgencyControlCenter({
        killSwitchEngaged: executionPosture.posture === 'paused'
      }).project([...queueCandidates(queue), ...revenueCandidates(revenue)])
    };
  }
}
