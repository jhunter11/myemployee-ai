import type SQLite from 'better-sqlite3';
import { z } from 'zod';

import type { AuthorizedMemoryRetrieval } from '../../agents/access-control-contracts';
import type { BoundAgentAccess } from '../../agents/access-control-repository';
import {
  compileScopedContext,
  type ScopedContextCompilation
} from '../../knowledge/context-compiler';
import { ScopedLexicalRetrievalService } from '../../knowledge/lexical-retrieval-service';
import { MemoryFragmentRepository } from '../../knowledge/memory-fragment-repository';
import {
  LexicalRetrievalQuerySchema,
  MemoryFragmentRecordSchema,
  type LexicalRetrievalItem,
  type LexicalRetrievalResult,
  type MemoryFragmentRecord,
  type RetrievalManifestOmitted,
  type RetrievalOmissionReason
} from '../../knowledge/retrieval-contracts';
import { ConsolidationCandidateRepository } from './consolidation-candidate-repository';
import type {
  ConsolidationProposalStore,
  MemorySystem,
  MemorySystemCapabilities,
  ProceduralPromotionStore,
  WorkingMemoryStore
} from './contracts';
import { ProcedureCandidateRepository } from './procedure-candidate-repository';
import { sha256 } from './hashing';
import { ALL_STORE_CLASSES } from './store-classes';
import { rerankByStorePolicy, type StoreRerankResult } from './store-retrieval-policy';
import {
  planTemporalRetrieval,
  TEMPORAL_OMISSION_REASONS,
  type TemporalRetrievalMode,
  type TemporalRetrievalPlan
} from './temporal-retrieval';
import { WorkingMemoryRepository } from './working-memory-repository';

export interface TemporalHybridMemorySystemOptions {
  sqlite: SQLite.Database;
  access: BoundAgentAccess;
}

/**
 * The audited query, plus one optional field. `asOf` absent is byte-for-byte the
 * base contract, so this backend stays a drop-in for every existing caller; `asOf`
 * present switches retrieval into bitemporal reconstruction mode.
 */
export const TemporalRetrievalQuerySchema = LexicalRetrievalQuerySchema.safeExtend({
  asOf: z.iso.datetime().nullable().optional()
});

export type TemporalRetrievalQuery = z.infer<typeof TemporalRetrievalQuerySchema>;

export interface TemporalRetrievalOutcome {
  /** The audited retrieval result, with the temporal decisions already applied. */
  readonly result: LexicalRetrievalResult;
  /** How the per-store weights reordered the candidate set. */
  readonly ranking: StoreRerankResult;
  /** Which candidates were withheld, why, and which revision pairs were collapsed. */
  readonly temporal: TemporalRetrievalPlan;
}

/**
 * Withheld items an `as_of` query is allowed to reconstruct from.
 *
 * `validity_ended` / `not_yet_valid` / `superseded` are pure *time* verdicts — the
 * whole point of an as-of query is to re-judge them against a different instant.
 * `retrieval_disabled` and `expired` are NOT here: the first is an operator kill
 * switch and the second is a retention deadline past which the record is due for
 * deletion. Neither is a statement about time-of-truth, so neither may be resurrected
 * by asking about the past. `result_limit` is excluded because those items are valid
 * now and were cut by the caller's own budget — pulling them back would widen the
 * result window rather than reinterpret it.
 */
const AS_OF_REHYDRATABLE_REASONS: ReadonlySet<RetrievalOmissionReason> = new Set([
  'validity_ended',
  'not_yet_valid',
  'superseded'
]);

const SENSITIVITY_RANK: Readonly<Record<AuthorizedMemoryRetrieval['sensitivity'], number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  private: 3,
  restricted: 4
};

interface MemoryFragmentRow {
  fragment_id: string;
  owner_scope_id: string;
  sleeve_id: string;
  source_id: string;
  source_hash: string;
  extraction_version: string;
  memory_kind: string;
  title: string;
  content: string;
  tags_json: string;
  valid_from: string;
  valid_until: string | null;
  recorded_at: string;
  confidence_permille: number;
  sensitivity: string;
  supersedes_fragment_id: string | null;
  superseded_by_fragment_id: string | null;
  review_at: string | null;
  expires_at: string | null;
  retrieval_eligible: number;
}

function toRecord(row: MemoryFragmentRow): MemoryFragmentRecord {
  return MemoryFragmentRecordSchema.parse({
    id: row.fragment_id,
    ownerScopeId: row.owner_scope_id,
    sleeveId: row.sleeve_id,
    sourceId: row.source_id,
    sourceHash: row.source_hash,
    extractionVersion: row.extraction_version,
    kind: row.memory_kind,
    title: row.title,
    content: row.content,
    tags: JSON.parse(row.tags_json) as unknown,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    recordedAt: row.recorded_at,
    confidencePermille: row.confidence_permille,
    sensitivity: row.sensitivity,
    supersedesFragmentId: row.supersedes_fragment_id,
    supersededByFragmentId: row.superseded_by_fragment_id,
    reviewAt: row.review_at,
    expiresAt: row.expires_at,
    retrievalEligible: row.retrieval_eligible === 1
  });
}

/**
 * Backend C — typed-hybrid plus explicit temporal-state reasoning.
 *
 * It keeps every typed-hybrid capability unchanged (working memory, propose-only
 * consolidation, propose-only procedural promotion, the same durable substrate) and
 * layers two deterministic passes onto `retrieve()`:
 *
 *   1. {@link rerankByStorePolicy} — finally honours the per-store `ftsWeights` that
 *      `store-classes.ts` has been declaring all along. This closes the one gap the
 *      typed-hybrid spec admits to: the weights were policy without an implementation.
 *   2. {@link planTemporalRetrieval} — Report 3's "second step should be
 *      temporalization, not graphification": validity windows, supersession, and
 *      explicit current/historical/transitional labels, including the A-TMA
 *      ghost-memory defense where an older revision of a live entity would otherwise
 *      be handed to the model as current.
 *
 * INVARIANTS THIS BACKEND MUST NOT BREAK
 *   * Suppression only ever REMOVES. Neither pass can introduce a fragment the
 *     audited path did not already authorize and return, so scope, sleeve, and
 *     sensitivity are exactly as tight as the flat backend's.
 *   * Every withheld item appears in `manifest.omitted` with a reason. Nothing is
 *     silently dropped; the richer temporal reason travels in `temporal.decisions`.
 *   * The manifest is rebuilt with the same field order and the same fingerprint
 *     construction as the audited service, so the receipt stays verifiable.
 *
 * The `asOf` mode reconstructs what was valid at a past instant. It re-reads only
 * fragments the audited path already listed as withheld for a time reason, and it
 * re-authorizes and re-checks scope, sleeve, sensitivity, and the operator kill
 * switch on every one of them before it will consider them.
 */
export class TemporalHybridMemorySystem implements MemorySystem {
  readonly id = 'typed_temporal' as const;
  readonly capabilities: MemorySystemCapabilities = Object.freeze({
    workingMemory: true,
    consolidation: true,
    proceduralPromotion: true,
    storeClasses: ALL_STORE_CLASSES
  });

  private readonly sqlite: SQLite.Database;
  private readonly access: BoundAgentAccess;
  private readonly fragments: MemoryFragmentRepository;
  private readonly retrieval: ScopedLexicalRetrievalService;
  private readonly working: WorkingMemoryRepository;
  private readonly consolidationStore: ConsolidationCandidateRepository;
  private readonly procedureStore: ProcedureCandidateRepository;

  constructor(options: TemporalHybridMemorySystemOptions) {
    this.sqlite = options.sqlite;
    this.access = options.access;
    this.fragments = new MemoryFragmentRepository(options.sqlite);
    this.retrieval = new ScopedLexicalRetrievalService(options.sqlite, options.access);
    this.working = new WorkingMemoryRepository(options.sqlite);
    this.consolidationStore = new ConsolidationCandidateRepository(options.sqlite);
    this.procedureStore = new ProcedureCandidateRepository(options.sqlite);
  }

  write(input: unknown): Promise<MemoryFragmentRecord> {
    return this.fragments.put(input);
  }

  async retrieve(query: unknown): Promise<LexicalRetrievalResult> {
    const outcome = await this.retrieveTemporal(query);
    return outcome.result;
  }

  /**
   * The same retrieval as {@link retrieve}, with the ranking and temporal audit
   * trail attached. Callers that need to explain a withheld item — an eval harness,
   * an operator dashboard — use this; the `MemorySystem` seam stays narrow.
   */
  async retrieveTemporal(rawQuery: unknown): Promise<TemporalRetrievalOutcome> {
    const query = TemporalRetrievalQuerySchema.parse(rawQuery);
    const base = await this.retrieval.query({
      authorization: query.authorization,
      text: query.text,
      limit: query.limit
    });

    const asOf = query.asOf ?? null;
    const mode: TemporalRetrievalMode = asOf === null ? 'current' : 'as_of';
    // In `current` mode the query time is the authorization's own instant, so the
    // temporal pass can never disagree with the gate that admitted the candidates.
    const queryTime = asOf ?? base.manifest.evaluatedAt;

    const candidates: LexicalRetrievalItem[] = [...base.items];
    if (mode === 'as_of') {
      candidates.push(...(await this.reconstructWithheld(query.authorization, base)));
    }

    const ranking = rerankByStorePolicy({
      normalizedTerms: base.manifest.normalizedTerms,
      candidates
    });

    const byFragmentId = new Map(candidates.map((item) => [item.id, item]));
    const rerankOrder: LexicalRetrievalItem[] = [];
    for (const entry of ranking.ranked) {
      const item = byFragmentId.get(entry.fragmentId);
      if (item !== undefined) rerankOrder.push(item);
    }

    const temporal = planTemporalRetrieval({ mode, queryTime, candidates: rerankOrder });
    const retained = new Set(temporal.retainedFragmentIds);
    const items = rerankOrder
      .filter((item) => retained.has(item.id))
      .slice(0, query.limit)
      .map((item, index) => ({ ...item, rank: index + 1 }));

    const selectedIds = new Set(items.map((item) => item.id));
    const suppressionById = new Map(
      temporal.decisions.map((decision) => [decision.fragmentId, decision.suppressionReason])
    );
    const baseOmittedIds = new Set(base.manifest.omitted.map((entry) => entry.fragmentId));

    // Carry the audited path's own omissions through untouched, minus anything an
    // as-of reconstruction promoted back into the selected set.
    const omitted: RetrievalManifestOmitted[] = base.manifest.omitted.filter(
      (entry) => !selectedIds.has(entry.fragmentId)
    );
    for (const item of rerankOrder) {
      if (selectedIds.has(item.id) || baseOmittedIds.has(item.id)) continue;
      const suppressionReason = suppressionById.get(item.id) ?? null;
      omitted.push({
        fragmentId: item.id,
        sourceId: item.sourceId,
        bm25: item.bm25,
        // A retained candidate that did not make the cut lost to the limit, not to time.
        reason:
          suppressionReason === null ? 'result_limit' : TEMPORAL_OMISSION_REASONS[suppressionReason]
      });
    }

    const unsignedManifest = {
      algorithm: base.manifest.algorithm,
      ownerScopeId: base.manifest.ownerScopeId,
      sleeveId: base.manifest.sleeveId,
      evaluatedAt: base.manifest.evaluatedAt,
      queryHash: base.manifest.queryHash,
      normalizedTerms: base.manifest.normalizedTerms,
      selected: items.map((item) => ({
        fragmentId: item.id,
        sourceId: item.sourceId,
        rank: item.rank,
        reason: item.selectionReason
      })),
      omitted
    };

    return {
      result: {
        ownerScopeId: base.ownerScopeId,
        sleeveId: base.sleeveId,
        items,
        manifest: {
          ...unsignedManifest,
          fingerprint: sha256(JSON.stringify(unsignedManifest))
        }
      },
      ranking,
      temporal
    };
  }

  /**
   * Re-reads the fragments the audited path withheld for a time reason so an as-of
   * query has something to reconstruct from. It re-runs the authorization gate rather
   * than trusting the caller's requested sensitivity, and re-asserts owner scope,
   * sleeve, the effective sensitivity ceiling, and `retrieval_eligible` in SQL. A row
   * that fails any of those is skipped, never surfaced — so this path can only ever
   * return a subset of what the original query was already allowed to see.
   */
  private reconstructWithheld(
    authorizationInput: unknown,
    base: LexicalRetrievalResult
  ): Promise<LexicalRetrievalItem[]> {
    return this.access.runAuthorizedMemoryRetrieval(authorizationInput, (authorization) =>
      Promise.resolve(this.readWithheldAuthorized(authorization, base))
    );
  }

  private readWithheldAuthorized(
    authorization: AuthorizedMemoryRetrieval,
    base: LexicalRetrievalResult
  ): LexicalRetrievalItem[] {
    const statement = this.sqlite.prepare(
      `SELECT * FROM memory_fragments
       WHERE fragment_id = @fragmentId
         AND owner_scope_id = @ownerScopeId
         AND sleeve_id = @sleeveId
         AND retrieval_eligible = 1
         AND (
           CASE sensitivity
             WHEN 'public' THEN 0
             WHEN 'internal' THEN 1
             WHEN 'confidential' THEN 2
             WHEN 'private' THEN 3
             ELSE 4
           END
         ) <= @sensitivityRank`
    );
    const alreadyPresent = new Set(base.items.map((item) => item.id));
    const reconstructed: LexicalRetrievalItem[] = [];
    let rank = base.items.length;
    for (const entry of base.manifest.omitted) {
      if (!AS_OF_REHYDRATABLE_REASONS.has(entry.reason)) continue;
      if (alreadyPresent.has(entry.fragmentId)) continue;
      alreadyPresent.add(entry.fragmentId);
      const row = statement.get({
        fragmentId: entry.fragmentId,
        ownerScopeId: authorization.ownerScopeId,
        sleeveId: authorization.sleeveId,
        sensitivityRank: SENSITIVITY_RANK[authorization.sensitivity]
      }) as MemoryFragmentRow | undefined;
      if (row === undefined) continue;
      rank += 1;
      reconstructed.push({
        ...toRecord(row),
        bm25: entry.bm25,
        rank,
        selectionReason: 'lexical_bm25'
      });
    }
    return reconstructed;
  }

  compileContext(input: unknown): ScopedContextCompilation {
    return compileScopedContext(input);
  }

  workingMemory(): WorkingMemoryStore {
    return this.working;
  }

  consolidation(): ConsolidationProposalStore {
    return this.consolidationStore;
  }

  procedures(): ProceduralPromotionStore {
    return this.procedureStore;
  }
}
