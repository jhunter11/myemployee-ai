import { createHash } from 'node:crypto';

import { AUTHORITY_LAYERS, type GrantVersionSet } from '../../agents/access-control-contracts';
import type { AccessControlRepository } from '../../agents/access-control-repository';
import type { MemoryFragmentInput } from '../../knowledge/retrieval-contracts';
import type { MemorySystem } from '../system/contracts';

/**
 * A small, hand-authored memory corpus for proving out competing memory backends.
 *
 * The synthetic workload generator produces volume; this corpus produces
 * *legibility*. Every item exists to make one specific backend behaviour visible
 * in a reasoning trace an operator can read: a superseded fact that a naive store
 * still returns, a policy whose validity window has closed, a neighbouring client
 * sleeve that must never appear, and an evidence chain that a multi-hop question
 * has to walk. Because each item declares the `role` it plays, a trace can explain
 * not just what was retrieved but why that retrieval was right or wrong.
 *
 * The clock is frozen at {@link DEMO_NOW}: nothing here reads the wall clock, so
 * the same corpus and the same question always produce the same trace.
 */

/** The simulated "now" every demo query is evaluated at. */
export const DEMO_NOW = '2026-07-24T12:00:00.000Z';

export const AGENCY_SCOPE_ID = 'agency:agency';
export const ACME_SCOPE_ID = 'client:acme_corp';
export const NORTHWIND_SCOPE_ID = 'client:northwind_ltd';
export const PERSONAL_SCOPE_ID = 'personal:operator';
export const DEMO_AGENT_ID = 'agency-developer';

/** Sleeve ids double as the demo's isolation boundaries. */
export const ACME_SLEEVE_ID = ACME_SCOPE_ID;
export const NORTHWIND_SLEEVE_ID = NORTHWIND_SCOPE_ID;
export const PERSONAL_SLEEVE_ID = PERSONAL_SCOPE_ID;

const SEEDED_AT = '2026-06-01T09:00:00.000Z';

/**
 * What a sample item is *for*. The trace renderer uses this to explain a backend's
 * behaviour in plain language rather than leaving the reader to infer it.
 */
export type SampleItemRole =
  | 'current_answer' // the correct evidence for some question
  | 'superseded' // an older revision that a temporal-blind store still surfaces
  | 'validity_ended' // correct once, but its validity window has closed
  | 'retrieval_disabled' // explicitly withdrawn from retrieval
  | 'supporting_evidence' // episodic/decision evidence backing a semantic fact
  | 'distractor' // lexically similar, semantically irrelevant
  | 'cross_sleeve_trap' // correct-looking, but in a neighbouring sleeve: must never appear
  | 'procedure'; // reusable workflow

export interface SampleMemoryItem {
  readonly fragment: MemoryFragmentInput;
  readonly role: SampleItemRole;
  /** Why this item is in the corpus — surfaced verbatim in reasoning traces. */
  readonly note: string;
}

function sourceHashFor(sourceId: string): string {
  return createHash('sha256').update(sourceId, 'utf8').digest('hex');
}

interface ItemOptions {
  id: string;
  scopeId: string;
  sleeveId: string;
  kind: MemoryFragmentInput['kind'];
  title: string;
  content: string;
  tags: string[];
  role: SampleItemRole;
  note: string;
  validFrom?: string;
  validUntil?: string | null;
  recordedAt?: string;
  supersedesFragmentId?: string | null;
  retrievalEligible?: boolean;
  sensitivity?: MemoryFragmentInput['sensitivity'];
}

function item(options: ItemOptions): SampleMemoryItem {
  const sourceId = `demo:${options.id}`;
  return {
    role: options.role,
    note: options.note,
    fragment: {
      id: options.id,
      ownerScopeId: options.scopeId,
      sleeveId: options.sleeveId,
      sourceId,
      sourceHash: sourceHashFor(sourceId),
      extractionVersion: 'demo_v1',
      kind: options.kind,
      title: options.title,
      content: options.content,
      tags: options.tags,
      validFrom: options.validFrom ?? SEEDED_AT,
      validUntil: options.validUntil ?? null,
      recordedAt: options.recordedAt ?? options.validFrom ?? SEEDED_AT,
      confidencePermille: 900,
      sensitivity: options.sensitivity ?? 'confidential',
      supersedesFragmentId: options.supersedesFragmentId ?? null,
      reviewAt: null,
      expiresAt: null,
      retrievalEligible: options.retrievalEligible ?? true
    }
  };
}

/**
 * The corpus, in write order. Order matters: a revision may only supersede a
 * fragment that already exists, so `..._v1` is always written before `..._v2`.
 */
export const SAMPLE_MEMORY: readonly SampleMemoryItem[] = [
  // --- Acme: a launch date that changed -------------------------------------
  item({
    id: 'acme-launch-date-v1',
    scopeId: ACME_SCOPE_ID,
    sleeveId: ACME_SLEEVE_ID,
    kind: 'fact',
    title: 'Acme relaunch ship date',
    content: 'The Acme relaunch ships on September 15, 2026.',
    tags: ['acme', 'launch', 'schedule'],
    validFrom: '2026-06-01T09:00:00.000Z',
    role: 'superseded',
    note: 'The original ship date. A store without supersession awareness still returns this as current.'
  }),
  item({
    id: 'acme-episode-call-7742',
    scopeId: ACME_SCOPE_ID,
    sleeveId: ACME_SLEEVE_ID,
    kind: 'episode',
    title: 'Client call 7742 transcript',
    content:
      'Meeting transcript: the client said the Acme launch moved from September 15 to September 30, pending legal signoff.',
    tags: ['acme', 'launch', 'call'],
    validFrom: '2026-07-10T15:30:00.000Z',
    role: 'supporting_evidence',
    note: 'The episodic evidence the corrected ship date was derived from — the first hop of the provenance chain.'
  }),
  item({
    id: 'acme-launch-date-v2',
    scopeId: ACME_SCOPE_ID,
    sleeveId: ACME_SLEEVE_ID,
    kind: 'fact',
    title: 'Acme relaunch ship date',
    content: 'The Acme relaunch ships on September 30, 2026, pending legal signoff.',
    tags: ['acme', 'launch', 'schedule'],
    validFrom: '2026-07-10T16:00:00.000Z',
    supersedesFragmentId: 'acme-launch-date-v1',
    role: 'current_answer',
    note: 'The correct current ship date, superseding v1 and derived from call 7742.'
  }),
  item({
    id: 'acme-decision-legal-gate',
    scopeId: ACME_SCOPE_ID,
    sleeveId: ACME_SLEEVE_ID,
    kind: 'decision',
    title: 'Gate the Acme launch announcement on legal signoff',
    content:
      'Decision: the Acme launch announcement is gated on legal signoff before any public communication.',
    tags: ['acme', 'launch', 'legal'],
    validFrom: '2026-07-10T17:00:00.000Z',
    role: 'supporting_evidence',
    note: 'A decision caused by the same call — the second hop for "why did the date move?".'
  }),

  // --- Acme: a policy whose validity window has closed -----------------------
  item({
    id: 'acme-code-freeze-window',
    scopeId: ACME_SCOPE_ID,
    sleeveId: ACME_SLEEVE_ID,
    kind: 'policy',
    title: 'Acme code freeze window',
    content: 'A code freeze is in effect for the Acme relaunch; no non-critical merges.',
    tags: ['acme', 'freeze', 'policy'],
    validFrom: '2026-07-01T00:00:00.000Z',
    validUntil: '2026-07-20T00:00:00.000Z',
    role: 'validity_ended',
    note: 'True in early July, expired on the 20th. Answering "is the freeze active?" with this is a stale-memory error.'
  }),

  // --- Acme: noise and withdrawn memory -------------------------------------
  item({
    id: 'acme-brand-palette',
    scopeId: ACME_SCOPE_ID,
    sleeveId: ACME_SLEEVE_ID,
    kind: 'artifact',
    title: 'Acme brand palette',
    content: 'The Acme relaunch brand palette is cobalt, slate, and warm white.',
    tags: ['acme', 'brand', 'design'],
    role: 'distractor',
    note: 'Shares the words "Acme" and "relaunch" with the launch-date question but answers nothing about schedule.'
  }),
  item({
    id: 'acme-retired-vendor',
    scopeId: ACME_SCOPE_ID,
    sleeveId: ACME_SLEEVE_ID,
    kind: 'fact',
    title: 'Former Acme print vendor',
    content: 'The Acme launch print vendor was Meridian Press, a relationship since ended.',
    tags: ['acme', 'launch', 'vendor'],
    retrievalEligible: false,
    role: 'retrieval_disabled',
    note: 'Withdrawn from retrieval by an operator. It must never reach a compiled context.'
  }),
  item({
    id: 'acme-release-procedure',
    scopeId: ACME_SCOPE_ID,
    sleeveId: ACME_SLEEVE_ID,
    kind: 'procedure',
    title: 'Acme release checklist',
    content:
      'Acme release checklist: confirm legal signoff, freeze merges, run the staging smoke pass, then announce.',
    tags: ['acme', 'release', 'checklist'],
    validFrom: '2026-06-15T09:00:00.000Z',
    role: 'procedure',
    note: 'Procedural memory — the reusable workflow a procedural store should surface for "how do we ship?".'
  }),

  // --- Northwind: the neighbouring sleeve that must never leak ---------------
  item({
    id: 'northwind-launch-date',
    scopeId: NORTHWIND_SCOPE_ID,
    sleeveId: NORTHWIND_SLEEVE_ID,
    kind: 'fact',
    title: 'Northwind relaunch ship date',
    content: 'The Northwind relaunch ships on August 5, 2026.',
    tags: ['northwind', 'launch', 'schedule'],
    role: 'cross_sleeve_trap',
    note: 'A different client with a near-identical fact. Any appearance in an Acme answer is a scope leak.'
  }),

  // --- Personal: an operator preference that changed -------------------------
  item({
    id: 'operator-report-format-v1',
    scopeId: PERSONAL_SCOPE_ID,
    sleeveId: PERSONAL_SLEEVE_ID,
    kind: 'preference',
    title: 'Operator report format',
    content: 'The operator prefers reports as short bulleted summaries.',
    tags: ['operator', 'report', 'format'],
    sensitivity: 'internal',
    role: 'superseded',
    note: 'The old stated preference, later reversed.'
  }),
  item({
    id: 'operator-report-format-v2',
    scopeId: PERSONAL_SCOPE_ID,
    sleeveId: PERSONAL_SLEEVE_ID,
    kind: 'preference',
    title: 'Operator report format',
    content: 'The operator prefers reports as dense narrative prose with citations.',
    tags: ['operator', 'report', 'format'],
    validFrom: '2026-07-18T08:00:00.000Z',
    supersedesFragmentId: 'operator-report-format-v1',
    sensitivity: 'internal',
    role: 'current_answer',
    note: 'The current stated preference. Preference drift is where flat stores most visibly fail.'
  })
];

/** A probe question plus the behaviour a correct backend must show. */
export interface SampleQuestion {
  readonly id: string;
  readonly question: string;
  readonly sleeveId: string;
  readonly scopeId: string;
  /** Fragment ids that must appear in the answer's evidence. Empty means the backend must abstain. */
  readonly expectedFragmentIds: readonly string[];
  /** Fragment ids whose presence is a failure — stale, withdrawn, or out-of-scope. */
  readonly forbiddenFragmentIds: readonly string[];
  readonly probes: string;
}

export const SAMPLE_QUESTIONS: readonly SampleQuestion[] = [
  {
    id: 'launch_date',
    question: 'When does the Acme relaunch ship?',
    sleeveId: ACME_SLEEVE_ID,
    scopeId: ACME_SCOPE_ID,
    expectedFragmentIds: ['acme-launch-date-v2'],
    forbiddenFragmentIds: ['acme-launch-date-v1', 'northwind-launch-date', 'acme-retired-vendor'],
    probes: 'Supersession: does the backend return the corrected date and suppress the old one?'
  },
  {
    id: 'code_freeze',
    question: 'Is the Acme code freeze still active?',
    sleeveId: ACME_SLEEVE_ID,
    scopeId: ACME_SCOPE_ID,
    expectedFragmentIds: [],
    forbiddenFragmentIds: ['acme-code-freeze-window'],
    probes:
      'Temporal validity: the freeze window closed on 2026-07-20, so citing it is a stale-memory error.'
  },
  {
    id: 'release_process',
    question: 'What is the Acme release checklist?',
    sleeveId: ACME_SLEEVE_ID,
    scopeId: ACME_SCOPE_ID,
    expectedFragmentIds: ['acme-release-procedure'],
    forbiddenFragmentIds: ['acme-retired-vendor', 'northwind-launch-date'],
    probes:
      'Procedural recall: can the backend surface a reusable workflow rather than raw episodes?'
  },
  {
    id: 'report_format',
    question: 'What report format does the operator prefer?',
    sleeveId: PERSONAL_SLEEVE_ID,
    scopeId: PERSONAL_SCOPE_ID,
    expectedFragmentIds: ['operator-report-format-v2'],
    forbiddenFragmentIds: ['operator-report-format-v1'],
    probes: 'Preference drift: is the current preference returned rather than the reversed one?'
  },
  {
    id: 'refund_policy',
    question: 'What is the Acme refund policy?',
    sleeveId: ACME_SLEEVE_ID,
    scopeId: ACME_SCOPE_ID,
    expectedFragmentIds: [],
    forbiddenFragmentIds: ['northwind-launch-date'],
    probes:
      'Abstention: with no supporting evidence the backend must decline rather than improvise.'
  }
];

export interface SampleSleeve {
  readonly scopeId: string;
  readonly sleeveId: string;
  readonly subjectId: string;
  readonly kind: 'client' | 'personal';
}

export const SAMPLE_SLEEVES: readonly SampleSleeve[] = [
  { scopeId: ACME_SCOPE_ID, sleeveId: ACME_SLEEVE_ID, subjectId: 'acme_corp', kind: 'client' },
  {
    scopeId: NORTHWIND_SCOPE_ID,
    sleeveId: NORTHWIND_SLEEVE_ID,
    subjectId: 'northwind_ltd',
    kind: 'client'
  },
  {
    scopeId: PERSONAL_SCOPE_ID,
    sleeveId: PERSONAL_SLEEVE_ID,
    subjectId: 'operator',
    kind: 'personal'
  }
];

export interface ProvisionedSampleMemory {
  /** Read-grant versions per sleeve, required to authorize retrieval. */
  readonly grantVersions: Readonly<Record<string, GrantVersionSet>>;
}

/**
 * Registers the scopes, sleeves, agent, and read grants the corpus needs. This is
 * deliberately the same deny-first path production uses: the demo cannot read a
 * sleeve it was not explicitly granted, so a scope leak in a trace is a real leak.
 */
export async function provisionSampleMemory(
  access: AccessControlRepository
): Promise<ProvisionedSampleMemory> {
  await access.registerScope({
    id: AGENCY_SCOPE_ID,
    kind: 'agency',
    subjectId: 'agency',
    parentScopeId: null,
    trustDomain: 'agency',
    createdAt: SEEDED_AT
  });
  await access.registerAgent({
    id: DEMO_AGENT_ID,
    homeScopeId: AGENCY_SCOPE_ID,
    trustDomain: 'agency',
    profileRevision: 1,
    createdAt: SEEDED_AT
  });

  const grantVersions: Record<string, GrantVersionSet> = {};
  for (const sleeve of SAMPLE_SLEEVES) {
    await access.registerScope({
      id: sleeve.scopeId,
      kind: sleeve.kind,
      subjectId: sleeve.subjectId,
      parentScopeId: AGENCY_SCOPE_ID,
      trustDomain: 'agency',
      createdAt: SEEDED_AT
    });
    await access.registerSleeve({
      id: sleeve.sleeveId,
      ownerScopeId: sleeve.scopeId,
      maxSensitivity: 'confidential',
      expiresAt: null,
      createdAt: SEEDED_AT
    });

    const versions = {} as Record<(typeof AUTHORITY_LAYERS)[number], number>;
    for (const layer of AUTHORITY_LAYERS) {
      const grant = await access.issueSleeveGrant({
        id: `sleeve-grant:${DEMO_AGENT_ID}-${sleeve.subjectId.replace(/_/gu, '-')}-read-${layer}`,
        agentId: DEMO_AGENT_ID,
        sleeveId: sleeve.sleeveId,
        authorityLayer: layer,
        permission: 'read',
        purpose: 'memory_backend_demo',
        sensitivityCap: 'confidential',
        expiresAt: '2027-01-01T00:00:00.000Z',
        expectedAgentVersion: 1,
        expectedScopeVersion: 1,
        expectedSleeveVersion: 1,
        issuedAt: SEEDED_AT
      });
      versions[layer] = grant.version;
    }
    grantVersions[sleeve.sleeveId] = versions;
  }

  return { grantVersions };
}

/**
 * Writes the corpus through a {@link MemorySystem}. Every backend receives the
 * byte-identical corpus in the byte-identical order, which is what makes a
 * cross-backend comparison a fair test of the backend rather than of its input.
 */
export async function loadSampleMemory(
  system: MemorySystem,
  items: readonly SampleMemoryItem[] = SAMPLE_MEMORY
): Promise<number> {
  let written = 0;
  for (const sample of items) {
    await system.write(sample.fragment);
    written += 1;
  }
  return written;
}

/** Look up the demo metadata for a fragment id, for trace annotation. */
export function sampleItemById(fragmentId: string): SampleMemoryItem | undefined {
  return SAMPLE_MEMORY.find((sample) => sample.fragment.id === fragmentId);
}
