import { z } from 'zod';

import type { ModelProviderId } from '../models/contracts';

export const JarvisChatRequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(2_000)
});

export type JarvisChatRequest = z.infer<typeof JarvisChatRequestSchema>;
export type JarvisChatIntent = 'today' | 'calendar' | 'memory' | 'agency' | 'pages' | 'help';

export interface JarvisChatResponse {
  mode: 'deterministic' | 'model';
  intent: JarvisChatIntent;
  reply: string;
  suggestedView: 'today' | 'calendar' | 'personal' | 'agency' | 'saved';
  evidenceRefs: string[];
  requiresApproval: false;
  provider?: ModelProviderId;
  model?: string;
}

interface PersonalChatReader {
  personalSnapshot(): Promise<unknown>;
}

interface AgencyChatReader {
  agencyControlSnapshot(): Promise<unknown>;
}

interface PageChatReader {
  list(): Promise<unknown[]>;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function count(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function plural(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

function intent(message: string): JarvisChatIntent {
  const command = message
    .trim()
    .toLowerCase()
    .replace(/[?.!]+$/u, '');
  if (
    /^(?:agency|agent|approval|autonomy)(?:\s+(?:agent\s+)?(?:status|posture|work|summary|queue|approvals?))?$/u.test(
      command
    ) ||
    /^(?:show|summarize|check|report|open|give me)\s+(?:me\s+|the\s+|my\s+)?(?:agency|agent|approval|autonomy)\b.{0,80}$/u.test(
      command
    )
  ) {
    return 'agency';
  }
  if (
    /^(?:today|attention|brief|briefing)(?:\s+(?:status|summary))?$/u.test(command) ||
    /^what needs my attention today$/u.test(command) ||
    /^(?:show|summarize|check|report|open|give me)\s+(?:me\s+|the\s+|my\s+)?(?:today|attention|brief|briefing)\b.{0,80}$/u.test(
      command
    )
  ) {
    return 'today';
  }
  if (
    /^(?:calendar|schedule|events?|focus block)(?:\s+(?:status|schedule|summary))?$/u.test(
      command
    ) ||
    /^(?:show|summarize|check|report|open|give me|what(?:'s| is))\s+(?:me\s+|the\s+|my\s+)?(?:calendar|schedule|events?|focus block)\b.{0,80}$/u.test(
      command
    )
  ) {
    return 'calendar';
  }
  if (
    /^(?:memory|remember|preferences?|decisions?)(?:\s+(?:status|summary))?$/u.test(command) ||
    /^what do you remember$/u.test(command) ||
    /^(?:show|summarize|check|report|open|give me)\s+(?:me\s+|the\s+|my\s+|your\s+)?(?:memory|preferences?|decisions?)\b.{0,80}$/u.test(
      command
    )
  ) {
    return 'memory';
  }
  if (
    /^(?:page|pages|view|views)(?:\s+(?:status|summary|list))?$/u.test(command) ||
    /^(?:show|summarize|check|report|open|list|give me)\s+(?:me\s+|the\s+|my\s+)?(?:saved\s+)?(?:page|pages|view|views)\b.{0,80}$/u.test(
      command
    )
  ) {
    return 'pages';
  }
  return 'help';
}

/**
 * A local, token-free command surface. It is intentionally useful before a
 * model is connected and establishes the command contract shared by web and
 * future Telegram adapters.
 */
export class JarvisChatService {
  constructor(
    private readonly options: {
      personal: PersonalChatReader;
      agency: AgencyChatReader;
      pages: PageChatReader;
    }
  ) {}

  async respond(input: unknown): Promise<JarvisChatResponse> {
    const request = JarvisChatRequestSchema.parse(input);
    const selected = intent(request.message);
    if (selected === 'agency') return this.agencyResponse();
    if (selected === 'calendar') return this.calendarResponse();
    if (selected === 'memory') return this.memoryResponse();
    if (selected === 'pages') return this.pagesResponse();
    if (selected === 'today') return this.todayResponse();
    return {
      mode: 'deterministic',
      intent: 'help',
      reply:
        'I can summarize today, calendar conflicts and focus blocks, personal memory, agency work and approvals, or saved pages. External commitments still require a reviewed action.',
      suggestedView: 'today',
      evidenceRefs: [],
      requiresApproval: false
    };
  }

  private async todayResponse(): Promise<JarvisChatResponse> {
    const briefing = object(object(await this.options.personal.personalSnapshot()).briefing);
    const headline =
      typeof briefing.headline === 'string' ? briefing.headline : 'Today is not available';
    const reviews = count(briefing.memoryReviewCount);
    const reviewLabel = reviews === 1 ? '1 personal memory' : `${reviews} personal memories`;
    return {
      mode: 'deterministic',
      intent: 'today',
      reply: `${headline}. There ${reviews === 1 ? 'is' : 'are'} ${reviewLabel} to review.`,
      suggestedView: 'today',
      evidenceRefs: array(briefing.sources).filter(
        (source): source is string => typeof source === 'string'
      ),
      requiresApproval: false
    };
  }

  private async calendarResponse(): Promise<JarvisChatResponse> {
    const calendar = object(object(await this.options.personal.personalSnapshot()).calendar);
    const events = array(calendar.events);
    const conflicts = array(calendar.conflicts);
    const proposal = object(calendar.proposedFocusBlock);
    const proposedEvent = object(proposal.event);
    const focus =
      typeof proposedEvent.start === 'string'
        ? ` A proposed focus block starts at ${proposedEvent.start}; no provider write was performed.`
        : '';
    return {
      mode: 'deterministic',
      intent: 'calendar',
      reply: `${plural(events.length, 'event')} and ${plural(conflicts.length, 'conflict')} are in today's bounded calendar.${focus}`,
      suggestedView: 'calendar',
      evidenceRefs: events
        .map((event) => object(event).id)
        .filter((id): id is string => typeof id === 'string')
        .map((id) => `calendar:${id}`),
      requiresApproval: false
    };
  }

  private async memoryResponse(): Promise<JarvisChatResponse> {
    const memory = object(object(await this.options.personal.personalSnapshot()).memory);
    const records = array(memory.records);
    const branches = new Set(
      records
        .map((record) => object(record).branch)
        .filter((branch): branch is string => typeof branch === 'string')
    );
    return {
      mode: 'deterministic',
      intent: 'memory',
      reply: `Personal memory contains ${plural(records.length, 'record')} across ${plural(branches.size, 'populated branch')}. Agency and client workers cannot read this sleeve.`,
      suggestedView: 'personal',
      evidenceRefs: records
        .map((record) => object(record).id)
        .filter((id): id is string => typeof id === 'string')
        .map((id) => `personal-memory:${id}`),
      requiresApproval: false
    };
  }

  private async agencyResponse(): Promise<JarvisChatResponse> {
    const agency = object(await this.options.agency.agencyControlSnapshot());
    const autonomous = array(agency.autonomous).length;
    const approvals = array(agency.approvalRequired).length;
    const blocked = array(agency.blocked).length;
    const posture = agency.posture === 'active' ? 'active' : 'paused';
    return {
      mode: 'deterministic',
      intent: 'agency',
      reply: `Agency autonomy is ${posture}: ${plural(autonomous, 'internal action')} can run, ${plural(approvals, 'action')} ${approvals === 1 ? 'needs' : 'need'} approval, and ${blocked} are blocked.`,
      suggestedView: 'agency',
      evidenceRefs: [...array(agency.autonomous), ...array(agency.approvalRequired)]
        .map((action) => object(action).sourceRef)
        .filter((source): source is string => typeof source === 'string'),
      requiresApproval: false
    };
  }

  private async pagesResponse(): Promise<JarvisChatResponse> {
    const pages = await this.options.pages.list();
    return {
      mode: 'deterministic',
      intent: 'pages',
      reply: `${plural(pages.length, 'reviewed page')} ${pages.length === 1 ? 'is' : 'are'} published. Page Studio can preview another safe declarative view.`,
      suggestedView: 'saved',
      evidenceRefs: pages
        .map((page) => object(page).slug)
        .filter((slug): slug is string => typeof slug === 'string')
        .map((slug) => `operator-page:${slug}`),
      requiresApproval: false
    };
  }
}
