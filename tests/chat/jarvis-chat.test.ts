import { describe, expect, it } from 'vitest';

import { JarvisChatService } from '../../src/chat/jarvis-chat';

function service(): JarvisChatService {
  return new JarvisChatService({
    personal: {
      personalSnapshot: () =>
        Promise.resolve({
          briefing: {
            headline: '2 events today · 1 agency approval needs you',
            eventCount: 2,
            conflictCount: 0,
            memoryReviewCount: 1,
            agencyApprovalCount: 1,
            sources: ['calendar:briefing', 'personal-memory:focus']
          },
          calendar: {
            events: [{ id: 'briefing', title: 'Daily briefing' }],
            conflicts: [],
            proposedFocusBlock: {
              event: { start: '2026-07-21T18:00:00.000Z', end: '2026-07-21T19:00:00.000Z' }
            }
          },
          memory: { records: [{ id: 'focus', branch: 'preferences' }] }
        })
    },
    agency: {
      agencyControlSnapshot: () =>
        Promise.resolve({
          posture: 'active',
          autonomous: [{ id: 'verify' }],
          approvalRequired: [{ id: 'approve' }],
          blocked: []
        })
    },
    pages: { list: () => Promise.resolve([{ slug: 'jarvis-home' }]) }
  });
}

describe('JarvisChatService', () => {
  it('answers today questions from bounded evidence without a model call', async () => {
    await expect(service().respond({ message: 'What needs my attention today?' })).resolves.toEqual(
      {
        mode: 'deterministic',
        intent: 'today',
        reply:
          '2 events today · 1 agency approval needs you. There is 1 personal memory to review.',
        suggestedView: 'today',
        evidenceRefs: ['calendar:briefing', 'personal-memory:focus'],
        requiresApproval: false
      }
    );
  });

  it('reports agency posture and keeps unknown requests within supported local commands', async () => {
    await expect(service().respond({ message: 'Show agency agent status' })).resolves.toMatchObject(
      {
        intent: 'agency',
        reply:
          'Agency autonomy is active: 1 internal action can run, 1 action needs approval, and 0 are blocked.',
        suggestedView: 'agency'
      }
    );
    await expect(
      service().respond({ message: 'Write a contract and pay it' })
    ).resolves.toMatchObject({
      intent: 'help',
      mode: 'deterministic',
      requiresApproval: false
    });
  });

  it.each([
    'Help me work through an agent design.',
    'What is the status of this architecture?',
    'I want to schedule our work.',
    'Explain memory safety in a web page.'
  ])('keeps ordinary conversation out of broad keyword commands: %s', async (message) => {
    await expect(service().respond({ message })).resolves.toMatchObject({
      intent: 'help',
      mode: 'deterministic'
    });
  });

  it('summarizes calendar evidence and clearly labels an uncommitted focus proposal', async () => {
    await expect(service().respond({ message: 'Show my calendar schedule' })).resolves.toEqual({
      mode: 'deterministic',
      intent: 'calendar',
      reply:
        "1 event and 0 conflicts are in today's bounded calendar. A proposed focus block starts at 2026-07-21T18:00:00.000Z; no provider write was performed.",
      suggestedView: 'calendar',
      evidenceRefs: ['calendar:briefing'],
      requiresApproval: false
    });
  });

  it('summarizes isolated personal memory and reviewed pages', async () => {
    await expect(service().respond({ message: 'What do you remember?' })).resolves.toMatchObject({
      intent: 'memory',
      reply:
        'Personal memory contains 1 record across 1 populated branch. Agency and client workers cannot read this sleeve.',
      suggestedView: 'personal',
      evidenceRefs: ['personal-memory:focus']
    });
    await expect(service().respond({ message: 'Show saved pages' })).resolves.toMatchObject({
      intent: 'pages',
      reply: '1 reviewed page is published. Page Studio can preview another safe declarative view.',
      suggestedView: 'saved',
      evidenceRefs: ['operator-page:jarvis-home']
    });
  });

  it('fails closed over malformed reader projections instead of inventing evidence', async () => {
    const malformed = new JarvisChatService({
      personal: {
        personalSnapshot: () =>
          Promise.resolve({
            briefing: { memoryReviewCount: -1, sources: [12] },
            calendar: {
              events: [{ id: 10 }],
              conflicts: [{}],
              proposedFocusBlock: null
            },
            memory: {
              records: [
                { id: 'one', branch: 'preferences' },
                { id: 2, branch: 'preferences' },
                { id: 'three', branch: null }
              ]
            }
          })
      },
      agency: {
        agencyControlSnapshot: () =>
          Promise.resolve({
            posture: 'unexpected',
            autonomous: 'invalid',
            approvalRequired: [{ sourceRef: 'queue:approval' }, { sourceRef: 10 }],
            blocked: [{}]
          })
      },
      pages: { list: () => Promise.resolve([{ slug: 42 }, {}]) }
    });

    await expect(malformed.respond({ message: 'briefing status' })).resolves.toMatchObject({
      reply: 'Today is not available. There are 0 personal memories to review.',
      evidenceRefs: []
    });
    await expect(malformed.respond({ message: 'calendar' })).resolves.toMatchObject({
      reply: "1 event and 1 conflict are in today's bounded calendar.",
      evidenceRefs: []
    });
    await expect(malformed.respond({ message: 'memory' })).resolves.toMatchObject({
      reply:
        'Personal memory contains 3 records across 1 populated branch. Agency and client workers cannot read this sleeve.',
      evidenceRefs: ['personal-memory:one', 'personal-memory:three']
    });
    await expect(malformed.respond({ message: 'agency work' })).resolves.toMatchObject({
      reply:
        'Agency autonomy is paused: 0 internal actions can run, 2 actions need approval, and 1 are blocked.',
      evidenceRefs: ['queue:approval']
    });
    await expect(malformed.respond({ message: 'views' })).resolves.toMatchObject({
      reply:
        '2 reviewed pages are published. Page Studio can preview another safe declarative view.',
      evidenceRefs: []
    });
  });

  it('rejects executable fields and oversized messages', async () => {
    await expect(service().respond({ message: 'today', tenantId: 'acme' })).rejects.toThrow();
    await expect(service().respond({ message: 'x'.repeat(2_001) })).rejects.toThrow();
  });
});
