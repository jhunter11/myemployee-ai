import { z } from 'zod';

import { AppError } from '../utils/errors';

export const CalendarConnectionIdSchema = z.string().regex(/^[a-z][a-z0-9_]{2,63}$/);
export const CalendarProviderKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);

const PersonalCalendarBindingSchema = z.strictObject({
  kind: z.literal('personal'),
  scopeId: z.string().regex(/^personal:[a-z][a-z0-9_-]{1,95}$/)
});
const ClientCalendarBindingSchema = z.strictObject({
  kind: z.literal('client'),
  scopeId: z.string().regex(/^client:[a-z][a-z0-9_-]{1,95}$/)
});

export const CalendarScopeBindingSchema = z.discriminatedUnion('kind', [
  PersonalCalendarBindingSchema,
  ClientCalendarBindingSchema
]);

export const CalendarConnectionStateSchema = z.enum([
  'disconnected',
  'active',
  'credential_expired',
  'revoked',
  'provider_error'
]);

export const CalendarConnectionErrorCodeSchema = z.enum([
  'credential_expired',
  'revoked',
  'provider_unavailable',
  'invalid_response'
]);

export const CalendarConnectionRecordSchema = z.strictObject({
  connectionId: CalendarConnectionIdSchema,
  binding: CalendarScopeBindingSchema,
  providerKey: CalendarProviderKeySchema,
  state: CalendarConnectionStateSchema,
  syncCursor: z.string().min(1).max(4096).nullable(),
  credentialExpiresAt: z.iso.datetime({ offset: true }).nullable(),
  lastSyncedAt: z.iso.datetime({ offset: true }).nullable(),
  lastErrorCode: CalendarConnectionErrorCodeSchema.nullable(),
  version: z.number().int().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true })
});

export const RegisterCalendarConnectionInputSchema = z.strictObject({
  connectionId: CalendarConnectionIdSchema,
  binding: CalendarScopeBindingSchema,
  providerKey: CalendarProviderKeySchema,
  createdAt: z.iso.datetime({ offset: true })
});

export const ActivateCalendarConnectionInputSchema = z
  .strictObject({
    connectionId: CalendarConnectionIdSchema,
    binding: CalendarScopeBindingSchema,
    expectedVersion: z.number().int().min(1),
    credentialExpiresAt: z.iso.datetime({ offset: true }).nullable(),
    activatedAt: z.iso.datetime({ offset: true })
  })
  .refine(
    (input) =>
      input.credentialExpiresAt === null ||
      Date.parse(input.credentialExpiresAt) > Date.parse(input.activatedAt),
    { message: 'credential expiry must follow activation', path: ['credentialExpiresAt'] }
  );

const ProviderEventIdSchema = z.string().trim().min(1).max(512);
const ProviderRevisionSchema = z.string().trim().min(1).max(512);

export const CalendarProviderUpsertSchema = z
  .strictObject({
    kind: z.literal('upsert'),
    providerEventId: ProviderEventIdSchema,
    providerRevision: ProviderRevisionSchema,
    title: z.string().trim().min(1).max(160),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    allDay: z.boolean(),
    location: z.string().trim().min(1).max(160).nullable(),
    attendeeCount: z.number().int().min(0).max(500)
  })
  .refine((event) => Date.parse(event.end) > Date.parse(event.start), {
    message: 'event end must follow start',
    path: ['end']
  });

export const CalendarProviderDeleteSchema = z.strictObject({
  kind: z.literal('delete'),
  providerEventId: ProviderEventIdSchema,
  providerRevision: ProviderRevisionSchema
});

export const CalendarProviderDeltaSchema = z.strictObject({
  changes: z
    .array(
      z.discriminatedUnion('kind', [CalendarProviderUpsertSchema, CalendarProviderDeleteSchema])
    )
    .max(500),
  nextCursor: z.string().min(1).max(4096),
  hasMore: z.boolean()
});

export const CalendarSyncInputSchema = z.strictObject({
  binding: CalendarScopeBindingSchema,
  connectionId: CalendarConnectionIdSchema,
  limit: z.number().int().min(1).max(500)
});

export type CalendarScopeBinding = z.infer<typeof CalendarScopeBindingSchema>;
export type CalendarConnectionRecord = z.infer<typeof CalendarConnectionRecordSchema>;
export type RegisterCalendarConnectionInput = z.infer<typeof RegisterCalendarConnectionInputSchema>;
export type ActivateCalendarConnectionInput = z.infer<typeof ActivateCalendarConnectionInputSchema>;
export type CalendarProviderDelta = z.infer<typeof CalendarProviderDeltaSchema>;
export type CalendarProviderChange = CalendarProviderDelta['changes'][number];

export interface CalendarProviderAdapter {
  readonly providerKey: string;
  pullIncremental(input: { cursor: string | null; limit: number }): Promise<unknown>;
}

export class CalendarProviderAuthorizationError extends Error {
  constructor(readonly reason: 'credential_expired' | 'revoked') {
    super('Calendar provider authorization is unavailable');
    this.name = 'CalendarProviderAuthorizationError';
  }
}

export class CalendarConnectionUnavailableError extends AppError {
  constructor() {
    super(503, 'CALENDAR_CONNECTION_UNAVAILABLE', 'Calendar connection is unavailable');
    this.name = 'CalendarConnectionUnavailableError';
  }
}

export class CalendarProviderInvalidResponseError extends AppError {
  constructor() {
    super(502, 'CALENDAR_PROVIDER_INVALID_RESPONSE', 'Calendar provider response is invalid');
    this.name = 'CalendarProviderInvalidResponseError';
  }
}
