import { createHash } from 'node:crypto';

import type SQLite from 'better-sqlite3';
import { z } from 'zod';

import type { ModelExecutionEnablementSnapshot } from './model-router';

export const ModelExecutionTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const ModelExecutionSurfaceSchema = z.enum(['web', 'telegram', 'automation']);
export const ModelExecutionProviderSchema = z.enum(['claude', 'codex', 'gemini', 'ollama']);

export type ModelExecutionTier = z.infer<typeof ModelExecutionTierSchema>;
export type ModelExecutionSurface = z.infer<typeof ModelExecutionSurfaceSchema>;
export type ModelExecutionProvider = z.infer<typeof ModelExecutionProviderSchema>;

const ModelExecutionEnablementSchema = z
  .strictObject({
    enabled: z.boolean(),
    version: z.number().int().min(1),
    updatedAt: z.iso.datetime(),
    updatedBy: z.string().trim().min(3).max(160),
    reason: z.string().trim().min(3).max(160),
    approver: z.string().trim().min(3).max(160).nullable(),
    approvedAt: z.iso.datetime().nullable(),
    allowedTiers: z.array(ModelExecutionTierSchema).max(3),
    allowedSurfaces: z.array(ModelExecutionSurfaceSchema).max(8),
    allowedProviders: z.array(ModelExecutionProviderSchema).max(8)
  })
  .superRefine((value, ctx) => {
    const consistent = value.enabled
      ? value.approver !== null &&
        value.approvedAt !== null &&
        value.allowedTiers.length > 0 &&
        value.allowedSurfaces.length > 0 &&
        value.allowedProviders.length > 0
      : value.approver === null &&
        value.approvedAt === null &&
        value.allowedTiers.length === 0 &&
        value.allowedSurfaces.length === 0 &&
        value.allowedProviders.length === 0;
    if (!consistent) {
      ctx.addIssue({
        code: 'custom',
        message: 'enablement approval/allow-list state is inconsistent'
      });
    }
  });

export type ModelExecutionEnablement = z.infer<typeof ModelExecutionEnablementSchema>;

export const EnableModelExecutionInputSchema = z.strictObject({
  approver: z.string().trim().min(3).max(160),
  reason: z.string().trim().min(3).max(160),
  // Raw input may repeat values; canonicalization deduplicates and sorts, so the
  // stored set is naturally bounded by the enum sizes.
  allowedTiers: z.array(ModelExecutionTierSchema).min(1).max(16),
  allowedSurfaces: z.array(ModelExecutionSurfaceSchema).min(1).max(16),
  allowedProviders: z.array(ModelExecutionProviderSchema).min(1).max(16),
  expectedVersion: z.number().int().min(1)
});

export const DisableModelExecutionInputSchema = z.strictObject({
  updatedBy: z.string().trim().min(3).max(160),
  reason: z.string().trim().min(3).max(160),
  expectedVersion: z.number().int().min(1)
});

export type EnableModelExecutionInput = z.infer<typeof EnableModelExecutionInputSchema>;
export type DisableModelExecutionInput = z.infer<typeof DisableModelExecutionInputSchema>;

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function uniqueSorted<T extends number | string>(values: T[]): T[] {
  return [...new Set(values)].sort((a, b) =>
    typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))
  );
}

interface EnablementRow {
  enabled: number;
  version: number;
  updated_at: string;
  updated_by: string;
  reason: string;
  approver: string | null;
  approved_at: string | null;
  allowed_tiers: string;
  allowed_surfaces: string;
  allowed_providers: string;
}

function parseJsonArray(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function fromRow(row: EnablementRow): ModelExecutionEnablement {
  return ModelExecutionEnablementSchema.parse({
    enabled: row.enabled === 1,
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    reason: row.reason,
    approver: row.approver,
    approvedAt: row.approved_at,
    allowedTiers: parseJsonArray(row.allowed_tiers),
    allowedSurfaces: parseJsonArray(row.allowed_surfaces),
    allowedProviders: parseJsonArray(row.allowed_providers)
  });
}

export interface ModelExecutionEnablementRepository {
  initialize(input: { occurredAt: string }): ModelExecutionEnablement;
  current(): ModelExecutionEnablement;
  enable(input: EnableModelExecutionInput & { occurredAt: string }): ModelExecutionEnablement;
  disable(input: DisableModelExecutionInput & { occurredAt: string }): ModelExecutionEnablement;
}

export class SqliteModelExecutionEnablementRepository implements ModelExecutionEnablementRepository {
  constructor(private readonly sqlite: SQLite.Database) {}

  initialize(input: { occurredAt: string }): ModelExecutionEnablement {
    const occurredAt = z.iso.datetime().parse(input.occurredAt);
    return this.sqlite.transaction(() => {
      const inserted = this.sqlite
        .prepare(
          `INSERT OR IGNORE INTO model_execution_enablement (
             singleton_id, enabled, version, updated_at, updated_by, reason,
             approver, approved_at, allowed_tiers, allowed_surfaces, allowed_providers
           ) VALUES ('jarvis', 0, 1, ?, 'system:bootstrap', 'runtime_state_initialized',
                     NULL, NULL, '[]', '[]', '[]')`
        )
        .run(occurredAt);
      if (inserted.changes === 1) {
        this.recordEvent({
          fromEnabled: null,
          toEnabled: 0,
          resultingVersion: 1,
          actorId: 'system:bootstrap',
          reason: 'runtime_state_initialized',
          approver: null,
          allowedTiers: [],
          allowedSurfaces: [],
          allowedProviders: [],
          occurredAt
        });
      }
      return this.readCurrent();
    })();
  }

  current(): ModelExecutionEnablement {
    return this.readCurrent();
  }

  enable(input: EnableModelExecutionInput & { occurredAt: string }): ModelExecutionEnablement {
    const allowedTiers = uniqueSorted(input.allowedTiers);
    const allowedSurfaces = uniqueSorted(input.allowedSurfaces);
    const allowedProviders = uniqueSorted(input.allowedProviders);
    return this.sqlite.transaction(() => {
      const previous = this.readCurrent();
      const nextVersion = previous.version + 1;
      const update = this.sqlite
        .prepare(
          `UPDATE model_execution_enablement
              SET enabled = 1, version = ?, updated_at = ?, updated_by = ?, reason = ?,
                  approver = ?, approved_at = ?, allowed_tiers = ?, allowed_surfaces = ?,
                  allowed_providers = ?
            WHERE singleton_id = 'jarvis' AND version = ?`
        )
        .run(
          nextVersion,
          input.occurredAt,
          input.approver,
          input.reason,
          input.approver,
          input.occurredAt,
          JSON.stringify(allowedTiers),
          JSON.stringify(allowedSurfaces),
          JSON.stringify(allowedProviders),
          input.expectedVersion
        );
      if (update.changes !== 1) throw new Error('model execution enablement version conflict');
      this.recordEvent({
        fromEnabled: previous.enabled ? 1 : 0,
        toEnabled: 1,
        resultingVersion: nextVersion,
        actorId: input.approver,
        reason: input.reason,
        approver: input.approver,
        allowedTiers,
        allowedSurfaces,
        allowedProviders,
        occurredAt: input.occurredAt
      });
      return this.readCurrent();
    })();
  }

  disable(input: DisableModelExecutionInput & { occurredAt: string }): ModelExecutionEnablement {
    return this.sqlite.transaction(() => {
      const previous = this.readCurrent();
      const nextVersion = previous.version + 1;
      const update = this.sqlite
        .prepare(
          `UPDATE model_execution_enablement
              SET enabled = 0, version = ?, updated_at = ?, updated_by = ?, reason = ?,
                  approver = NULL, approved_at = NULL, allowed_tiers = '[]',
                  allowed_surfaces = '[]', allowed_providers = '[]'
            WHERE singleton_id = 'jarvis' AND version = ?`
        )
        .run(nextVersion, input.occurredAt, input.updatedBy, input.reason, input.expectedVersion);
      if (update.changes !== 1) throw new Error('model execution enablement version conflict');
      this.recordEvent({
        fromEnabled: previous.enabled ? 1 : 0,
        toEnabled: 0,
        resultingVersion: nextVersion,
        actorId: input.updatedBy,
        reason: input.reason,
        approver: null,
        allowedTiers: [],
        allowedSurfaces: [],
        allowedProviders: [],
        occurredAt: input.occurredAt
      });
      return this.readCurrent();
    })();
  }

  private recordEvent(event: {
    fromEnabled: number | null;
    toEnabled: number;
    resultingVersion: number;
    actorId: string;
    reason: string;
    approver: string | null;
    allowedTiers: number[];
    allowedSurfaces: string[];
    allowedProviders: string[];
    occurredAt: string;
  }): void {
    const eventId = `model-enablement-event:${hash(
      JSON.stringify([event.resultingVersion, event.toEnabled, event.actorId, event.occurredAt])
    )}`;
    this.sqlite
      .prepare(
        `INSERT INTO model_execution_enablement_events (
           event_id, from_enabled, to_enabled, resulting_version, actor_id, reason,
           approver, allowed_tiers, allowed_surfaces, allowed_providers, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventId,
        event.fromEnabled,
        event.toEnabled,
        event.resultingVersion,
        event.actorId,
        event.reason,
        event.approver,
        JSON.stringify(event.allowedTiers),
        JSON.stringify(event.allowedSurfaces),
        JSON.stringify(event.allowedProviders),
        event.occurredAt
      );
  }

  private readCurrent(): ModelExecutionEnablement {
    const row = this.sqlite
      .prepare("SELECT * FROM model_execution_enablement WHERE singleton_id = 'jarvis'")
      .get() as EnablementRow | undefined;
    if (!row) throw new Error('model execution enablement is not initialized');
    return fromRow(row);
  }
}

const DISABLED_SNAPSHOT: ModelExecutionEnablementSnapshot = Object.freeze({
  enabled: false,
  allowedTiers: [],
  version: 1
});

export class ModelExecutionEnablementService {
  private readonly now: () => string;

  constructor(
    private readonly options: {
      repository: ModelExecutionEnablementRepository;
      now?: () => string;
    }
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  initialize(): Promise<ModelExecutionEnablement> {
    return Promise.resolve(
      this.options.repository.initialize({ occurredAt: new Date(this.now()).toISOString() })
    );
  }

  current(): Promise<ModelExecutionEnablement> {
    return Promise.resolve(this.options.repository.current());
  }

  enable(input: unknown): Promise<ModelExecutionEnablement> {
    // Deferred into the promise chain so a synchronous validation or
    // version-conflict throw surfaces as a rejection, not a thrown call.
    return Promise.resolve().then(() => {
      const parsed = EnableModelExecutionInputSchema.parse(input);
      return this.options.repository.enable({
        ...parsed,
        occurredAt: new Date(this.now()).toISOString()
      });
    });
  }

  disable(input: unknown): Promise<ModelExecutionEnablement> {
    return Promise.resolve().then(() => {
      const parsed = DisableModelExecutionInputSchema.parse(input);
      return this.options.repository.disable({
        ...parsed,
        occurredAt: new Date(this.now()).toISOString()
      });
    });
  }

  async snapshot(): Promise<ModelExecutionEnablementSnapshot> {
    const record = await this.current();
    return {
      enabled: record.enabled,
      allowedTiers: [...record.allowedTiers],
      version: record.version
    };
  }

  /**
   * Fail-closed snapshot for the router: any read/parse failure of the durable
   * record yields the disabled snapshot rather than propagating an error, so a
   * corrupt enablement row can never accidentally permit model execution.
   */
  async resolveSnapshot(): Promise<ModelExecutionEnablementSnapshot> {
    try {
      return await this.snapshot();
    } catch {
      return { ...DISABLED_SNAPSHOT, allowedTiers: [] };
    }
  }
}
