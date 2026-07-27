import { z } from 'zod';

import {
  AccessSensitivitySchema,
  AuthorizeMemoryRetrievalInputSchema,
  ControlScopeIdSchema,
  MemorySleeveIdSchema
} from '../agents/access-control-contracts';

const fragmentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sourceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const extractionVersionPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const tagPattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const MemoryFragmentIdSchema = z.string().regex(fragmentIdPattern);
export const MemorySourceIdSchema = z.string().regex(sourceIdPattern);
export const MemorySourceHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const MemoryKindSchema = z.enum([
  'policy',
  'identity',
  'fact',
  'decision',
  'preference',
  'procedure',
  'blueprint',
  'episode',
  'artifact',
  'summary'
]);
export const MemorySensitivitySchema = AccessSensitivitySchema;

export const MemoryFragmentInputSchema = z
  .strictObject({
    id: MemoryFragmentIdSchema,
    ownerScopeId: ControlScopeIdSchema,
    sleeveId: MemorySleeveIdSchema,
    sourceId: MemorySourceIdSchema,
    sourceHash: MemorySourceHashSchema,
    extractionVersion: z.string().regex(extractionVersionPattern),
    kind: MemoryKindSchema,
    title: z.string().trim().min(1).max(240),
    content: z.string().min(1).max(65_536),
    tags: z.array(z.string().regex(tagPattern)).max(20),
    validFrom: z.iso.datetime(),
    validUntil: z.iso.datetime().nullable(),
    recordedAt: z.iso.datetime(),
    confidencePermille: z.number().int().min(0).max(1_000),
    sensitivity: MemorySensitivitySchema,
    supersedesFragmentId: MemoryFragmentIdSchema.nullable(),
    reviewAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    retrievalEligible: z.boolean()
  })
  .superRefine((fragment, context) => {
    if (fragment.validUntil !== null && fragment.validUntil <= fragment.validFrom) {
      context.addIssue({
        code: 'custom',
        path: ['validUntil'],
        message: 'validUntil must be later than validFrom'
      });
    }
    if (fragment.expiresAt !== null && fragment.expiresAt <= fragment.recordedAt) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be later than recordedAt'
      });
    }
    if (fragment.supersedesFragmentId === fragment.id) {
      context.addIssue({
        code: 'custom',
        path: ['supersedesFragmentId'],
        message: 'A memory fragment cannot supersede itself'
      });
    }
    const uniqueTags = new Set(fragment.tags);
    if (uniqueTags.size !== fragment.tags.length) {
      context.addIssue({
        code: 'custom',
        path: ['tags'],
        message: 'Memory fragment tags must be unique'
      });
    }
  });

export const MemoryFragmentRecordSchema = MemoryFragmentInputSchema.safeExtend({
  supersededByFragmentId: MemoryFragmentIdSchema.nullable()
});

export const LexicalRetrievalQuerySchema = z.strictObject({
  authorization: AuthorizeMemoryRetrievalInputSchema.safeExtend({
    permission: z.literal('read')
  }),
  text: z.string().trim().min(2).max(1_000),
  limit: z.number().int().min(1).max(25)
});

export type MemoryFragmentId = z.infer<typeof MemoryFragmentIdSchema>;
export type MemorySourceId = z.infer<typeof MemorySourceIdSchema>;
export type MemoryFragmentInput = z.infer<typeof MemoryFragmentInputSchema>;
export type MemoryFragmentRecord = z.infer<typeof MemoryFragmentRecordSchema>;
export type LexicalRetrievalQuery = z.infer<typeof LexicalRetrievalQuerySchema>;

export type RetrievalOmissionReason =
  | 'result_limit'
  | 'expired'
  | 'superseded'
  | 'retrieval_disabled'
  | 'not_yet_valid'
  | 'validity_ended';

export interface LexicalRetrievalItem extends MemoryFragmentRecord {
  bm25: number;
  rank: number;
  selectionReason: 'lexical_bm25';
}

export interface RetrievalManifestSelected {
  fragmentId: MemoryFragmentId;
  sourceId: MemorySourceId;
  rank: number;
  reason: 'lexical_bm25';
}

export interface RetrievalManifestOmitted {
  fragmentId: MemoryFragmentId;
  sourceId: MemorySourceId;
  bm25: number;
  reason: RetrievalOmissionReason;
}

export interface LexicalSelectionManifest {
  algorithm: 'sqlite_fts5_bm25_v1';
  ownerScopeId: MemoryFragmentRecord['ownerScopeId'];
  sleeveId: MemoryFragmentRecord['sleeveId'];
  evaluatedAt: string;
  queryHash: string;
  normalizedTerms: string[];
  selected: RetrievalManifestSelected[];
  omitted: RetrievalManifestOmitted[];
  fingerprint: string;
}

export interface LexicalRetrievalResult {
  ownerScopeId: MemoryFragmentRecord['ownerScopeId'];
  sleeveId: MemoryFragmentRecord['sleeveId'];
  items: LexicalRetrievalItem[];
  manifest: LexicalSelectionManifest;
}
