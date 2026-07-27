import { isDeepStrictEqual } from 'node:util';

import type SQLite from 'better-sqlite3';

import { AppError } from '../../utils/errors';
import {
  WorkingMemoryEntryInputSchema,
  WorkingMemoryReadQuerySchema,
  WorkingMemoryRecordSchema,
  type WorkingMemoryEntryInput,
  type WorkingMemoryRecord,
  type WorkingMemoryStore
} from './contracts';
import { sha256 } from './hashing';

interface WorkingMemoryRow {
  entry_id: string;
  owner_scope_id: string;
  sleeve_id: string;
  run_id: string;
  slot_key: string;
  content: string;
  content_sha256: string;
  sensitivity: string;
  recorded_at: string;
  expires_at: string;
  supersedes_entry_id: string | null;
  superseded_by_entry_id: string | null;
}

function toRecord(row: WorkingMemoryRow): WorkingMemoryRecord {
  return WorkingMemoryRecordSchema.parse({
    id: row.entry_id,
    ownerScopeId: row.owner_scope_id,
    sleeveId: row.sleeve_id,
    runId: row.run_id,
    slotKey: row.slot_key,
    content: row.content,
    contentSha256: row.content_sha256,
    sensitivity: row.sensitivity,
    recordedAt: row.recorded_at,
    expiresAt: row.expires_at,
    supersedesEntryId: row.supersedes_entry_id,
    supersededByEntryId: row.superseded_by_entry_id
  });
}

/**
 * Run-local working state. Entries are append-only and immutable; an agent
 * "updates" a slot by writing a new entry that supersedes the prior one. Reads
 * are strictly bound to (owner scope, sleeve, run) — there is no cross-run path,
 * so working state never leaks between runs and is never promoted to durable memory.
 */
export class WorkingMemoryRepository implements WorkingMemoryStore {
  constructor(private readonly sqlite: SQLite.Database) {}

  record(rawInput: unknown): Promise<WorkingMemoryRecord> {
    return Promise.resolve().then(() => this.recordValidated(rawInput));
  }

  private recordValidated(rawInput: unknown): WorkingMemoryRecord {
    const input = WorkingMemoryEntryInputSchema.parse(rawInput);
    const contentSha256 = sha256(input.content);
    const write = this.sqlite.transaction((entry: WorkingMemoryEntryInput) => {
      const sleeve = this.sqlite
        .prepare(
          `SELECT max_sensitivity FROM memory_sleeves
           WHERE sleeve_id = ? AND owner_scope_id = ? AND state = 'active'`
        )
        .get(entry.sleeveId, entry.ownerScopeId) as
        { max_sensitivity: WorkingMemoryEntryInput['sensitivity'] } | undefined;
      if (sleeve === undefined) {
        throw new AppError(
          409,
          'WORKING_MEMORY_SLEEVE_INVALID',
          'Working memory requires an active registered sleeve binding'
        );
      }
      const sensitivityRank: Readonly<Record<WorkingMemoryEntryInput['sensitivity'], number>> = {
        public: 0,
        internal: 1,
        confidential: 2,
        private: 3,
        restricted: 4
      };
      if (sensitivityRank[entry.sensitivity] > sensitivityRank[sleeve.max_sensitivity]) {
        throw new AppError(
          409,
          'WORKING_MEMORY_SENSITIVITY_INVALID',
          'Working memory sensitivity exceeds its registered sleeve cap'
        );
      }

      const existingRow = this.sqlite
        .prepare('SELECT * FROM working_memory WHERE entry_id = ?')
        .get(entry.id) as WorkingMemoryRow | undefined;
      if (existingRow !== undefined) {
        const existing = toRecord(existingRow);
        const expected: WorkingMemoryRecord = {
          ...entry,
          contentSha256,
          supersededByEntryId: existing.supersededByEntryId
        };
        if (!isDeepStrictEqual(existing, expected)) {
          throw new AppError(
            409,
            'WORKING_MEMORY_CONFLICT',
            'Working memory entry ID is already bound to different immutable content'
          );
        }
        return existing;
      }

      this.sqlite
        .prepare(
          `INSERT INTO working_memory (
             entry_id, owner_scope_id, sleeve_id, run_id, slot_key, content,
             content_sha256, sensitivity, recorded_at, expires_at,
             supersedes_entry_id, superseded_by_entry_id
           ) VALUES (
             @id, @ownerScopeId, @sleeveId, @runId, @slotKey, @content,
             @contentSha256, @sensitivity, @recordedAt, @expiresAt,
             @supersedesEntryId, NULL
           )`
        )
        .run({ ...entry, contentSha256 });

      if (entry.supersedesEntryId !== null) {
        const update = this.sqlite
          .prepare(
            `UPDATE working_memory
             SET superseded_by_entry_id = ?
             WHERE entry_id = ?
               AND owner_scope_id = ?
               AND sleeve_id = ?
               AND run_id = ?
               AND superseded_by_entry_id IS NULL`
          )
          .run(entry.id, entry.supersedesEntryId, entry.ownerScopeId, entry.sleeveId, entry.runId);
        if (update.changes !== 1) {
          throw new AppError(
            409,
            'WORKING_MEMORY_SUPERSESSION_CONFLICT',
            'Working memory supersession changed concurrently or crossed a run'
          );
        }
      }

      const inserted = this.sqlite
        .prepare('SELECT * FROM working_memory WHERE entry_id = ?')
        .get(entry.id) as WorkingMemoryRow;
      return toRecord(inserted);
    });
    return write(input);
  }

  read(rawQuery: unknown): Promise<WorkingMemoryRecord[]> {
    return Promise.resolve().then(() => {
      const query = WorkingMemoryReadQuerySchema.parse(rawQuery);
      const rows = this.sqlite
        .prepare(
          `SELECT * FROM working_memory
           WHERE owner_scope_id = @ownerScopeId
             AND sleeve_id = @sleeveId
             AND run_id = @runId
             AND superseded_by_entry_id IS NULL
             AND expires_at > @evaluatedAt
             AND (@slotKey IS NULL OR slot_key = @slotKey)
           ORDER BY recorded_at DESC, entry_id ASC
           LIMIT @limit`
        )
        .all({
          ownerScopeId: query.ownerScopeId,
          sleeveId: query.sleeveId,
          runId: query.runId,
          evaluatedAt: query.evaluatedAt,
          slotKey: query.slotKey,
          limit: query.limit
        }) as WorkingMemoryRow[];
      return rows.map(toRecord);
    });
  }
}
