import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { Kysely, Selectable, Transaction } from 'kysely';
import { z } from 'zod';

import type {
  AgentProfileInstanceMembersTable,
  AgentProfileInstancesTable,
  JarvisDatabase
} from '../db/types';
import { AppError } from '../utils/errors';
import { AccessAgentIdSchema, ControlScopeIdSchema } from './access-control-contracts';
import {
  ProfileInstanceManifestSchema,
  ProfileInstanceStateSchema,
  type ProfileInstanceManifest,
  type ProfileInstanceState
} from './profile-instance-contracts';
import { AgentProfileSchema, type AgentProfile } from './profile-catalog';

const MAX_INSTANCE_LIST = 100;
const MAX_VERSION = 2_147_483_647;
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const InstanceIdSchema = z.string().regex(/^profile-instance:[a-f0-9]{32}$/u);
const RecipeIdSchema = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/u);
const TimestampSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const PlanProfileInstanceInputSchema = z.strictObject({
  manifest: ProfileInstanceManifestSchema,
  manifestSha256: DigestSchema
});
const ProfileInstanceCursorSchema = z.strictObject({
  createdAt: TimestampSchema,
  instanceId: InstanceIdSchema
});

type DatabaseExecutor = Kysely<JarvisDatabase> | Transaction<JarvisDatabase>;
type InstanceRow = Selectable<AgentProfileInstancesTable>;
type MemberRow = Selectable<AgentProfileInstanceMembersTable>;

export interface PlanProfileInstanceInput {
  manifest: ProfileInstanceManifest;
  manifestSha256: string;
}

export interface ProfileInstanceRecord {
  instanceId: string;
  recipeId: string;
  recipeSha256: string;
  scopeId: string;
  scopeVersion: number;
  knowledgeScopeId: string;
  manifest: ProfileInstanceManifest;
  manifestSha256: string;
  approvedBy: string;
  state: ProfileInstanceState;
  version: number;
  createdAt: string;
  expiresAt: string;
  activatedAt: string | null;
  expiredAt: string | null;
  updatedAt: string;
}

/** Keyset position in `listByState`'s `(created_at, instance_id)` ordering. */
export interface ProfileInstanceCursor {
  createdAt: string;
  instanceId: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function corruption(instanceId: string): AppError {
  return new AppError(
    500,
    'PROFILE_INSTANCE_CORRUPT',
    `Stored profile instance ${instanceId} failed integrity verification`
  );
}

function conflict(message: string): AppError {
  return new AppError(409, 'PROFILE_INSTANCE_CONFLICT', message);
}

function isUniqueConstraint(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = String((error as Error & { code?: unknown }).code);
  return code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function canonicalManifest(manifest: ProfileInstanceManifest): string {
  return JSON.stringify(ProfileInstanceManifestSchema.parse(manifest));
}

function canonicalProfile(profile: AgentProfile): string {
  return JSON.stringify(AgentProfileSchema.parse(profile));
}

function validateStoredInstance(
  row: InstanceRow,
  memberRows: readonly MemberRow[]
): ProfileInstanceRecord {
  try {
    const state = ProfileInstanceStateSchema.parse(row.state);
    if (sha256(row.manifest_json) !== row.manifest_sha256) {
      throw corruption(row.instance_id);
    }

    const manifest = ProfileInstanceManifestSchema.parse(JSON.parse(row.manifest_json));
    const normalizedManifestJson = canonicalManifest(manifest);
    if (
      normalizedManifestJson !== row.manifest_json ||
      sha256(normalizedManifestJson) !== row.manifest_sha256
    ) {
      throw corruption(row.instance_id);
    }

    if (
      manifest.instanceId !== row.instance_id ||
      manifest.recipeId !== row.recipe_id ||
      manifest.recipeSha256 !== row.recipe_sha256 ||
      manifest.scope.id !== row.scope_id ||
      manifest.scope.version !== row.scope_version ||
      manifest.knowledgeScope.id !== row.knowledge_scope_id ||
      manifest.approvedBy !== row.approved_by ||
      manifest.createdAt !== row.created_at ||
      manifest.expiresAt !== row.expires_at ||
      TimestampSchema.parse(row.created_at) !== row.created_at ||
      TimestampSchema.parse(row.expires_at) !== row.expires_at ||
      TimestampSchema.parse(row.updated_at) !== row.updated_at ||
      (row.activated_at !== null && TimestampSchema.parse(row.activated_at) !== row.activated_at) ||
      (row.expired_at !== null && TimestampSchema.parse(row.expired_at) !== row.expired_at) ||
      (state === 'planned' &&
        (row.version !== 1 ||
          row.activated_at !== null ||
          row.expired_at !== null ||
          row.updated_at !== row.created_at)) ||
      (state === 'active' &&
        (row.version !== 2 ||
          row.activated_at === null ||
          row.expired_at !== null ||
          row.updated_at !== row.activated_at ||
          row.activated_at < row.created_at ||
          row.activated_at >= row.expires_at)) ||
      // A quarantined lease keeps the activation column it carried on entry, so
      // `activated_at` is what distinguishes a planned lease that expired
      // (version 2) from an active one that expired (version 3).
      (state === 'expired' &&
        (row.expired_at === null ||
          row.updated_at !== row.expired_at ||
          row.expired_at < row.expires_at ||
          row.version !== (row.activated_at === null ? 2 : 3) ||
          (row.activated_at !== null &&
            (row.activated_at < row.created_at || row.activated_at >= row.expires_at))))
    ) {
      throw corruption(row.instance_id);
    }

    if (memberRows.length !== manifest.members.length) {
      throw corruption(row.instance_id);
    }

    const expectedByOrdinal = new Map(
      manifest.members.map((member) => [member.ordinal, member] as const)
    );
    for (const memberRow of memberRows) {
      const expected = expectedByOrdinal.get(memberRow.ordinal);
      if (expected === undefined) {
        throw corruption(row.instance_id);
      }

      if (sha256(memberRow.profile_json) !== memberRow.profile_sha256) {
        throw corruption(row.instance_id);
      }
      const storedProfile = AgentProfileSchema.parse(JSON.parse(memberRow.profile_json));
      const expectedProfileJson = canonicalProfile(expected.profile);
      if (
        canonicalProfile(storedProfile) !== memberRow.profile_json ||
        memberRow.profile_json !== expectedProfileJson ||
        memberRow.profile_sha256 !== sha256(expectedProfileJson) ||
        memberRow.agent_id !== expected.profile.id ||
        memberRow.instance_id !== row.instance_id ||
        memberRow.template_profile_id !== expected.templateProfileId ||
        memberRow.created_at !== row.created_at
      ) {
        throw corruption(row.instance_id);
      }
    }

    return {
      instanceId: row.instance_id,
      recipeId: row.recipe_id,
      recipeSha256: row.recipe_sha256,
      scopeId: row.scope_id,
      scopeVersion: row.scope_version,
      knowledgeScopeId: row.knowledge_scope_id,
      manifest,
      manifestSha256: row.manifest_sha256,
      approvedBy: row.approved_by,
      state,
      version: row.version,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      activatedAt: row.activated_at,
      expiredAt: row.expired_at,
      updatedAt: row.updated_at
    };
  } catch (error) {
    if (error instanceof AppError && error.code === 'PROFILE_INSTANCE_CORRUPT') {
      throw error;
    }
    throw corruption(row.instance_id);
  }
}

export class ProfileInstanceRepository {
  constructor(
    private readonly db: Kysely<JarvisDatabase>,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async plan(rawInput: PlanProfileInstanceInput): Promise<ProfileInstanceRecord> {
    const input = PlanProfileInstanceInputSchema.parse(rawInput);
    const manifestJson = canonicalManifest(input.manifest);
    if (sha256(manifestJson) !== input.manifestSha256) {
      throw conflict('Profile instance manifest digest does not match its canonical content');
    }

    try {
      return await this.db.transaction().execute(async (transaction) => {
        const existing = await this.findCollision(
          transaction,
          input.manifest.instanceId,
          input.manifest.recipeId,
          input.manifest.scope.id
        );
        if (existing !== undefined) {
          return this.requireExactReplay(transaction, existing, input);
        }

        const inserted = await transaction
          .insertInto('agent_profile_instances')
          .values({
            instance_id: input.manifest.instanceId,
            recipe_id: input.manifest.recipeId,
            recipe_sha256: input.manifest.recipeSha256,
            scope_id: input.manifest.scope.id,
            scope_version: input.manifest.scope.version,
            knowledge_scope_id: input.manifest.knowledgeScope.id,
            manifest_json: manifestJson,
            manifest_sha256: input.manifestSha256,
            approved_by: input.manifest.approvedBy,
            state: 'planned',
            version: 1,
            created_at: input.manifest.createdAt,
            expires_at: input.manifest.expiresAt,
            activated_at: null,
            updated_at: input.manifest.createdAt
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        if (input.manifest.members.length > 0) {
          await transaction
            .insertInto('agent_profile_instance_members')
            .values(
              input.manifest.members.map((member) => {
                const profileJson = canonicalProfile(member.profile);
                return {
                  agent_id: member.profile.id,
                  instance_id: input.manifest.instanceId,
                  template_profile_id: member.templateProfileId,
                  ordinal: member.ordinal,
                  profile_json: profileJson,
                  profile_sha256: sha256(profileJson),
                  created_at: input.manifest.createdAt
                };
              })
            )
            .execute();
        }

        return this.loadRecord(transaction, inserted);
      });
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;

      const existing = await this.findCollision(
        this.db,
        input.manifest.instanceId,
        input.manifest.recipeId,
        input.manifest.scope.id
      );
      if (existing === undefined) {
        throw conflict('Profile instance member identity conflicts with another instance');
      }
      return this.requireExactReplay(this.db, existing, input);
    }
  }

  /**
   * Resolves the one live (planned or active) lease for a recipe scope.
   * Quarantined leases are deliberately invisible here so an expired scope can
   * be renewed instead of colliding with its own history.
   */
  async findByRecipeScope(
    rawRecipeId: string,
    rawScopeId: string
  ): Promise<ProfileInstanceRecord | undefined> {
    const recipeId = RecipeIdSchema.parse(rawRecipeId);
    const scopeId = ControlScopeIdSchema.parse(rawScopeId);
    const row = await this.db
      .selectFrom('agent_profile_instances')
      .selectAll()
      .where('recipe_id', '=', recipeId)
      .where('scope_id', '=', scopeId)
      .where('state', '!=', 'expired')
      .executeTakeFirst();
    return row === undefined ? undefined : this.loadRecord(this.db, row);
  }

  async findById(rawInstanceId: string): Promise<ProfileInstanceRecord | undefined> {
    const instanceId = InstanceIdSchema.parse(rawInstanceId);
    const row = await this.db
      .selectFrom('agent_profile_instances')
      .selectAll()
      .where('instance_id', '=', instanceId)
      .executeTakeFirst();
    return row === undefined ? undefined : this.loadRecord(this.db, row);
  }

  /**
   * One page of instances in a state, ordered by `(created_at, instance_id)`.
   * Passing the previous page's last record as `after` walks the whole state
   * deterministically, including states a caller does not drain as it goes.
   */
  async listByState(
    rawState: ProfileInstanceState,
    rawLimit: number = MAX_INSTANCE_LIST,
    after?: ProfileInstanceCursor
  ): Promise<ProfileInstanceRecord[]> {
    const state = ProfileInstanceStateSchema.parse(rawState);
    const limit = z.number().int().min(1).max(MAX_INSTANCE_LIST).parse(rawLimit);
    const cursor = after === undefined ? undefined : ProfileInstanceCursorSchema.parse(after);
    let query = this.db
      .selectFrom('agent_profile_instances')
      .selectAll()
      .where('state', '=', state);
    if (cursor !== undefined) {
      query = query.where((eb) =>
        eb.or([
          eb('created_at', '>', cursor.createdAt),
          eb.and([
            eb('created_at', '=', cursor.createdAt),
            eb('instance_id', '>', cursor.instanceId)
          ])
        ])
      );
    }
    const rows = await query
      .orderBy('created_at', 'asc')
      .orderBy('instance_id', 'asc')
      .limit(limit)
      .execute();
    return Promise.all(rows.map((row) => this.loadRecord(this.db, row)));
  }

  /**
   * Quarantines a lease whose window has closed. The manifest, its members, and
   * any activation timestamp are retained verbatim — expiry only closes the
   * lease, it never rewrites what was approved.
   */
  async expire(
    rawInstanceId: string,
    rawExpectedVersion: number,
    rawExpiredAt: string
  ): Promise<ProfileInstanceRecord> {
    const instanceId = InstanceIdSchema.parse(rawInstanceId);
    const expectedVersion = z
      .number()
      .int()
      .min(1)
      .max(MAX_VERSION - 1)
      .parse(rawExpectedVersion);
    const expiredAt = TimestampSchema.parse(rawExpiredAt);

    return this.db.transaction().execute(async (transaction) => {
      const existingRow = await transaction
        .selectFrom('agent_profile_instances')
        .selectAll()
        .where('instance_id', '=', instanceId)
        .executeTakeFirst();
      if (existingRow === undefined) {
        throw conflict(`Profile instance ${instanceId} does not exist`);
      }

      const existing = await this.loadRecord(transaction, existingRow);
      if (existing.state === 'expired' || existing.version !== expectedVersion) {
        throw conflict(`Profile instance ${instanceId} expiry version does not match`);
      }
      if (expiredAt < existing.expiresAt) {
        throw conflict(`Profile instance ${instanceId} has not reached the end of its lease`);
      }

      const updated = await transaction
        .updateTable('agent_profile_instances')
        .set({
          state: 'expired',
          version: expectedVersion + 1,
          expired_at: expiredAt,
          updated_at: expiredAt
        })
        .where('instance_id', '=', instanceId)
        .where('state', '!=', 'expired')
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirst();
      if (updated === undefined) {
        throw conflict(`Profile instance ${instanceId} expiry lost a concurrent update`);
      }
      return this.loadRecord(transaction, updated);
    });
  }

  async activate(
    rawInstanceId: string,
    rawExpectedVersion: number,
    rawActivatedAt: string
  ): Promise<ProfileInstanceRecord> {
    const instanceId = InstanceIdSchema.parse(rawInstanceId);
    const expectedVersion = z
      .number()
      .int()
      .min(1)
      .max(MAX_VERSION - 1)
      .parse(rawExpectedVersion);
    const activatedAt = TimestampSchema.parse(rawActivatedAt);

    return this.db.transaction().execute(async (transaction) => {
      const existingRow = await transaction
        .selectFrom('agent_profile_instances')
        .selectAll()
        .where('instance_id', '=', instanceId)
        .executeTakeFirst();
      if (existingRow === undefined) {
        throw conflict(`Profile instance ${instanceId} does not exist`);
      }

      const existing = await this.loadRecord(transaction, existingRow);
      if (existing.state !== 'planned' || existing.version !== expectedVersion) {
        throw conflict(`Profile instance ${instanceId} activation version does not match`);
      }
      if (activatedAt < existing.createdAt || activatedAt >= existing.expiresAt) {
        throw conflict(`Profile instance ${instanceId} activation timestamp is outside its lease`);
      }

      const updated = await transaction
        .updateTable('agent_profile_instances')
        .set({
          state: 'active',
          version: expectedVersion + 1,
          activated_at: activatedAt,
          updated_at: activatedAt
        })
        .where('instance_id', '=', instanceId)
        .where('state', '=', 'planned')
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirst();
      if (updated === undefined) {
        throw conflict(`Profile instance ${instanceId} activation lost a concurrent update`);
      }
      return this.loadRecord(transaction, updated);
    });
  }

  async findAgentProfile(rawAgentId: string): Promise<AgentProfile | undefined> {
    const agentId = AccessAgentIdSchema.parse(rawAgentId);
    const now = TimestampSchema.parse(this.now());
    const row = await this.db
      .selectFrom('agent_profile_instance_members')
      .innerJoin(
        'agent_profile_instances',
        'agent_profile_instances.instance_id',
        'agent_profile_instance_members.instance_id'
      )
      .select('agent_profile_instances.instance_id')
      .where('agent_profile_instance_members.agent_id', '=', agentId)
      .where('agent_profile_instances.state', '=', 'active')
      .where('agent_profile_instances.expires_at', '>', now)
      .executeTakeFirst();
    if (row === undefined) return undefined;

    const instance = await this.findById(row.instance_id);
    if (instance === undefined) {
      throw corruption(row.instance_id);
    }
    const profile = instance.manifest.members.find(
      (member) => member.profile.id === agentId
    )?.profile;
    if (profile === undefined) {
      throw corruption(row.instance_id);
    }
    return profile;
  }

  private async findCollision(
    executor: DatabaseExecutor,
    instanceId: string,
    recipeId: string,
    scopeId: string
  ): Promise<InstanceRow | undefined> {
    const byInstanceId = await executor
      .selectFrom('agent_profile_instances')
      .selectAll()
      .where('instance_id', '=', instanceId)
      .executeTakeFirst();
    const byRecipeScope = await executor
      .selectFrom('agent_profile_instances')
      .selectAll()
      .where('recipe_id', '=', recipeId)
      .where('scope_id', '=', scopeId)
      .where('state', '!=', 'expired')
      .executeTakeFirst();

    if (
      byInstanceId !== undefined &&
      byRecipeScope !== undefined &&
      byInstanceId.instance_id !== byRecipeScope.instance_id
    ) {
      throw conflict('Profile instance identity and recipe scope resolve to different records');
    }
    return byInstanceId ?? byRecipeScope;
  }

  private async requireExactReplay(
    executor: DatabaseExecutor,
    row: InstanceRow,
    input: PlanProfileInstanceInput
  ): Promise<ProfileInstanceRecord> {
    const existing = await this.loadRecord(executor, row);
    if (
      existing.manifestSha256 !== input.manifestSha256 ||
      !isDeepStrictEqual(existing.manifest, input.manifest)
    ) {
      throw conflict(
        `Profile instance ${input.manifest.instanceId} already exists with a different manifest`
      );
    }
    return existing;
  }

  private async loadRecord(
    executor: DatabaseExecutor,
    row: InstanceRow
  ): Promise<ProfileInstanceRecord> {
    const memberRows = await executor
      .selectFrom('agent_profile_instance_members')
      .selectAll()
      .where('instance_id', '=', row.instance_id)
      .orderBy('ordinal', 'asc')
      .execute();
    return validateStoredInstance(row, memberRows);
  }
}
