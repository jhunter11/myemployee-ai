import { isDeepStrictEqual } from 'node:util';

import type SQLite from 'better-sqlite3';

import { AppError } from '../../utils/errors';
import {
  ProcedureCandidateInputSchema,
  ProcedureCandidateQuerySchema,
  ProcedureCandidateRecordSchema,
  type ProcedureCandidateInput,
  type ProcedureCandidateRecord,
  type ProceduralPromotionStore
} from './contracts';
import { procedureContentHash, workflowSignatureForSteps } from './hashing';

interface ProcedureRow {
  candidate_id: string;
  owner_scope_id: string;
  sleeve_id: string;
  workflow_signature: string;
  title: string;
  steps_json: string;
  success_count: number;
  first_seen_at: string;
  last_seen_at: string;
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

function toRecord(row: ProcedureRow): ProcedureCandidateRecord {
  return ProcedureCandidateRecordSchema.parse({
    id: row.candidate_id,
    ownerScopeId: row.owner_scope_id,
    sleeveId: row.sleeve_id,
    workflowSignature: row.workflow_signature,
    title: row.title,
    steps: JSON.parse(row.steps_json) as unknown,
    successCount: row.success_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
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
 * Propose-only store for repeated-workflow (Voyager-style) procedure promotion.
 * The declared {@link ProcedureCandidateInput.workflowSignature} must match the
 * signature deterministically derived from the steps, so a candidate cannot be
 * mislabeled. Promotion to a durable procedure/blueprint remains operator-gated.
 */
export class ProcedureCandidateRepository implements ProceduralPromotionStore {
  constructor(private readonly sqlite: SQLite.Database) {}

  propose(rawInput: unknown): Promise<ProcedureCandidateRecord> {
    return Promise.resolve().then(() => this.proposeValidated(rawInput));
  }

  private proposeValidated(rawInput: unknown): ProcedureCandidateRecord {
    const input = ProcedureCandidateInputSchema.parse(rawInput);
    const derivedSignature = workflowSignatureForSteps(input.steps);
    if (derivedSignature !== input.workflowSignature) {
      throw new AppError(
        409,
        'PROCEDURE_SIGNATURE_MISMATCH',
        'workflowSignature does not match the deterministic signature of the steps'
      );
    }
    const contentSha256 = procedureContentHash(input);
    const write = this.sqlite.transaction((candidate: ProcedureCandidateInput) => {
      const existingRow = this.sqlite
        .prepare('SELECT * FROM memory_procedure_candidates WHERE candidate_id = ?')
        .get(candidate.id) as ProcedureRow | undefined;
      if (existingRow !== undefined) {
        const existing = toRecord(existingRow);
        const expected: ProcedureCandidateRecord = {
          ...candidate,
          contentSha256,
          supersededByCandidateId: existing.supersededByCandidateId
        };
        if (!isDeepStrictEqual(existing, expected)) {
          throw new AppError(
            409,
            'PROCEDURE_CANDIDATE_CONFLICT',
            'Procedure candidate ID is already bound to different immutable content'
          );
        }
        return existing;
      }

      this.sqlite
        .prepare(
          `INSERT INTO memory_procedure_candidates (
             candidate_id, owner_scope_id, sleeve_id, workflow_signature, title,
             steps_json, success_count, first_seen_at, last_seen_at, rationale,
             planner_version, proposed_by, sensitivity, content_sha256, recorded_at,
             expires_at, supersedes_candidate_id, superseded_by_candidate_id
           ) VALUES (
             @id, @ownerScopeId, @sleeveId, @workflowSignature, @title,
             @stepsJson, @successCount, @firstSeenAt, @lastSeenAt, @rationale,
             @plannerVersion, @proposedBy, @sensitivity, @contentSha256, @recordedAt,
             @expiresAt, @supersedesCandidateId, NULL
           )`
        )
        .run({
          id: candidate.id,
          ownerScopeId: candidate.ownerScopeId,
          sleeveId: candidate.sleeveId,
          workflowSignature: candidate.workflowSignature,
          title: candidate.title,
          stepsJson: JSON.stringify(candidate.steps),
          successCount: candidate.successCount,
          firstSeenAt: candidate.firstSeenAt,
          lastSeenAt: candidate.lastSeenAt,
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
            `UPDATE memory_procedure_candidates
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
            'PROCEDURE_SUPERSESSION_CONFLICT',
            'Procedure supersession changed concurrently or crossed a sleeve'
          );
        }
      }

      const inserted = this.sqlite
        .prepare('SELECT * FROM memory_procedure_candidates WHERE candidate_id = ?')
        .get(candidate.id) as ProcedureRow;
      return toRecord(inserted);
    });
    return write(input);
  }

  listOpen(rawQuery: unknown): Promise<ProcedureCandidateRecord[]> {
    return Promise.resolve().then(() => {
      const query = ProcedureCandidateQuerySchema.parse(rawQuery);
      const rows = this.sqlite
        .prepare(
          `SELECT * FROM memory_procedure_candidates
           WHERE owner_scope_id = @ownerScopeId
             AND sleeve_id = @sleeveId
             AND superseded_by_candidate_id IS NULL
             AND expires_at > @evaluatedAt
           ORDER BY recorded_at DESC, candidate_id ASC
           LIMIT @limit`
        )
        .all({
          ownerScopeId: query.ownerScopeId,
          sleeveId: query.sleeveId,
          evaluatedAt: query.evaluatedAt,
          limit: query.limit
        }) as ProcedureRow[];
      return rows.map(toRecord);
    });
  }
}
