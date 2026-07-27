import { describe, expect, it } from 'vitest';

import {
  MEMORY_RECORD_SCHEMA_VERSION,
  MemoryClaimTriplePayloadSchema,
  MemoryRevisionSchema,
  MemoryStructuredPayloadSchema,
  sleeveClassForSleeveId
} from '../../../src/memory/ledger/record-contracts';

const CONTENT_HASH = `sha256:${'a'.repeat(64)}`;
const CANONICAL_HASH = `sha256:${'b'.repeat(64)}`;

/** The report's own "semantic fact derived from episodes" example, in repo id shapes. */
function revision(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
    recordType: 'MemoryRevision',
    memoryId: 'mem_fact_114',
    revisionId: 'rev_fact_114_a',
    revisionNo: 1,
    ownerScopeId: 'client:acme_corp',
    sleeveId: 'client:acme_corp',
    sleeveClass: 'client',
    kind: 'fact',
    entityKey: 'launch/date',
    status: 'active',
    approvalState: 'reviewed',
    authorityTier: 'operator_explicit',
    confidencePermille: 950,
    sensitivity: 'confidential',
    retentionPolicy: 'until_superseded',
    legalHold: false,
    eventTime: '2026-09-30T00:00:00.000Z',
    observedAt: '2026-07-24T18:18:00.000Z',
    createdTxTime: '2026-07-24T18:20:12.022Z',
    recordedTxSeq: 88_261,
    validFrom: '2026-07-24T18:12:41.000Z',
    validUntil: null,
    decidedAt: '2026-07-24T18:20:00.000Z',
    authorAgentId: 'agency-developer',
    workflowId: 'wf_fact_extraction_v4',
    runId: null,
    derivationMethod: 'episode_extraction_plus_operator_review',
    sourceEventIds: ['evt_call_7742'],
    evidenceRefs: [{ type: 'memory_revision', id: 'rev_ep_001' }],
    derivedFrom: ['mem_ep_001'],
    contradicts: [],
    supersedes: null,
    supersededBy: null,
    payloadCanonical: {
      form: 'triple',
      subject: 'project:acme-relaunch',
      predicate: 'launch_date',
      object: '2026-09-30',
      qualifiers: []
    },
    contentHash: CONTENT_HASH,
    canonicalHash: CANONICAL_HASH,
    tombstone: null,
    ...overrides
  };
}

function tombstone(overrides: Record<string, unknown> = {}) {
  return {
    reason: 'privacy_erasure',
    ticketId: 'tkt_del_0001',
    purgeState: 'purged',
    recordedAt: '2026-07-25T09:00:00.000Z',
    ...overrides
  };
}

function accepts(overrides: Record<string, unknown>): boolean {
  return MemoryRevisionSchema.safeParse(revision(overrides)).success;
}

describe('memrec/v1 revision contract', () => {
  it("accepts the report's canonical semantic-fact revision and rejects unknown fields", () => {
    expect(MemoryRevisionSchema.safeParse(revision()).success).toBe(true);
    expect(accepts({ authorNickname: 'pm' })).toBe(false);
    expect(accepts({ schemaVersion: 'memrec/v2' })).toBe(false);
    expect(accepts({ recordType: 'MemoryCommand' })).toBe(false);
  });

  describe('bitemporal invariants', () => {
    it('requires validUntil strictly after validFrom, and treats null as open-ended', () => {
      expect(accepts({ validUntil: '2026-08-01T00:00:00.000Z' })).toBe(true);
      expect(accepts({ validUntil: '2026-07-24T18:12:41.000Z' })).toBe(false);
      expect(accepts({ validUntil: '2026-07-01T00:00:00.000Z' })).toBe(false);
      expect(accepts({ validUntil: null })).toBe(true);
    });

    it('keeps the event axis free of the transaction axis in both directions', () => {
      // A planned launch three months out, recorded today.
      expect(accepts({ eventTime: '2026-12-01T00:00:00.000Z' })).toBe(true);
      // A retroactive correction about something that happened last year.
      expect(accepts({ eventTime: '2025-01-01T00:00:00.000Z' })).toBe(true);
      expect(accepts({ eventTime: null })).toBe(true);
      // Backdated and future-dated validity are both legitimate.
      expect(accepts({ validFrom: '2020-01-01T00:00:00.000Z' })).toBe(true);
      expect(accepts({ validFrom: '2030-01-01T00:00:00.000Z' })).toBe(true);
    });

    it('refuses an observation or decision that postdates ledger acceptance', () => {
      expect(accepts({ observedAt: '2026-07-24T18:20:12.023Z' })).toBe(false);
      expect(accepts({ observedAt: '2026-07-24T18:20:12.022Z' })).toBe(true);
      expect(accepts({ decidedAt: '2026-07-24T18:20:12.023Z' })).toBe(false);
    });

    it('binds decidedAt to a decided review state in both directions', () => {
      expect(accepts({ approvalState: 'reviewed', decidedAt: null })).toBe(false);
      expect(
        accepts({ approvalState: 'auto_accepted', decidedAt: '2026-07-24T18:20:00.000Z' })
      ).toBe(false);
      expect(accepts({ approvalState: 'auto_accepted', decidedAt: null })).toBe(true);
    });
  });

  describe('identity and scope', () => {
    it('derives sleeveClass from the sleeve root and rejects a mislabelled class', () => {
      expect(sleeveClassForSleeveId('client:acme_corp')).toBe('client');
      expect(sleeveClassForSleeveId('shared:approved_bundles')).toBe('shared_approved');
      expect(sleeveClassForSleeveId('agent:project-pm:scratch')).toBe('agent_scratch');
      expect(sleeveClassForSleeveId('nonsense')).toBeNull();
      expect(sleeveClassForSleeveId(':leading')).toBeNull();
      // An unrecognised root maps to nothing rather than defaulting to a class.
      expect(sleeveClassForSleeveId('bogus:thing')).toBeNull();

      expect(accepts({ sleeveClass: 'project' })).toBe(false);
      expect(accepts({ sleeveId: 'shared:approved_bundles', sleeveClass: 'shared_approved' })).toBe(
        true
      );
      expect(accepts({ sleeveId: 'shared:approved_bundles', sleeveClass: 'client' })).toBe(false);
    });

    it('refuses a first revision that claims to supersede something', () => {
      expect(accepts({ revisionNo: 1, supersedes: 'rev_fact_114_z' })).toBe(false);
      expect(accepts({ revisionNo: 2, supersedes: 'rev_fact_114_z' })).toBe(true);
      expect(accepts({ revisionNo: 0 })).toBe(false);
    });
  });

  describe('link hygiene', () => {
    it('rejects self-referencing supersession, contradiction, and derivation', () => {
      expect(accepts({ revisionNo: 2, supersedes: 'rev_fact_114_a' })).toBe(false);
      expect(accepts({ supersededBy: 'rev_fact_114_a' })).toBe(false);
      expect(accepts({ status: 'active_conflicted', contradicts: ['rev_fact_114_a'] })).toBe(false);
      expect(accepts({ derivedFrom: ['mem_fact_114'] })).toBe(false);
    });

    it('rejects duplicate provenance entries on every list', () => {
      expect(
        accepts({ status: 'active_conflicted', contradicts: ['rev_other_1', 'rev_other_1'] })
      ).toBe(false);
      expect(accepts({ derivedFrom: ['mem_ep_001', 'mem_ep_001'] })).toBe(false);
      expect(accepts({ sourceEventIds: ['evt_call_7742', 'evt_call_7742'] })).toBe(false);
      expect(
        accepts({
          evidenceRefs: [
            { type: 'memory_revision', id: 'rev_ep_001' },
            { type: 'memory_revision', id: 'rev_ep_001' }
          ]
        })
      ).toBe(false);
      // Same id under a different evidence type is a different reference.
      expect(
        accepts({
          evidenceRefs: [
            { type: 'memory_revision', id: 'rev_ep_001' },
            { type: 'artifact', id: 'rev_ep_001' }
          ]
        })
      ).toBe(true);
    });
  });

  describe('lifecycle and review as separable axes', () => {
    it('rejects incoherent (status, approvalState) pairings', () => {
      expect(accepts({ status: 'active', approvalState: 'pending', decidedAt: null })).toBe(false);
      expect(accepts({ status: 'pending_review', approvalState: 'pending', decidedAt: null })).toBe(
        true
      );
      expect(accepts({ status: 'pending_review', approvalState: 'approved' })).toBe(false);
      expect(accepts({ status: 'active', approvalState: 'rejected' })).toBe(false);
    });

    it('treats active_conflicted as a flagged RELATION that needs a link', () => {
      expect(accepts({ status: 'active_conflicted', contradicts: [] })).toBe(false);
      expect(accepts({ status: 'active_conflicted', contradicts: ['rev_other_1'] })).toBe(true);
    });

    it('refuses a revision that is both superseded and still active', () => {
      expect(accepts({ supersededBy: 'rev_fact_114_b' })).toBe(false);
      expect(
        accepts({
          status: 'active_conflicted',
          contradicts: ['rev_other_1'],
          supersededBy: 'rev_fact_114_b'
        })
      ).toBe(false);
      expect(accepts({ status: 'superseded', supersededBy: 'rev_fact_114_b' })).toBe(true);
    });
  });

  describe('deletion, purge, and legal hold', () => {
    it('requires a tombstone in exactly the deletion states and nowhere else', () => {
      expect(accepts({ tombstone: tombstone() })).toBe(false);
      expect(accepts({ status: 'deleted_logical', tombstone: null })).toBe(false);
      expect(
        accepts({ status: 'deleted_logical', tombstone: tombstone({ purgeState: 'pending' }) })
      ).toBe(true);
      // Purge state must agree with the lifecycle state, not merely be present.
      expect(
        accepts({ status: 'deleted_logical', tombstone: tombstone({ purgeState: 'scheduled' }) })
      ).toBe(false);
      expect(
        accepts({ status: 'purge_scheduled', tombstone: tombstone({ purgeState: 'scheduled' }) })
      ).toBe(true);
    });

    it('lets a purged record keep tombstone metadata only, never payload content', () => {
      const purged = {
        status: 'purged',
        tombstone: tombstone(),
        payloadCanonical: { form: 'redacted', redactionReason: 'privacy_erasure' }
      };
      expect(accepts(purged)).toBe(true);
      // A purge that kept the claim is rejected.
      expect(accepts({ status: 'purged', tombstone: tombstone() })).toBe(false);
      // A redacted payload outside a deletion state is rejected.
      expect(
        accepts({ payloadCanonical: { form: 'redacted', redactionReason: 'privacy_erasure' } })
      ).toBe(false);
    });

    it('blocks purge while a legal hold is in force', () => {
      const purged = {
        status: 'purged',
        tombstone: tombstone(),
        payloadCanonical: { form: 'redacted', redactionReason: 'legal_order' }
      };
      expect(accepts({ ...purged, legalHold: false })).toBe(true);
      expect(accepts({ ...purged, legalHold: true })).toBe(false);
      // A hold does not block the earlier, reversible stages of deletion.
      expect(
        accepts({
          status: 'deleted_logical',
          legalHold: true,
          tombstone: tombstone({ purgeState: 'pending' })
        })
      ).toBe(true);
    });
  });

  describe('evidence obligation', () => {
    it('requires evidence for derived semantic and procedural memories', () => {
      const bare = { sourceEventIds: [], evidenceRefs: [], derivedFrom: [] };
      expect(
        accepts({
          ...bare,
          authorityTier: 'agent_inference',
          derivationMethod: 'agent_inference',
          approvalState: 'auto_accepted',
          decidedAt: null
        })
      ).toBe(false);
      // Operator-authored explicit policy is the documented exemption.
      expect(accepts({ ...bare, authorityTier: 'operator_explicit' })).toBe(true);
      expect(accepts({ ...bare, authorityTier: 'policy_signed_approved' })).toBe(true);
      // Episodic evidence is itself the record of what happened; nothing to cite.
      expect(
        accepts({
          ...bare,
          kind: 'episode',
          entityKey: null,
          authorityTier: 'tool_observation',
          derivationMethod: 'direct_observation'
        })
      ).toBe(true);
      // A single source event satisfies the obligation.
      expect(
        accepts({ ...bare, sourceEventIds: ['evt_call_7742'], authorityTier: 'agent_inference' })
      ).toBe(true);
    });
  });

  describe('payload forms', () => {
    it('requires triple qualifiers to be unique and sorted so the encoding is unambiguous', () => {
      const triple = (qualifiers: string[]) => ({
        form: 'triple',
        subject: 'operator',
        predicate: 'prefers_theme',
        object: 'dark_mode',
        qualifiers
      });
      expect(MemoryClaimTriplePayloadSchema.safeParse(triple(['eu', 'q4'])).success).toBe(true);
      expect(MemoryClaimTriplePayloadSchema.safeParse(triple(['q4', 'eu'])).success).toBe(false);
      expect(MemoryClaimTriplePayloadSchema.safeParse(triple(['eu', 'eu'])).success).toBe(false);
      expect(MemoryClaimTriplePayloadSchema.safeParse(triple(['Bad Qualifier'])).success).toBe(
        false
      );
    });

    it('requires a structured payload to carry at least one integer-safe field', () => {
      expect(
        MemoryStructuredPayloadSchema.safeParse({ form: 'structured', fields: {} }).success
      ).toBe(false);
      expect(
        MemoryStructuredPayloadSchema.safeParse({
          form: 'structured',
          fields: { channel: 'meeting_transcript', participants: ['operator'], turns: 12 }
        }).success
      ).toBe(true);
      // Floats have no unambiguous canonical form, so they never enter a payload.
      expect(
        MemoryStructuredPayloadSchema.safeParse({ form: 'structured', fields: { ratio: 0.1 } })
          .success
      ).toBe(false);
    });
  });
});
