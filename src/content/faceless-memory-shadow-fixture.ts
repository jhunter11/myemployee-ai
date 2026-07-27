import { createHash } from 'node:crypto';

import type {
  MemoryFragmentInput,
  RetrievalOmissionReason
} from '../knowledge/retrieval-contracts';

export const FACELESS_SHADOW_EVALUATED_AT = '2026-07-25T18:00:00.000Z';
export const FACELESS_SHADOW_RECORDED_AT = '2026-07-24T18:00:00.000Z';
export const FACELESS_SHADOW_OWNER_SCOPE_ID = 'client:creator_lab';
export const FACELESS_SHADOW_SLEEVE_ID = 'client:creator_lab_marketing';
export const FACELESS_SHADOW_NEIGHBOR_SCOPE_ID = 'client:neighbor_lab';
export const FACELESS_SHADOW_NEIGHBOR_SLEEVE_ID = 'client:neighbor_lab_marketing';
export const FACELESS_SHADOW_AGENT_ID = 'faceless-content-shadow';
export const FACELESS_SHADOW_PURPOSE = 'faceless_memory_shadow';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fragment(
  id: string,
  title: string,
  content: string,
  overrides: Partial<MemoryFragmentInput> = {}
): MemoryFragmentInput {
  const sourceId = overrides.sourceId ?? `run:${id}`;
  return {
    id,
    ownerScopeId: FACELESS_SHADOW_OWNER_SCOPE_ID,
    sleeveId: FACELESS_SHADOW_SLEEVE_ID,
    sourceId,
    sourceHash: sha256(`${sourceId}\0${content}`),
    extractionVersion: 'faceless_shadow_v1',
    kind: 'episode',
    title,
    content,
    tags: [],
    validFrom: FACELESS_SHADOW_RECORDED_AT,
    validUntil: null,
    recordedAt: FACELESS_SHADOW_RECORDED_AT,
    confidencePermille: 900,
    sensitivity: 'confidential',
    supersedesFragmentId: null,
    reviewAt: null,
    expiresAt: null,
    retrievalEligible: true,
    ...overrides
  };
}

/**
 * The fixture is intentionally small and legible. It is a scaffold that proves the
 * shadow machinery and safety gates; it is not the 120–200 case frozen promotion set.
 *
 * Ordering matters only for the explicit supersession pair: v1 must exist before v2.
 */
export const FACELESS_SHADOW_FRAGMENTS: readonly MemoryFragmentInput[] = [
  fragment(
    'faceless-episode-run-a',
    'Run A content result',
    'Run A completed the Midnight Memo short story and recorded strong seven day retention.',
    { tags: ['midnight', 'short_story', 'retention'] }
  ),
  fragment(
    'faceless-semantic-retention-note',
    'Midnight retention',
    'Creator Lab records general audience retention notes for future experiments.',
    {
      sourceId: 'note:faceless-retention',
      kind: 'fact',
      tags: ['retention']
    }
  ),
  fragment(
    'faceless-rights-decision-v1',
    'Rights review decision',
    'The archive pack rights are cleared for short story production.',
    {
      sourceId: 'decision:faceless-rights-v1',
      kind: 'decision',
      tags: ['rights', 'archive']
    }
  ),
  fragment(
    'faceless-rights-decision-v2',
    'Current rights review decision',
    'The archive pack rights are blocked pending a renewed license for production.',
    {
      sourceId: 'decision:faceless-rights-v2',
      kind: 'decision',
      tags: ['rights', 'archive'],
      recordedAt: '2026-07-25T12:00:00.000Z',
      validFrom: '2026-07-25T12:00:00.000Z',
      supersedesFragmentId: 'faceless-rights-decision-v1'
    }
  ),
  fragment(
    'faceless-expired-premium-gate',
    'Higgsfield premium production approved',
    'Higgsfield premium production was approved for the prior proof window.',
    {
      sourceId: 'decision:faceless-premium-expired',
      kind: 'decision',
      tags: ['higgsfield', 'premium'],
      recordedAt: '2026-07-20T12:00:00.000Z',
      validFrom: '2026-07-20T12:00:00.000Z',
      expiresAt: '2026-07-24T12:00:00.000Z'
    }
  ),
  fragment(
    'faceless-withdrawn-account-plan',
    'Social account plan approved',
    'The social account plan was approved before the operator withdrew it.',
    {
      sourceId: 'artifact:faceless-account-plan-withdrawn',
      kind: 'artifact',
      tags: ['social', 'account'],
      retrievalEligible: false
    }
  ),
  fragment(
    'faceless-future-analytics',
    'Future longform analytics checkpoint',
    'A future analytics checkpoint applies to longform content after the next pilot window.',
    {
      sourceId: 'decision:faceless-analytics-future',
      kind: 'decision',
      tags: ['analytics', 'longform'],
      validFrom: '2026-08-01T12:00:00.000Z'
    }
  ),
  fragment(
    'neighbor-episode-run-a',
    'Run A content result',
    'Run A completed the Midnight Memo short story and recorded strong seven day retention.',
    {
      ownerScopeId: FACELESS_SHADOW_NEIGHBOR_SCOPE_ID,
      sleeveId: FACELESS_SHADOW_NEIGHBOR_SLEEVE_ID,
      sourceId: 'run:neighbor-episode-run-a',
      tags: ['midnight', 'short_story', 'retention']
    }
  )
];

export type FacelessShadowCaseCategory = 'recall' | 'temporal' | 'abstention';

export interface FacelessShadowQuestion {
  readonly id: string;
  readonly category: FacelessShadowCaseCategory;
  readonly text: string;
  readonly expectedFragmentIds: readonly string[];
  readonly forbiddenFragmentIds: readonly string[];
  readonly expectAbstention: boolean;
  readonly expectedSuppressions: Readonly<Record<string, RetrievalOmissionReason>>;
}

export const FACELESS_SHADOW_QUESTIONS: readonly FacelessShadowQuestion[] = [
  {
    id: 'prior_episode',
    category: 'recall',
    text: 'Which Midnight Memo short story had strong retention?',
    expectedFragmentIds: ['faceless-episode-run-a'],
    forbiddenFragmentIds: ['neighbor-episode-run-a'],
    expectAbstention: false,
    expectedSuppressions: {}
  },
  {
    id: 'current_rights_decision',
    category: 'temporal',
    text: 'What is the current archive pack rights decision?',
    expectedFragmentIds: ['faceless-rights-decision-v2'],
    forbiddenFragmentIds: ['faceless-rights-decision-v1'],
    expectAbstention: false,
    expectedSuppressions: {
      'faceless-rights-decision-v1': 'superseded'
    }
  },
  {
    id: 'expired_premium_gate',
    category: 'temporal',
    text: 'Was Higgsfield premium production approved?',
    expectedFragmentIds: [],
    forbiddenFragmentIds: ['faceless-expired-premium-gate'],
    expectAbstention: true,
    expectedSuppressions: {
      'faceless-expired-premium-gate': 'expired'
    }
  },
  {
    id: 'withdrawn_account_plan',
    category: 'temporal',
    text: 'Which social account plan was approved?',
    expectedFragmentIds: [],
    forbiddenFragmentIds: ['faceless-withdrawn-account-plan'],
    expectAbstention: true,
    expectedSuppressions: {
      'faceless-withdrawn-account-plan': 'retrieval_disabled'
    }
  },
  {
    id: 'future_analytics',
    category: 'temporal',
    text: 'What future analytics checkpoint applies to longform?',
    expectedFragmentIds: [],
    forbiddenFragmentIds: ['faceless-future-analytics'],
    expectAbstention: true,
    expectedSuppressions: {
      'faceless-future-analytics': 'not_yet_valid'
    }
  },
  {
    id: 'refund_policy',
    category: 'abstention',
    text: 'What is the Creator Lab refund policy?',
    expectedFragmentIds: [],
    forbiddenFragmentIds: ['neighbor-episode-run-a'],
    expectAbstention: true,
    expectedSuppressions: {}
  }
];
