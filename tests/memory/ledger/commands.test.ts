import { describe, expect, it } from 'vitest';

import {
  commandBaseRevisionId,
  commandHash,
  commandMemoryId,
  deriveAuditId,
  deriveEdgeId,
  deriveEventId,
  deriveRevisionId,
  LedgerCommandEnvelopeSchema,
  LedgerCommandSchema,
  LEDGER_COMMAND_OPS,
  LEDGER_OPERATION_POLICIES,
  MEMORY_COMMAND_SCHEMA_VERSION
} from '../../../src/memory/ledger/commands';
import { authorityRank } from '../../../src/memory/ledger/authority';

const SLEEVE_ID = 'client:acme_corp';
const OWNER_SCOPE_ID = 'client:acme_corp';
const AGENT_ID = 'agency-developer';
const ISSUED_AT = '2026-07-24T18:14:03.512Z';

function draft(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'preference',
    entityKey: 'operator/report_format',
    payloadCanonical: {
      form: 'triple',
      subject: 'operator',
      predicate: 'prefers_report_format',
      object: 'dense_narrative_with_citations',
      qualifiers: []
    },
    eventTime: null,
    observedAt: '2026-07-24T18:12:41.000Z',
    validFrom: '2026-07-24T18:12:41.000Z',
    validUntil: null,
    derivationMethod: 'explicit_operator_statement',
    confidencePermille: 990,
    sensitivity: 'confidential',
    retentionPolicy: 'retain_until_revoked',
    legalHold: false,
    workflowId: 'wf_preference_capture_v3',
    runId: null,
    sourceEventIds: ['evt_chat_8830'],
    evidenceRefs: [],
    derivedFrom: [],
    ...overrides
  };
}

function command(
  op: string,
  extra: Record<string, unknown> = {},
  base: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: MEMORY_COMMAND_SCHEMA_VERSION,
    commandId: 'cmd_0001',
    idempotencyKey: 'idk_0001',
    ownerScopeId: OWNER_SCOPE_ID,
    sleeveId: SLEEVE_ID,
    issuedBy: AGENT_ID,
    issuedAt: ISSUED_AT,
    authorityTier: 'operator_explicit',
    approvalState: 'auto_accepted',
    decidedAt: null,
    op,
    ...extra,
    ...base
  };
}

function accepts(value: unknown): boolean {
  return LedgerCommandSchema.safeParse(value).success;
}

const OBSERVE = command('OBSERVE', { memoryId: 'mem_pref_007', draft: draft() });
const UPDATE_METADATA: Record<string, unknown> = {
  confidencePermille: 990,
  sensitivity: 'confidential',
  retentionPolicy: 'retain_until_revoked',
  legalHold: false,
  evidenceRefs: []
};
const UPDATE = command('UPDATE', {
  memoryId: 'mem_pref_007',
  baseRevisionId: 'rev_pref_007_a',
  payloadCanonical: draft().payloadCanonical,
  metadata: UPDATE_METADATA
});

describe('memcmd/v1 command protocol', () => {
  describe('the operations table', () => {
    it('covers every legal operation exactly once with a coherent policy', () => {
      expect(LEDGER_COMMAND_OPS).toHaveLength(14);
      expect(Object.keys(LEDGER_OPERATION_POLICIES).sort()).toEqual([...LEDGER_COMMAND_OPS].sort());
      for (const op of LEDGER_COMMAND_OPS) {
        const policy = LEDGER_OPERATION_POLICIES[op];
        expect(policy.op).toBe(op);
        expect(policy.idempotencyAnchor.length).toBeGreaterThan(0);
        expect(policy.rollback.length).toBeGreaterThan(0);
      }
    });

    it('reserves the privileged operations for high authority tiers', () => {
      const rankOf = (op: (typeof LEDGER_COMMAND_OPS)[number]) =>
        authorityRank(LEDGER_OPERATION_POLICIES[op].minimumAuthorityTier);
      // Deletion, promotion, and import are the three ops that suppress retrieval,
      // publish across a boundary, or materialize another sleeve's content.
      expect(rankOf('DELETE')).toBeGreaterThanOrEqual(rankOf('SUPERSEDE'));
      expect(rankOf('PROMOTE')).toBeGreaterThanOrEqual(rankOf('MERGE'));
      expect(rankOf('IMPORT')).toBe(authorityRank('policy_signed_approved'));
      expect(LEDGER_OPERATION_POLICIES.DELETE.requiredApprovalStates).toEqual(['approved']);
      expect(LEDGER_OPERATION_POLICIES.PROMOTE.requiredApprovalStates).toEqual(['approved']);
      expect(LEDGER_OPERATION_POLICIES.IMPORT.requiredApprovalStates).toEqual(['approved']);
      expect(LEDGER_OPERATION_POLICIES.OBSERVE.requiredApprovalStates).toBeNull();
    });

    it('declares which operations compare-and-swap on a base revision', () => {
      const required = LEDGER_COMMAND_OPS.filter(
        (op) => LEDGER_OPERATION_POLICIES[op].baseRevision === 'required'
      );
      expect(required).toEqual([
        'ADD',
        'UPDATE',
        'SUPERSEDE',
        'RETRACT',
        'DELETE',
        'MERGE',
        'SPLIT',
        'EXPIRE',
        'REVALIDATE'
      ]);
      // Thread-opening and cross-sleeve ops have no head to swap against.
      expect(LEDGER_OPERATION_POLICIES.OBSERVE.baseRevision).toBe('forbidden');
      expect(LEDGER_OPERATION_POLICIES.PROMOTE.baseRevision).toBe('forbidden');
      expect(LEDGER_OPERATION_POLICIES.IMPORT.baseRevision).toBe('forbidden');
      expect(LEDGER_OPERATION_POLICIES.NOOP.baseRevision).toBe('forbidden');
      expect(LEDGER_OPERATION_POLICIES.PROPOSE.baseRevision).toBe('optional');
    });
  });

  describe('protocol rule 1: UPDATE is metadata-only', () => {
    it('makes the rule enforceable by requiring the payload on the command', () => {
      expect(accepts(UPDATE)).toBe(true);
      const withoutPayload: Record<string, unknown> = { ...UPDATE };
      delete withoutPayload.payloadCanonical;
      // Without the payload the reducer would have nothing to compare a claim
      // against, so a semantic edit would pass silently.
      expect(accepts(withoutPayload)).toBe(false);
    });

    it('restricts the metadata patch to fields outside the canonical hash', () => {
      expect(Object.keys(UPDATE_METADATA).sort()).toEqual([
        'confidencePermille',
        'evidenceRefs',
        'legalHold',
        'retentionPolicy',
        'sensitivity'
      ]);
      expect(
        accepts({ ...UPDATE, metadata: { ...UPDATE_METADATA, entityKey: 'operator/other' } })
      ).toBe(false);
      expect(accepts({ ...UPDATE, metadata: { ...UPDATE_METADATA, validFrom: ISSUED_AT } })).toBe(
        false
      );
    });
  });

  describe('envelope and strictness', () => {
    it('accepts every operation in its canonical shape', () => {
      expect(accepts(OBSERVE)).toBe(true);
      expect(accepts(command('NOOP', { reason: 'nothing to do' }))).toBe(true);
      expect(
        accepts(
          command('RETRACT', {
            memoryId: 'mem_pref_007',
            baseRevisionId: 'rev_pref_007_a',
            reasonCode: 'disproven'
          })
        )
      ).toBe(true);
    });

    it('rejects unknown fields and a mismatched schema version', () => {
      expect(accepts({ ...OBSERVE, priority: 'high' })).toBe(false);
      expect(accepts({ ...OBSERVE, schemaVersion: 'memcmd/v2' })).toBe(false);
      expect(accepts({ ...OBSERVE, op: 'DESTROY' })).toBe(false);
      expect(accepts({ ...OBSERVE, draft: { ...draft(), colour: 'blue' } })).toBe(false);
    });

    it('reads the addressable header out of a command the full schema rejects', () => {
      const malformed = { ...OBSERVE, draft: { broken: true } };
      expect(accepts(malformed)).toBe(false);
      // Protocol rule 2 depends on this: a command that cannot be parsed must still
      // be auditable, so the envelope has to survive on its own.
      const envelope = LedgerCommandEnvelopeSchema.safeParse(malformed);
      expect(envelope.success).toBe(true);
      expect(envelope.success && envelope.data.commandId).toBe('cmd_0001');
      // With no addressable header there is nothing to attach an audit row to.
      expect(LedgerCommandEnvelopeSchema.safeParse({ op: 'OBSERVE' }).success).toBe(false);
    });
  });

  describe('cross-field invariants', () => {
    it('binds decidedAt to a decided review state in both directions', () => {
      expect(accepts({ ...OBSERVE, approvalState: 'approved', decidedAt: null })).toBe(false);
      expect(accepts({ ...OBSERVE, approvalState: 'approved', decidedAt: ISSUED_AT })).toBe(true);
      expect(accepts({ ...OBSERVE, approvalState: 'auto_accepted', decidedAt: ISSUED_AT })).toBe(
        false
      );
    });

    it('refuses a decision or an observation that postdates issuance', () => {
      expect(
        accepts({
          ...OBSERVE,
          approvalState: 'approved',
          decidedAt: '2026-07-24T18:14:03.513Z'
        })
      ).toBe(false);
      expect(
        accepts({ ...OBSERVE, draft: draft({ observedAt: '2026-07-24T18:14:03.513Z' }) })
      ).toBe(false);
    });

    it('refuses a draft that authors a redacted payload', () => {
      // A redacted payload is the residue of an approved erasure, never an input.
      expect(
        accepts({
          ...OBSERVE,
          draft: draft({
            payloadCanonical: { form: 'redacted', redactionReason: 'privacy_erasure' }
          })
        })
      ).toBe(false);
    });

    it('refuses a validity interval that closes before it opens', () => {
      expect(
        accepts({
          ...OBSERVE,
          draft: draft({
            validFrom: '2026-07-24T18:12:41.000Z',
            validUntil: '2026-07-24T18:12:41.000Z'
          })
        })
      ).toBe(false);
      expect(
        accepts({ ...OBSERVE, draft: draft({ validUntil: '2026-08-01T00:00:00.000Z' }) })
      ).toBe(true);
    });

    it('refuses duplicate provenance entries', () => {
      expect(accepts({ ...OBSERVE, draft: draft({ sourceEventIds: ['evt_a', 'evt_a'] }) })).toBe(
        false
      );
      expect(
        accepts({
          ...OBSERVE,
          draft: draft({
            evidenceRefs: [
              { type: 'artifact', id: 'art_1' },
              { type: 'artifact', id: 'art_1' }
            ]
          })
        })
      ).toBe(false);
    });
  });

  describe('multi-thread operation plans', () => {
    const mergeSources = [
      { memoryId: 'mem_a', baseRevisionId: 'rev_a' },
      { memoryId: 'mem_b', baseRevisionId: 'rev_b' }
    ];
    const merge = command(
      'MERGE',
      {
        sources: mergeSources,
        survivorMemoryId: 'mem_a',
        draft: draft({ derivedFrom: ['mem_b'] })
      },
      { approvalState: 'approved', decidedAt: ISSUED_AT }
    );

    it('requires merge sources to be sorted, unique, and to contain the survivor', () => {
      expect(accepts(merge)).toBe(true);
      // Unsorted sources would hash to a different set for the same merge.
      expect(accepts({ ...merge, sources: [...mergeSources].reverse() })).toBe(false);
      expect(accepts({ ...merge, sources: [mergeSources[0], mergeSources[0]] })).toBe(false);
      expect(accepts({ ...merge, survivorMemoryId: 'mem_z' })).toBe(false);
      expect(accepts({ ...merge, sources: [mergeSources[0]] })).toBe(false);
    });

    it('refuses a split part that reuses the base thread identity', () => {
      const parts = [
        { memoryId: 'mem_part_a', draft: draft({ derivedFrom: ['mem_base'] }) },
        { memoryId: 'mem_part_b', draft: draft({ derivedFrom: ['mem_base'] }) }
      ];
      const split = command(
        'SPLIT',
        { memoryId: 'mem_base', baseRevisionId: 'rev_base', parts },
        { approvalState: 'approved', decidedAt: ISSUED_AT }
      );
      expect(accepts(split)).toBe(true);
      expect(
        accepts({
          ...split,
          parts: [{ memoryId: 'mem_base', draft: draft({ derivedFrom: ['mem_other'] }) }, parts[1]]
        })
      ).toBe(false);
      // A one-part split is not a split; it would leave two live heads for one claim.
      expect(accepts({ ...split, parts: [parts[0]] })).toBe(false);
    });

    it('requires bundle members and approved targets to be sorted and unique', () => {
      const bundle: Record<string, unknown> = {
        memoryId: 'mem_bundle_004',
        eventTime: null,
        observedAt: '2026-07-24T18:12:41.000Z',
        validFrom: '2026-07-24T18:12:41.000Z',
        validUntil: null,
        sensitivity: 'internal',
        retentionPolicy: 'until_superseded_or_revoked',
        legalHold: false,
        confidencePermille: 1_000,
        approvedTargetSleeveIds: ['agency:agency', 'company:studio_ops'],
        sanitizationNotes: ['removed raw transcript excerpts']
      };
      const promote = command(
        'PROMOTE',
        { memberRevisionIds: ['rev_fact_114_a', 'rev_proc_021_c'], bundle },
        { approvalState: 'approved', decidedAt: ISSUED_AT }
      );
      expect(accepts(promote)).toBe(true);
      expect(accepts({ ...promote, memberRevisionIds: ['rev_proc_021_c', 'rev_fact_114_a'] })).toBe(
        false
      );
      expect(
        accepts({
          ...promote,
          bundle: { ...bundle, approvedTargetSleeveIds: ['agency:agency', 'agency:agency'] }
        })
      ).toBe(false);
      expect(accepts({ ...promote, bundle: { ...bundle, approvedTargetSleeveIds: [] } })).toBe(
        false
      );
    });
  });

  describe('accessors and derived identity', () => {
    it('reports the primary thread and CAS guard for each operation', () => {
      const parsedObserve = LedgerCommandSchema.parse(OBSERVE);
      expect(commandMemoryId(parsedObserve)).toBe('mem_pref_007');
      expect(commandBaseRevisionId(parsedObserve)).toBeNull();

      const parsedUpdate = LedgerCommandSchema.parse(UPDATE);
      expect(commandBaseRevisionId(parsedUpdate)).toBe('rev_pref_007_a');

      const parsedNoop = LedgerCommandSchema.parse(command('NOOP', { reason: 'evaluated' }));
      expect(commandMemoryId(parsedNoop)).toBeNull();

      const parsedMerge = LedgerCommandSchema.parse(
        command(
          'MERGE',
          {
            sources: [
              { memoryId: 'mem_a', baseRevisionId: 'rev_a' },
              { memoryId: 'mem_b', baseRevisionId: 'rev_b' }
            ],
            survivorMemoryId: 'mem_b',
            draft: draft({ derivedFrom: ['mem_a'] })
          },
          { approvalState: 'approved', decidedAt: ISSUED_AT }
        )
      );
      expect(commandMemoryId(parsedMerge)).toBe('mem_b');
      // The CAS guard reported for a merge is the SURVIVOR's base, not the first source.
      expect(commandBaseRevisionId(parsedMerge)).toBe('rev_b');
    });

    it('hashes a command deterministically and notices any change', () => {
      const parsed = LedgerCommandSchema.parse(OBSERVE);
      const first = commandHash(parsed);
      expect(commandHash(LedgerCommandSchema.parse(OBSERVE))).toBe(first);
      expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);

      const nudged = LedgerCommandSchema.parse({
        ...OBSERVE,
        draft: draft({ confidencePermille: 989 })
      });
      expect(commandHash(nudged)).not.toBe(first);
    });

    it('derives every minted id as a pure function of its inputs', () => {
      // A random or clock-derived id would make replay determinism false by
      // construction, so identity has to be reproducible from the command alone.
      expect(deriveRevisionId('cmd_0001', 'mem_a', 1)).toBe(
        deriveRevisionId('cmd_0001', 'mem_a', 1)
      );
      expect(deriveRevisionId('cmd_0001', 'mem_a', 1)).not.toBe(
        deriveRevisionId('cmd_0001', 'mem_a', 2)
      );
      expect(deriveRevisionId('cmd_0001', 'mem_a', 1)).not.toBe(
        deriveRevisionId('cmd_0002', 'mem_a', 1)
      );
      expect(deriveRevisionId('cmd_0001', 'mem_a', 1)).toMatch(/^rev_[a-f0-9]{40}$/);
      expect(deriveEventId('cmd_0001')).toMatch(/^lev_[a-f0-9]{40}$/);
      expect(deriveAuditId('cmd_0001')).toMatch(/^aud_[a-f0-9]{40}$/);
      expect(deriveEdgeId(SLEEVE_ID, 'rev_a', 'mem_b', 'derived_from')).toMatch(
        /^pve_[a-f0-9]{40}$/
      );
      // Edge identity must separate direction and type, or two distinct relations
      // would collapse onto one row.
      expect(deriveEdgeId(SLEEVE_ID, 'rev_a', 'mem_b', 'derived_from')).not.toBe(
        deriveEdgeId(SLEEVE_ID, 'mem_b', 'rev_a', 'derived_from')
      );
      expect(deriveEdgeId(SLEEVE_ID, 'rev_a', 'mem_b', 'derived_from')).not.toBe(
        deriveEdgeId(SLEEVE_ID, 'rev_a', 'mem_b', 'used')
      );
    });
  });
});
