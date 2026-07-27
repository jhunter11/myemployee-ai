import { describe, expect, it } from 'vitest';

import { verifyRevisionIntegrity } from '../../../src/memory/ledger/canonical';
import { MEMORY_COMMAND_SCHEMA_VERSION } from '../../../src/memory/ledger/commands';
import {
  createLedgerState,
  currentActiveRevision,
  LedgerCommandMalformedError,
  projectionFingerprint,
  reduceCommand,
  replayCommands,
  threadHead,
  threadRevisions,
  type LedgerState
} from '../../../src/memory/ledger/reducer';
import type { MemoryRevision } from '../../../src/memory/ledger/record-contracts';

const SLEEVE_ID = 'client:acme_corp';
const OWNER_SCOPE_ID = 'client:acme_corp';
const AGENT_ID = 'agency-developer';
const T0 = '2026-07-24T18:00:00.000Z';
const T1 = '2026-07-24T19:00:00.000Z';

function emptyState(overrides: Partial<LedgerState> = {}): LedgerState {
  return {
    ...createLedgerState({
      sleeveId: SLEEVE_ID,
      ownerScopeId: OWNER_SCOPE_ID,
      maxSensitivity: 'confidential'
    }),
    ...overrides
  };
}

const BASE_PAYLOAD = {
  form: 'triple',
  subject: 'operator',
  predicate: 'prefers_report_format',
  object: 'dense_narrative',
  qualifiers: [] as string[]
};

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'preference',
    entityKey: 'operator/report_format',
    payloadCanonical: BASE_PAYLOAD,
    eventTime: null,
    observedAt: T0,
    validFrom: T0,
    validUntil: null,
    derivationMethod: 'direct_observation',
    confidencePermille: 900,
    sensitivity: 'confidential',
    retentionPolicy: 'until_superseded',
    legalHold: false,
    workflowId: null,
    runId: null,
    sourceEventIds: ['evt_chat_8830'],
    evidenceRefs: [],
    derivedFrom: [],
    ...overrides
  };
}

function command(
  id: string,
  op: string,
  extra: Record<string, unknown> = {},
  base: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: MEMORY_COMMAND_SCHEMA_VERSION,
    commandId: `cmd_${id}`,
    idempotencyKey: `idk_${id}`,
    ownerScopeId: OWNER_SCOPE_ID,
    sleeveId: SLEEVE_ID,
    issuedBy: AGENT_ID,
    issuedAt: T0,
    authorityTier: 'tool_observation',
    approvalState: 'auto_accepted',
    decidedAt: null,
    op,
    ...extra,
    ...base
  };
}

/** The report's protocol: an observation becomes a draft, a draft a proposal, a proposal canonical. */
function activateThread(
  state: LedgerState,
  memoryId: string,
  prefix: string,
  overrides: Record<string, unknown> = {},
  authorityTier = 'tool_observation'
): { state: LedgerState; revisionId: string } {
  const observed = reduceCommand(
    state,
    command(`${prefix}1`, 'OBSERVE', { memoryId, draft: draft(overrides) }, { authorityTier })
  );
  expect(observed.audit.outcome).toBe('OBSERVED');
  const proposed = reduceCommand(
    observed.state,
    command(
      `${prefix}2`,
      'PROPOSE',
      { memoryId, baseRevisionId: observed.audit.revisionIds[0], draft: draft(overrides) },
      { authorityTier }
    )
  );
  expect(proposed.audit.outcome).toBe('PROPOSED');
  const added = reduceCommand(
    proposed.state,
    command(
      `${prefix}3`,
      'ADD',
      { memoryId, baseRevisionId: proposed.audit.revisionIds[0], draft: draft(overrides) },
      { authorityTier }
    )
  );
  expect(added.audit.outcome).toBe('APPLIED');
  const revisionId = added.audit.revisionIds[0];
  if (revisionId === undefined) throw new Error('activation produced no revision');
  return { state: added.state, revisionId };
}

function head(state: LedgerState, memoryId: string): MemoryRevision {
  const revision = threadHead(state, memoryId);
  if (revision === null) throw new Error(`thread ${memoryId} is empty`);
  return revision;
}

describe('deterministic ledger reducer', () => {
  describe('protocol rule 2: every command produces an audit event', () => {
    it('audits acceptances, refusals, duplicates, and explicit no-ops alike', () => {
      const opened = reduceCommand(
        emptyState(),
        command('0001', 'OBSERVE', { memoryId: 'mem_a', draft: draft() })
      );
      expect(opened.audit.outcome).toBe('OBSERVED');
      expect(opened.audit.stateChanged).toBe(true);
      expect(opened.event).not.toBeNull();

      const duplicate = reduceCommand(
        opened.state,
        command('0001', 'OBSERVE', { memoryId: 'mem_a', draft: draft() })
      );
      expect(duplicate.audit.outcome).toBe('NOOP_DUPLICATE');
      expect(duplicate.event).toBeNull();

      const noop = reduceCommand(opened.state, command('0002', 'NOOP', { reason: 'evaluated' }));
      expect(noop.audit.outcome).toBe('NOOP_EXPLICIT');
      expect(noop.audit.stateChanged).toBe(false);
      expect(noop.event).toBeNull();

      const malformed = reduceCommand(
        opened.state,
        command('0003', 'OBSERVE', { memoryId: 'mem_b', draft: { broken: true } })
      );
      expect(malformed.audit.outcome).toBe('INVALID_COMMAND');
      // Even an unparsable command leaves a trace an operator can act on.
      expect(malformed.audit.reason.length).toBeGreaterThan(0);
      expect(malformed.audit.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it('refuses to invent an audit for a command it cannot even address', () => {
      // No command id, no sleeve, no sequence: there is nothing to attach a row to,
      // so the boundary rejects it rather than logging a fiction.
      expect(() => reduceCommand(emptyState(), { op: 'OBSERVE' })).toThrow(
        LedgerCommandMalformedError
      );
    });

    it('burns the sequence and the idempotency key even when it refuses', () => {
      const state = emptyState();
      const denied = reduceCommand(
        state,
        command('0001', 'DELETE', {
          memoryId: 'mem_a',
          baseRevisionId: 'rev_missing',
          ticket: { reason: 'operator_delete', ticketId: 'tkt_1' }
        })
      );
      expect(denied.audit.outcome).toBe('DENIED');
      // The command is in the log; a retry must be a NEW command after a re-read.
      expect(denied.state.nextSleeveSeq).toBe(2);
      expect(denied.state.idempotencyKeys).toEqual(['idk_0001']);
      expect(denied.state.revisions).toHaveLength(0);
    });
  });

  describe('the lifecycle protocol', () => {
    it('walks observation -> proposal -> canonical, closing each prior head', () => {
      const { state, revisionId } = activateThread(emptyState(), 'mem_pref', 'a');
      const revisions = threadRevisions(state, 'mem_pref');
      // Closed revisions keep the status they recorded whenever `-> superseded` is
      // not a legal move from it: the draft was PROPOSED and the proposal was
      // ACCEPTED, and rewriting either would falsify the historical record.
      expect(revisions.map((revision) => revision.status)).toEqual([
        'observed_draft',
        'proposed',
        'active'
      ]);
      expect(revisions.map((revision) => revision.revisionNo)).toEqual([1, 2, 3]);
      expect(revisions[0]?.supersededBy).toBe(revisions[1]?.revisionId);
      expect(revisions[1]?.supersededBy).toBe(revisionId);
      expect(revisions[2]?.supersedes).toBe(revisions[1]?.revisionId);
      expect(currentActiveRevision(state, 'mem_pref')?.revisionId).toBe(revisionId);
    });

    it('refuses an illegal lifecycle move instead of forcing it', () => {
      const opened = reduceCommand(
        emptyState(),
        command('0001', 'OBSERVE', { memoryId: 'mem_a', draft: draft() })
      );
      // observed_draft -> active is absent from the transition table: a draft has to
      // be proposed before it can become canonical.
      const promoted = reduceCommand(
        opened.state,
        command('0002', 'ADD', {
          memoryId: 'mem_a',
          baseRevisionId: opened.audit.revisionIds[0],
          draft: draft()
        })
      );
      expect(promoted.audit.outcome).toBe('LIFECYCLE_DENIED');
      expect(promoted.audit.reason).toContain("'observed_draft' -> 'active'");
    });

    it('refuses to revalidate a retracted thread, and expires then closes a live one', () => {
      const activated = activateThread(emptyState(), 'mem_a', 'a');
      const retracted = reduceCommand(
        activated.state,
        command('0100', 'RETRACT', {
          memoryId: 'mem_a',
          baseRevisionId: activated.revisionId,
          reasonCode: 'disproven'
        })
      );
      expect(retracted.audit.outcome).toBe('APPLIED');
      expect(head(retracted.state, 'mem_a').status).toBe('retracted');
      expect(currentActiveRevision(retracted.state, 'mem_a')).toBeNull();

      // `retracted` only leads to deletion in the lifecycle table, so reviving a
      // retracted claim is denied rather than quietly permitted.
      const revived = reduceCommand(
        retracted.state,
        command('0101', 'REVALIDATE', {
          memoryId: 'mem_a',
          baseRevisionId: retracted.audit.revisionIds[0],
          draft: draft()
        })
      );
      expect(revived.audit.outcome).toBe('LIFECYCLE_DENIED');
    });

    it('closes a validity interval on EXPIRE and refuses a non-advancing expiry', () => {
      const activated = activateThread(emptyState(), 'mem_a', 'a');
      const early = reduceCommand(
        activated.state,
        command('0100', 'EXPIRE', {
          memoryId: 'mem_a',
          baseRevisionId: activated.revisionId,
          validUntil: '2026-07-24T17:00:00.000Z'
        })
      );
      expect(early.audit.outcome).toBe('TEMPORAL_INVALID');

      const expired = reduceCommand(
        activated.state,
        command('0101', 'EXPIRE', {
          memoryId: 'mem_a',
          baseRevisionId: activated.revisionId,
          validUntil: T1
        })
      );
      expect(expired.audit.outcome).toBe('APPLIED');
      const expiredHead = head(expired.state, 'mem_a');
      expect(expiredHead.status).toBe('expired');
      expect(expiredHead.validUntil).toBe(T1);
      expect(currentActiveRevision(expired.state, 'mem_a')).toBeNull();

      // `expired -> superseded` IS legal, so fresh evidence can revive the thread.
      const revalidated = reduceCommand(
        expired.state,
        command('0102', 'REVALIDATE', {
          memoryId: 'mem_a',
          baseRevisionId: expiredHead.revisionId,
          draft: draft({ validFrom: T1, observedAt: T0 })
        })
      );
      expect(revalidated.audit.outcome).toBe('APPLIED');
      expect(currentActiveRevision(revalidated.state, 'mem_a')?.status).toBe('active');
    });
  });

  describe('compare-and-swap', () => {
    it('rejects a command whose base is no longer the thread head', () => {
      const activated = activateThread(emptyState(), 'mem_a', 'a');
      const first = reduceCommand(
        activated.state,
        command('0100', 'SUPERSEDE', {
          memoryId: 'mem_a',
          baseRevisionId: activated.revisionId,
          draft: draft({ payloadCanonical: { ...BASE_PAYLOAD, object: 'terse' } })
        })
      );
      expect(first.audit.outcome).toBe('APPLIED');

      // The losing writer of a concurrent pair reads a base that has moved on.
      const stale = reduceCommand(
        first.state,
        command('0101', 'SUPERSEDE', {
          memoryId: 'mem_a',
          baseRevisionId: activated.revisionId,
          draft: draft({ payloadCanonical: { ...BASE_PAYLOAD, object: 'tables' } })
        })
      );
      expect(stale.audit.outcome).toBe('STALE_BASE');
      expect(stale.state.revisions).toHaveLength(first.state.revisions.length);
    });

    it('rejects a base on a thread that does not exist', () => {
      const result = reduceCommand(
        emptyState(),
        command('0001', 'SUPERSEDE', {
          memoryId: 'mem_ghost',
          baseRevisionId: 'rev_ghost',
          draft: draft()
        })
      );
      expect(result.audit.outcome).toBe('STALE_BASE');
    });
  });

  describe('protocol rule 1: UPDATE is metadata-only', () => {
    it('accepts a metadata patch that leaves the claim digest untouched', () => {
      const activated = activateThread(emptyState(), 'mem_a', 'a');
      const before = head(activated.state, 'mem_a');
      const updated = reduceCommand(
        activated.state,
        command('0100', 'UPDATE', {
          memoryId: 'mem_a',
          baseRevisionId: activated.revisionId,
          payloadCanonical: BASE_PAYLOAD,
          metadata: {
            confidencePermille: 999,
            sensitivity: 'internal',
            retentionPolicy: 'retain_until_revoked',
            legalHold: true,
            evidenceRefs: [{ type: 'artifact', id: 'art_policy_doc_22' }]
          }
        })
      );
      expect(updated.audit.outcome).toBe('APPLIED');
      const after = head(updated.state, 'mem_a');
      expect(after.confidencePermille).toBe(999);
      expect(after.legalHold).toBe(true);
      // The CLAIM digest is untouched; only the revision's own identity moved.
      expect(after.contentHash).toBe(before.contentHash);
      expect(after.canonicalHash).not.toBe(before.canonicalHash);
    });

    it('rejects an UPDATE whose payload differs from its base', () => {
      const activated = activateThread(emptyState(), 'mem_a', 'a');
      const rejected = reduceCommand(
        activated.state,
        command('0100', 'UPDATE', {
          memoryId: 'mem_a',
          baseRevisionId: activated.revisionId,
          payloadCanonical: {
            form: 'triple',
            subject: 'operator',
            predicate: 'prefers_report_format',
            object: 'terse_bullets',
            qualifiers: []
          },
          metadata: {
            confidencePermille: 900,
            sensitivity: 'confidential',
            retentionPolicy: 'until_superseded',
            legalHold: false,
            evidenceRefs: []
          }
        })
      );
      expect(rejected.audit.outcome).toBe('UPDATE_PAYLOAD_CHANGED');
      expect(rejected.audit.reason).toContain('SUPERSEDE');
      expect(rejected.state.revisions).toHaveLength(activated.state.revisions.length);
    });
  });

  describe('authorization and authority precedence', () => {
    it('denies an operation below its authority floor, deny-by-default', () => {
      const activated = activateThread(emptyState(), 'mem_a', 'a');
      const denied = reduceCommand(
        activated.state,
        command(
          '0100',
          'DELETE',
          {
            memoryId: 'mem_a',
            baseRevisionId: activated.revisionId,
            ticket: { reason: 'privacy_erasure', ticketId: 'tkt_del_1' }
          },
          { authorityTier: 'agent_inference', approvalState: 'approved', decidedAt: T0 }
        )
      );
      expect(denied.audit.outcome).toBe('DENIED');
      expect(denied.audit.reason).toContain('operator_explicit');
    });

    it('denies a sensitivity above the sleeve cap', () => {
      const denied = reduceCommand(
        emptyState(),
        command('0001', 'OBSERVE', {
          memoryId: 'mem_a',
          draft: draft({ sensitivity: 'restricted' })
        })
      );
      expect(denied.audit.outcome).toBe('DENIED');
      expect(denied.audit.reason).toContain('exceeds the sleeve cap');
    });

    it('denies a command addressed to another sleeve without touching this one', () => {
      const denied = reduceCommand(
        emptyState(),
        command(
          '0001',
          'OBSERVE',
          { memoryId: 'mem_a', draft: draft() },
          {
            sleeveId: 'agency:agency',
            ownerScopeId: 'agency:agency'
          }
        )
      );
      expect(denied.audit.outcome).toBe('DENIED');
      expect(denied.state.revisions).toHaveLength(0);
    });

    it('refuses a lower-authority supersession of a higher-authority active claim', () => {
      const operator = activateThread(
        emptyState(),
        'mem_a',
        'a',
        { derivationMethod: 'explicit_operator_statement' },
        'operator_explicit'
      );

      // The writer clears the op's authority FLOOR, so this is the precedence gate
      // firing, not the authorization gate: an agent observation must not quietly
      // overwrite what the operator stated.
      const downgrade = reduceCommand(
        operator.state,
        command(
          '0101',
          'SUPERSEDE',
          {
            memoryId: 'mem_a',
            baseRevisionId: operator.revisionId,
            draft: draft({ payloadCanonical: { ...BASE_PAYLOAD, object: 'tables' } })
          },
          { authorityTier: 'agent_observation' }
        )
      );
      expect(downgrade.audit.outcome).toBe('AUTHORITY_DENIED');
      expect(downgrade.audit.reason).toContain('authority_lower_denied');

      // The same writer at equal authority is the ordinary revision path.
      const equal = reduceCommand(
        operator.state,
        command(
          '0102',
          'SUPERSEDE',
          {
            memoryId: 'mem_a',
            baseRevisionId: operator.revisionId,
            draft: draft({
              derivationMethod: 'explicit_operator_statement',
              payloadCanonical: { ...BASE_PAYLOAD, object: 'tables' }
            })
          },
          { authorityTier: 'operator_explicit' }
        )
      );
      expect(equal.audit.outcome).toBe('APPLIED');
    });

    it('refuses a successor whose validity opens before the claim it closes', () => {
      const activated = activateThread(emptyState(), 'mem_a', 'a');
      const backdated = reduceCommand(
        activated.state,
        command('0100', 'SUPERSEDE', {
          memoryId: 'mem_a',
          baseRevisionId: activated.revisionId,
          draft: draft({
            validFrom: '2026-07-01T00:00:00.000Z',
            payloadCanonical: { ...BASE_PAYLOAD, object: 'terse' }
          })
        })
      );
      expect(backdated.audit.outcome).toBe('TEMPORAL_INVALID');
    });
  });

  describe('conflict handling', () => {
    const competing = {
      entityKey: 'launch/date',
      payloadCanonical: {
        form: 'triple',
        subject: 'project:acme',
        predicate: 'launch_date',
        object: '2026-09-30',
        qualifiers: []
      }
    };

    it('keeps both claims and flags them symmetrically on an authority tie', () => {
      const first = activateThread(emptyState(), 'mem_x', 'a', competing);
      const second = activateThread(first.state, 'mem_y', 'b', {
        ...competing,
        payloadCanonical: { ...competing.payloadCanonical, object: '2026-10-15' }
      });

      const left = head(second.state, 'mem_x');
      const right = head(second.state, 'mem_y');
      expect(right.status).toBe('active_conflicted');
      expect(left.status).toBe('active_conflicted');
      // The conflict graph must be symmetric, or retrieval would answer confidently
      // from whichever side happened to stay unflagged.
      expect(right.contradicts).toContain(left.revisionId);
      expect(left.contradicts).toContain(right.revisionId);
    });

    it('lets a strictly higher authority take effect without flagging either side', () => {
      const first = activateThread(emptyState(), 'mem_x', 'a', competing);
      const second = activateThread(
        first.state,
        'mem_y',
        'b',
        {
          ...competing,
          payloadCanonical: { ...competing.payloadCanonical, object: '2026-10-15' },
          derivationMethod: 'explicit_operator_statement'
        },
        'operator_explicit'
      );
      expect(head(second.state, 'mem_y').status).toBe('active');
      // A decided winner is not a conflict: nothing is flagged, and the losing claim
      // stays on record rather than being deleted.
      expect(head(second.state, 'mem_x').status).toBe('active');
      expect(head(second.state, 'mem_y').contradicts).toEqual([]);
    });

    it('rejects a candidate that a higher-authority active claim outranks', () => {
      const operator = activateThread(
        emptyState(),
        'mem_x',
        'o',
        { ...competing, derivationMethod: 'explicit_operator_statement' },
        'operator_explicit'
      );

      // A statistical pattern cannot displace an operator's explicit statement.
      const weakDraft = {
        ...competing,
        payloadCanonical: { ...competing.payloadCanonical, object: '2026-12-01' },
        derivationMethod: 'statistical_aggregation'
      };
      const weak = reduceCommand(
        operator.state,
        command(
          'w1',
          'OBSERVE',
          { memoryId: 'mem_y', draft: draft(weakDraft) },
          { authorityTier: 'statistical_pattern' }
        )
      );
      const weakProposed = reduceCommand(
        weak.state,
        command(
          'w2',
          'PROPOSE',
          {
            memoryId: 'mem_y',
            baseRevisionId: weak.audit.revisionIds[0],
            draft: draft(weakDraft)
          },
          { authorityTier: 'statistical_pattern' }
        )
      );
      const weakAdded = reduceCommand(
        weakProposed.state,
        command(
          'w3',
          'ADD',
          {
            memoryId: 'mem_y',
            baseRevisionId: weakProposed.audit.revisionIds[0],
            draft: draft(weakDraft)
          },
          { authorityTier: 'agent_observation' }
        )
      );
      expect(weakAdded.audit.outcome).toBe('CONFLICT_REJECTED');
      expect(head(weakAdded.state, 'mem_x').status).toBe('active');
      // The outranked candidate never became canonical, and the winner is untouched.
      expect(head(weakAdded.state, 'mem_y').status).toBe('proposed');
    });
  });

  describe('deletion', () => {
    it('writes a tombstone with a redacted payload and enqueues the cascade', () => {
      const activated = activateThread(emptyState(), 'mem_a', 'a');
      const deleted = reduceCommand(
        activated.state,
        command(
          '0100',
          'DELETE',
          {
            memoryId: 'mem_a',
            baseRevisionId: activated.revisionId,
            ticket: { reason: 'privacy_erasure', ticketId: 'tkt_del_0001' }
          },
          { authorityTier: 'operator_explicit', approvalState: 'approved', decidedAt: T0 }
        )
      );
      expect(deleted.audit.outcome).toBe('APPLIED');
      const tombstoned = head(deleted.state, 'mem_a');
      expect(tombstoned.status).toBe('deleted_logical');
      expect(tombstoned.payloadCanonical.form).toBe('redacted');
      expect(tombstoned.tombstone?.ticketId).toBe('tkt_del_0001');
      expect(tombstoned.tombstone?.purgeState).toBe('pending');
      expect(deleted.state.deletionQueue).toEqual(['mem_a']);
      expect(currentActiveRevision(deleted.state, 'mem_a')).toBeNull();
    });

    it('refuses to delete a thread under legal hold', () => {
      const activated = activateThread(emptyState(), 'mem_a', 'a', { legalHold: true });
      const blocked = reduceCommand(
        activated.state,
        command(
          '0100',
          'DELETE',
          {
            memoryId: 'mem_a',
            baseRevisionId: activated.revisionId,
            ticket: { reason: 'privacy_erasure', ticketId: 'tkt_del_0001' }
          },
          { authorityTier: 'operator_explicit', approvalState: 'approved', decidedAt: T0 }
        )
      );
      expect(blocked.audit.outcome).toBe('PRECONDITION_FAILED');
      expect(blocked.audit.reason).toContain('Legal hold');
    });
  });

  describe('merge and split', () => {
    const first = {
      entityKey: 'client/contact',
      payloadCanonical: {
        form: 'triple',
        subject: 'client:acme',
        predicate: 'primary_contact',
        object: 'dana',
        qualifiers: []
      }
    };

    it('collapses duplicate threads onto a survivor and closes the rest', () => {
      const a = activateThread(emptyState(), 'mem_a', 'a', first);
      const b = activateThread(a.state, 'mem_b', 'b', {
        entityKey: 'client/contact_alt',
        payloadCanonical: { ...first.payloadCanonical, subject: 'client:acme_ltd' }
      });
      const merged = reduceCommand(
        b.state,
        command(
          '0200',
          'MERGE',
          {
            sources: [
              { memoryId: 'mem_a', baseRevisionId: a.revisionId },
              { memoryId: 'mem_b', baseRevisionId: b.revisionId }
            ],
            survivorMemoryId: 'mem_a',
            draft: draft({ ...first, derivedFrom: ['mem_b'] })
          },
          {
            authorityTier: 'human_artifact_verified',
            approvalState: 'approved',
            decidedAt: T0
          }
        )
      );
      expect(merged.audit.outcome).toBe('MERGED');
      expect(head(merged.state, 'mem_a').status).toBe('active');
      expect(head(merged.state, 'mem_b').status).toBe('superseded');
      expect(currentActiveRevision(merged.state, 'mem_b')).toBeNull();
      expect(head(merged.state, 'mem_a').derivedFrom).toContain('mem_b');
    });

    it('refuses a merge plan that drops an absorbed thread from provenance', () => {
      const a = activateThread(emptyState(), 'mem_a', 'a', first);
      const b = activateThread(a.state, 'mem_b', 'b', {
        entityKey: 'client/contact_alt',
        payloadCanonical: { ...first.payloadCanonical, subject: 'client:acme_ltd' }
      });
      const merged = reduceCommand(
        b.state,
        command(
          '0200',
          'MERGE',
          {
            sources: [
              { memoryId: 'mem_a', baseRevisionId: a.revisionId },
              { memoryId: 'mem_b', baseRevisionId: b.revisionId }
            ],
            survivorMemoryId: 'mem_a',
            draft: draft({ ...first, derivedFrom: [] })
          },
          { authorityTier: 'human_artifact_verified', approvalState: 'approved', decidedAt: T0 }
        )
      );
      expect(merged.audit.outcome).toBe('PRECONDITION_FAILED');
      expect(merged.audit.reason).toContain('derivedFrom');
    });

    it('separates a conflated thread into parts that declare their ancestry', () => {
      const a = activateThread(emptyState(), 'mem_a', 'a', first);
      const split = reduceCommand(
        a.state,
        command(
          '0200',
          'SPLIT',
          {
            memoryId: 'mem_a',
            baseRevisionId: a.revisionId,
            parts: [
              {
                memoryId: 'mem_p1',
                draft: draft({
                  entityKey: 'client/contact_email',
                  payloadCanonical: { ...first.payloadCanonical, predicate: 'contact_email' },
                  derivedFrom: ['mem_a']
                })
              },
              {
                memoryId: 'mem_p2',
                draft: draft({
                  entityKey: 'client/contact_phone',
                  payloadCanonical: { ...first.payloadCanonical, predicate: 'contact_phone' },
                  derivedFrom: ['mem_a']
                })
              }
            ]
          },
          { authorityTier: 'human_artifact_verified', approvalState: 'approved', decidedAt: T0 }
        )
      );
      expect(split.audit.outcome).toBe('SPLIT');
      expect(head(split.state, 'mem_a').status).toBe('superseded');
      expect(head(split.state, 'mem_p1').status).toBe('active');
      expect(head(split.state, 'mem_p2').status).toBe('active');
      expect(split.audit.revisionIds).toHaveLength(3);
    });

    it('refuses a split whose own parts contradict each other', () => {
      // Each part is admissible against the pre-command state — neither conflicts
      // with anything that existed beforehand. The contradiction exists only
      // BETWEEN them. Checking every part against `state` alone lets one command
      // commit both sides of a contradiction as active, with no conflict flag and
      // no contradiction edge, invisible to the engine built to catch exactly this.
      const a = activateThread(emptyState(), 'mem_a', 'a', first);
      const sameEntity = {
        entityKey: 'client/contact_email',
        derivedFrom: ['mem_a']
      };
      const split = reduceCommand(
        a.state,
        command(
          '0201',
          'SPLIT',
          {
            memoryId: 'mem_a',
            baseRevisionId: a.revisionId,
            parts: [
              {
                memoryId: 'mem_p1',
                draft: draft({
                  ...sameEntity,
                  payloadCanonical: {
                    ...first.payloadCanonical,
                    predicate: 'contact_email',
                    object: 'dana@acme.test'
                  }
                })
              },
              {
                memoryId: 'mem_p2',
                draft: draft({
                  ...sameEntity,
                  payloadCanonical: {
                    ...first.payloadCanonical,
                    predicate: 'contact_email',
                    object: 'reyes@acme.test'
                  }
                })
              }
            ]
          },
          { authorityTier: 'human_artifact_verified', approvalState: 'approved', decidedAt: T0 }
        )
      );

      expect(split.audit.outcome).not.toBe('SPLIT');
      // Nothing committed: the base thread is untouched and no part exists.
      expect(head(split.state, 'mem_a').status).toBe('active');
      expect(split.state.revisions.filter((r) => r.memoryId.startsWith('mem_p'))).toHaveLength(0);
    });
  });

  describe('determinism', () => {
    /**
     * A realistic log: the acceptance chain, a supersession, and an explicit NOOP.
     * Built once by running the reducer to learn the derived base revision ids, then
     * replayed from scratch so the assertions compare two independent folds.
     */
    function fullLog(): Record<string, unknown>[] {
      const observed = reduceCommand(
        emptyState(),
        command('0001', 'OBSERVE', { memoryId: 'mem_a', draft: draft() })
      );
      const proposeCommand = command('0002', 'PROPOSE', {
        memoryId: 'mem_a',
        baseRevisionId: observed.audit.revisionIds[0],
        draft: draft()
      });
      const proposed = reduceCommand(observed.state, proposeCommand);
      const addCommand = command('0003', 'ADD', {
        memoryId: 'mem_a',
        baseRevisionId: proposed.audit.revisionIds[0],
        draft: draft()
      });
      const added = reduceCommand(proposed.state, addCommand);
      const supersedeCommand = command('0004', 'SUPERSEDE', {
        memoryId: 'mem_a',
        baseRevisionId: added.audit.revisionIds[0],
        draft: draft({
          validFrom: T1,
          payloadCanonical: { ...BASE_PAYLOAD, object: 'terse_bullets' }
        })
      });
      return [
        command('0001', 'OBSERVE', { memoryId: 'mem_a', draft: draft() }),
        proposeCommand,
        addCommand,
        supersedeCommand,
        command('0005', 'NOOP', { reason: 'evaluated, nothing to do' })
      ];
    }

    it('replays the same ordered log to a bit-identical projection', () => {
      const commands = fullLog();
      const first = replayCommands(emptyState(), commands);
      const second = replayCommands(emptyState(), commands);

      expect(projectionFingerprint(first.state)).toBe(projectionFingerprint(second.state));
      expect(first.state.revisions.map((revision) => revision.revisionId)).toEqual(
        second.state.revisions.map((revision) => revision.revisionId)
      );
      expect(first.state.revisions.map((revision) => revision.canonicalHash)).toEqual(
        second.state.revisions.map((revision) => revision.canonicalHash)
      );
      expect(first.audits.map((audit) => audit.fingerprint)).toEqual(
        second.audits.map((audit) => audit.fingerprint)
      );
      expect(first.state.edges.map((entry) => entry.edgeId)).toEqual(
        second.state.edges.map((entry) => entry.edgeId)
      );
      for (const revision of first.state.revisions) {
        expect(() => verifyRevisionIntegrity(revision)).not.toThrow();
      }
    });

    it('makes duplicate delivery indistinguishable from exactly-once delivery', () => {
      const commands = fullLog();
      const exactlyOnce = replayCommands(emptyState(), commands);
      // Every command delivered twice, interleaved exactly as a flaky transport would.
      const duplicated = replayCommands(
        emptyState(),
        commands.flatMap((entry) => [entry, entry])
      );

      expect(projectionFingerprint(duplicated.state)).toBe(
        projectionFingerprint(exactlyOnce.state)
      );
      expect(duplicated.state.revisions).toHaveLength(exactlyOnce.state.revisions.length);
      expect(duplicated.state.nextSleeveSeq).toBe(exactlyOnce.state.nextSleeveSeq);
      expect(duplicated.audits.filter((audit) => audit.outcome === 'NOOP_DUPLICATE')).toHaveLength(
        commands.length
      );
    });

    it('produces a different projection for a different order of the same commands', () => {
      const commands = fullLog();
      const ordered = replayCommands(emptyState(), commands);
      const shuffled = replayCommands(emptyState(), [
        commands[1],
        commands[0],
        ...commands.slice(2)
      ]);
      // Order IS meaning: a proposal that arrives before its observation is stale,
      // and the fingerprint must say so rather than converge anyway.
      expect(projectionFingerprint(shuffled.state)).not.toBe(projectionFingerprint(ordered.state));
    });
  });

  describe('projection invariants', () => {
    it('holds every structural invariant across a mixed command history', () => {
      const a = activateThread(emptyState(), 'mem_a', 'a');
      const b = activateThread(a.state, 'mem_b', 'b', {
        entityKey: 'operator/tone',
        payloadCanonical: {
          form: 'triple',
          subject: 'operator',
          predicate: 'prefers_tone',
          object: 'plain',
          qualifiers: []
        }
      });
      const superseded = reduceCommand(
        b.state,
        command('0300', 'SUPERSEDE', {
          memoryId: 'mem_a',
          baseRevisionId: a.revisionId,
          draft: draft({
            validFrom: T1,
            payloadCanonical: { ...BASE_PAYLOAD, object: 'terse' }
          })
        })
      );
      const retracted = reduceCommand(
        superseded.state,
        command('0301', 'RETRACT', {
          memoryId: 'mem_b',
          baseRevisionId: b.revisionId,
          reasonCode: 'evidence_invalid'
        })
      );
      const state = retracted.state;

      // revisionId is globally unique.
      const ids = state.revisions.map((revision) => revision.revisionId);
      expect(new Set(ids).size).toBe(ids.length);

      for (const memoryId of ['mem_a', 'mem_b']) {
        const revisions = threadRevisions(state, memoryId);
        // revisionNo is strictly increasing within a memoryId.
        for (let index = 1; index < revisions.length; index += 1) {
          expect(revisions[index]?.revisionNo).toBe((revisions[index - 1]?.revisionNo ?? 0) + 1);
        }
        // At most one current-active revision per thread.
        expect(
          revisions.filter(
            (revision) =>
              revision.supersededBy === null &&
              (revision.status === 'active' || revision.status === 'active_conflicted')
          ).length
        ).toBeLessThanOrEqual(1);
        // Exactly one open head, and every non-head is closed by its successor.
        expect(revisions.filter((revision) => revision.supersededBy === null)).toHaveLength(1);
        for (const revision of revisions) {
          if (revision.supersededBy !== null) {
            expect(revision.status).not.toBe('active');
            expect(revision.status).not.toBe('active_conflicted');
          }
          if (revision.validUntil !== null) {
            expect(Date.parse(revision.validUntil)).toBeGreaterThan(Date.parse(revision.validFrom));
          }
          expect(() => verifyRevisionIntegrity(revision)).not.toThrow();
        }
      }

      // A retracted thread is never the current-active revision.
      expect(currentActiveRevision(state, 'mem_b')).toBeNull();
      expect(currentActiveRevision(state, 'mem_a')?.status).toBe('active');
    });

    it('records the PROV footprint of every accepted revision', () => {
      const activated = activateThread(emptyState(), 'mem_a', 'a', {
        evidenceRefs: [{ type: 'artifact', id: 'art_policy_doc_22' }],
        derivedFrom: ['mem_source']
      });
      const state = activated.state;
      const generated = state.edges.filter((entry) => entry.edgeType === 'generated');
      expect(generated).toHaveLength(state.revisions.length);
      expect(state.edges.some((entry) => entry.edgeType === 'associated_with')).toBe(true);
      expect(
        state.edges.some(
          (entry) => entry.edgeType === 'derived_from' && entry.toId === 'mem_source'
        )
      ).toBe(true);
      expect(
        state.edges.some((entry) => entry.edgeType === 'used' && entry.toId === 'evt_chat_8830')
      ).toBe(true);
      // Edge identity is deterministic, so a replay never duplicates the graph.
      expect(new Set(state.edges.map((entry) => entry.edgeId)).size).toBe(state.edges.length);
    });
  });
});
