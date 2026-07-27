import { z } from 'zod';

const AgencyCandidateSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/),
  category: z.enum([
    'research',
    'reconciliation',
    'draft',
    'verification',
    'schedule_worker',
    'evidence_collection',
    'outbound_message',
    'contract',
    'pricing',
    'payment',
    'client_data_disclosure',
    'production_release',
    'destructive_operation',
    'policy_change'
  ]),
  label: z.string().trim().min(1).max(160),
  reversible: z.boolean(),
  externalEffect: z.boolean(),
  executionEligibility: z.enum(['bound', 'proposal_only']).optional(),
  sourceRef: z.string().regex(/^[a-z][a-z0-9-]*:[A-Za-z0-9._:-]{2,127}$/)
});

export type AgencyCandidate = z.infer<typeof AgencyCandidateSchema>;
export interface AgencyAction extends AgencyCandidate {
  approvalState: 'autonomous' | 'approval_required' | 'blocked';
  reason: string;
}

const autonomousCategories = new Set<AgencyCandidate['category']>([
  'research',
  'reconciliation',
  'draft',
  'verification',
  'schedule_worker',
  'evidence_collection'
]);

export interface AgencyControlSnapshot {
  posture: 'active' | 'paused';
  killSwitchEngaged: boolean;
  autonomous: AgencyAction[];
  approvalRequired: AgencyAction[];
  blocked: AgencyAction[];
}

export class AgencyControlCenter {
  constructor(private readonly options: { killSwitchEngaged: boolean }) {}

  project(input: unknown[]): AgencyControlSnapshot {
    const candidates = input.map((candidate) => AgencyCandidateSchema.parse(candidate));
    const snapshot: AgencyControlSnapshot = {
      posture: this.options.killSwitchEngaged ? 'paused' : 'active',
      killSwitchEngaged: this.options.killSwitchEngaged,
      autonomous: [],
      approvalRequired: [],
      blocked: []
    };
    candidates.forEach((candidate) => {
      const safe =
        autonomousCategories.has(candidate.category) &&
        candidate.reversible &&
        !candidate.externalEffect &&
        candidate.executionEligibility !== 'proposal_only';
      const approvalState = safe
        ? this.options.killSwitchEngaged
          ? 'blocked'
          : 'autonomous'
        : 'approval_required';
      const action: AgencyAction = {
        ...candidate,
        approvalState,
        reason:
          approvalState === 'autonomous'
            ? 'Preapproved reversible internal work.'
            : approvalState === 'blocked'
              ? 'The agency kill switch is engaged.'
              : candidate.executionEligibility === 'proposal_only'
                ? 'No verified executor is bound to this tenant and work type; review only.'
                : 'External, irreversible, or privileged work requires operator approval.'
      };
      if (approvalState === 'autonomous') snapshot.autonomous.push(action);
      else if (approvalState === 'approval_required') snapshot.approvalRequired.push(action);
      else snapshot.blocked.push(action);
    });
    return snapshot;
  }
}
