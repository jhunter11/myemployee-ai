import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FlatLexicalMemorySystem } from '../../../src/memory/system/flat-lexical-system';
import { TemporalHybridMemorySystem } from '../../../src/memory/system/temporal-hybrid-system';
import { TypedHybridMemorySystem } from '../../../src/memory/system/typed-hybrid-system';
import { workflowSignatureForSteps } from '../../../src/memory/system/hashing';
import {
  AGENT_ID,
  createMemorySystemHarness,
  EVALUATED_AT,
  fragmentInput,
  OWNER_SCOPE_ID,
  retrievalAuthorization,
  SLEEVE_ID,
  type MemorySystemHarness
} from './memory-system-harness';

const JANUARY = '2026-01-01T00:00:00.000Z';
const MARCH = '2026-03-01T00:00:00.000Z';
const JUNE = '2026-06-01T00:00:00.000Z';
const EARLY_JULY = '2026-07-01T00:00:00.000Z';

describe('temporal-hybrid memory system (backend C)', () => {
  let harness: MemorySystemHarness;
  let temporal: TemporalHybridMemorySystem;
  let typed: TypedHybridMemorySystem;
  let flat: FlatLexicalMemorySystem;

  beforeEach(async () => {
    harness = await createMemorySystemHarness();
    const options = { sqlite: harness.context.sqlite, access: harness.boundAccess };
    temporal = new TemporalHybridMemorySystem(options);
    typed = new TypedHybridMemorySystem(options);
    flat = new FlatLexicalMemorySystem(options);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  function query(text: string, overrides: Record<string, unknown> = {}) {
    return {
      authorization: retrievalAuthorization(harness.grantVersions),
      text,
      limit: 10,
      ...overrides
    };
  }

  /**
   * Two revisions of the same semantic fact, written independently: no supersession
   * link, no closed validity window, both retrieval-eligible. This is the shape the
   * audited SQL cannot filter, and the shape A-TMA calls ghost memory.
   */
  async function writeUnlinkedRevisions(): Promise<void> {
    await temporal.write(
      fragmentInput('billing_v1', {
        kind: 'fact',
        title: 'Acme billing contact',
        content: 'Billing questions route to Dana Reyes.',
        tags: ['billing'],
        validFrom: JUNE,
        recordedAt: JUNE
      })
    );
    await temporal.write(
      fragmentInput('billing_v2', {
        kind: 'fact',
        title: 'Acme billing contact',
        content: 'Billing questions route to Priya Shah.',
        tags: ['billing'],
        validFrom: EARLY_JULY,
        recordedAt: EARLY_JULY
      })
    );
  }

  it('keeps every typed-hybrid capability', async () => {
    expect(temporal.id).toBe('typed_temporal');
    expect(temporal.capabilities).toMatchObject({
      workingMemory: true,
      consolidation: true,
      proceduralPromotion: true
    });

    const working = temporal.workingMemory();
    await working.record({
      id: 'wm-1',
      ownerScopeId: OWNER_SCOPE_ID,
      sleeveId: SLEEVE_ID,
      runId: 'run-1',
      slotKey: 'active_goal',
      content: 'reconcile the close',
      sensitivity: 'confidential',
      recordedAt: EVALUATED_AT,
      expiresAt: '2026-07-22T00:00:00.000Z',
      supersedesEntryId: null
    });
    const live = await working.read({
      ownerScopeId: OWNER_SCOPE_ID,
      sleeveId: SLEEVE_ID,
      runId: 'run-1',
      slotKey: null,
      evaluatedAt: EVALUATED_AT,
      limit: 10
    });
    expect(live.map((entry) => entry.id)).toEqual(['wm-1']);

    const consolidation = temporal.consolidation();
    await consolidation.propose({
      id: 'memcons-1',
      ownerScopeId: OWNER_SCOPE_ID,
      sleeveId: SLEEVE_ID,
      targetStore: 'semantic',
      proposedKind: 'summary',
      title: 'Summary: close',
      content: 'Recurring close topic',
      sourceFragmentIds: ['frag-a', 'frag-b'],
      evidenceCount: 2,
      temporalState: 'current',
      confidencePermille: 600,
      rationale: 'Recurred twice.',
      plannerVersion: 'planner-1',
      proposedBy: AGENT_ID,
      sensitivity: 'confidential',
      recordedAt: EVALUATED_AT,
      expiresAt: '2026-08-21T12:00:00.000Z',
      supersedesCandidateId: null
    });
    expect(
      (
        await consolidation.listOpen({
          ownerScopeId: OWNER_SCOPE_ID,
          sleeveId: SLEEVE_ID,
          targetStore: null,
          evaluatedAt: EVALUATED_AT,
          limit: 10
        })
      ).map((candidate) => candidate.id)
    ).toEqual(['memcons-1']);

    const procedures = temporal.procedures();
    const steps = ['open ledger', 'reconcile balances', 'sign off'];
    await procedures.propose({
      id: 'memproc-1',
      ownerScopeId: OWNER_SCOPE_ID,
      sleeveId: SLEEVE_ID,
      workflowSignature: workflowSignatureForSteps(steps),
      title: 'Monthly close',
      steps,
      successCount: 4,
      firstSeenAt: JUNE,
      lastSeenAt: EVALUATED_AT,
      rationale: 'Succeeded 4 times.',
      plannerVersion: 'planner-1',
      proposedBy: AGENT_ID,
      sensitivity: 'internal',
      recordedAt: EVALUATED_AT,
      expiresAt: '2026-08-21T12:00:00.000Z',
      supersedesCandidateId: null
    });
    expect(
      (
        await procedures.listOpen({
          ownerScopeId: OWNER_SCOPE_ID,
          sleeveId: SLEEVE_ID,
          evaluatedAt: EVALUATED_AT,
          limit: 10
        })
      ).map((candidate) => candidate.id)
    ).toEqual(['memproc-1']);
  });

  describe('the experiment: an unlinked stale revision beside its replacement', () => {
    it('is returned as current by flat and typed_hybrid', async () => {
      await writeUnlinkedRevisions();
      const flatResult = await flat.retrieve(query('acme billing contact'));
      const typedResult = await typed.retrieve(query('acme billing contact'));
      expect([...flatResult.items.map((item) => item.id)].sort()).toEqual([
        'billing_v1',
        'billing_v2'
      ]);
      expect([...typedResult.items.map((item) => item.id)].sort()).toEqual([
        'billing_v1',
        'billing_v2'
      ]);
      expect(typedResult.manifest.omitted.filter((entry) => entry.reason === 'superseded')).toEqual(
        []
      );
    });

    it('is suppressed by typed_temporal and reported, never silently dropped', async () => {
      await writeUnlinkedRevisions();
      const outcome = await temporal.retrieveTemporal(query('acme billing contact'));

      expect(outcome.result.items.map((item) => item.id)).toEqual(['billing_v2']);
      expect(outcome.result.manifest.omitted).toContainEqual(
        expect.objectContaining({ fragmentId: 'billing_v1', reason: 'superseded' })
      );
      expect(outcome.temporal.ghostPairs).toEqual([
        expect.objectContaining({
          currentFragmentId: 'billing_v2',
          ghostFragmentId: 'billing_v1',
          detectedBy: 'entity_revision'
        })
      ]);
      const ghost = outcome.temporal.decisions.find((entry) => entry.fragmentId === 'billing_v1');
      expect(ghost?.state).toBe('historical');
      expect(ghost?.suppressionReason).toBe('ghost_revision');
    });

    it('never suppresses the surviving current revision', async () => {
      await writeUnlinkedRevisions();
      const outcome = await temporal.retrieveTemporal(query('acme billing contact'));
      const survivor = outcome.temporal.decisions.find(
        (entry) => entry.fragmentId === 'billing_v2'
      );
      expect(survivor?.retained).toBe(true);
      expect(survivor?.state).toBe('current');
      expect(
        outcome.result.manifest.omitted.some((entry) => entry.fragmentId === 'billing_v2')
      ).toBe(false);
    });
  });

  it('leaves a lone valid current fact completely untouched', async () => {
    await temporal.write(
      fragmentInput('solo_fact', {
        kind: 'fact',
        title: 'Acme billing contact',
        content: 'Billing questions route to Dana Reyes.'
      })
    );
    const outcome = await temporal.retrieveTemporal(query('acme billing contact'));
    expect(outcome.result.items.map((item) => item.id)).toEqual(['solo_fact']);
    expect(outcome.result.manifest.omitted).toEqual([]);
    expect(outcome.temporal.decisions[0]?.retained).toBe(true);
  });

  it('never collapses episodic evidence that shares a title', async () => {
    for (const [id, day] of [
      ['sync_a', JUNE],
      ['sync_b', EARLY_JULY]
    ] as const) {
      await temporal.write(
        fragmentInput(id, {
          kind: 'episode',
          title: 'Acme weekly sync',
          content: `Weekly sync notes recorded on ${day}.`,
          validFrom: day,
          recordedAt: day
        })
      );
    }
    const outcome = await temporal.retrieveTemporal(query('acme weekly sync'));
    expect([...outcome.result.items.map((item) => item.id)].sort()).toEqual(['sync_a', 'sync_b']);
    expect(outcome.temporal.ghostPairs).toEqual([]);
  });

  describe('as-of reconstruction', () => {
    async function writeLinkedRevisions(): Promise<void> {
      await temporal.write(
        fragmentInput('escalation_v1', {
          kind: 'fact',
          title: 'Acme escalation contact',
          content: 'Escalations route to Dana Reyes.',
          validFrom: JANUARY,
          validUntil: JUNE,
          recordedAt: JANUARY
        })
      );
      await temporal.write(
        fragmentInput('escalation_v2', {
          kind: 'fact',
          title: 'Acme escalation contact',
          content: 'Escalations route to Priya Shah.',
          validFrom: JUNE,
          recordedAt: JUNE,
          supersedesFragmentId: 'escalation_v1'
        })
      );
    }

    it('answers "now" with the successor', async () => {
      await writeLinkedRevisions();
      const outcome = await temporal.retrieveTemporal(query('acme escalation contact'));
      expect(outcome.result.items.map((item) => item.id)).toEqual(['escalation_v2']);
      expect(outcome.result.manifest.omitted).toContainEqual(
        expect.objectContaining({ fragmentId: 'escalation_v1', reason: 'superseded' })
      );
    });

    it('answers "as of March" with the revision March actually had', async () => {
      await writeLinkedRevisions();
      const outcome = await temporal.retrieveTemporal(
        query('acme escalation contact', { asOf: MARCH })
      );
      expect(outcome.result.items.map((item) => item.id)).toEqual(['escalation_v1']);
      expect(outcome.result.items[0]?.content).toContain('Dana Reyes');
      expect(outcome.result.manifest.omitted).toContainEqual(
        expect.objectContaining({ fragmentId: 'escalation_v2', reason: 'not_yet_valid' })
      );
      expect(outcome.temporal.mode).toBe('as_of');
      expect(outcome.temporal.queryTime).toBe(MARCH);
    });

    it('reports the authorization instant in the manifest, not the as-of instant', async () => {
      await writeLinkedRevisions();
      const outcome = await temporal.retrieveTemporal(
        query('acme escalation contact', { asOf: MARCH })
      );
      expect(outcome.result.manifest.evaluatedAt).toBe(EVALUATED_AT);
    });

    it('refuses to reconstruct an operator-withdrawn fragment', async () => {
      await temporal.write(
        fragmentInput('withdrawn_note', {
          kind: 'fact',
          title: 'Acme escalation contact',
          content: 'Escalations route to a retracted owner.',
          validFrom: JANUARY,
          recordedAt: JANUARY,
          retrievalEligible: false
        })
      );
      const outcome = await temporal.retrieveTemporal(
        query('acme escalation contact', { asOf: MARCH })
      );
      expect(outcome.result.items).toEqual([]);
      expect(outcome.result.manifest.omitted).toContainEqual(
        expect.objectContaining({ fragmentId: 'withdrawn_note', reason: 'retrieval_disabled' })
      );
    });
  });

  describe('per-store reweighting', () => {
    /**
     * Byte-identical title/content/tags filed under two different kinds. BM25 scores
     * them identically, so the flat path falls through to its `recorded_at DESC`
     * tie-break; only the per-store weight vectors can separate them.
     */
    async function writeIdenticalTextInTwoStores(): Promise<void> {
      const shared = {
        title: 'Cobalt notes',
        content: 'The cobalt reconciliation checklist ran clean.',
        tags: ['finance']
      };
      await temporal.write(
        fragmentInput('doc_semantic', {
          ...shared,
          kind: 'fact',
          validFrom: JUNE,
          recordedAt: JUNE
        })
      );
      await temporal.write(
        fragmentInput('doc_episodic', {
          ...shared,
          kind: 'episode',
          validFrom: EARLY_JULY,
          recordedAt: EARLY_JULY
        })
      );
    }

    it('reorders what the flat path ranked by recency alone', async () => {
      await writeIdenticalTextInTwoStores();
      const text = 'cobalt reconciliation checklist';
      const flatResult = await flat.retrieve(query(text));
      const typedResult = await typed.retrieve(query(text));
      const outcome = await temporal.retrieveTemporal(query(text));

      // Flat: identical BM25, so the newer record wins the `recorded_at DESC` tie-break.
      // This must be asserted against the FLAT backend. Asserting it against
      // typed_hybrid only worked while typed_hybrid had no re-rank of its own, and
      // that identity was the very confound the typed arm exists to remove.
      expect(flatResult.items.map((item) => item.id)).toEqual(['doc_episodic', 'doc_semantic']);
      // Per-store: semantic 8*1 + 1*3 = 11 beats episodic 4*1 + 2*3 = 10.
      expect(outcome.result.items.map((item) => item.id)).toEqual(['doc_semantic', 'doc_episodic']);
      expect(outcome.ranking.ranked.map((entry) => entry.storeScore)).toEqual([11, 10]);
      // typed_hybrid owns the re-rank; typed_temporal only adds validity reasoning.
      // Agreeing here is what keeps TypedBasic->TypedTemporal a single-axis contrast.
      expect(typedResult.items.map((item) => item.id)).toEqual(
        outcome.result.items.map((item) => item.id)
      );
    });

    it('applies each store class its own declared weight vector', async () => {
      await writeIdenticalTextInTwoStores();
      const outcome = await temporal.retrieveTemporal(query('cobalt reconciliation checklist'));
      const weights = new Map(
        outcome.ranking.ranked.map((entry) => [entry.fragmentId, entry.weights])
      );
      expect(weights.get('doc_semantic')).toEqual([8, 1, 2]);
      expect(weights.get('doc_episodic')).toEqual([4, 2, 2]);
    });
  });

  describe('manifest discipline and determinism', () => {
    it('accounts for every candidate exactly once across selected and omitted', async () => {
      await writeUnlinkedRevisions();
      await temporal.write(
        fragmentInput('billing_retired', {
          kind: 'fact',
          title: 'Acme billing escalation',
          content: 'Billing escalations routed to a retired queue.',
          validFrom: JANUARY,
          validUntil: JUNE,
          recordedAt: JANUARY
        })
      );
      const outcome = await temporal.retrieveTemporal(query('acme billing contact'));
      const selected = outcome.result.manifest.selected.map((entry) => entry.fragmentId);
      const omitted = outcome.result.manifest.omitted.map((entry) => entry.fragmentId);
      expect(selected).toEqual(outcome.result.items.map((item) => item.id));
      expect(outcome.result.items.map((item) => item.rank)).toEqual([1]);
      expect(new Set([...selected, ...omitted]).size).toBe(selected.length + omitted.length);
      for (const decision of outcome.temporal.decisions) {
        if (decision.retained) continue;
        expect(omitted).toContain(decision.fragmentId);
      }
    });

    it('honours the caller limit after suppression without backfilling', async () => {
      await writeUnlinkedRevisions();
      const outcome = await temporal.retrieveTemporal(query('acme billing contact', { limit: 1 }));
      // billing_v2 fills the single slot; billing_v1 is the ghost. Nothing is pulled
      // in to replace it — suppression only ever removes.
      expect(outcome.result.items.map((item) => item.id)).toEqual(['billing_v2']);
    });

    it('fingerprints two identical retrievals identically', async () => {
      await writeUnlinkedRevisions();
      const first = await temporal.retrieveTemporal(query('acme billing contact'));
      const second = await temporal.retrieveTemporal(query('acme billing contact'));
      expect(second.result.manifest.fingerprint).toBe(first.result.manifest.fingerprint);
      expect(second.temporal.fingerprint).toBe(first.temporal.fingerprint);
      expect(second.ranking.fingerprint).toBe(first.ranking.fingerprint);
    });

    it('produces a different manifest fingerprint than the unsuppressed backend', async () => {
      await writeUnlinkedRevisions();
      const typedResult = await typed.retrieve(query('acme billing contact'));
      const outcome = await temporal.retrieveTemporal(query('acme billing contact'));
      expect(outcome.result.manifest.fingerprint).not.toBe(typedResult.manifest.fingerprint);
      expect(outcome.result.manifest.queryHash).toBe(typedResult.manifest.queryHash);
    });

    it('stays a drop-in on the MemorySystem seam when no asOf is supplied', async () => {
      await writeUnlinkedRevisions();
      const result = await temporal.retrieve(query('acme billing contact'));
      expect(result.items.map((item) => item.id)).toEqual(['billing_v2']);
      expect(result.ownerScopeId).toBe(OWNER_SCOPE_ID);
      expect(result.sleeveId).toBe(SLEEVE_ID);
    });
  });
});
