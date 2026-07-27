import {
  CalendarConnectionUnavailableError,
  CalendarProviderAuthorizationError,
  CalendarProviderDeltaSchema,
  CalendarProviderInvalidResponseError,
  CalendarProviderKeySchema,
  CalendarSyncInputSchema,
  type CalendarConnectionRecord,
  type CalendarProviderAdapter,
  type CalendarScopeBinding
} from './calendar-provider-contracts';
import type { SqliteCalendarProviderRepository } from './calendar-provider-repository';

export interface CalendarSyncResult {
  connection: CalendarConnectionRecord;
  upserted: number;
  deleted: number;
  hasMore: boolean;
}

export class CalendarProviderSyncService {
  private readonly now: () => string;

  constructor(
    private readonly repository: SqliteCalendarProviderRepository,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async sync(rawInput: {
    binding: CalendarScopeBinding;
    connectionId: string;
    adapter: CalendarProviderAdapter;
    limit: number;
  }): Promise<CalendarSyncResult> {
    const input = CalendarSyncInputSchema.parse({
      binding: rawInput.binding,
      connectionId: rawInput.connectionId,
      limit: rawInput.limit
    });
    const providerKey = CalendarProviderKeySchema.parse(rawInput.adapter.providerKey);
    const connection = await this.repository.findExact(input.binding, input.connectionId);
    if (
      connection === null ||
      connection.providerKey !== providerKey ||
      (connection.state !== 'active' && connection.state !== 'provider_error')
    ) {
      throw new CalendarConnectionUnavailableError();
    }

    const syncedAt = new Date(this.now()).toISOString();
    if (
      connection.credentialExpiresAt !== null &&
      Date.parse(connection.credentialExpiresAt) <= Date.parse(syncedAt)
    ) {
      await this.repository.markFailure({
        binding: input.binding,
        connectionId: input.connectionId,
        expectedVersion: connection.version,
        state: 'credential_expired',
        errorCode: 'credential_expired',
        failedAt: syncedAt
      });
      throw new CalendarConnectionUnavailableError();
    }

    let rawDelta: unknown;
    try {
      rawDelta = await rawInput.adapter.pullIncremental({
        cursor: connection.syncCursor,
        limit: input.limit
      });
    } catch (error) {
      if (error instanceof CalendarProviderAuthorizationError) {
        await this.repository.markFailure({
          binding: input.binding,
          connectionId: input.connectionId,
          expectedVersion: connection.version,
          state: error.reason,
          errorCode: error.reason,
          failedAt: syncedAt
        });
      } else {
        await this.repository.markFailure({
          binding: input.binding,
          connectionId: input.connectionId,
          expectedVersion: connection.version,
          state: 'provider_error',
          errorCode: 'provider_unavailable',
          failedAt: syncedAt
        });
      }
      throw new CalendarConnectionUnavailableError();
    }

    const parsed = CalendarProviderDeltaSchema.safeParse(rawDelta);
    if (!parsed.success) {
      await this.repository.markFailure({
        binding: input.binding,
        connectionId: input.connectionId,
        expectedVersion: connection.version,
        state: 'provider_error',
        errorCode: 'invalid_response',
        failedAt: syncedAt
      });
      throw new CalendarProviderInvalidResponseError();
    }

    const stored = await this.repository.persistDelta({
      binding: input.binding,
      connectionId: input.connectionId,
      expectedVersion: connection.version,
      expectedCursor: connection.syncCursor,
      delta: parsed.data,
      syncedAt
    });
    return { ...stored, hasMore: parsed.data.hasMore };
  }
}
