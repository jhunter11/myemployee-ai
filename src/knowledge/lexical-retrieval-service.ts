import { createHash } from 'node:crypto';

import type SQLite from 'better-sqlite3';

import type { AuthorizedMemoryRetrieval } from '../agents/access-control-contracts';
import type { BoundAgentAccess } from '../agents/access-control-repository';
import {
  LexicalRetrievalQuerySchema,
  MemoryFragmentRecordSchema,
  type LexicalRetrievalItem,
  type LexicalRetrievalResult,
  type RetrievalManifestOmitted,
  type RetrievalOmissionReason
} from './retrieval-contracts';

const algorithm = 'sqlite_fts5_bm25_v1' as const;
const omittedCandidateLimit = 25;

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

function ftsExpression(terms: readonly string[]): string {
  return terms.map((term) => `"${term}"`).join(' OR ');
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

function omissionReason(row: RetrievalRow, evaluatedAt: string): RetrievalOmissionReason {
  if (row.superseded_by_fragment_id !== null) return 'superseded';
  if (row.retrieval_eligible !== 1) return 'retrieval_disabled';
  if (row.expires_at !== null && row.expires_at <= evaluatedAt) return 'expired';
  if (row.valid_from > evaluatedAt) return 'not_yet_valid';
  return 'validity_ended';
}

function manifestOmission(
  row: RetrievalRow,
  reason: RetrievalOmissionReason
): RetrievalManifestOmitted {
  return {
    fragmentId: MemoryFragmentRecordSchema.shape.id.parse(row.fragment_id),
    sourceId: MemoryFragmentRecordSchema.shape.sourceId.parse(row.source_id),
    bm25: row.bm25_score,
    reason
  };
}

export class ScopedLexicalRetrievalService {
  constructor(
    private readonly sqlite: SQLite.Database,
    private readonly access: BoundAgentAccess
  ) {}

  async query(rawInput: unknown): Promise<LexicalRetrievalResult> {
    const input = LexicalRetrievalQuerySchema.parse(rawInput);
    return this.access.runAuthorizedMemoryRetrieval(input.authorization, (authorization) =>
      Promise.resolve(this.queryAuthorized(authorization, input.text, input.limit))
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
        algorithm,
        ownerScopeId: authorization.ownerScopeId,
        sleeveId: authorization.sleeveId,
        ownerScopeVersion: authorization.ownerScopeVersion,
        sleeveVersion: authorization.sleeveVersion,
        grantVersions: authorization.grantVersions,
        normalizedTerms
      })
    );
    if (normalizedTerms.length === 0) {
      const emptyManifest = {
        algorithm,
        ownerScopeId: authorization.ownerScopeId,
        sleeveId: authorization.sleeveId,
        evaluatedAt: authorization.authorizedAt,
        queryHash,
        normalizedTerms,
        selected: [],
        omitted: []
      };
      return {
        ownerScopeId: authorization.ownerScopeId,
        sleeveId: authorization.sleeveId,
        items: [],
        manifest: {
          ...emptyManifest,
          fingerprint: sha256(JSON.stringify(emptyManifest))
        }
      };
    }

    const expression = ftsExpression(normalizedTerms);
    const commonSql = `
      SELECT mf.*, bm25(memory_fragments_fts, 8.0, 1.0, 2.0) AS bm25_score
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
        ) <= @sensitivityRank`;
    const eligibleSql = `${commonSql}
        AND mf.retrieval_eligible = 1
        AND mf.superseded_by_fragment_id IS NULL
        AND mf.valid_from <= @evaluatedAt
        AND (mf.valid_until IS NULL OR mf.valid_until > @evaluatedAt)
        AND (mf.expires_at IS NULL OR mf.expires_at > @evaluatedAt)
      ORDER BY bm25_score ASC, mf.recorded_at DESC, mf.fragment_id ASC
      LIMIT @candidateLimit`;
    const ineligibleSql = `${commonSql}
        AND NOT (
          mf.retrieval_eligible = 1
          AND mf.superseded_by_fragment_id IS NULL
          AND mf.valid_from <= @evaluatedAt
          AND (mf.valid_until IS NULL OR mf.valid_until > @evaluatedAt)
          AND (mf.expires_at IS NULL OR mf.expires_at > @evaluatedAt)
        )
      ORDER BY bm25_score ASC, mf.recorded_at DESC, mf.fragment_id ASC
      LIMIT @candidateLimit`;
    const bindings = {
      expression,
      ownerScopeId: authorization.ownerScopeId,
      sleeveId: authorization.sleeveId,
      sensitivityRank: {
        public: 0,
        internal: 1,
        confidential: 2,
        private: 3,
        restricted: 4
      }[authorization.sensitivity],
      evaluatedAt: authorization.authorizedAt,
      candidateLimit: limit + omittedCandidateLimit
    };
    const eligibleRows = this.sqlite.prepare(eligibleSql).all(bindings) as RetrievalRow[];
    const ineligibleRows = this.sqlite
      .prepare(ineligibleSql)
      .all({ ...bindings, candidateLimit: omittedCandidateLimit }) as RetrievalRow[];

    const selectedRows = eligibleRows.slice(0, limit);
    const items = selectedRows.map((row, index) => toItem(row, index + 1));
    const selected = items.map((item) => ({
      fragmentId: item.id,
      sourceId: item.sourceId,
      rank: item.rank,
      reason: item.selectionReason
    }));
    const omitted = [
      ...eligibleRows.slice(limit).map((row) => manifestOmission(row, 'result_limit' as const)),
      ...ineligibleRows.map((row) =>
        manifestOmission(row, omissionReason(row, authorization.authorizedAt))
      )
    ];
    const unsignedManifest = {
      algorithm,
      ownerScopeId: authorization.ownerScopeId,
      sleeveId: authorization.sleeveId,
      evaluatedAt: authorization.authorizedAt,
      queryHash,
      normalizedTerms,
      selected,
      omitted
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
}
