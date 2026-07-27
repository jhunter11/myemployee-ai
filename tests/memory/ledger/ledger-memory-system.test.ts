import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTHORITY_LAYERS,
  type AuthorityLayer,
  type GrantVersionSet
} from '../../../src/agents/access-control-contracts';
import { AccessControlRepository } from '../../../src/agents/access-control-repository';
import { createDatabase, type GlobalDatabaseContext } from '../../../src/db/database';
import { FlatLexicalMemorySystem } from '../../../src/memory/system/flat-lexical-system';
import { LedgerMemorySystem } from '../../../src/memory/ledger/ledger-memory-system';
import { projectionFingerprint } from '../../../src/memory/ledger/reducer';

const AGENCY_SCOPE = 'agency:agency';
const OWNER_SCOPE_ID = 'client:acme_corp';
const SLEEVE_ID = 'client:acme_corp';
const AGENT_ID = 'agency-developer';
const RECORDED_AT = '2026-07-19T12:00:00.000Z';
const EVALUATED_AT = '2026-07-21T12:00:00.000Z';

interface Harness {
  context: GlobalDatabaseContext;
  access: AccessControlRepository;
  grantVersions: GrantVersionSet;
  boundAccess: ReturnType<AccessControlRepository['bindAgent']>;
  cleanup(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const projectRoot = join(__dirname, '..', '..', '..');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-ledger-system-'));
  const context = await createDatabase({
    projectRoot,
    filename: join(temporaryRoot, 'jarvis.sqlite')
  });
  const access = new AccessControlRepository(context.db, () => new Date(EVALUATED_AT));

  await access.registerScope({
    id: AGENCY_SCOPE,
    kind: 'agency',
    subjectId: 'agency',
    parentScopeId: null,
    trustDomain: 'agency',
    createdAt: RECORDED_AT
  });
  await access.registerScope({
    id: OWNER_SCOPE_ID,
    kind: 'client',
    subjectId: 'acme_corp',
    parentScopeId: AGENCY_SCOPE,
    trustDomain: 'agency',
    createdAt: RECORDED_AT
  });
  await access.registerAgent({
    id: AGENT_ID,
    homeScopeId: AGENCY_SCOPE,
    trustDomain: 'agency',
    profileRevision: 1,
    createdAt: RECORDED_AT
  });
  await access.registerSleeve({
    id: SLEEVE_ID,
    ownerScopeId: OWNER_SCOPE_ID,
    maxSensitivity: 'confidential',
    expiresAt: null,
    createdAt: RECORDED_AT
  });

  const versions = {} as Record<AuthorityLayer, number>;
  for (const layer of AUTHORITY_LAYERS) {
    const grant = await access.issueSleeveGrant({
      id: `sleeve-grant:${AGENT_ID}-acme-read-${layer}`,
      agentId: AGENT_ID,
      sleeveId: SLEEVE_ID,
      authorityLayer: layer,
      permission: 'read',
      purpose: 'memory_system_test',
      sensitivityCap: 'confidential',
      expiresAt: '2026-08-21T12:00:00.000Z',
      expectedAgentVersion: 1,
      expectedScopeVersion: 1,
      expectedSleeveVersion: 1,
      issuedAt: RECORDED_AT
    });
    versions[layer] = grant.version;
  }

  return {
    context,
    access,
    grantVersions: versions,
    boundAccess: access.bindAgent({ agentId: AGENT_ID, expectedAgentVersion: 1 }),
    async cleanup() {
      await context.destroy();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  };
}

function retrievalAuthorization(grantVersions: GrantVersionSet) {
  return {
    sleeveId: SLEEVE_ID,
    expectedSleeveVersion: 1,
    expectedOwnerScopeVersion: 1,
    permission: 'read' as const,
    purpose: 'memory_system_test',
    sensitivity: 'confidential' as const,
    grantVersions
  };
}

function fragmentInput(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ownerScopeId: OWNER_SCOPE_ID,
    sleeveId: SLEEVE_ID,
    sourceId: `note:${id}`,
    sourceHash: createHash('sha256').update(id, 'utf8').digest('hex'),
    extractionVersion: 'markdown_v1',
    kind: 'fact',
    title: `Memory ${id}`,
    content: 'Quarterly close uses the cobalt reconciliation checklist.',
    tags: ['finance', 'close'],
    validFrom: RECORDED_AT,
    validUntil: null,
    recordedAt: RECORDED_AT,
    confidencePermille: 900,
    sensitivity: 'confidential',
    supersedesFragmentId: null,
    reviewAt: null,
    expiresAt: null,
    retrievalEligible: true,
    ...overrides
  };
}

describe('ledger memory system (backend D)', () => {
  let harness: Harness;
  let system: LedgerMemorySystem;

  beforeEach(async () => {
    harness = await createHarness();
    system = new LedgerMemorySystem({
      sqlite: harness.context.sqlite,
      access: harness.boundAccess,
      authorAgentId: AGENT_ID
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('declares its capabilities honestly', () => {
    expect(system.id).toBe('ledger');
    expect(system.capabilities).toMatchObject({
      workingMemory: false,
      consolidation: false,
      proceduralPromotion: false
    });
    // Three durable store classes; there is no run-local working store here.
    expect(system.capabilities.storeClasses).toEqual(['episodic', 'semantic', 'procedural']);
    expect(system.workingMemory()).toBeNull();
    expect(system.consolidation()).toBeNull();
    expect(system.procedures()).toBeNull();
  });

  it('stays behaviorally interchangeable with the flat backend on the core path', async () => {
    const flat = new FlatLexicalMemorySystem({
      sqlite: harness.context.sqlite,
      access: harness.boundAccess
    });

    const record = await system.write(fragmentInput('acme_close'));
    expect(record.id).toBe('acme_close');
    expect(record.supersededByFragmentId).toBeNull();

    const query = {
      authorization: retrievalAuthorization(harness.grantVersions),
      text: 'cobalt close',
      limit: 10
    };
    const viaLedger = await system.retrieve(query);
    const viaFlat = await flat.retrieve(query);
    // The retrieval substrate is shared, so the two backends must agree exactly.
    expect(viaLedger.items.map((item) => item.id)).toEqual(['acme_close']);
    expect(viaLedger.manifest.fingerprint).toBe(viaFlat.manifest.fingerprint);
  });

  describe('the ledger is the system of record', () => {
    it('drives every write through the OBSERVE -> PROPOSE -> ADD protocol', async () => {
      await system.write(fragmentInput('acme_close'));

      const audits = await system.ledger().auditTrail(SLEEVE_ID);
      expect(audits.map((audit) => audit.op)).toEqual(['OBSERVE', 'PROPOSE', 'ADD']);
      expect(audits.map((audit) => audit.outcome)).toEqual(['OBSERVED', 'PROPOSED', 'APPLIED']);
      expect(audits.map((audit) => audit.sleeveSeq)).toEqual([1, 2, 3]);

      const memoryId = LedgerMemorySystem.memoryIdForFragment(SLEEVE_ID, 'acme_close');
      const current = await system.ledger().currentActiveRevision(SLEEVE_ID, memoryId);
      expect(current?.status).toBe('active');
      expect(current?.revisionNo).toBe(3);
      expect(current?.authorAgentId).toBe(AGENT_ID);
      // A programmatic write is a tool observation and claims nothing more.
      expect(current?.authorityTier).toBe('tool_observation');
      expect(current?.kind).toBe('fact');
    });

    it('anchors the revision to the fragment by reference and digest, not by copy', async () => {
      const fragment = fragmentInput('acme_close');
      await system.write(fragment);
      const memoryId = LedgerMemorySystem.memoryIdForFragment(SLEEVE_ID, 'acme_close');
      const current = await system.ledger().currentActiveRevision(SLEEVE_ID, memoryId);

      expect(current?.payloadCanonical.form).toBe('structured');
      const fields =
        current?.payloadCanonical.form === 'structured' ? current.payloadCanonical.fields : {};
      expect(fields.fragment_id).toBe('acme_close');
      expect(fields.source_id).toBe('note:acme_close');
      expect(fields.content_sha256).toBe(
        createHash('sha256').update(fragment.content, 'utf8').digest('hex')
      );
      // The body itself stays in the retrieval substrate: the canonical form caps a
      // string well below a fragment's 64KB ceiling, and keeping the text out of
      // immutable history is what makes erasure tractable.
      expect(JSON.stringify(fields)).not.toContain('cobalt reconciliation');
      expect(current?.evidenceRefs).toEqual([{ type: 'artifact', id: 'acme_close' }]);
    });

    it('writes no fragment when the ledger refuses the command', async () => {
      await expect(
        // Above the sleeve's `confidential` cap; the ledger denies before anything lands.
        system.write(fragmentInput('acme_secret', { sensitivity: 'restricted' }))
      ).rejects.toThrow();

      const fragments = harness.context.sqlite
        .prepare('SELECT fragment_id FROM memory_fragments')
        .all() as { fragment_id: string }[];
      expect(fragments).toHaveLength(0);
      const audits = await system.ledger().auditTrail(SLEEVE_ID);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.outcome).toBe('DENIED');
    });

    it('reads an unambiguous author out of the access tables rather than guessing', async () => {
      const unbound = new LedgerMemorySystem({
        sqlite: harness.context.sqlite,
        access: harness.boundAccess
      });
      await unbound.write(fragmentInput('acme_close'));
      const memoryId = LedgerMemorySystem.memoryIdForFragment(SLEEVE_ID, 'acme_close');
      // One authorized agent on the sleeve is a FACT about the grant table, not an
      // inference, so the write is attributable and proceeds.
      expect(
        (await unbound.ledger().currentActiveRevision(SLEEVE_ID, memoryId))?.authorAgentId
      ).toBe(AGENT_ID);
    });

    it('refuses to attribute a write once the author is ambiguous', async () => {
      await harness.access.registerAgent({
        id: 'agency-analyst',
        homeScopeId: AGENCY_SCOPE,
        trustDomain: 'agency',
        profileRevision: 1,
        createdAt: RECORDED_AT
      });
      await harness.access.issueSleeveGrant({
        id: 'sleeve-grant:agency-analyst-acme-read-operator',
        agentId: 'agency-analyst',
        sleeveId: SLEEVE_ID,
        authorityLayer: 'operator',
        permission: 'read',
        purpose: 'memory_system_test',
        sensitivityCap: 'confidential',
        expiresAt: '2026-08-21T12:00:00.000Z',
        expectedAgentVersion: 1,
        expectedScopeVersion: 1,
        expectedSleeveVersion: 1,
        issuedAt: RECORDED_AT
      });

      const unbound = new LedgerMemorySystem({
        sqlite: harness.context.sqlite,
        access: harness.boundAccess
      });
      // Two candidates and no tiebreak: provenance that might be wrong is worse
      // than a write that did not happen.
      await expect(unbound.write(fragmentInput('acme_close'))).rejects.toThrow(/authorAgentId/u);
      expect(await unbound.ledger().auditTrail(SLEEVE_ID)).toHaveLength(0);
      expect(
        harness.context.sqlite.prepare('SELECT fragment_id FROM memory_fragments').all()
      ).toHaveLength(0);

      // An explicit binding resolves the ambiguity without weakening the rule.
      const bound = new LedgerMemorySystem({
        sqlite: harness.context.sqlite,
        access: harness.boundAccess,
        authorAgentId: 'agency-analyst'
      });
      const memoryId = LedgerMemorySystem.memoryIdForFragment(SLEEVE_ID, 'acme_close');
      await bound.write(fragmentInput('acme_close'));
      expect((await bound.ledger().currentActiveRevision(SLEEVE_ID, memoryId))?.authorAgentId).toBe(
        'agency-analyst'
      );
    });
  });

  describe('determinism through the seam', () => {
    it('is idempotent: writing the same fragment twice changes nothing', async () => {
      const first = await system.write(fragmentInput('acme_close'));
      const beforeReplay = await system.ledger().replay(SLEEVE_ID, OWNER_SCOPE_ID);

      const second = await system.write(fragmentInput('acme_close'));
      expect(second).toEqual(first);

      const afterReplay = await system.ledger().replay(SLEEVE_ID, OWNER_SCOPE_ID);
      // Duplicate delivery through the seam is indistinguishable from exactly-once.
      expect(projectionFingerprint(afterReplay.state)).toBe(
        projectionFingerprint(beforeReplay.state)
      );
      expect((await system.ledger().auditTrail(SLEEVE_ID)).length).toBe(3);
    });

    it('rebuilds the stored projection from the log alone', async () => {
      await system.write(fragmentInput('acme_close'));
      await system.write(fragmentInput('acme_invoices'));

      const replayed = await system.ledger().replay(SLEEVE_ID, OWNER_SCOPE_ID);
      const stored = await system.ledger().revisions(SLEEVE_ID);
      expect(replayed.state.revisions.map((revision) => revision.revisionId)).toEqual(
        stored.map((revision) => revision.revisionId)
      );
      expect(replayed.state.revisions.map((revision) => revision.canonicalHash)).toEqual(
        stored.map((revision) => revision.canonicalHash)
      );
    });

    it('keeps two fragments on independent threads', async () => {
      await system.write(fragmentInput('acme_close'));
      await system.write(fragmentInput('acme_invoices'));
      const closeThread = LedgerMemorySystem.memoryIdForFragment(SLEEVE_ID, 'acme_close');
      const invoiceThread = LedgerMemorySystem.memoryIdForFragment(SLEEVE_ID, 'acme_invoices');
      expect(closeThread).not.toBe(invoiceThread);
      // Thread identity is scoped by sleeve: the same fragment id elsewhere is a
      // different thread, so a shared id can never join two sleeves by accident.
      expect(LedgerMemorySystem.memoryIdForFragment('agency:agency', 'acme_close')).not.toBe(
        closeThread
      );
      expect(
        (await system.ledger().currentActiveRevision(SLEEVE_ID, invoiceThread))?.revisionNo
      ).toBe(3);
    });
  });
});
