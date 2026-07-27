import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import SQLite from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CalendarProviderAuthorizationError,
  type CalendarProviderAdapter
} from '../../src/personal/calendar-provider-contracts';
import { SqliteCalendarProviderRepository } from '../../src/personal/calendar-provider-repository';
import { CalendarProviderSyncService } from '../../src/personal/calendar-sync-service';
import { ProviderCalendarReader } from '../../src/personal/provider-calendar-reader';

const projectRoot = join(__dirname, '..', '..');
const personal = { kind: 'personal' as const, scopeId: 'personal:jarvis' };
const client = { kind: 'client' as const, scopeId: 'client:acme' };
const createdAt = '2026-07-21T12:00:00.000Z';

function adapter(pull: CalendarProviderAdapter['pullIncremental']): CalendarProviderAdapter {
  return { providerKey: 'test_provider', pullIncremental: pull };
}

describe('provider-neutral calendar sync', () => {
  let sqlite: SQLite.Database;
  let repository: SqliteCalendarProviderRepository;

  beforeEach(async () => {
    sqlite = new SQLite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(
      await readFile(join(projectRoot, 'src/db/migrations/014_calendar_connections.sql'), 'utf8')
    );
    repository = new SqliteCalendarProviderRepository(sqlite);
  });

  afterEach(() => sqlite.close());

  it('registers idempotently but never rebinds an existing connection ID', async () => {
    const registration = {
      connectionId: 'jarvis_primary',
      binding: personal,
      providerKey: 'test_provider',
      createdAt
    };

    const first = await repository.register(registration);
    await expect(repository.register(registration)).resolves.toEqual(first);
    expect(() => repository.register({ ...registration, binding: client })).toThrow(
      'calendar connection ID is already bound'
    );
  });

  it('reports a configured but disconnected calendar honestly and never calls the provider', async () => {
    await repository.register({
      connectionId: 'jarvis_primary',
      binding: personal,
      providerKey: 'test_provider',
      createdAt
    });
    const pull = vi.fn<CalendarProviderAdapter['pullIncremental']>();
    const service = new CalendarProviderSyncService(repository, {
      now: () => '2026-07-21T12:01:00.000Z'
    });

    await expect(
      service.sync({
        binding: personal,
        connectionId: 'jarvis_primary',
        adapter: adapter(pull),
        limit: 50
      })
    ).rejects.toMatchObject({ code: 'CALENDAR_CONNECTION_UNAVAILABLE' });
    expect(pull).not.toHaveBeenCalled();

    const reader = new ProviderCalendarReader(repository, {
      binding: personal,
      connectionId: 'jarvis_primary',
      now: () => '2026-07-21T12:01:00.000Z'
    });
    await expect(
      reader.read({
        from: '2026-07-21T00:00:00.000Z',
        to: '2026-07-22T00:00:00.000Z',
        limit: 10
      })
    ).rejects.toMatchObject({ code: 'CALENDAR_CONNECTION_UNAVAILABLE' });
  });

  it('atomically ingests normalized events and advances an opaque incremental cursor', async () => {
    await repository.register({
      connectionId: 'jarvis_primary',
      binding: personal,
      providerKey: 'test_provider',
      createdAt
    });
    await repository.activate({
      connectionId: 'jarvis_primary',
      binding: personal,
      expectedVersion: 1,
      credentialExpiresAt: '2026-08-21T12:00:00.000Z',
      activatedAt: '2026-07-21T12:01:00.000Z'
    });
    const pull = vi.fn<CalendarProviderAdapter['pullIncremental']>().mockResolvedValue({
      changes: [
        {
          kind: 'upsert',
          providerEventId: 'provider/event#42',
          providerRevision: 'revision-1',
          title: 'Client discovery',
          start: '2026-07-21T14:00:00.000Z',
          end: '2026-07-21T14:45:00.000Z',
          allDay: false,
          location: 'Video call',
          attendeeCount: 2
        }
      ],
      nextCursor: 'opaque.cursor/one',
      hasMore: false
    });
    const service = new CalendarProviderSyncService(repository, {
      now: () => '2026-07-21T12:02:00.000Z'
    });

    const result = await service.sync({
      binding: personal,
      connectionId: 'jarvis_primary',
      adapter: adapter(pull),
      limit: 50
    });

    expect(pull).toHaveBeenCalledWith({ cursor: null, limit: 50 });
    expect(result).toMatchObject({ upserted: 1, deleted: 0, hasMore: false });
    expect(result.connection).toMatchObject({
      state: 'active',
      syncCursor: 'opaque.cursor/one',
      lastSyncedAt: '2026-07-21T12:02:00.000Z',
      lastErrorCode: null,
      version: 3
    });

    const reader = new ProviderCalendarReader(repository, {
      binding: personal,
      connectionId: 'jarvis_primary',
      now: () => '2026-07-21T12:03:00.000Z'
    });
    await expect(reader.connectionState()).resolves.toMatchObject({
      state: 'active',
      syncCursor: 'opaque.cursor/one'
    });
    const snapshot = await reader.read({
      from: '2026-07-21T00:00:00.000Z',
      to: '2026-07-22T00:00:00.000Z',
      limit: 10
    });
    expect(snapshot).toMatchObject({
      events: [{ title: 'Client discovery', source: 'provider' }],
      conflicts: [],
      truncated: false
    });
    expect(snapshot.events[0]?.id).toMatch(/^calendar:[a-f0-9]{48}$/);
  });

  it('uses the stored cursor on the next sync and applies upserts and tombstones together', async () => {
    await repository.register({
      connectionId: 'jarvis_primary',
      binding: personal,
      providerKey: 'test_provider',
      createdAt
    });
    await repository.activate({
      connectionId: 'jarvis_primary',
      binding: personal,
      expectedVersion: 1,
      credentialExpiresAt: '2026-08-21T12:00:00.000Z',
      activatedAt: '2026-07-21T12:01:00.000Z'
    });
    const pull = vi
      .fn<CalendarProviderAdapter['pullIncremental']>()
      .mockResolvedValueOnce({
        changes: [
          {
            kind: 'upsert',
            providerEventId: 'old-event',
            providerRevision: '1',
            title: 'Old event',
            start: '2026-07-21T13:00:00.000Z',
            end: '2026-07-21T14:00:00.000Z',
            allDay: false,
            location: null,
            attendeeCount: 0
          }
        ],
        nextCursor: 'cursor-1',
        hasMore: true
      })
      .mockResolvedValueOnce({
        changes: [
          { kind: 'delete', providerEventId: 'old-event', providerRevision: '2' },
          {
            kind: 'upsert',
            providerEventId: 'new-event',
            providerRevision: '1',
            title: 'New event',
            start: '2026-07-21T15:00:00.000Z',
            end: '2026-07-21T16:00:00.000Z',
            allDay: false,
            location: null,
            attendeeCount: 1
          }
        ],
        nextCursor: 'cursor-2',
        hasMore: false
      });
    const times = ['2026-07-21T12:02:00.000Z', '2026-07-21T12:03:00.000Z'];
    const service = new CalendarProviderSyncService(repository, {
      now: () => times.shift() ?? '2026-07-21T12:03:00.000Z'
    });

    await service.sync({
      binding: personal,
      connectionId: 'jarvis_primary',
      adapter: adapter(pull),
      limit: 25
    });
    const result = await service.sync({
      binding: personal,
      connectionId: 'jarvis_primary',
      adapter: adapter(pull),
      limit: 25
    });

    expect(pull).toHaveBeenNthCalledWith(2, { cursor: 'cursor-1', limit: 25 });
    expect(result).toMatchObject({ upserted: 1, deleted: 1, hasMore: false });
    await expect(
      repository.readEvents({
        binding: personal,
        connectionId: 'jarvis_primary',
        from: '2026-07-21T00:00:00.000Z',
        to: '2026-07-22T00:00:00.000Z',
        limit: 10
      })
    ).resolves.toEqual([expect.objectContaining({ title: 'New event' })]);
  });

  it('binds reads and syncs to the exact personal or client scope', async () => {
    await repository.register({
      connectionId: 'jarvis_primary',
      binding: personal,
      providerKey: 'test_provider',
      createdAt
    });
    await repository.register({
      connectionId: 'acme_primary',
      binding: client,
      providerKey: 'test_provider',
      createdAt
    });
    const pull = vi.fn<CalendarProviderAdapter['pullIncremental']>();
    const service = new CalendarProviderSyncService(repository, {
      now: () => '2026-07-21T12:05:00.000Z'
    });

    await expect(
      service.sync({
        binding: client,
        connectionId: 'jarvis_primary',
        adapter: adapter(pull),
        limit: 25
      })
    ).rejects.toMatchObject({ code: 'CALENDAR_CONNECTION_UNAVAILABLE' });
    expect(pull).not.toHaveBeenCalled();
    await expect(repository.findExact(client, 'jarvis_primary')).resolves.toBeNull();

    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO calendar_provider_events (
             calendar_event_id, connection_id, scope_id, provider_event_id, provider_revision,
             title, start_at, end_at, all_day, location, attendee_count, event_state,
             first_seen_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
        )
        .run(
          `calendar:${'a'.repeat(48)}`,
          'jarvis_primary',
          'client:acme',
          'cross-scope',
          '1',
          'Forbidden',
          '2026-07-21T15:00:00.000Z',
          '2026-07-21T16:00:00.000Z',
          0,
          null,
          0,
          createdAt,
          createdAt
        )
    ).toThrow();
  });

  it.each([
    ['credential_expired', new CalendarProviderAuthorizationError('credential_expired')],
    ['revoked', new CalendarProviderAuthorizationError('revoked')]
  ] as const)('fails closed and persists a sanitized %s state', async (state, providerError) => {
    await repository.register({
      connectionId: 'jarvis_primary',
      binding: personal,
      providerKey: 'test_provider',
      createdAt
    });
    await repository.activate({
      connectionId: 'jarvis_primary',
      binding: personal,
      expectedVersion: 1,
      credentialExpiresAt: '2026-08-21T12:00:00.000Z',
      activatedAt: '2026-07-21T12:01:00.000Z'
    });
    const pull = vi
      .fn<CalendarProviderAdapter['pullIncremental']>()
      .mockRejectedValue(Object.assign(providerError, { secret: 'raw-provider-token' }));
    const service = new CalendarProviderSyncService(repository, {
      now: () => '2026-07-21T12:02:00.000Z'
    });

    await expect(
      service.sync({
        binding: personal,
        connectionId: 'jarvis_primary',
        adapter: adapter(pull),
        limit: 25
      })
    ).rejects.toMatchObject({ code: 'CALENDAR_CONNECTION_UNAVAILABLE' });

    const connection = await repository.findExact(personal, 'jarvis_primary');
    expect(connection).toMatchObject({ state, lastErrorCode: state, syncCursor: null });
    expect(JSON.stringify(connection)).not.toContain('raw-provider-token');
    await expect(
      new ProviderCalendarReader(repository, {
        binding: personal,
        connectionId: 'jarvis_primary',
        now: () => '2026-07-21T12:03:00.000Z'
      }).read({
        from: '2026-07-21T00:00:00.000Z',
        to: '2026-07-22T00:00:00.000Z',
        limit: 10
      })
    ).rejects.toMatchObject({ code: 'CALENDAR_CONNECTION_UNAVAILABLE' });
  });

  it('sanitizes a transient provider failure and permits a later retry', async () => {
    await repository.register({
      connectionId: 'jarvis_primary',
      binding: personal,
      providerKey: 'test_provider',
      createdAt
    });
    await repository.activate({
      connectionId: 'jarvis_primary',
      binding: personal,
      expectedVersion: 1,
      credentialExpiresAt: null,
      activatedAt: '2026-07-21T12:01:00.000Z'
    });
    const pull = vi
      .fn<CalendarProviderAdapter['pullIncremental']>()
      .mockRejectedValueOnce(new Error('RAW_PROVIDER_FAILURE token=secret'))
      .mockResolvedValueOnce({ changes: [], nextCursor: 'recovered-cursor', hasMore: false });
    const times = ['2026-07-21T12:02:00.000Z', '2026-07-21T12:03:00.000Z'];
    const service = new CalendarProviderSyncService(repository, {
      now: () => times.shift() ?? '2026-07-21T12:03:00.000Z'
    });
    const input = {
      binding: personal,
      connectionId: 'jarvis_primary',
      adapter: adapter(pull),
      limit: 25
    };

    await expect(service.sync(input)).rejects.toMatchObject({
      code: 'CALENDAR_CONNECTION_UNAVAILABLE',
      message: 'Calendar connection is unavailable'
    });
    await expect(repository.findExact(personal, 'jarvis_primary')).resolves.toMatchObject({
      state: 'provider_error',
      lastErrorCode: 'provider_unavailable',
      version: 3
    });
    await expect(service.sync(input)).resolves.toMatchObject({
      connection: { state: 'active', lastErrorCode: null, syncCursor: 'recovered-cursor' }
    });
  });

  it('does not call the provider after the credential expiry boundary', async () => {
    await repository.register({
      connectionId: 'jarvis_primary',
      binding: personal,
      providerKey: 'test_provider',
      createdAt
    });
    await repository.activate({
      connectionId: 'jarvis_primary',
      binding: personal,
      expectedVersion: 1,
      credentialExpiresAt: '2026-07-21T12:01:00.000Z',
      activatedAt: '2026-07-21T12:00:30.000Z'
    });
    const pull = vi.fn<CalendarProviderAdapter['pullIncremental']>();
    const service = new CalendarProviderSyncService(repository, {
      now: () => '2026-07-21T12:01:00.000Z'
    });

    await expect(
      service.sync({
        binding: personal,
        connectionId: 'jarvis_primary',
        adapter: adapter(pull),
        limit: 25
      })
    ).rejects.toMatchObject({ code: 'CALENDAR_CONNECTION_UNAVAILABLE' });
    expect(pull).not.toHaveBeenCalled();
    await expect(repository.findExact(personal, 'jarvis_primary')).resolves.toMatchObject({
      state: 'credential_expired',
      lastErrorCode: 'credential_expired'
    });
  });

  it('rolls back every event and cursor change when a provider delta is malformed', async () => {
    await repository.register({
      connectionId: 'jarvis_primary',
      binding: personal,
      providerKey: 'test_provider',
      createdAt
    });
    await repository.activate({
      connectionId: 'jarvis_primary',
      binding: personal,
      expectedVersion: 1,
      credentialExpiresAt: '2026-08-21T12:00:00.000Z',
      activatedAt: '2026-07-21T12:01:00.000Z'
    });
    const pull = vi.fn().mockResolvedValue({
      changes: [
        {
          kind: 'upsert',
          providerEventId: 'bad-event',
          providerRevision: '1',
          title: 'Impossible event',
          start: '2026-07-21T15:00:00.000Z',
          end: '2026-07-21T14:00:00.000Z',
          allDay: false,
          location: null,
          attendeeCount: 0
        }
      ],
      nextCursor: 'must-not-commit',
      hasMore: false
    });
    const service = new CalendarProviderSyncService(repository, {
      now: () => '2026-07-21T12:02:00.000Z'
    });

    await expect(
      service.sync({
        binding: personal,
        connectionId: 'jarvis_primary',
        adapter: adapter(pull),
        limit: 25
      })
    ).rejects.toMatchObject({ code: 'CALENDAR_PROVIDER_INVALID_RESPONSE' });
    await expect(repository.findExact(personal, 'jarvis_primary')).resolves.toMatchObject({
      state: 'provider_error',
      syncCursor: null,
      lastSyncedAt: null,
      lastErrorCode: 'invalid_response'
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_provider_events').get()).toEqual({
      count: 0
    });
  });

  it('rejects stale or expired persistence attempts without advancing state', async () => {
    await repository.register({
      connectionId: 'jarvis_primary',
      binding: personal,
      providerKey: 'test_provider',
      createdAt
    });
    await repository.activate({
      connectionId: 'jarvis_primary',
      binding: personal,
      expectedVersion: 1,
      credentialExpiresAt: '2026-07-21T12:05:00.000Z',
      activatedAt: '2026-07-21T12:01:00.000Z'
    });
    const delta = { changes: [], nextCursor: 'forbidden-cursor', hasMore: false };

    expect(() =>
      repository.persistDelta({
        binding: personal,
        connectionId: 'jarvis_primary',
        expectedVersion: 99,
        expectedCursor: null,
        delta,
        syncedAt: '2026-07-21T12:02:00.000Z'
      })
    ).toThrow('calendar sync version conflict');
    expect(() =>
      repository.persistDelta({
        binding: personal,
        connectionId: 'jarvis_primary',
        expectedVersion: 2,
        expectedCursor: null,
        delta,
        syncedAt: '2026-07-21T12:05:00.000Z'
      })
    ).toThrow('calendar credential expired during sync');
    await expect(repository.findExact(personal, 'jarvis_primary')).resolves.toMatchObject({
      state: 'active',
      syncCursor: null,
      version: 2
    });
  });
});
