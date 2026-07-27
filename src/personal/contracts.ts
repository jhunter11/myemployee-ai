import { z } from 'zod';

export const PersonalMemoryIdSchema = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/);
export const PersonalMemoryBranchSchema = z.enum([
  'identity',
  'preferences',
  'people',
  'projects',
  'decisions',
  'routines',
  'learning'
]);
const MemoryTextSchema = z.string().trim().min(1).max(500);

export const PersonalMemoryCorrectionSchema = z.strictObject({
  correctedAt: z.iso.datetime(),
  reason: MemoryTextSchema,
  previousSummary: MemoryTextSchema
});

export const PersonalMemoryRecordSchema = z.strictObject({
  version: z.literal(1),
  id: PersonalMemoryIdSchema,
  branch: PersonalMemoryBranchSchema,
  title: z.string().trim().min(1).max(120),
  summary: MemoryTextSchema,
  provenance: z.enum(['operator_statement', 'operator_correction', 'observed_pattern']),
  confidence: z.number().min(0).max(1),
  sensitivity: z.enum(['private', 'confidential']),
  scope: z.literal('personal'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  reviewAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  corrections: z.array(PersonalMemoryCorrectionSchema).max(25)
});

export const PersonalMemorySummarySchema = PersonalMemoryRecordSchema.pick({
  id: true,
  branch: true,
  title: true,
  summary: true,
  confidence: true,
  sensitivity: true,
  reviewAt: true
}).extend({ source: z.string().regex(/^personal-memory:[a-z][a-z0-9-]{2,63}$/) });

export const PersonalCalendarEventSchema = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/),
    title: z.string().trim().min(1).max(160),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    allDay: z.boolean(),
    location: z.string().trim().min(1).max(160).nullable(),
    attendeeCount: z.number().int().min(0).max(500),
    source: z.enum(['local_demo', 'provider'])
  })
  .refine((event) => Date.parse(event.end) > Date.parse(event.start), {
    message: 'event end must follow start',
    path: ['end']
  });

export type PersonalMemoryRecord = z.infer<typeof PersonalMemoryRecordSchema>;
export type PersonalMemorySummary = z.infer<typeof PersonalMemorySummarySchema>;
export type PersonalCalendarEvent = z.infer<typeof PersonalCalendarEventSchema>;
