import { isDeepStrictEqual } from 'node:util';

import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { JarvisDatabase } from '../db/types';
import { KnowledgeScopeIdSchema, type KnowledgeScopeRecord } from '../knowledge/contracts';
import type { KnowledgeScopeRepository } from '../knowledge/scope-repository';
import { AppError } from '../utils/errors';
import { ControlScopeIdSchema, type ControlScopeRecord } from './access-control-contracts';
import type { AccessControlRepository } from './access-control-repository';
import type { AgentProfile } from './profile-catalog';
import type { ProfileInstanceState } from './profile-instance-contracts';
import type {
  ProfileInstanceCursor,
  ProfileInstanceRecord,
  ProfileInstanceRepository
} from './profile-instance-repository';
import { planProfileInstance } from './profile-instance-planner';

const DEFAULT_RECOVERY_BATCH_SIZE = 100;
/** Bounds startup recovery at MAX_RECOVERY_PAGES × recoveryBatchSize instances. */
const MAX_RECOVERY_PAGES = 100;
const RecoveryBatchSizeSchema = z.number().int().min(1).max(DEFAULT_RECOVERY_BATCH_SIZE);
const TimestampSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const RecipeIdSchema = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/u);
const ApprovedOperatorSchema = z
  .string()
  .min(12)
  .max(128)
  .regex(/^operator:[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/u);

export const InstantiateProfileRecipeInputSchema = z.strictObject({
  recipeId: RecipeIdSchema,
  scopeId: ControlScopeIdSchema,
  expectedScopeVersion: z.number().int().min(1).max(2_147_483_647),
  knowledgeScopeId: KnowledgeScopeIdSchema,
  approvedBy: ApprovedOperatorSchema,
  expiresAt: TimestampSchema
});

export type InstantiateProfileRecipeInput = z.infer<typeof InstantiateProfileRecipeInputSchema>;

export interface ProfileInstanceResult {
  instanceId: string;
  recipeId: string;
  recipeSha256: string;
  instanceManifestSha256: string;
  scopeId: string;
  scopeVersion: number;
  profileCount: number;
  sleeveCount: number;
  sleeveGrantCount: number;
  toolGrantCount: number;
  blueprintReady: true;
  authorizationReady: false;
  profiles: readonly AgentProfile[];
  createdAt: string;
  expiresAt: string;
}

function conflict(code: string, message: string): AppError {
  return new AppError(409, code, message);
}

function sameIdSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const expectedSet = new Set(expected);
  return actual.every((id) => expectedSet.has(id));
}

function resultFrom(record: ProfileInstanceRecord): ProfileInstanceResult {
  const { manifest } = record;
  return Object.freeze({
    instanceId: manifest.instanceId,
    recipeId: manifest.recipeId,
    recipeSha256: manifest.recipeSha256,
    instanceManifestSha256: record.manifestSha256,
    scopeId: manifest.scope.id,
    scopeVersion: manifest.scope.version,
    profileCount: manifest.members.length,
    sleeveCount: manifest.sleeves.length,
    sleeveGrantCount: manifest.sleeveGrants.length,
    toolGrantCount: manifest.toolGrants.length,
    blueprintReady: true,
    authorizationReady: false,
    profiles: Object.freeze(manifest.members.map(({ profile }) => profile)),
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt
  });
}

export interface ProfileInstanceRecoveryReport {
  expiredCount: number;
  resumedCount: number;
  auditedCount: number;
}

export class ProfileInstanceService {
  private readonly db: Kysely<JarvisDatabase>;
  private readonly access: AccessControlRepository;
  private readonly knowledgeScopes: KnowledgeScopeRepository;
  private readonly instances: ProfileInstanceRepository;
  private readonly recoveryBatchSize: number;
  private readonly now: () => string;

  constructor(options: {
    db: Kysely<JarvisDatabase>;
    access: AccessControlRepository;
    knowledgeScopes: KnowledgeScopeRepository;
    instances: ProfileInstanceRepository;
    recoveryBatchSize?: number;
    now?: () => string;
  }) {
    this.db = options.db;
    this.access = options.access;
    this.knowledgeScopes = options.knowledgeScopes;
    this.instances = options.instances;
    this.recoveryBatchSize = RecoveryBatchSizeSchema.parse(
      options.recoveryBatchSize ?? DEFAULT_RECOVERY_BATCH_SIZE
    );
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async instantiate(rawInput: unknown): Promise<ProfileInstanceResult> {
    const input = InstantiateProfileRecipeInputSchema.parse(rawInput);
    const createdAt = new Date(this.now()).toISOString();
    if (Date.parse(input.expiresAt) <= Date.parse(createdAt)) {
      throw conflict(
        'PROFILE_INSTANCE_EXPIRY_INVALID',
        'Profile instance expiry must follow its creation time'
      );
    }

    const [scope, knowledgeScope] = await Promise.all([
      this.access.findScope(input.scopeId),
      this.knowledgeScopes.findById(input.knowledgeScopeId)
    ]);
    if (
      scope === undefined ||
      scope.state !== 'active' ||
      scope.version !== input.expectedScopeVersion
    ) {
      throw conflict(
        'PROFILE_INSTANCE_SCOPE_INVALID',
        'Profile instance requires the exact active registered control scope version'
      );
    }
    if (knowledgeScope === undefined) {
      throw conflict(
        'PROFILE_INSTANCE_KNOWLEDGE_SCOPE_INVALID',
        'Profile instance requires an exact registered knowledge scope'
      );
    }

    const existing = await this.instances.findByRecipeScope(input.recipeId, input.scopeId);
    if (
      existing !== undefined &&
      (existing.approvedBy !== input.approvedBy ||
        existing.expiresAt !== input.expiresAt ||
        existing.knowledgeScopeId !== input.knowledgeScopeId ||
        existing.scopeVersion !== input.expectedScopeVersion)
    ) {
      throw conflict(
        'PROFILE_INSTANCE_CONFLICT',
        `Recipe ${input.recipeId} already has a differently approved scope-bound instance`
      );
    }

    const plan = planProfileInstance({
      recipeId: input.recipeId,
      scope,
      knowledgeScope,
      approvedBy: input.approvedBy,
      createdAt: existing?.createdAt ?? createdAt,
      expiresAt: input.expiresAt
    });
    if (existing !== undefined && existing.manifest.recipeSha256 !== plan.manifest.recipeSha256) {
      throw conflict(
        'PROFILE_INSTANCE_RECIPE_DRIFT',
        `Recipe ${input.recipeId} changed after its scope-bound manifest was approved`
      );
    }

    await this.assertExternalBindings(
      plan.manifest.scope,
      plan.manifest.knowledgeScope,
      plan.manifest
    );
    const record = await this.instances.plan(plan);
    return this.provision(record);
  }

  /**
   * Quarantines leases whose window has closed, replays interrupted planned
   * installs, and audits every remaining active manifest before the gateway
   * begins serving. Stored snapshots, not current recipe code, are the recovery
   * source. Expiry runs first so a lapsed lease is never re-provisioned.
   */
  async initialize(): Promise<ProfileInstanceRecoveryReport> {
    const startedAt = new Date(this.now()).toISOString();
    let expiredCount = 0;
    for (const state of ['planned', 'active'] as const) {
      await this.sweep(state, async (record) => {
        if (record.expiresAt > startedAt) return false;
        await this.instances.expire(record.manifest.instanceId, record.version, startedAt);
        expiredCount += 1;
        return true;
      });
    }

    let resumedCount = 0;
    await this.sweep('planned', async (record) => {
      await this.provision(record);
      resumedCount += 1;
      return true;
    });

    let auditedCount = 0;
    await this.sweep('active', async (record) => {
      await this.provision(record);
      auditedCount += 1;
      // An audit confirms the lease; it stays active, so the cursor must step
      // past it rather than re-reading the same page.
      return false;
    });

    return { expiredCount, resumedCount, auditedCount };
  }

  /**
   * Walks every instance in a state in bounded pages. `visit` reports whether it
   * moved the record out of the state; records left in place are stepped over by
   * the keyset cursor so the walk always terminates.
   */
  private async sweep(
    state: ProfileInstanceState,
    visit: (record: ProfileInstanceRecord) => Promise<boolean>
  ): Promise<void> {
    let cursor: ProfileInstanceCursor | undefined;
    for (let page = 0; page < MAX_RECOVERY_PAGES; page += 1) {
      const records = await this.instances.listByState(state, this.recoveryBatchSize, cursor);
      if (records.length === 0) return;

      for (const record of records) {
        const departed = await visit(record);
        if (!departed) {
          cursor = { createdAt: record.createdAt, instanceId: record.manifest.instanceId };
        }
      }
      // Every record in this page left the state, so the next page starts from
      // wherever the unmoved cursor already points (the head, when none moved).
      if (records.length < this.recoveryBatchSize) return;
    }
    throw conflict(
      'PROFILE_INSTANCE_RECOVERY_OVERFLOW',
      `Startup recovery exceeded ${MAX_RECOVERY_PAGES} pages of ${state} profile instances`
    );
  }

  private async provision(record: ProfileInstanceRecord): Promise<ProfileInstanceResult> {
    const { manifest } = record;
    await this.assertExternalBindings(manifest.scope, manifest.knowledgeScope, manifest);

    for (const agent of manifest.agentRegistrations) await this.access.registerAgent(agent);
    for (const sleeve of manifest.sleeves) await this.access.registerSleeve(sleeve);

    await this.assertBlueprintGrantSet(manifest, true);
    for (const grant of manifest.sleeveGrants) await this.access.issueSleeveGrant(grant);
    for (const grant of manifest.toolGrants) await this.access.issueToolGrant(grant);
    await this.assertBlueprintGrantSet(manifest, false);

    let active = record;
    if (record.state !== 'active') {
      try {
        active = await this.instances.activate(
          record.manifest.instanceId,
          record.version,
          this.now()
        );
      } catch (error) {
        const converged = await this.instances.findById(record.manifest.instanceId);
        if (
          !(error instanceof AppError) ||
          error.code !== 'PROFILE_INSTANCE_CONFLICT' ||
          converged?.state !== 'active' ||
          converged.manifestSha256 !== record.manifestSha256
        ) {
          throw error;
        }
        active = converged;
      }
    }
    return resultFrom(active);
  }

  private async assertExternalBindings(
    scope: ControlScopeRecord,
    knowledgeScope: KnowledgeScopeRecord,
    manifest: ProfileInstanceRecord['manifest']
  ): Promise<void> {
    const [currentScope, currentKnowledge] = await Promise.all([
      this.access.findScope(scope.id),
      this.knowledgeScopes.findById(knowledgeScope.id)
    ]);
    if (
      currentScope === undefined ||
      currentScope.state !== 'active' ||
      !isDeepStrictEqual(currentScope, scope)
    ) {
      throw conflict(
        'PROFILE_INSTANCE_SCOPE_INVALID',
        'Stored profile instance control scope binding is stale or inactive'
      );
    }
    if (currentKnowledge === undefined || !isDeepStrictEqual(currentKnowledge, knowledgeScope)) {
      throw conflict(
        'PROFILE_INSTANCE_KNOWLEDGE_SCOPE_INVALID',
        'Stored profile instance knowledge binding drifted'
      );
    }

    const lead = manifest.members[0]?.profile;
    if (lead === undefined || lead.parentId === null) {
      throw conflict(
        'PROFILE_INSTANCE_PARENT_INVALID',
        'Runtime recipe must attach to an approved external parent profile'
      );
    }
    const parent = await this.access.findAgent(lead.parentId);
    if (
      parent === undefined ||
      parent.state !== 'active' ||
      parent.trustDomain !== scope.trustDomain
    ) {
      throw conflict(
        'PROFILE_INSTANCE_PARENT_INVALID',
        'Runtime recipe parent must be active in the exact trust domain'
      );
    }

    let cursor = scope.parentScopeId;
    const visited = new Set<string>([scope.id]);
    for (let depth = 0; depth < 16 && cursor !== null; depth += 1) {
      if (cursor === parent.homeScopeId) return;
      if (visited.has(cursor)) break;
      visited.add(cursor);
      const ancestor = await this.access.findScope(cursor);
      if (
        ancestor === undefined ||
        ancestor.state !== 'active' ||
        ancestor.trustDomain !== scope.trustDomain
      ) {
        break;
      }
      cursor = ancestor.parentScopeId;
    }
    throw conflict(
      'PROFILE_INSTANCE_SCOPE_INVALID',
      'Runtime scope must be an exact descendant of its approved parent profile home scope'
    );
  }

  private async assertBlueprintGrantSet(
    manifest: ProfileInstanceRecord['manifest'],
    allowMissing: boolean
  ): Promise<void> {
    const agentIds = manifest.members.map(({ profile }) => profile.id);
    const [actualSleeves, actualTools] = await Promise.all([
      this.db
        .selectFrom('agent_sleeve_grants')
        .select('grant_id')
        .where('agent_id', 'in', agentIds)
        .where('authority_layer', '=', 'blueprint')
        .where('state', '=', 'active')
        .execute(),
      this.db
        .selectFrom('agent_tool_grants')
        .select('grant_id')
        .where('agent_id', 'in', agentIds)
        .where('authority_layer', '=', 'blueprint')
        .where('state', '=', 'active')
        .execute()
    ]);
    const actualSleeveIds = actualSleeves.map(({ grant_id }) => grant_id);
    const actualToolIds = actualTools.map(({ grant_id }) => grant_id);
    const expectedSleeveIds = manifest.sleeveGrants.map(({ id }) => id);
    const expectedToolIds = manifest.toolGrants.map(({ id }) => id);
    const sleeveExpected = new Set(expectedSleeveIds);
    const toolExpected = new Set(expectedToolIds);
    const hasUnexpected =
      actualSleeveIds.some((id) => !sleeveExpected.has(id)) ||
      actualToolIds.some((id) => !toolExpected.has(id));
    const exact =
      sameIdSet(actualSleeveIds, expectedSleeveIds) && sameIdSet(actualToolIds, expectedToolIds);
    if (hasUnexpected || (!allowMissing && !exact)) {
      throw conflict(
        'PROFILE_INSTANCE_ACCESS_DRIFT',
        'Active instance blueprint grants differ from the approved stored manifest'
      );
    }
  }
}
