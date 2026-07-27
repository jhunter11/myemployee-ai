import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';

import type { EscalationEvent } from '../config/schemas';
import { EscalationEventSchema } from '../config/schemas';
import type { AuditLogsTable, JarvisDatabase } from './types';

const StoredAuditEnvelopeSchema = z.strictObject({
  runId: z.string().nullable(),
  eventDescription: z.string().min(1),
  actions: z.array(z.string().min(1))
});

interface StoredAuditEnvelope {
  runId: string | null;
  eventDescription: string;
  actions: string[];
}

export interface AuditRecord extends EscalationEvent {
  id: number;
}

export interface DashboardAuditSummary {
  unresolvedCount: number;
  recent: Array<{
    id: number;
    severity: string;
    clientId: string | null;
    runId: string | null;
    resolved: boolean;
    timestamp: string;
  }>;
}

function validateDashboardLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('dashboard limit must be an integer between 1 and 100');
  }
  return limit;
}

function encodeEnvelope(event: EscalationEvent): string {
  const envelope: StoredAuditEnvelope = {
    runId: event.runId,
    eventDescription: event.eventDescription,
    actions: event.actions
  };
  return JSON.stringify(envelope);
}

function decodeEnvelope(value: string): StoredAuditEnvelope {
  const parsed: unknown = JSON.parse(value);
  return StoredAuditEnvelopeSchema.parse(parsed);
}

function toAuditRecord(row: Selectable<AuditLogsTable>): AuditRecord {
  const envelope = decodeEnvelope(row.event_description);
  const event = EscalationEventSchema.parse({
    severity: row.severity,
    clientId: row.client_id,
    runId: envelope.runId,
    eventDescription: envelope.eventDescription,
    actions: envelope.actions,
    resolved: Boolean(row.resolved),
    timestamp: row.timestamp
  });

  return { id: row.id, ...event };
}

export class AuditRepository {
  constructor(private readonly db: Kysely<JarvisDatabase>) {}

  async record(input: EscalationEvent): Promise<AuditRecord> {
    const event = EscalationEventSchema.parse(input);
    const row = await this.db
      .insertInto('audit_logs')
      .values({
        timestamp: event.timestamp,
        severity: event.severity,
        event_description: encodeEnvelope(event),
        client_id: event.clientId,
        resolved: event.resolved ? 1 : 0
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toAuditRecord(row);
  }

  async recordRecoveryOnce(runId: string, input: EscalationEvent): Promise<AuditRecord> {
    const event = EscalationEventSchema.parse(input);
    if (event.runId !== runId) {
      throw new Error('Recovery audit run does not match its durable marker');
    }
    const eventDescription = encodeEnvelope(event);

    return this.db.transaction().execute(async (transaction) => {
      const marker = await transaction
        .selectFrom('run_recovery_queue')
        .select('audit_id')
        .where('run_id', '=', runId)
        .executeTakeFirst();
      if (marker === undefined) {
        throw new Error(`Recovery audit ${runId} has no durable marker`);
      }
      if (marker.audit_id !== null) {
        const existing = await transaction
          .selectFrom('audit_logs')
          .selectAll()
          .where('id', '=', marker.audit_id)
          .executeTakeFirst();
        if (existing === undefined) {
          throw new Error(`Recovery audit ${runId} references a missing audit record`);
        }
        return toAuditRecord(existing);
      }

      const row = await transaction
        .insertInto('audit_logs')
        .values({
          timestamp: event.timestamp,
          severity: event.severity,
          event_description: eventDescription,
          client_id: event.clientId,
          resolved: event.resolved ? 1 : 0
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('run_recovery_queue')
        .set({ audit_id: row.id })
        .where('run_id', '=', runId)
        .where('audit_id', 'is', null)
        .executeTakeFirstOrThrow();

      return toAuditRecord(row);
    });
  }

  async findById(id: number): Promise<AuditRecord | undefined> {
    const row = await this.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : toAuditRecord(row);
  }

  /**
   * Returns only operator-safe audit metadata. The private event description
   * is read solely to recover its durable run id and is never returned.
   */
  async dashboardSummary(limit: number): Promise<DashboardAuditSummary> {
    const safeLimit = validateDashboardLimit(limit);
    const [unresolved, rows] = await Promise.all([
      this.db
        .selectFrom('audit_logs')
        .select((expression) => expression.fn.countAll<number>().as('count'))
        .where('resolved', '=', 0)
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('audit_logs')
        .select([
          'id',
          'severity',
          'client_id as clientId',
          'resolved',
          'timestamp',
          'event_description'
        ])
        .orderBy('timestamp', 'desc')
        .orderBy('id', 'desc')
        .limit(safeLimit)
        .execute()
    ]);

    return {
      unresolvedCount: Number(unresolved.count),
      recent: rows.map((row) => ({
        id: row.id,
        severity: row.severity,
        clientId: row.clientId,
        runId: decodeEnvelope(row.event_description).runId,
        resolved: Boolean(row.resolved),
        timestamp: row.timestamp
      }))
    };
  }
}
