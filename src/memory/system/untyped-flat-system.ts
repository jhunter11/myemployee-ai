import { createHash } from 'node:crypto';

import type SQLite from 'better-sqlite3';

import type { AuthorizedMemoryRetrieval } from '../../agents/access-control-contracts';
import type { BoundAgentAccess } from '../../agents/access-control-repository';
import {
  compileScopedContext,
  type ScopedContextCompilation
} from '../../knowledge/context-compiler';
import { MemoryFragmentRepository } from '../../knowledge/memory-fragment-repository';
import {
  LexicalRetrievalQuerySchema,
  MemoryFragmentRecordSchema,
  type LexicalRetrievalItem,
  type LexicalRetrievalResult,
  type MemoryFragmentRecord
} from '../../knowledge/retrieval-contracts';
import type {
  ConsolidationProposalStore,
  MemorySystem,
  MemorySystemCapabilities,
  ProceduralPromotionStore,
  WorkingMemoryStore
} from './contracts';

export interface UntypedFlatMemorySystemOptions {
  sqlite: SQLite.Database;
  access: BoundAgentAccess;
}

interface RetrievalRow {
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
  bm25_score: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function termsFor(text: string): string[] {
  const terms = text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(terms.map((term) => term.slice(0, 64)))].slice(0, 32);
}

function toItem(row: RetrievalRow, rank: number): LexicalRetrievalItem {
  const record = MemoryFragmentRecordSchema.parse({
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
  return { ...record, bm25: row.bm25_score, rank, selectionReason: 'lexical_bm25' };
}

/**
 * Backend E — the EXPERIMENTAL CONTROL. Not for production use.
 *
 * Jarvis's `flat` backend is already stronger than the "flat store with tags"
 * baseline the memory literature compares against: its retrieval SQL filters
 * superseded revisions, closed validity windows, and operator-withdrawn items
 * before ranking. That is good engineering, but it makes the reports' central
 * hypothesis — that typed/temporal memory beats flat tagged memory — untestable
 * here, because the flat arm already has the temporal behaviour under test.
 *
 * This backend restores the honest control: one store, metadata tags, lexical
 * ranking, and NO temporal reasoning. It deliberately returns superseded facts,
 * expired policies, and withdrawn items as though they were current.
 *
 * What it does NOT relax is safety. Scope binding and the sensitivity ceiling are
 * enforced exactly as elsewhere, so the control isolates temporal correctness as
 * the single variable. A control that also leaked across sleeves would measure two
 * things at once and would be unsafe to run against real memory.
 */
export class UntypedFlatMemorySystem implements MemorySystem {
  readonly id = 'flat_untyped' as const;
  readonly capabilities: MemorySystemCapabilities = Object.freeze({
    workingMemory: false,
    consolidation: false,
    proceduralPromotion: false,
    storeClasses: Object.freeze(['episodic', 'semantic', 'procedural'] as const)
  });

  private readonly fragments: MemoryFragmentRepository;

  constructor(private readonly options: UntypedFlatMemorySystemOptions) {
    this.fragments = new MemoryFragmentRepository(options.sqlite);
  }

  write(input: unknown): Promise<MemoryFragmentRecord> {
    return this.fragments.put(input);
  }

  async retrieve(rawQuery: unknown): Promise<LexicalRetrievalResult> {
    const query = LexicalRetrievalQuerySchema.parse(rawQuery);
    return this.options.access.runAuthorizedMemoryRetrieval(query.authorization, (authorization) =>
      Promise.resolve(this.queryAuthorized(authorization, query.text, query.limit))
    );
  }

  private queryAuthorized(
    authorization: AuthorizedMemoryRetrieval,
    text: string,
    limit: number
  ): LexicalRetrievalResult {
    const normalizedTerms = termsFor(text);
    const queryHash = sha256(
      JSON.stringify({
        algorithm: 'sqlite_fts5_bm25_v1',
        ownerScopeId: authorization.ownerScopeId,
        sleeveId: authorization.sleeveId,
        normalizedTerms
      })
    );

    let rows: RetrievalRow[] = [];
    if (normalizedTerms.length > 0) {
      // Scope and sensitivity are still enforced. Temporal state deliberately is not.
      rows = this.options.sqlite
        .prepare(
          `SELECT mf.*, bm25(memory_fragments_fts, 8.0, 1.0, 2.0) AS bm25_score
           FROM memory_fragments_fts
           JOIN memory_fragments AS mf ON mf.rowid = memory_fragments_fts.rowid
           WHERE memory_fragments_fts MATCH @expression
             AND mf.owner_scope_id = @ownerScopeId
             AND mf.sleeve_id = @sleeveId
             AND (
               CASE mf.sensitivity
                 WHEN 'public' THEN 0
                 WHEN 'internal' THEN 1
                 WHEN 'confidential' THEN 2
                 WHEN 'private' THEN 3
                 ELSE 4
               END
             ) <= @sensitivityRank
           ORDER BY bm25_score ASC, mf.recorded_at DESC, mf.fragment_id ASC
           LIMIT @candidateLimit`
        )
        .all({
          expression: normalizedTerms.map((term) => `"${term}"`).join(' OR '),
          ownerScopeId: authorization.ownerScopeId,
          sleeveId: authorization.sleeveId,
          sensitivityRank: {
            public: 0,
            internal: 1,
            confidential: 2,
            private: 3,
            restricted: 4
          }[authorization.sensitivity],
          candidateLimit: limit
        }) as RetrievalRow[];
    }

    const items = rows.map((row, index) => toItem(row, index + 1));
    const unsignedManifest = {
      algorithm: 'sqlite_fts5_bm25_v1' as const,
      ownerScopeId: authorization.ownerScopeId,
      sleeveId: authorization.sleeveId,
      evaluatedAt: authorization.authorizedAt,
      queryHash,
      normalizedTerms,
      selected: items.map((item) => ({
        fragmentId: item.id,
        sourceId: item.sourceId,
        rank: item.rank,
        reason: item.selectionReason
      })),
      // The control has no suppression stage, so nothing is ever held back.
      omitted: []
    };

    return {
      ownerScopeId: authorization.ownerScopeId,
      sleeveId: authorization.sleeveId,
      items,
      manifest: {
        ...unsignedManifest,
        fingerprint: sha256(JSON.stringify(unsignedManifest))
      }
    };
  }

  compileContext(input: unknown): ScopedContextCompilation {
    return compileScopedContext(input);
  }

  workingMemory(): WorkingMemoryStore | null {
    return null;
  }

  consolidation(): ConsolidationProposalStore | null {
    return null;
  }

  procedures(): ProceduralPromotionStore | null {
    return null;
  }
}
