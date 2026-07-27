import { describe, expect, it } from 'vitest';

import { AgencyControlCenter } from '../../src/agency/control-center';

describe('AgencyControlCenter', () => {
  it('allows only reversible internal categories to be autonomous', () => {
    const center = new AgencyControlCenter({ killSwitchEngaged: false });
    const snapshot = center.project([
      {
        id: 'verify-output',
        category: 'verification',
        label: 'Verify report output',
        reversible: true,
        externalEffect: false,
        sourceRef: 'queue:verify-output'
      },
      {
        id: 'send-draft',
        category: 'outbound_message',
        label: 'Send reviewed draft',
        reversible: false,
        externalEffect: true,
        sourceRef: 'revenue:send-draft'
      }
    ]);
    expect(snapshot.autonomous.map(({ id }) => id)).toEqual(['verify-output']);
    expect(snapshot.approvalRequired.map(({ id }) => id)).toEqual(['send-draft']);
  });

  it('blocks autonomous execution while the kill switch is engaged', () => {
    const snapshot = new AgencyControlCenter({ killSwitchEngaged: true }).project([
      {
        id: 'research-market',
        category: 'research',
        label: 'Research a public market',
        reversible: true,
        externalEffect: false,
        sourceRef: 'queue:research-market'
      }
    ]);
    expect(snapshot.posture).toBe('paused');
    expect(snapshot.autonomous).toEqual([]);
    expect(snapshot.blocked[0]).toMatchObject({ id: 'research-market', approvalState: 'blocked' });
  });

  it('keeps reversible internal work proposal-only without a verified executor binding', () => {
    const snapshot = new AgencyControlCenter({ killSwitchEngaged: false }).project([
      {
        id: 'unbound-project-task',
        category: 'verification',
        label: 'Verify proposed project evidence',
        reversible: true,
        externalEffect: false,
        executionEligibility: 'proposal_only',
        sourceRef: 'queue:unbound-project-task'
      }
    ]);

    expect(snapshot.autonomous).toEqual([]);
    expect(snapshot.approvalRequired[0]).toMatchObject({
      id: 'unbound-project-task',
      approvalState: 'approval_required',
      reason: 'No verified executor is bound to this tenant and work type; review only.'
    });
  });
});
