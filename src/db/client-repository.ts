import type { Kysely, Selectable } from 'kysely';

import type { ClientProfile } from '../config/schemas';
import type { ClientRegistryTable, JarvisDatabase } from './types';

export type ClientStatus = 'active' | 'suspended';

export interface ClientRecord {
  id: string;
  name: string;
  profile: ClientProfile;
  status: ClientStatus;
  createdAt: string;
}

export type NewClientRecord = ClientRecord;

export interface DashboardClientSummary {
  counts: Record<'total' | ClientStatus, number>;
  items: ClientRecord[];
}

function validateDashboardLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('dashboard limit must be an integer between 1 and 100');
  }
  return limit;
}

function toClientRecord(row: Selectable<ClientRegistryTable>): ClientRecord {
  return {
    id: row.id,
    name: row.name,
    profile: row.profile_type as ClientProfile,
    status: row.status as ClientStatus,
    createdAt: row.created_at
  };
}

export class ClientRepository {
  constructor(private readonly db: Kysely<JarvisDatabase>) {}

  async create(input: NewClientRecord): Promise<ClientRecord> {
    const row = await this.db
      .insertInto('client_registry')
      .values({
        id: input.id,
        name: input.name,
        profile_type: input.profile,
        status: input.status,
        created_at: input.createdAt
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toClientRecord(row);
  }

  async list(): Promise<ClientRecord[]> {
    const rows = await this.db
      .selectFrom('client_registry')
      .selectAll()
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();

    return rows.map(toClientRecord);
  }

  async dashboardSummary(limit: number): Promise<DashboardClientSummary> {
    const safeLimit = validateDashboardLimit(limit);
    const [statusRows, items] = await Promise.all([
      this.db
        .selectFrom('client_registry')
        .select(['status', (expression) => expression.fn.countAll<number>().as('count')])
        .groupBy('status')
        .execute(),
      this.db
        .selectFrom('client_registry')
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('id', 'asc')
        .limit(safeLimit)
        .execute()
    ]);
    const counts: DashboardClientSummary['counts'] = { total: 0, active: 0, suspended: 0 };
    for (const row of statusRows) {
      if (row.status === 'active' || row.status === 'suspended') {
        const count = Number(row.count);
        counts[row.status] = count;
        counts.total += count;
      }
    }

    return { counts, items: items.map(toClientRecord) };
  }

  async findById(id: string): Promise<ClientRecord | undefined> {
    const row = await this.db
      .selectFrom('client_registry')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : toClientRecord(row);
  }

  async updateStatus(id: string, status: ClientStatus): Promise<ClientRecord | undefined> {
    const row = await this.db
      .updateTable('client_registry')
      .set({ status })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toClientRecord(row);
  }

  async delete(id: string): Promise<boolean> {
    const row = await this.db
      .deleteFrom('client_registry')
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();

    return row !== undefined;
  }
}
