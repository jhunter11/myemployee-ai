import { z } from 'zod';

export const ModelWorkTypeSchema = z.enum([
  'deterministic',
  'classification',
  'extraction',
  'drafting',
  'summarization',
  'synthesis',
  'code',
  'review'
]);

export const ModelRouteInputSchema = z.strictObject({
  operation: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  workType: ModelWorkTypeSchema,
  risk: z.enum(['low', 'medium', 'high']),
  sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']),
  assurance: z.enum(['standard', 'high']),
  priorValidationFailures: z.number().int().min(0).max(2),
  networkMode: z.enum(['none', 'local_only', 'allowlist'])
});

export const ContextProvenanceSchema = z.strictObject({
  kind: z.enum(['policy', 'request', 'repository', 'memory', 'tool']),
  reference: z.string().trim().min(1).max(256)
});

export const ContextFragmentSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/),
  priority: z.number().int().min(0).max(100),
  required: z.boolean(),
  provenance: ContextProvenanceSchema,
  content: z.string().min(1).max(65_536)
});

export const ContextBudgetInputSchema = z
  .strictObject({
    maxUtf8Bytes: z.number().int().min(1).max(1_048_576),
    maxEstimatedTokens: z.number().int().min(1).max(262_144),
    fragments: z.array(ContextFragmentSchema).max(64)
  })
  .superRefine((input, context) => {
    const seen = new Set<string>();
    for (const fragment of input.fragments) {
      if (seen.has(fragment.id)) {
        context.addIssue({
          code: 'custom',
          path: ['fragments'],
          message: `Duplicate context fragment id: ${fragment.id}`
        });
      }
      seen.add(fragment.id);
    }
  });

export type ModelRouteInput = z.infer<typeof ModelRouteInputSchema>;
export type ContextProvenance = z.infer<typeof ContextProvenanceSchema>;
export type ContextFragment = z.infer<typeof ContextFragmentSchema>;
export type ContextBudgetInput = z.infer<typeof ContextBudgetInputSchema>;
