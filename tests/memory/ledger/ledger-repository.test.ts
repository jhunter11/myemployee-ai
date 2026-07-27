import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccessControlRepository } from '../../../src/agents/access-control-repository';
import { createDatabase, type GlobalDatabaseContext } from '../../../src/db/database';
import { MEMORY_COMMAND_SCHEMA_VERSION } from '../../../src/memory/ledger/commands';
import {
  LedgerCommandRejectedError,
  LedgerRepository,
  LedgerStaleBaseError
} from '../../../src/memory/ledger/ledger-repository';
import {
  createLedgerState,
  projectionFingerprint,
  replayCommands
} from '../../../src/memory/ledger/reducer';

const AGENCY_SCOPE = 'agency:agency';
const CLIENT_SCOPE = 'client:acme_corp';
const CLIENT_SLEEVE = 'client:acme_corp';
const SHARED_SLEEVE = 'shared:approved';
const AGENCY_SLEEVE = 'agency:agency';
const AGENT_ID = 'agency-developer';
const T0 = '2026-07-24T18:00:00.000Z';
const T1 = '2026-07-24T19:00:00.000Z';
const T2 = '2026-07-24T20:00:00.000Z';

interface Harness {
  context: GlobalDatabaseContext;
  ledger: LedgerRepository;
  cleanup(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const projectRoot = join(__dirname, '..', '..', '..');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-memory-ledger-'));
  const context = await createDatabase({
    projectRoot,
    filename: join(temporaryRoot, 'jarvis.sqlite')
  });
  const access = new AccessControlRepository(context.db, () => new Date(T0));

  await access.registerScope({
    id: AGENCY_SCOPE,
    kind: 'agency',
    subjectId: 'agency',
    parentScopeId: null,
    trustDomain: 'agency',
    createdAt: T0
  });
  await access.registerScope({
    id: CLIENT_SCOPE,
    kind: 'client',
    subjectId: 'acme_corp',
    parentScopeId: AGENCY_SCOPE,
    trustDomain: 'agency',
    createdAt: T0
  });
  await access.registerAgent({
    id: AGENT_ID,
    homeScopeId: AGENCY_SCOPE,
    trustDomain: 'agency',
    profileRevision: 1,
    createdAt: T0
  });
  for (const [sleeveId, ownerScopeId] of [
    [CLIENT_SLEEVE, CLIENT_SCOPE],
    [SHARED_SLEEVE, AGENCY_SCOPE],
    [AGENCY_SLEEVE, AGENCY_SCOPE]
  ] as const) {
    await access.registerSleeve({
      id: sleeveId,
      ownerScopeId,
      maxSensitivity: 'confidential',
      expiresAt: null,
      createdAt: T0
    });
  }

  return {
    context,
    ledger: new LedgerRepository(context.sqlite),
    async cleanup() {
      await context.destroy();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  };
}

const BASE_PAYLOAD = {
  form: 'triple',
  subject: 'project:acme',
  predicate: 'launch_date',
  object: '2026-09-30',
  qualifiers: [] as string[]
};

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'fact',
    entityKey: 'launch/date',
    payloadCanonical: BASE_PAYLOAD,
    eventTime: null,
    observedAt: T0,
    validFrom: T0,
    validUntil: null,
    derivationMethod: 'direct_observation',
    confidencePermille: 950,
    sensitivity: 'confidential',
    retentionPolicy: 'until_superseded',
    legalHold: false,
    workflowId: null,
    runId: null,
    sourceEventIds: ['evt_call_7742'],
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
    ownerScopeId: CLIENT_SCOPE,
    sleeveId: CLIENT_SLEEVE,
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

describe('ledger repository', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  /** Drives the acceptance chain and returns the canonical revision id. */
  async function activate(
    memoryId: string,
    prefix: string,
    overrides: Record<string, unknown> = {},
    approval: Record<string, unknown> = {}
  ): Promise<string> {
    const observed = await harness.ledger.submit(
      command(`${prefix}1`, 'OBSERVE', { memoryId, draft: draft(overrides) })
    );
    const proposed = await harness.ledger.submit(
      command(`${prefix}2`, 'PROPOSE', {
        memoryId,
        baseRevisionId: observed.revisions[0]?.revisionId,
        draft: draft(overrides)
      })
    );
    const added = await harness.ledger.submit(
      command(
        `${prefix}3`,
        'ADD',
        { memoryId, baseRevisionId: proposed.revisions[0]?.revisionId, draft: draft(overrides) },
        approval
      )
    );
    const revisionId = added.revisions[0]?.revisionId;
    if (revisionId === undefined) throw new Error('activation produced no revision');
    return revisionId;
  }

  function rows(table: string, sleeveId = CLIENT_SLEEVE): Record<string, unknown>[] {
    return harness.context.sqlite
      .prepare(`SELECT * FROM ${table} WHERE sleeve_id = ? ORDER BY rowid ASC`)
      .all(sleeveId) as Record<string, unknown>[];
  }

  describe('sequencing and durability', () => {
    it('assigns a monotonic per-sleeve sequence and persists the whole footprint', async () => {
      const revisionId = await activate('mem_launch', 'a');

      const commands = rows('memory_ledger_commands');
      expect(commands.map((row) => row.sleeve_seq)).toEqual([1, 2, 3]);
      expect(commands.map((row) => row.op)).toEqual(['OBSERVE', 'PROPOSE', 'ADD']);
      // Only accepted commands emit events, and each carries its command's sequence.
      expect(rows('memory_ledger_events').map((row) => row.sleeve_seq)).toEqual([1, 2, 3]);
      expect(rows('memory_ledger_audit').map((row) => row.outcome)).toEqual([
        'OBSERVED',
        'PROPOSED',
        'APPLIED'
      ]);

      const revisions = rows('memory_revisions');
      expect(revisions).toHaveLength(3);
      // Exactly one current-active revision per thread.
      expect(revisions.filter((row) => row.is_current_active === 1)).toHaveLength(1);
      expect(revisions.find((row) => row.is_current_active === 1)?.revision_id).toBe(revisionId);
      expect(rows('memory_provenance_edges').length).toBeGreaterThan(0);
    });

    it('keeps sleeve partitions independent', async () => {
      await activate('mem_launch', 'a');
      await harness.ledger.submit(
        command(
          'b1',
          'OBSERVE',
          { memoryId: 'mem_other', draft: draft({ sensitivity: 'internal' }) },
          { sleeveId: AGENCY_SLEEVE, ownerScopeId: AGENCY_SCOPE }
        )
      );
      // A second sleeve starts its own sequence at 1; the log is partitioned, not shared.
      expect(rows('memory_ledger_commands', AGENCY_SLEEVE).map((row) => row.sleeve_seq)).toEqual([
        1
      ]);
      expect(rows('memory_ledger_commands').map((row) => row.sleeve_seq)).toEqual([1, 2, 3]);
    });

    it('returns the original outcome for a duplicate idempotency key', async () => {
      const first = await harness.ledger.submit(
        command('a1', 'OBSERVE', { memoryId: 'mem_launch', draft: draft() })
      );
      const second = await harness.ledger.submit(
        command('a1', 'OBSERVE', { memoryId: 'mem_launch', draft: draft() })
      );
      expect(second.duplicate).toBe(true);
      expect(second.audit.fingerprint).toBe(first.audit.fingerprint);
      expect(second.revisions.map((revision) => revision.revisionId)).toEqual(
        first.revisions.map((revision) => revision.revisionId)
      );
      // A duplicate consumes no sequence and writes no second row.
      expect(rows('memory_ledger_commands')).toHaveLength(1);
      expect(rows('memory_revisions')).toHaveLength(1);
    });
  });

  describe('refusals are durable facts', () => {
    it('throws a typed stale-base error after committing the audit row', async () => {
      const revisionId = await activate('mem_launch', 'a');
      await harness.ledger.submit(
        command('b1', 'SUPERSEDE', {
          memoryId: 'mem_launch',
          baseRevisionId: revisionId,
          draft: draft({
            validFrom: T1,
            payloadCanonical: { ...BASE_PAYLOAD, object: '2026-10-15' }
          })
        })
      );

      await expect(
        harness.ledger.submit(
          command('b2', 'SUPERSEDE', {
            memoryId: 'mem_launch',
            baseRevisionId: revisionId,
            draft: draft({ payloadCanonical: { ...BASE_PAYLOAD, object: '2026-11-01' } })
          })
        )
      ).rejects.toBeInstanceOf(LedgerStaleBaseError);

      // The refusal is in the log, not lost: rolling it back would erase the record
      // an operator needs to debug a losing writer.
      const audits = await harness.ledger.auditTrail(CLIENT_SLEEVE);
      expect(audits.map((audit) => audit.outcome)).toContain('STALE_BASE');
      expect(rows('memory_ledger_commands').map((row) => row.sleeve_seq)).toEqual([1, 2, 3, 4, 5]);
      // The idempotency key is burned; a retry must be a NEW command after a re-read.
      expect(rows('memory_ledger_commands').map((row) => row.idempotency_key)).toContain('idk_b2');
    });

    it('throws a typed rejection for a denied command and still audits it', async () => {
      await expect(
        harness.ledger.submit(
          command('z1', 'OBSERVE', {
            memoryId: 'mem_secret',
            draft: draft({ sensitivity: 'restricted' })
          })
        )
      ).rejects.toBeInstanceOf(LedgerCommandRejectedError);

      const audits = await harness.ledger.auditTrail(CLIENT_SLEEVE);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.outcome).toBe('DENIED');
      expect(audits[0]?.reason).toContain('exceeds the sleeve cap');
      expect(rows('memory_revisions')).toHaveLength(0);
    });

    it('refuses a write against a sleeve that is not registered and active', async () => {
      await expect(
        harness.ledger.submit(
          command(
            'z2',
            'OBSERVE',
            { memoryId: 'mem_a', draft: draft() },
            { sleeveId: 'project:ghost', ownerScopeId: 'project:ghost' }
          )
        )
      ).rejects.toThrow(/active registered sleeve/u);
    });
  });

  describe('replay', () => {
    it('rebuilds a projection identical to the stored one', async () => {
      const revisionId = await activate('mem_launch', 'a');
      await harness.ledger.submit(
        command('b1', 'SUPERSEDE', {
          memoryId: 'mem_launch',
          baseRevisionId: revisionId,
          draft: draft({
            validFrom: T1,
            payloadCanonical: { ...BASE_PAYLOAD, object: '2026-10-15' }
          })
        })
      );
      await harness.ledger.submit(command('b2', 'NOOP', { reason: 'evaluated, nothing to do' }));

      const replayed = await harness.ledger.replay(CLIENT_SLEEVE, CLIENT_SCOPE);
      const stored = {
        ...createLedgerState({
          sleeveId: CLIENT_SLEEVE,
          ownerScopeId: CLIENT_SCOPE,
          maxSensitivity: 'confidential' as const
        }),
        nextSleeveSeq: replayed.state.nextSleeveSeq,
        idempotencyKeys: replayed.state.idempotencyKeys,
        revisions: await harness.ledger.revisions(CLIENT_SLEEVE),
        edges: await harness.ledger.provenanceEdges(CLIENT_SLEEVE),
        // Deliberately NOT copied from `replayed`. Copying a field out of the object
        // under comparison makes that field untestable by construction: the
        // assertion below would pass no matter what the stored projection said, and
        // it did — it hid `deletionQueue` never being restored on load.
        deletionQueue: await harness.ledger.pendingDeletions(CLIENT_SLEEVE)
      };
      // The log alone reproduces the projection, hashes included.
      expect(projectionFingerprint(replayed.state)).toBe(projectionFingerprint(stored));
      expect(replayed.audits.map((audit) => audit.outcome)).toEqual([
        'OBSERVED',
        'PROPOSED',
        'APPLIED',
        'APPLIED',
        'NOOP_EXPLICIT'
      ]);
    });

    it('restores the outstanding deletion cascade on load, not just in memory', async () => {
      // A DELETE schedules erasure. If the queue lives only in the in-memory state
      // it is empty again after the next load, and the erasure obligation is lost
      // with nothing failing — the projection still "matches" because both sides
      // forgot the same thing.
      const revisionId = await activate('mem_launch', 'a');
      await harness.ledger.submit(
        command(
          'a4',
          'DELETE',
          {
            memoryId: 'mem_launch',
            baseRevisionId: revisionId,
            ticket: { reason: 'privacy_erasure', ticketId: 'tkt_erasure_001' }
          },
          // Erasure is operator work: the policy table refuses DELETE below this
          // authority tier, and refuses it again unless a human actually approved.
          // ...and the decision must precede issuance, so it cannot be back-dated.
          { authorityTier: 'operator_explicit', approvalState: 'approved', decidedAt: T0 }
        )
      );

      expect(await harness.ledger.pendingDeletions(CLIENT_SLEEVE)).toEqual(['mem_launch']);

      // A brand-new repository over the same file: nothing carried in memory.
      const reopened = new LedgerRepository(harness.context.sqlite);
      expect(await reopened.pendingDeletions(CLIENT_SLEEVE)).toEqual(['mem_launch']);
    });

    it('withholds a contradicted head from default retrieval and offers it explicitly', async () => {
      // While a contradiction is unresolved, serving either side silently picks a
      // winner the ledger never decided. Default retrieval abstains; a caller that
      // wants the flagged head must ask for it and handle the contradiction.
      const revisionId = await activate('mem_launch', 'a');
      // `contradicts` must be set alongside the status: the revision schema refuses
      // a flagged record with no contradiction link, which is itself the invariant
      // that keeps `active_conflicted` a relation rather than a mood.
      harness.context.sqlite
        .prepare(
          `UPDATE memory_revisions
              SET status = 'active_conflicted', contradicts_json = ?
            WHERE revision_id = ?`
        )
        .run(JSON.stringify(['rev_other_side']), revisionId);

      expect(await harness.ledger.currentActiveRevision(CLIENT_SLEEVE, 'mem_launch')).toBeNull();
      const flagged = await harness.ledger.conflictedHeadRevision(CLIENT_SLEEVE, 'mem_launch');
      expect(flagged?.revisionId).toBe(revisionId);
      expect(flagged?.status).toBe('active_conflicted');
    });

    it('audits a payload it cannot represent rather than forgetting the command', async () => {
      // The protocol rule is that every command which can be sequenced leaves an
      // audit record, refusals included — a command that is both refused and
      // forgotten is the one you most need to be able to look up later.
      //
      // Two guards stand between an unrepresentable payload and the projection:
      // the zod payload union rejects it first, and the reducer's canonicalizer
      // THROWS on anything that slips past. This asserts the outcome both share.
      // The reducer's try/catch is defence in depth for the second guard, not the
      // only thing standing here — the union currently catches this shape.
      const deep = (depth: number): Record<string, unknown> =>
        depth === 0 ? { leaf: 'x' } : { nested: deep(depth - 1) };

      await expect(
        harness.ledger.submit(
          command('deep1', 'OBSERVE', {
            memoryId: 'mem_deep',
            draft: draft({ payloadCanonical: deep(64) })
          })
        )
      ).rejects.toBeInstanceOf(LedgerCommandRejectedError);

      const audits = rows('memory_ledger_audit');
      expect(audits.at(-1)?.outcome).toBe('INVALID_COMMAND');
      // Refused before anything was written: no revision for the rejected thread.
      expect(rows('memory_revisions').filter((row) => row.memory_id === 'mem_deep')).toHaveLength(
        0
      );
    });

    it('replays the persisted log to the same projection the pure reducer produces', async () => {
      await activate('mem_launch', 'a');
      const documents = (
        harness.context.sqlite
          .prepare(
            'SELECT payload_json FROM memory_ledger_commands WHERE sleeve_id = ? ORDER BY sleeve_seq ASC'
          )
          .all(CLIENT_SLEEVE) as { payload_json: string }[]
      ).map((row) => JSON.parse(row.payload_json) as unknown);

      const pure = replayCommands(
        createLedgerState({
          sleeveId: CLIENT_SLEEVE,
          ownerScopeId: CLIENT_SCOPE,
          maxSensitivity: 'confidential'
        }),
        documents
      );
      const persisted = await harness.ledger.replay(CLIENT_SLEEVE, CLIENT_SCOPE);
      expect(projectionFingerprint(persisted.state)).toBe(projectionFingerprint(pure.state));
    });
  });

  describe('bitemporal queries', () => {
    it('separates what was true from what was known', async () => {
      const first = await activate('mem_launch', 'a');
      const corrected = await harness.ledger.submit({
        ...command('b1', 'SUPERSEDE', {
          memoryId: 'mem_launch',
          baseRevisionId: first,
          draft: draft({
            validFrom: T1,
            observedAt: T1,
            payloadCanonical: { ...BASE_PAYLOAD, object: '2026-10-15' }
          })
        }),
        issuedAt: T1
      });
      const correctedId = corrected.revisions[0]?.revisionId;

      expect((await harness.ledger.currentRevision(CLIENT_SLEEVE, 'mem_launch'))?.revisionId).toBe(
        correctedId
      );
      expect(
        (await harness.ledger.currentActiveRevision(CLIENT_SLEEVE, 'mem_launch'))?.revisionId
      ).toBe(correctedId);

      // Valid at T0: the correction's interval had not opened yet.
      expect((await harness.ledger.asOf(CLIENT_SLEEVE, 'mem_launch', T0, T2))?.revisionId).toBe(
        first
      );
      // Valid at T1 and known by T2: the correction.
      expect((await harness.ledger.asOf(CLIENT_SLEEVE, 'mem_launch', T1, T2))?.revisionId).toBe(
        correctedId
      );
      // Valid at T1 but only as far as the ledger knew at T0: the original still.
      // Collapsing the axes would answer with a correction the system had not received.
      expect((await harness.ledger.asOf(CLIENT_SLEEVE, 'mem_launch', T1, T0))?.revisionId).toBe(
        first
      );
      expect(await harness.ledger.asOf(CLIENT_SLEEVE, 'mem_ghost', T1, T2)).toBeNull();
    });

    it('stops surfacing a retracted thread as current-active', async () => {
      const revisionId = await activate('mem_launch', 'a');
      await harness.ledger.submit(
        command('b1', 'RETRACT', {
          memoryId: 'mem_launch',
          baseRevisionId: revisionId,
          reasonCode: 'disproven'
        })
      );
      expect(await harness.ledger.currentActiveRevision(CLIENT_SLEEVE, 'mem_launch')).toBeNull();
      // The head is still readable by explicit query; only default retrieval abstains.
      expect((await harness.ledger.currentRevision(CLIENT_SLEEVE, 'mem_launch'))?.status).toBe(
        'retracted'
      );
      expect(rows('memory_revisions').filter((row) => row.is_current_active === 1)).toHaveLength(0);
    });
  });

  describe('cross-sleeve promotion and import', () => {
    async function promoteBundle(): Promise<string> {
      const memberId = await activate(
        'mem_launch',
        'a',
        {},
        {
          approvalState: 'approved',
          decidedAt: T0
        }
      );
      const promoted = await harness.ledger.submit(
        command(
          'p1',
          'PROMOTE',
          {
            memberRevisionIds: [memberId],
            bundle: {
              memoryId: 'mem_bundle_004',
              eventTime: null,
              observedAt: T0,
              validFrom: T0,
              validUntil: null,
              sensitivity: 'confidential',
              retentionPolicy: 'until_superseded_or_revoked',
              legalHold: false,
              confidencePermille: 1_000,
              approvedTargetSleeveIds: [AGENCY_SLEEVE],
              sanitizationNotes: ['removed raw transcript excerpts']
            }
          },
          {
            sleeveId: SHARED_SLEEVE,
            ownerScopeId: AGENCY_SCOPE,
            authorityTier: 'operator_explicit',
            approvalState: 'approved',
            decidedAt: T0
          }
        )
      );
      const bundleRevisionId = promoted.revisions[0]?.revisionId;
      if (bundleRevisionId === undefined) throw new Error('promotion produced no bundle');
      expect(promoted.audit.outcome).toBe('PROMOTED');
      return bundleRevisionId;
    }

    it('publishes a bundle and imports it into an approved target', async () => {
      const bundleRevisionId = await promoteBundle();
      expect(
        rows('memory_provenance_edges', SHARED_SLEEVE).some((row) => row.edge_type === 'bundled_in')
      ).toBe(true);

      const imported = await harness.ledger.submit(
        command(
          'i1',
          'IMPORT',
          {
            bundleRevisionId,
            memoryId: 'mem_import_004',
            eventTime: null,
            observedAt: T0,
            validFrom: T0,
            validUntil: null,
            retentionPolicy: 'until_superseded_or_revoked',
            confidencePermille: 1_000
          },
          {
            sleeveId: AGENCY_SLEEVE,
            ownerScopeId: AGENCY_SCOPE,
            authorityTier: 'policy_signed_approved',
            approvalState: 'approved',
            decidedAt: T0
          }
        )
      );
      expect(imported.audit.outcome).toBe('IMPORTED');
      const projection = await harness.ledger.currentActiveRevision(
        AGENCY_SLEEVE,
        'mem_import_004'
      );
      // The import carries the bundle's label verbatim and names its ancestor.
      expect(projection?.sensitivity).toBe('confidential');
      expect(projection?.evidenceRefs).toEqual([{ type: 'memory_revision', id: bundleRevisionId }]);
    });

    it('denies an import into a sleeve the bundle did not approve', async () => {
      const bundleRevisionId = await promoteBundle();
      await expect(
        harness.ledger.submit(
          command(
            'i2',
            'IMPORT',
            {
              bundleRevisionId,
              memoryId: 'mem_import_004',
              eventTime: null,
              observedAt: T0,
              validFrom: T0,
              validUntil: null,
              retentionPolicy: 'until_superseded_or_revoked',
              confidencePermille: 1_000
            },
            {
              sleeveId: CLIENT_SLEEVE,
              ownerScopeId: CLIENT_SCOPE,
              authorityTier: 'policy_signed_approved',
              approvalState: 'approved',
              decidedAt: T0
            }
          )
        )
      ).rejects.toBeInstanceOf(LedgerCommandRejectedError);

      const audits = await harness.ledger.auditTrail(CLIENT_SLEEVE);
      expect(audits[audits.length - 1]?.reason).toContain('does not approve target sleeve');
    });

    it('denies a promotion that would declassify its members', async () => {
      const memberId = await activate(
        'mem_launch',
        'a',
        {},
        {
          approvalState: 'approved',
          decidedAt: T0
        }
      );
      await expect(
        harness.ledger.submit(
          command(
            'p2',
            'PROMOTE',
            {
              memberRevisionIds: [memberId],
              bundle: {
                memoryId: 'mem_bundle_005',
                eventTime: null,
                observedAt: T0,
                validFrom: T0,
                validUntil: null,
                // Lower than the member's `confidential`: the ledger cannot verify a
                // payload was scrubbed, so it refuses to relabel it.
                sensitivity: 'public',
                retentionPolicy: 'until_superseded_or_revoked',
                legalHold: false,
                confidencePermille: 1_000,
                approvedTargetSleeveIds: [AGENCY_SLEEVE],
                sanitizationNotes: []
              }
            },
            {
              sleeveId: SHARED_SLEEVE,
              ownerScopeId: AGENCY_SCOPE,
              authorityTier: 'operator_explicit',
              approvalState: 'approved',
              decidedAt: T0
            }
          )
        )
      ).rejects.toThrow(/declassify/u);
    });
  });

  describe('storage guards', () => {
    it('refuses to delete or rewrite anything the ledger has recorded', async () => {
      await activate('mem_launch', 'a');
      const sqlite = harness.context.sqlite;

      expect(() => sqlite.prepare('DELETE FROM memory_revisions').run()).toThrow(
        /cannot be deleted/u
      );
      expect(() => sqlite.prepare('DELETE FROM memory_ledger_commands').run()).toThrow(
        /cannot be deleted/u
      );
      expect(() => sqlite.prepare('DELETE FROM memory_ledger_audit').run()).toThrow(
        /cannot be deleted/u
      );
      expect(() => sqlite.prepare("UPDATE memory_ledger_commands SET op = 'NOOP'").run()).toThrow(
        /append-only/u
      );
      expect(() =>
        sqlite.prepare("UPDATE memory_ledger_audit SET outcome = 'APPLIED'").run()
      ).toThrow(/append-only/u);
    });

    it('refuses a revision edit outside the projection columns', async () => {
      const revisionId = await activate('mem_launch', 'a');
      const sqlite = harness.context.sqlite;
      expect(() =>
        sqlite
          .prepare('UPDATE memory_revisions SET confidence_permille = 1 WHERE revision_id = ?')
          .run(revisionId)
      ).toThrow(/immutable outside its projection columns/u);
      expect(() =>
        sqlite
          .prepare("UPDATE memory_revisions SET status = 'retracted' WHERE revision_id = ?")
          .run(revisionId)
      ).toThrow(/immutable outside its projection columns/u);
      // A closed revision never becomes current again.
      const closed = rows('memory_revisions').find((row) => row.superseded_by !== null);
      expect(() =>
        sqlite
          .prepare('UPDATE memory_revisions SET is_current_active = 1 WHERE revision_id = ?')
          .run(closed?.revision_id)
      ).toThrow(/immutable outside its projection columns/u);
    });

    it('refuses a second current-active revision for one thread', async () => {
      const revisionId = await activate('mem_launch', 'a');
      const sqlite = harness.context.sqlite;
      const closed = rows('memory_revisions').find(
        (row) => row.revision_id !== revisionId && row.superseded_by !== null
      );
      // The unique partial index enforces the invariant independently of the reducer.
      expect(() =>
        sqlite
          .prepare(
            "UPDATE memory_revisions SET is_current_active = 1, status = 'active' WHERE revision_id = ?"
          )
          .run(closed?.revision_id)
      ).toThrow();
    });
  });
});
