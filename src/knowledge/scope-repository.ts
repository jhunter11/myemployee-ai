import { isDeepStrictEqual } from 'node:util';

import type { Kysely, Selectable } from 'kysely';

import type { JarvisDatabase, KnowledgeScopesTable } from '../db/types';
import { AppError } from '../utils/errors';
import {
  KnowledgeScopeIdSchema,
  KnowledgeScopeRecordSchema,
  RegisterKnowledgeScopeInputSchema,
  type KnowledgeScopeId,
  type KnowledgeScopeRecord,
  type RegisterKnowledgeScopeInput
} from './contracts';

function toRecord(row: Selectable<KnowledgeScopesTable>): KnowledgeScopeRecord {
  return KnowledgeScopeRecordSchema.parse({
    id: row.scope_id,
    kind: row.scope_kind,
    subjectId: row.subject_id,
    parentScopeId: row.parent_scope_id,
    clientId: row.client_id,
    rootKey: row.root_key,
    graphPartition: row.graph_partition,
    createdAt: row.created_at
  });
}

function expectedRecord(input: RegisterKnowledgeScopeInput): KnowledgeScopeRecord {
  const subjectId = input.kind === 'client' ? input.clientId : input.subjectId;
  return KnowledgeScopeRecordSchema.parse({
    id: `${input.kind}:${subjectId}`,
    kind: input.kind,
    subjectId,
    parentScopeId: input.kind === 'harness' ? null : input.parentScopeId,
    clientId: input.kind === 'client' ? input.clientId : null,
    rootKey: `knowledge/${input.kind}/${subjectId}`,
    graphPartition: `graphify/${input.kind}/${subjectId}`,
    createdAt: input.createdAt
  });
}

export class KnowledgeScopeRepository {
  constructor(private readonly db: Kysely<JarvisDatabase>) {}

  async register(rawInput: RegisterKnowledgeScopeInput): Promise<KnowledgeScopeRecord> {
    const input = RegisterKnowledgeScopeInputSchema.parse(rawInput);
    const expected = expectedRecord(input);

    return this.db.transaction().execute(async (transaction) => {
      const existingRow = await transaction
        .selectFrom('knowledge_scopes')
        .selectAll()
        .where('scope_id', '=', expected.id)
        .executeTakeFirst();
      if (existingRow !== undefined) {
        const existing = toRecord(existingRow);
        if (!isDeepStrictEqual(existing, expected)) {
          throw new AppError(
            409,
            'KNOWLEDGE_SCOPE_CONFLICT',
            `Knowledge scope ${expected.id} already exists with a different binding`
          );
        }
        return existing;
      }

      if (input.kind !== 'harness') {
        const parent = await transaction
          .selectFrom('knowledge_scopes')
          .select(['scope_id', 'scope_kind'])
          .where('scope_id', '=', input.parentScopeId)
          .executeTakeFirst();
        const requiredParentKind = input.kind === 'project' ? 'harness' : 'project';
        if (parent === undefined || parent.scope_kind !== requiredParentKind) {
          throw new AppError(
            409,
            'KNOWLEDGE_PARENT_INVALID',
            `${input.kind} scope ${expected.id} requires an existing ${requiredParentKind} parent`
          );
        }
      }

      if (input.kind === 'client') {
        const client = await transaction
          .selectFrom('client_registry')
          .select('id')
          .where('id', '=', input.clientId)
          .executeTakeFirst();
        if (client === undefined) {
          throw new AppError(
            409,
            'KNOWLEDGE_CLIENT_INVALID',
            `Client ${input.clientId} must exist before its knowledge scope is registered`
          );
        }
      }

      const inserted = await transaction
        .insertInto('knowledge_scopes')
        .values({
          scope_id: expected.id,
          scope_kind: expected.kind,
          subject_id: expected.subjectId,
          parent_scope_id: expected.parentScopeId,
          client_id: expected.clientId,
          root_key: expected.rootKey,
          graph_partition: expected.graphPartition,
          created_at: expected.createdAt
        })
        .onConflict((conflict) => conflict.column('scope_id').doNothing())
        .returningAll()
        .executeTakeFirst();

      if (inserted === undefined) {
        const racedRow = await transaction
          .selectFrom('knowledge_scopes')
          .selectAll()
          .where('scope_id', '=', expected.id)
          .executeTakeFirstOrThrow();
        const raced = toRecord(racedRow);
        if (!isDeepStrictEqual(raced, expected)) {
          throw new AppError(
            409,
            'KNOWLEDGE_SCOPE_CONFLICT',
            `Knowledge scope ${expected.id} was concurrently registered with a different binding`
          );
        }
        return raced;
      }

      return toRecord(inserted);
    });
  }

  async findById(rawId: KnowledgeScopeId): Promise<KnowledgeScopeRecord | undefined> {
    const id = KnowledgeScopeIdSchema.parse(rawId);
    const row = await this.db
      .selectFrom('knowledge_scopes')
      .selectAll()
      .where('scope_id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async listChildren(rawParentId: KnowledgeScopeId, limit = 100): Promise<KnowledgeScopeRecord[]> {
    const parentId = KnowledgeScopeIdSchema.parse(rawParentId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('knowledge scope limit must be an integer between 1 and 100');
    }
    const rows = await this.db
      .selectFrom('knowledge_scopes')
      .selectAll()
      .where('parent_scope_id', '=', parentId)
      .orderBy('scope_kind', 'asc')
      .orderBy('scope_id', 'asc')
      .limit(limit)
      .execute();
    return rows.map(toRecord);
  }

  async isAncestor(rawAncestorId: KnowledgeScopeId, rawDescendantId: KnowledgeScopeId) {
    const ancestorId = KnowledgeScopeIdSchema.parse(rawAncestorId);
    const descendantId = KnowledgeScopeIdSchema.parse(rawDescendantId);
    if (ancestorId === descendantId) return false;

    let currentId: KnowledgeScopeId | null = descendantId;
    for (let depth = 0; depth < 3 && currentId !== null; depth += 1) {
      const row = await this.db
        .selectFrom('knowledge_scopes')
        .select('parent_scope_id')
        .where('scope_id', '=', currentId)
        .executeTakeFirst();
      if (row === undefined || row.parent_scope_id === null) return false;
      if (row.parent_scope_id === ancestorId) return true;
      currentId = KnowledgeScopeIdSchema.parse(row.parent_scope_id);
    }
    return false;
  }
}
