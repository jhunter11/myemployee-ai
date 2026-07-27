import { z } from 'zod';

import { ClientIdSchema } from '../config/schemas';

const scopeSubjectPattern = /^[a-z][a-z0-9_]{2,62}$/;
const scopeIdPattern = /^(harness|project|client):[a-z][a-z0-9_]{2,62}$/;
const rootKeyPattern = /^knowledge\/(harness|project|client)\/[a-z][a-z0-9_]{2,62}$/;
const graphPartitionPattern = /^graphify\/(harness|project|client)\/[a-z][a-z0-9_]{2,62}$/;

export const KnowledgeScopeKindSchema = z.enum(['harness', 'project', 'client']);
export const KnowledgeScopeSubjectSchema = z.string().regex(scopeSubjectPattern);
export const KnowledgeScopeIdSchema = z.string().regex(scopeIdPattern);
export const KnowledgeRootKeySchema = z.string().regex(rootKeyPattern);
export const KnowledgeGraphPartitionSchema = z.string().regex(graphPartitionPattern);

export const RegisterKnowledgeScopeInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('harness'),
    subjectId: KnowledgeScopeSubjectSchema,
    createdAt: z.iso.datetime()
  }),
  z.strictObject({
    kind: z.literal('project'),
    subjectId: KnowledgeScopeSubjectSchema,
    parentScopeId: KnowledgeScopeIdSchema,
    createdAt: z.iso.datetime()
  }),
  z.strictObject({
    kind: z.literal('client'),
    clientId: ClientIdSchema,
    parentScopeId: KnowledgeScopeIdSchema,
    createdAt: z.iso.datetime()
  })
]);

export const KnowledgeScopeRecordSchema = z.strictObject({
  id: KnowledgeScopeIdSchema,
  kind: KnowledgeScopeKindSchema,
  subjectId: KnowledgeScopeSubjectSchema,
  parentScopeId: KnowledgeScopeIdSchema.nullable(),
  clientId: ClientIdSchema.nullable(),
  rootKey: KnowledgeRootKeySchema,
  graphPartition: KnowledgeGraphPartitionSchema,
  createdAt: z.iso.datetime()
});

export const KnowledgePrincipalSchema = z.strictObject({
  kind: KnowledgeScopeKindSchema,
  scopeId: KnowledgeScopeIdSchema
});

export const KnowledgeProjectionSchema = z.enum(['metadata', 'content']);

export const KnowledgeAdapterIsolationSchema = z.strictObject({
  graphPartition: KnowledgeGraphPartitionSchema,
  queryLogging: z.discriminatedUnion('mode', [
    z.strictObject({
      mode: z.literal('disabled'),
      control: z.literal('GRAPHIFY_QUERY_LOG_DISABLE=1')
    }),
    z.strictObject({
      mode: z.literal('scope-protected'),
      logPartition: KnowledgeGraphPartitionSchema
    })
  ])
});

export const KnowledgeQueryInputSchema = z.strictObject({
  scopeId: KnowledgeScopeIdSchema,
  text: z.string().trim().min(2).max(1_000),
  projection: KnowledgeProjectionSchema,
  limit: z.number().int().min(1).max(25)
});

export const KnowledgeMetadataHitSchema = z.strictObject({
  documentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  title: z.string().trim().min(1).max(160),
  kind: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
  updatedAt: z.iso.datetime(),
  score: z.number().finite().min(0).max(1),
  tags: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)).max(20)
});

export const KnowledgeContentHitSchema = KnowledgeMetadataHitSchema.extend({
  excerpt: z.string().max(2_000)
});

export type KnowledgeScopeKind = z.infer<typeof KnowledgeScopeKindSchema>;
export type KnowledgeScopeId = z.infer<typeof KnowledgeScopeIdSchema>;
export type KnowledgeGraphPartition = z.infer<typeof KnowledgeGraphPartitionSchema>;
export type RegisterKnowledgeScopeInput = z.infer<typeof RegisterKnowledgeScopeInputSchema>;
export type KnowledgeScopeRecord = z.infer<typeof KnowledgeScopeRecordSchema>;
export type KnowledgePrincipal = z.infer<typeof KnowledgePrincipalSchema>;
export type KnowledgeProjection = z.infer<typeof KnowledgeProjectionSchema>;
export type KnowledgeAdapterIsolation = z.infer<typeof KnowledgeAdapterIsolationSchema>;
export type KnowledgeQueryInput = z.infer<typeof KnowledgeQueryInputSchema>;
export type KnowledgeMetadataHit = z.infer<typeof KnowledgeMetadataHitSchema>;
export type KnowledgeContentHit = z.infer<typeof KnowledgeContentHitSchema>;

/**
 * Adapters receive only an opaque registered partition. A Graphify adapter is
 * responsible for mapping that partition to its own preconfigured graph path;
 * callers never provide or receive a filesystem or project path.
 */
export interface KnowledgeAdapterQuery {
  graphPartition: KnowledgeGraphPartition;
  text: string;
  projection: KnowledgeProjection;
  limit: number;
}

export interface ScopedKnowledgeAdapter {
  readonly isolation: KnowledgeAdapterIsolation;
  query(input: KnowledgeAdapterQuery): Promise<readonly unknown[]>;
}

export interface ScopedKnowledgeAdapterResolver {
  resolve(graphPartition: KnowledgeGraphPartition): ScopedKnowledgeAdapter | undefined;
}

export interface KnowledgeQueryResult {
  scopeId: KnowledgeScopeId;
  projection: KnowledgeProjection;
  redacted: boolean;
  items: Array<KnowledgeMetadataHit | KnowledgeContentHit>;
}
