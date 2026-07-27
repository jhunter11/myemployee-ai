import { describe, expect, it } from 'vitest';

import {
  ConsolidationCandidateInputSchema,
  MemorySystemIdSchema,
  ProcedureCandidateInputSchema,
  WorkingMemoryEntryInputSchema
} from '../../../src/memory/system/contracts';
import { workflowSignatureForSteps } from '../../../src/memory/system/hashing';

const OWNER = 'client:acme_corp';
const SLEEVE = 'client:acme_corp';

function workingEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wm-1',
    ownerScopeId: OWNER,
    sleeveId: SLEEVE,
    runId: 'run-1',
    slotKey: 'active_goal',
    content: 'Draft the acme reconciliation plan',
    sensitivity: 'confidential',
    recordedAt: '2026-07-21T12:00:00.000Z',
    expiresAt: '2026-07-21T13:00:00.000Z',
    supersedesEntryId: null,
    ...overrides
  };
}

function consolidationCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'memcons-1',
    ownerScopeId: OWNER,
    sleeveId: SLEEVE,
    targetStore: 'semantic',
    proposedKind: 'summary',
    title: 'Summary: close',
    content: 'Recurring topic close consolidated from 3 episodes.',
    sourceFragmentIds: ['frag-a', 'frag-b', 'frag-c'],
    evidenceCount: 3,
    temporalState: 'current',
    confidencePermille: 600,
    rationale: 'Topic recurred 3 times.',
    plannerVersion: 'planner-1',
    proposedBy: 'agency-developer',
    sensitivity: 'confidential',
    recordedAt: '2026-07-21T12:00:00.000Z',
    expiresAt: '2026-08-21T12:00:00.000Z',
    supersedesCandidateId: null,
    ...overrides
  };
}

function procedureCandidate(overrides: Record<string, unknown> = {}) {
  const steps = ['open ledger', 'reconcile balances', 'sign off'];
  return {
    id: 'memproc-1',
    ownerScopeId: OWNER,
    sleeveId: SLEEVE,
    workflowSignature: workflowSignatureForSteps(steps),
    title: 'Monthly close',
    steps,
    successCount: 4,
    firstSeenAt: '2026-05-21T12:00:00.000Z',
    lastSeenAt: '2026-07-21T12:00:00.000Z',
    rationale: 'Succeeded 4 times.',
    plannerVersion: 'planner-1',
    proposedBy: 'agency-developer',
    sensitivity: 'internal',
    recordedAt: '2026-07-21T12:00:00.000Z',
    expiresAt: '2026-08-21T12:00:00.000Z',
    supersedesCandidateId: null,
    ...overrides
  };
}

describe('memory system contracts', () => {
  it('accepts a valid working memory entry and rejects reversed validity', () => {
    expect(WorkingMemoryEntryInputSchema.safeParse(workingEntry()).success).toBe(true);
    expect(
      WorkingMemoryEntryInputSchema.safeParse(
        workingEntry({ expiresAt: '2026-07-21T11:00:00.000Z' })
      ).success
    ).toBe(false);
    expect(
      WorkingMemoryEntryInputSchema.safeParse(workingEntry({ supersedesEntryId: 'wm-1' })).success
    ).toBe(false);
    expect(
      WorkingMemoryEntryInputSchema.safeParse(workingEntry({ slotKey: 'Bad Slot' })).success
    ).toBe(false);
  });

  it('binds a consolidation candidate kind to its target store', () => {
    expect(ConsolidationCandidateInputSchema.safeParse(consolidationCandidate()).success).toBe(
      true
    );
    // procedure kind cannot target the semantic store
    expect(
      ConsolidationCandidateInputSchema.safeParse(
        consolidationCandidate({ proposedKind: 'procedure' })
      ).success
    ).toBe(false);
    // fact kind cannot target the procedural store
    expect(
      ConsolidationCandidateInputSchema.safeParse(
        consolidationCandidate({ targetStore: 'procedural', proposedKind: 'fact' })
      ).success
    ).toBe(false);
    // procedural target with a procedural kind is valid
    expect(
      ConsolidationCandidateInputSchema.safeParse(
        consolidationCandidate({ targetStore: 'procedural', proposedKind: 'procedure' })
      ).success
    ).toBe(true);
  });

  it('rejects consolidation evidence weaker than the provenance sample or with duplicate sources', () => {
    expect(
      ConsolidationCandidateInputSchema.safeParse(consolidationCandidate({ evidenceCount: 2 }))
        .success
    ).toBe(false);
    expect(
      ConsolidationCandidateInputSchema.safeParse(
        consolidationCandidate({ sourceFragmentIds: ['frag-a', 'frag-a', 'frag-c'] })
      ).success
    ).toBe(false);
  });

  it('rejects a procedure candidate whose lastSeen precedes firstSeen', () => {
    expect(ProcedureCandidateInputSchema.safeParse(procedureCandidate()).success).toBe(true);
    expect(
      ProcedureCandidateInputSchema.safeParse(
        procedureCandidate({ lastSeenAt: '2026-04-21T12:00:00.000Z' })
      ).success
    ).toBe(false);
  });

  it('constrains the backend id enum', () => {
    expect(MemorySystemIdSchema.safeParse('flat').success).toBe(true);
    expect(MemorySystemIdSchema.safeParse('typed_hybrid').success).toBe(true);
    expect(MemorySystemIdSchema.safeParse('graph').success).toBe(false);
  });
});
