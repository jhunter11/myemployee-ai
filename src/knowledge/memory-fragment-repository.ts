import { isDeepStrictEqual } from 'node:util';

import type SQLite from 'better-sqlite3';

import { AppError } from '../utils/errors';
import {
  MemoryFragmentInputSchema,
  MemoryFragmentRecordSchema,
  type MemoryFragmentInput,
  type MemoryFragmentRecord
} from './retrieval-contracts';

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

function matchesInput(record: MemoryFragmentRecord, input: MemoryFragmentInput): boolean {
  return isDeepStrictEqual(record, {
    ...input,
    supersededByFragmentId: record.supersededByFragmentId
  });
}

export class MemoryFragmentRepository {
  constructor(private readonly sqlite: SQLite.Database) {}

  put(rawInput: unknown): Promise<MemoryFragmentRecord> {
    return Promise.resolve().then(() => this.putValidated(rawInput));
  }

  private putValidated(rawInput: unknown): MemoryFragmentRecord {
    const input = MemoryFragmentInputSchema.parse(rawInput);
    const write = this.sqlite.transaction((fragment: MemoryFragmentInput) => {
      const sleeve = this.sqlite
        .prepare(
          `SELECT owner_scope_id, max_sensitivity
           FROM memory_sleeves
           WHERE sleeve_id = ? AND owner_scope_id = ? AND state = 'active'`
        )
        .get(fragment.sleeveId, fragment.ownerScopeId) as
        { owner_scope_id: string; max_sensitivity: MemoryFragmentInput['sensitivity'] } | undefined;
      if (sleeve === undefined) {
        throw new AppError(
          409,
          'MEMORY_SLEEVE_INVALID',
          'Memory fragments require an active registered sleeve binding'
        );
      }
      const sensitivityRank: Readonly<Record<MemoryFragmentInput['sensitivity'], number>> = {
        public: 0,
        internal: 1,
        confidential: 2,
        private: 3,
        restricted: 4
      };
      if (sensitivityRank[fragment.sensitivity] > sensitivityRank[sleeve.max_sensitivity]) {
        throw new AppError(
          409,
          'MEMORY_SENSITIVITY_INVALID',
          'Memory fragment sensitivity exceeds its registered sleeve cap'
        );
      }

      const existingRow = this.sqlite
        .prepare('SELECT * FROM memory_fragments WHERE fragment_id = ?')
        .get(fragment.id) as MemoryFragmentRow | undefined;
      if (existingRow !== undefined) {
        const existing = toRecord(existingRow);
        if (!matchesInput(existing, fragment)) {
          throw new AppError(
            409,
            'MEMORY_FRAGMENT_CONFLICT',
            'Memory fragment ID is already bound to different immutable content'
          );
        }
        return existing;
      }

      if (fragment.supersedesFragmentId !== null) {
        const priorRow = this.sqlite
          .prepare('SELECT * FROM memory_fragments WHERE fragment_id = ?')
          .get(fragment.supersedesFragmentId) as MemoryFragmentRow | undefined;
        if (priorRow === undefined) {
          throw new AppError(
            409,
            'MEMORY_SUPERSESSION_INVALID',
            'A superseded memory fragment must already exist'
          );
        }
        const prior = toRecord(priorRow);
        if (prior.ownerScopeId !== fragment.ownerScopeId || prior.sleeveId !== fragment.sleeveId) {
          throw new AppError(
            409,
            'MEMORY_SUPERSESSION_FORBIDDEN',
            'Memory supersession cannot cross registered sleeves'
          );
        }
        if (prior.supersededByFragmentId !== null && prior.supersededByFragmentId !== fragment.id) {
          throw new AppError(
            409,
            'MEMORY_SUPERSESSION_CONFLICT',
            'Memory fragment was already superseded by another revision'
          );
        }
      }

      this.sqlite
        .prepare(
          `INSERT INTO memory_fragments (
             fragment_id, owner_scope_id, sleeve_id, source_id, source_hash, extraction_version,
             memory_kind, title, content, tags_json, tags_text, valid_from,
             valid_until, recorded_at, confidence_permille, sensitivity,
             supersedes_fragment_id, superseded_by_fragment_id, review_at,
             expires_at, retrieval_eligible
           ) VALUES (
             @fragmentId, @ownerScopeId, @sleeveId, @sourceId, @sourceHash, @extractionVersion,
             @memoryKind, @title, @content, @tagsJson, @tagsText, @validFrom,
             @validUntil, @recordedAt, @confidencePermille, @sensitivity,
             @supersedesFragmentId, NULL, @reviewAt, @expiresAt, @retrievalEligible
           )`
        )
        .run({
          fragmentId: fragment.id,
          ownerScopeId: fragment.ownerScopeId,
          sleeveId: fragment.sleeveId,
          sourceId: fragment.sourceId,
          sourceHash: fragment.sourceHash,
          extractionVersion: fragment.extractionVersion,
          memoryKind: fragment.kind,
          title: fragment.title,
          content: fragment.content,
          tagsJson: JSON.stringify(fragment.tags),
          tagsText: fragment.tags.join(' '),
          validFrom: fragment.validFrom,
          validUntil: fragment.validUntil,
          recordedAt: fragment.recordedAt,
          confidencePermille: fragment.confidencePermille,
          sensitivity: fragment.sensitivity,
          supersedesFragmentId: fragment.supersedesFragmentId,
          reviewAt: fragment.reviewAt,
          expiresAt: fragment.expiresAt,
          retrievalEligible: fragment.retrievalEligible ? 1 : 0
        });

      if (fragment.supersedesFragmentId !== null) {
        const update = this.sqlite
          .prepare(
            `UPDATE memory_fragments
             SET superseded_by_fragment_id = ?
             WHERE fragment_id = ?
               AND owner_scope_id = ?
               AND sleeve_id = ?
               AND superseded_by_fragment_id IS NULL`
          )
          .run(
            fragment.id,
            fragment.supersedesFragmentId,
            fragment.ownerScopeId,
            fragment.sleeveId
          );
        if (update.changes !== 1) {
          throw new AppError(
            409,
            'MEMORY_SUPERSESSION_CONFLICT',
            'Memory supersession changed concurrently'
          );
        }
      }

      const inserted = this.sqlite
        .prepare('SELECT * FROM memory_fragments WHERE fragment_id = ?')
        .get(fragment.id) as MemoryFragmentRow;
      return toRecord(inserted);
    });

    return write(input);
  }
}
