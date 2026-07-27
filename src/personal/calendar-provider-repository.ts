import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type SQLite from 'better-sqlite3';
import { z } from 'zod';

import { type PersonalCalendarEvent, PersonalCalendarEventSchema } from './contracts';
import {
  ActivateCalendarConnectionInputSchema,
  CalendarConnectionErrorCodeSchema,
  CalendarConnectionRecordSchema,
  CalendarConnectionStateSchema,
  CalendarProviderDeltaSchema,
  CalendarScopeBindingSchema,
  RegisterCalendarConnectionInputSchema,
  type ActivateCalendarConnectionInput,
  type CalendarConnectionRecord,
  type CalendarProviderDelta,
  type CalendarScopeBinding,
  type RegisterCalendarConnectionInput
} from './calendar-provider-contracts';

interface CalendarConnectionRow {
  connection_id: string;
  scope_kind: string;
  scope_id: string;
  provider_key: string;
  state: string;
  sync_cursor: string | null;
  credential_expires_at: string | null;
  last_synced_at: string | null;
  last_error_code: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface CalendarEventRow {
  calendar_event_id: string;
  title: string;
  start_at: string;
  end_at: string;
  all_day: number;
  location: string | null;
  attendee_count: number;
}

const CalendarEventReadInputSchema = z
  .strictObject({
    binding: CalendarScopeBindingSchema,
    connectionId: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    limit: z.number().int().min(1).max(51)
  })
  .refine((input) => Date.parse(input.to) > Date.parse(input.from), {
    message: 'to must follow from',
    path: ['to']
  });

const MarkConnectionFailureInputSchema = z.strictObject({
  binding: CalendarScopeBindingSchema,
  connectionId: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  expectedVersion: z.number().int().min(1),
  state: CalendarConnectionStateSchema.extract(['credential_expired', 'revoked', 'provider_error']),
  errorCode: CalendarConnectionErrorCodeSchema,
  failedAt: z.iso.datetime({ offset: true })
});

const PersistCalendarDeltaInputSchema = z.strictObject({
  binding: CalendarScopeBindingSchema,
  connectionId: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  expectedVersion: z.number().int().min(1),
  expectedCursor: z.string().min(1).max(4096).nullable(),
  delta: CalendarProviderDeltaSchema,
  syncedAt: z.iso.datetime({ offset: true })
});

function canonicalTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function connectionFromRow(row: CalendarConnectionRow): CalendarConnectionRecord {
  return CalendarConnectionRecordSchema.parse({
    connectionId: row.connection_id,
    binding: { kind: row.scope_kind, scopeId: row.scope_id },
    providerKey: row.provider_key,
    state: row.state,
    syncCursor: row.sync_cursor,
    credentialExpiresAt: row.credential_expires_at,
    lastSyncedAt: row.last_synced_at,
    lastErrorCode: row.last_error_code,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function eventFromRow(row: CalendarEventRow): PersonalCalendarEvent {
  return PersonalCalendarEventSchema.parse({
    id: row.calendar_event_id,
    title: row.title,
    start: row.start_at,
    end: row.end_at,
    allDay: Boolean(row.all_day),
    location: row.location,
    attendeeCount: row.attendee_count,
    source: 'provider'
  });
}

function calendarEventId(connectionId: string, providerEventId: string): string {
  const digest = createHash('sha256')
    .update(`${connectionId}\u0000${providerEventId}`, 'utf8')
    .digest('hex');
  return `calendar:${digest.slice(0, 48)}`;
}

function exactRegistration(
  input: RegisterCalendarConnectionInput,
  record: CalendarConnectionRecord
): boolean {
  return (
    input.connectionId === record.connectionId &&
    input.providerKey === record.providerKey &&
    isDeepStrictEqual(input.binding, record.binding) &&
    canonicalTimestamp(input.createdAt) === record.createdAt
  );
}

function failurePairIsValid(input: {
  state: 'credential_expired' | 'revoked' | 'provider_error';
  errorCode: 'credential_expired' | 'revoked' | 'provider_unavailable' | 'invalid_response';
}): boolean {
  if (input.state === 'credential_expired') return input.errorCode === 'credential_expired';
  if (input.state === 'revoked') return input.errorCode === 'revoked';
  return input.errorCode === 'provider_unavailable' || input.errorCode === 'invalid_response';
}

export class SqliteCalendarProviderRepository {
  constructor(private readonly sqlite: SQLite.Database) {}

  register(rawInput: RegisterCalendarConnectionInput): Promise<CalendarConnectionRecord> {
    const input = RegisterCalendarConnectionInputSchema.parse(rawInput);
    const timestamp = canonicalTimestamp(input.createdAt);
    const record = this.sqlite.transaction(() => {
      const existing = this.findRow(input.connectionId);
      if (existing !== undefined) {
        const parsed = connectionFromRow(existing);
        if (!exactRegistration(input, parsed)) {
          throw new Error('calendar connection ID is already bound');
        }
        return parsed;
      }
      this.sqlite
        .prepare(
          `INSERT INTO calendar_provider_connections (
             connection_id, scope_kind, scope_id, provider_key, state, sync_cursor,
             credential_expires_at, last_synced_at, last_error_code, version,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'disconnected', NULL, NULL, NULL, NULL, 1, ?, ?)`
        )
        .run(
          input.connectionId,
          input.binding.kind,
          input.binding.scopeId,
          input.providerKey,
          timestamp,
          timestamp
        );
      const inserted = this.findRow(input.connectionId);
      if (inserted === undefined) throw new Error('calendar connection was not stored');
      return connectionFromRow(inserted);
    })();
    return Promise.resolve(record);
  }

  activate(rawInput: ActivateCalendarConnectionInput): Promise<CalendarConnectionRecord> {
    const input = ActivateCalendarConnectionInputSchema.parse(rawInput);
    const activatedAt = canonicalTimestamp(input.activatedAt);
    const credentialExpiresAt =
      input.credentialExpiresAt === null ? null : canonicalTimestamp(input.credentialExpiresAt);
    const record = this.sqlite.transaction(() => {
      const update = this.sqlite
        .prepare(
          `UPDATE calendar_provider_connections
           SET state = 'active', sync_cursor = NULL, credential_expires_at = ?,
               last_synced_at = NULL, last_error_code = NULL,
               version = version + 1, updated_at = ?
           WHERE connection_id = ? AND scope_kind = ? AND scope_id = ? AND version = ?`
        )
        .run(
          credentialExpiresAt,
          activatedAt,
          input.connectionId,
          input.binding.kind,
          input.binding.scopeId,
          input.expectedVersion
        );
      if (update.changes !== 1) throw new Error('calendar activation version conflict');
      this.sqlite
        .prepare('DELETE FROM calendar_provider_events WHERE connection_id = ? AND scope_id = ?')
        .run(input.connectionId, input.binding.scopeId);
      const row = this.findExactRow(input.binding, input.connectionId);
      if (row === undefined) throw new Error('activated calendar connection disappeared');
      return connectionFromRow(row);
    })();
    return Promise.resolve(record);
  }

  findExact(
    rawBinding: CalendarScopeBinding,
    connectionId: string
  ): Promise<CalendarConnectionRecord | null> {
    const binding = CalendarScopeBindingSchema.parse(rawBinding);
    const parsedConnectionId = z
      .string()
      .regex(/^[a-z][a-z0-9_]{2,63}$/)
      .parse(connectionId);
    const row = this.findExactRow(binding, parsedConnectionId);
    return Promise.resolve(row === undefined ? null : connectionFromRow(row));
  }

  markFailure(rawInput: {
    binding: CalendarScopeBinding;
    connectionId: string;
    expectedVersion: number;
    state: 'credential_expired' | 'revoked' | 'provider_error';
    errorCode: 'credential_expired' | 'revoked' | 'provider_unavailable' | 'invalid_response';
    failedAt: string;
  }): Promise<CalendarConnectionRecord> {
    const input = MarkConnectionFailureInputSchema.parse(rawInput);
    if (!failurePairIsValid(input)) throw new Error('calendar failure state does not match error');
    const update = this.sqlite
      .prepare(
        `UPDATE calendar_provider_connections
         SET state = ?, last_error_code = ?, version = version + 1, updated_at = ?
         WHERE connection_id = ? AND scope_kind = ? AND scope_id = ?
           AND version = ? AND state IN ('active', 'provider_error')`
      )
      .run(
        input.state,
        input.errorCode,
        canonicalTimestamp(input.failedAt),
        input.connectionId,
        input.binding.kind,
        input.binding.scopeId,
        input.expectedVersion
      );
    if (update.changes !== 1) throw new Error('calendar failure transition version conflict');
    const row = this.findExactRow(input.binding, input.connectionId);
    if (row === undefined) throw new Error('failed calendar connection disappeared');
    return Promise.resolve(connectionFromRow(row));
  }

  persistDelta(rawInput: {
    binding: CalendarScopeBinding;
    connectionId: string;
    expectedVersion: number;
    expectedCursor: string | null;
    delta: CalendarProviderDelta;
    syncedAt: string;
  }): Promise<{ connection: CalendarConnectionRecord; upserted: number; deleted: number }> {
    const input = PersistCalendarDeltaInputSchema.parse(rawInput);
    const syncedAt = canonicalTimestamp(input.syncedAt);
    const result = this.sqlite.transaction(() => {
      const currentRow = this.findExactRow(input.binding, input.connectionId);
      if (currentRow === undefined) throw new Error('calendar connection was not found');
      const current = connectionFromRow(currentRow);
      if (
        current.version !== input.expectedVersion ||
        current.syncCursor !== input.expectedCursor ||
        (current.state !== 'active' && current.state !== 'provider_error')
      ) {
        throw new Error('calendar sync version conflict');
      }
      if (
        current.credentialExpiresAt !== null &&
        Date.parse(current.credentialExpiresAt) <= Date.parse(syncedAt)
      ) {
        throw new Error('calendar credential expired during sync');
      }

      let upserted = 0;
      let deleted = 0;
      for (const change of input.delta.changes) {
        if (change.kind === 'delete') {
          const deletion = this.sqlite
            .prepare(
              `UPDATE calendar_provider_events
               SET provider_revision = ?, event_state = 'deleted', updated_at = ?
               WHERE connection_id = ? AND scope_id = ? AND provider_event_id = ?`
            )
            .run(
              change.providerRevision,
              syncedAt,
              input.connectionId,
              input.binding.scopeId,
              change.providerEventId
            );
          deleted += deletion.changes;
          continue;
        }

        this.sqlite
          .prepare(
            `INSERT INTO calendar_provider_events (
               calendar_event_id, connection_id, scope_id, provider_event_id,
               provider_revision, title, start_at, end_at, all_day, location,
               attendee_count, event_state, first_seen_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
             ON CONFLICT(connection_id, provider_event_id) DO UPDATE SET
               provider_revision = excluded.provider_revision,
               title = excluded.title,
               start_at = excluded.start_at,
               end_at = excluded.end_at,
               all_day = excluded.all_day,
               location = excluded.location,
               attendee_count = excluded.attendee_count,
               event_state = 'active',
               updated_at = excluded.updated_at`
          )
          .run(
            calendarEventId(input.connectionId, change.providerEventId),
            input.connectionId,
            input.binding.scopeId,
            change.providerEventId,
            change.providerRevision,
            change.title,
            canonicalTimestamp(change.start),
            canonicalTimestamp(change.end),
            Number(change.allDay),
            change.location,
            change.attendeeCount,
            syncedAt,
            syncedAt
          );
        upserted += 1;
      }

      const update = this.sqlite
        .prepare(
          `UPDATE calendar_provider_connections
           SET state = 'active', sync_cursor = ?, last_synced_at = ?,
               last_error_code = NULL, version = version + 1, updated_at = ?
           WHERE connection_id = ? AND scope_kind = ? AND scope_id = ?
             AND version = ? AND sync_cursor IS ? AND state IN ('active', 'provider_error')`
        )
        .run(
          input.delta.nextCursor,
          syncedAt,
          syncedAt,
          input.connectionId,
          input.binding.kind,
          input.binding.scopeId,
          input.expectedVersion,
          input.expectedCursor
        );
      if (update.changes !== 1) throw new Error('calendar sync version conflict');
      const updated = this.findExactRow(input.binding, input.connectionId);
      if (updated === undefined) throw new Error('synced calendar connection disappeared');
      return { connection: connectionFromRow(updated), upserted, deleted };
    })();
    return Promise.resolve(result);
  }

  readEvents(rawInput: {
    binding: CalendarScopeBinding;
    connectionId: string;
    from: string;
    to: string;
    limit: number;
  }): Promise<PersonalCalendarEvent[]> {
    const input = CalendarEventReadInputSchema.parse(rawInput);
    const rows = this.sqlite
      .prepare(
        `SELECT calendar_event_id, title, start_at, end_at, all_day, location, attendee_count
         FROM calendar_provider_events
         WHERE connection_id = ? AND scope_id = ? AND event_state = 'active'
           AND end_at > ? AND start_at < ?
         ORDER BY start_at ASC, end_at ASC, calendar_event_id ASC
         LIMIT ?`
      )
      .all(
        input.connectionId,
        input.binding.scopeId,
        canonicalTimestamp(input.from),
        canonicalTimestamp(input.to),
        input.limit
      ) as CalendarEventRow[];
    return Promise.resolve(rows.map(eventFromRow));
  }

  private findRow(connectionId: string): CalendarConnectionRow | undefined {
    return this.sqlite
      .prepare('SELECT * FROM calendar_provider_connections WHERE connection_id = ?')
      .get(connectionId) as CalendarConnectionRow | undefined;
  }

  private findExactRow(
    binding: CalendarScopeBinding,
    connectionId: string
  ): CalendarConnectionRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT * FROM calendar_provider_connections
         WHERE connection_id = ? AND scope_kind = ? AND scope_id = ?`
      )
      .get(connectionId, binding.kind, binding.scopeId) as CalendarConnectionRow | undefined;
  }
}
