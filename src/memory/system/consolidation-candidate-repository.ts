import { isDeepStrictEqual } from 'node:util';

import type SQLite from 'better-sqlite3';

import { AppError } from '../../utils/errors';
import {
  ConsolidationCandidateInputSchema,
  ConsolidationCandidateQuerySchema,
  ConsolidationCandidateRecordSchema,
  type ConsolidationCandidateInput,
  type ConsolidationCandidateRecord,
  type ConsolidationProposalStore
} from './contracts';
import { consolidationContentHash } from './hashing';

interface ConsolidationRow {
  candidate_id: string;
  owner_scope_id: string;
  sleeve_id: string;
  target_store: string;
  proposed_kind: string;
  title: string;
  content: string;
  source_fragment_ids_json: string;
  evidence_count: number;
  temporal_state: string;
  confidence_permille: number;
  rationale: string;
  planner_version: string;
  proposed_by: string;
  sensitivity: string;
  content_sha256: string;
  recorded_at: string;
  expires_at: string;
  supersedes_candidate_id: string | null;
  superseded_by_candidate_id: string | null;
}

function toRecord(row: ConsolidationRow): ConsolidationCandidateRecord {
  return ConsolidationCandidateRecordSchema.parse({
    id: row.candidate_id,
    ownerScopeId: row.owner_scope_id,
    sleeveId: row.sleeve_id,
    targetStore: row.target_store,
    proposedKind: row.proposed_kind,
    title: row.title,
    content: row.content,
    sourceFragmentIds: JSON.parse(row.source_fragment_ids_json) as unknown,
    evidenceCount: row.evidence_count,
    temporalState: row.temporal_state,
    confidencePermille: row.confidence_permille,
    rationale: row.rationale,
    plannerVersion: row.planner_version,
    proposedBy: row.proposed_by,
    sensitivity: row.sensitivity,
    contentSha256: row.content_sha256,
    recordedAt: row.recorded_at,
    expiresAt: row.expires_at,
    supersedesCandidateId: row.supersedes_candidate_id,
    supersededByCandidateId: row.superseded_by_candidate_id
  });
}

/**
 * Propose-only store for episodic -> semantic/procedural distillations. Writing a
 * candidate never mutates durable memory and never crosses a sleeve; an operator
 * must materialize an accepted candidate through the existing SharedApprovedBundle
 * / fragment-write paths. Candidates are immutable and revised only by supersession.
 */
export class ConsolidationCandidateRepository implements ConsolidationProposalStore {
  constructor(private readonly sqlite: SQLite.Database) {}

  propose(rawInput: unknown): Promise<ConsolidationCandidateRecord> {
    return Promise.resolve().then(() => this.proposeValidated(rawInput));
  }

  private proposeValidated(rawInput: unknown): ConsolidationCandidateRecord {
    const input = ConsolidationCandidateInputSchema.parse(rawInput);
    const contentSha256 = consolidationContentHash(input);
    const write = this.sqlite.transaction((candidate: ConsolidationCandidateInput) => {
      const existingRow = this.sqlite
        .prepare('SELECT * FROM memory_consolidation_candidates WHERE candidate_id = ?')
        .get(candidate.id) as ConsolidationRow | undefined;
      if (existingRow !== undefined) {
        const existing = toRecord(existingRow);
        const expected: ConsolidationCandidateRecord = {
          ...candidate,
          contentSha256,
          supersededByCandidateId: existing.supersededByCandidateId
        };
        if (!isDeepStrictEqual(existing, expected)) {
          throw new AppError(
            409,
            'CONSOLIDATION_CANDIDATE_CONFLICT',
            'Consolidation candidate ID is already bound to different immutable content'
          );
        }
        return existing;
      }

      this.sqlite
        .prepare(
          `INSERT INTO memory_consolidation_candidates (
             candidate_id, owner_scope_id, sleeve_id, target_store, proposed_kind,
             title, content, source_fragment_ids_json, evidence_count, temporal_state,
             confidence_permille, rationale, planner_version, proposed_by, sensitivity,
             content_sha256, recorded_at, expires_at, supersedes_candidate_id,
             superseded_by_candidate_id
           ) VALUES (
             @id, @ownerScopeId, @sleeveId, @targetStore, @proposedKind,
             @title, @content, @sourceFragmentIdsJson, @evidenceCount, @temporalState,
             @confidencePermille, @rationale, @plannerVersion, @proposedBy, @sensitivity,
             @contentSha256, @recordedAt, @expiresAt, @supersedesCandidateId,
             NULL
           )`
        )
        .run({
          id: candidate.id,
          ownerScopeId: candidate.ownerScopeId,
          sleeveId: candidate.sleeveId,
          targetStore: candidate.targetStore,
          proposedKind: candidate.proposedKind,
          title: candidate.title,
          content: candidate.content,
          sourceFragmentIdsJson: JSON.stringify(candidate.sourceFragmentIds),
          evidenceCount: candidate.evidenceCount,
          temporalState: candidate.temporalState,
          confidencePermille: candidate.confidencePermille,
          rationale: candidate.rationale,
          plannerVersion: candidate.plannerVersion,
          proposedBy: candidate.proposedBy,
          sensitivity: candidate.sensitivity,
          contentSha256,
          recordedAt: candidate.recordedAt,
          expiresAt: candidate.expiresAt,
          supersedesCandidateId: candidate.supersedesCandidateId
        });

      if (candidate.supersedesCandidateId !== null) {
        const update = this.sqlite
          .prepare(
            `UPDATE memory_consolidation_candidates
             SET superseded_by_candidate_id = ?
             WHERE candidate_id = ?
               AND owner_scope_id = ?
               AND sleeve_id = ?
               AND superseded_by_candidate_id IS NULL`
          )
          .run(
            candidate.id,
            candidate.supersedesCandidateId,
            candidate.ownerScopeId,
            candidate.sleeveId
          );
        if (update.changes !== 1) {
          throw new AppError(
            409,
            'CONSOLIDATION_SUPERSESSION_CONFLICT',
            'Consolidation supersession changed concurrently or crossed a sleeve'
          );
        }
      }

      const inserted = this.sqlite
        .prepare('SELECT * FROM memory_consolidation_candidates WHERE candidate_id = ?')
        .get(candidate.id) as ConsolidationRow;
      return toRecord(inserted);
    });
    return write(input);
  }

  listOpen(rawQuery: unknown): Promise<ConsolidationCandidateRecord[]> {
    return Promise.resolve().then(() => {
      const query = ConsolidationCandidateQuerySchema.parse(rawQuery);
      const rows = this.sqlite
        .prepare(
          `SELECT * FROM memory_consolidation_candidates
           WHERE owner_scope_id = @ownerScopeId
             AND sleeve_id = @sleeveId
             AND superseded_by_candidate_id IS NULL
             AND expires_at > @evaluatedAt
             AND (@targetStore IS NULL OR target_store = @targetStore)
           ORDER BY recorded_at DESC, candidate_id ASC
           LIMIT @limit`
        )
        .all({
          ownerScopeId: query.ownerScopeId,
          sleeveId: query.sleeveId,
          targetStore: query.targetStore,
          evaluatedAt: query.evaluatedAt,
          limit: query.limit
        }) as ConsolidationRow[];
      return rows.map(toRecord);
    });
  }
}
