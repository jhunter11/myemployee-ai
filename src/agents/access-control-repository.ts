import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { Kysely, Selectable, Transaction } from 'kysely';

import type {
  AccessAgentsTable,
  AgentSleeveGrantsTable,
  AgentToolGrantsTable,
  ControlScopesTable,
  JarvisDatabase,
  MemorySleevesTable,
  SharedApprovedBundlesTable
} from '../db/types';
import { AppError } from '../utils/errors';
import {
  AUTHORITY_LAYERS,
  AccessAgentIdSchema,
  AccessAgentRecordSchema,
  AccessSensitivitySchema,
  AgentAuthorizationPrincipalSchema,
  AgentSleeveGrantRecordSchema,
  AgentToolGrantRecordSchema,
  AuthorizeMemoryAccessInputSchema,
  AuthorizeMemoryRetrievalInputSchema,
  AuthorizeToolUseInputSchema,
  AuthorizedMemoryAccessSchema,
  AuthorizedMemoryRetrievalSchema,
  AuthorizedToolUseSchema,
  ControlScopeIdSchema,
  ControlScopeRecordSchema,
  IssueAgentSleeveGrantInputSchema,
  IssueAgentToolGrantInputSchema,
  MemorySleeveIdSchema,
  MemorySleeveKindSchema,
  MemorySleeveRecordSchema,
  PublishSharedApprovedBundleInputSchema,
  RegisterAccessAgentInputSchema,
  RegisterControlScopeInputSchema,
  RegisterMemorySleeveInputSchema,
  RevokeAccessRecordInputSchema,
  SharedApprovedBundleRecordSchema,
  type AccessAgentRecord,
  type AccessSensitivity,
  type AgentAuthorizationPrincipal,
  type AgentSleeveGrantRecord,
  type AgentToolGrantRecord,
  type AuthorityLayer,
  type AuthorizedMemoryAccess,
  type AuthorizedMemoryRetrieval,
  type AuthorizedToolUse,
  type ControlScopeRecord,
  type GrantVersionSet,
  type IssueAgentSleeveGrantInput,
  type IssueAgentToolGrantInput,
  type MemorySleeveKind,
  type MemorySleeveRecord,
  type PublishSharedApprovedBundleInput,
  type RegisterAccessAgentInput,
  type RegisterControlScopeInput,
  type RegisterMemorySleeveInput,
  type RevokeAccessRecordInput,
  type SharedApprovedBundleRecord
} from './access-control-contracts';

const sensitivityRank: Readonly<Record<AccessSensitivity, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  private: 3,
  restricted: 4
};

export class MemoryAccessDeniedError extends AppError {
  constructor() {
    super(403, 'MEMORY_ACCESS_DENIED', 'Memory access is not authorized');
    this.name = 'MemoryAccessDeniedError';
  }
}

export class ToolAccessDeniedError extends AppError {
  constructor() {
    super(403, 'TOOL_ACCESS_DENIED', 'Tool access is not authorized');
    this.name = 'ToolAccessDeniedError';
  }
}

function conflict(code: string, message: string): AppError {
  return new AppError(409, code, message);
}

function toScope(row: Selectable<ControlScopesTable>): ControlScopeRecord {
  return ControlScopeRecordSchema.parse({
    id: row.scope_id,
    kind: row.scope_kind,
    subjectId: row.subject_id,
    parentScopeId: row.parent_scope_id,
    trustDomain: row.trust_domain,
    state: row.state,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function toAgent(row: Selectable<AccessAgentsTable>): AccessAgentRecord {
  return AccessAgentRecordSchema.parse({
    id: row.agent_id,
    homeScopeId: row.home_scope_id,
    trustDomain: row.trust_domain,
    profileRevision: row.profile_revision,
    state: row.state,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function toSleeve(row: Selectable<MemorySleevesTable>): MemorySleeveRecord {
  return MemorySleeveRecordSchema.parse({
    id: row.sleeve_id,
    ownerScopeId: row.owner_scope_id,
    kind: row.sleeve_kind,
    maxSensitivity: row.max_sensitivity,
    partitionKey: row.partition_key,
    expiresAt: row.expires_at,
    state: row.state,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function toSleeveGrant(row: Selectable<AgentSleeveGrantsTable>): AgentSleeveGrantRecord {
  return AgentSleeveGrantRecordSchema.parse({
    id: row.grant_id,
    agentId: row.agent_id,
    sleeveId: row.sleeve_id,
    authorityLayer: row.authority_layer,
    permission: row.permission,
    purpose: row.purpose,
    sensitivityCap: row.sensitivity_cap,
    expiresAt: row.expires_at,
    state: row.state,
    version: row.version,
    boundAgentVersion: row.bound_agent_version,
    boundScopeVersion: row.bound_scope_version,
    boundSleeveVersion: row.bound_sleeve_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function toToolGrant(row: Selectable<AgentToolGrantsTable>): AgentToolGrantRecord {
  return AgentToolGrantRecordSchema.parse({
    id: row.grant_id,
    agentId: row.agent_id,
    toolId: row.tool_id,
    authorityLayer: row.authority_layer,
    access: row.access,
    purpose: row.purpose,
    sensitivityCap: row.sensitivity_cap,
    expiresAt: row.expires_at,
    state: row.state,
    version: row.version,
    boundAgentVersion: row.bound_agent_version,
    boundScopeVersion: row.bound_scope_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function parseFragments(row: Selectable<SharedApprovedBundlesTable>): unknown {
  try {
    return JSON.parse(row.fragments_json) as unknown;
  } catch {
    throw new AppError(500, 'SHARED_BUNDLE_CORRUPT', 'Stored shared bundle fragments are invalid');
  }
}

function toSharedBundle(row: Selectable<SharedApprovedBundlesTable>): SharedApprovedBundleRecord {
  if (sha256(row.fragments_json) !== row.content_sha256) {
    throw new AppError(500, 'SHARED_BUNDLE_CORRUPT', 'Stored shared bundle digest is invalid');
  }
  return SharedApprovedBundleRecordSchema.parse({
    id: row.bundle_id,
    sourceScopeId: row.source_scope_id,
    expectedSourceScopeVersion: row.source_scope_version,
    targetSleeveId: row.target_sleeve_id,
    expectedTargetScopeVersion: row.target_scope_version,
    expectedTargetSleeveVersion: row.target_sleeve_version,
    purpose: row.purpose,
    publishedSensitivity: row.published_sensitivity,
    fragments: parseFragments(row),
    contentSha256: row.content_sha256,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    expiresAt: row.expires_at,
    state: row.state,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function deriveSleeveKind(id: string): MemorySleeveKind {
  const namespace = id.split(':', 1)[0];
  if (namespace === 'agent') return 'agent_scratch';
  if (namespace === 'shared') return 'shared_approved';
  return MemorySleeveKindSchema.parse(namespace);
}

function derivePartitionKey(id: string): string {
  return `memory/sleeves/${id.replaceAll(':', '/')}`;
}

function canonicalTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function effectiveExpiry(expiries: readonly string[]): string {
  const timestamps = expiries.map((expiry) => Date.parse(expiry));
  return new Date(Math.min(...timestamps)).toISOString();
}

function isUnexpired(at: string, expiresAt: string | null): boolean {
  return expiresAt === null || Date.parse(at) < Date.parse(expiresAt);
}

function withinSensitivity(requested: AccessSensitivity, cap: AccessSensitivity): boolean {
  return sensitivityRank[requested] <= sensitivityRank[cap];
}

function expectedGrantVersions(
  grants: readonly (AgentSleeveGrantRecord | AgentToolGrantRecord)[]
): GrantVersionSet | undefined {
  if (grants.length !== AUTHORITY_LAYERS.length) return undefined;
  const versions = new Map<AuthorityLayer, number>();
  for (const grant of grants) {
    if (versions.has(grant.authorityLayer)) return undefined;
    versions.set(grant.authorityLayer, grant.version);
  }
  if (!AUTHORITY_LAYERS.every((layer) => versions.has(layer))) return undefined;
  return {
    blueprint: versions.get('blueprint') as number,
    operator: versions.get('operator') as number,
    tenant: versions.get('tenant') as number,
    channel: versions.get('channel') as number,
    run: versions.get('run') as number
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactScopeInput(input: RegisterControlScopeInput): ControlScopeRecord {
  return ControlScopeRecordSchema.parse({
    ...input,
    state: 'active',
    version: 1,
    updatedAt: input.createdAt
  });
}

function exactAgentInput(input: RegisterAccessAgentInput): AccessAgentRecord {
  return AccessAgentRecordSchema.parse({
    ...input,
    state: 'active',
    version: 1,
    updatedAt: input.createdAt
  });
}

function exactSleeveInput(input: RegisterMemorySleeveInput): MemorySleeveRecord {
  return MemorySleeveRecordSchema.parse({
    ...input,
    kind: deriveSleeveKind(input.id),
    partitionKey: derivePartitionKey(input.id),
    state: 'active',
    version: 1,
    updatedAt: input.createdAt
  });
}

export interface BoundAgentAccess {
  authorizeMemoryAccess(rawInput: unknown): Promise<AuthorizedMemoryAccess>;
  authorizeMemoryRetrieval(rawInput: unknown): Promise<AuthorizedMemoryRetrieval>;
  authorizeToolUse(rawInput: unknown): Promise<AuthorizedToolUse>;
  runAuthorizedMemoryAccess<T>(
    rawInput: unknown,
    access: (authorization: AuthorizedMemoryAccess) => Promise<T>
  ): Promise<T>;
  runAuthorizedMemoryRetrieval<T>(
    rawInput: unknown,
    retrieve: (authorization: AuthorizedMemoryRetrieval) => Promise<T>
  ): Promise<T>;
}

export class AccessControlRepository {
  private readonly issuedRetrievalCapabilities = new WeakSet<object>();

  constructor(
    private readonly db: Kysely<JarvisDatabase>,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async registerScope(rawInput: unknown): Promise<ControlScopeRecord> {
    const parsed = RegisterControlScopeInputSchema.parse(rawInput);
    const input = { ...parsed, createdAt: canonicalTimestamp(parsed.createdAt) };
    const expected = exactScopeInput(input);

    return this.db.transaction().execute(async (transaction) => {
      const existingRow = await transaction
        .selectFrom('control_scopes')
        .selectAll()
        .where('scope_id', '=', input.id)
        .executeTakeFirst();
      if (existingRow !== undefined) {
        const existing = toScope(existingRow);
        if (!isDeepStrictEqual(existing, expected)) {
          throw conflict(
            'CONTROL_SCOPE_CONFLICT',
            `Control scope ${input.id} already exists with a different binding`
          );
        }
        return existing;
      }

      if (input.parentScopeId !== null) {
        const parent = await transaction
          .selectFrom('control_scopes')
          .select(['scope_id', 'state'])
          .where('scope_id', '=', input.parentScopeId)
          .executeTakeFirst();
        if (parent === undefined || parent.state !== 'active') {
          throw conflict(
            'CONTROL_SCOPE_PARENT_INVALID',
            `Control scope ${input.id} requires an active registered parent`
          );
        }
      }

      const row = await transaction
        .insertInto('control_scopes')
        .values({
          scope_id: expected.id,
          scope_kind: expected.kind,
          subject_id: expected.subjectId,
          parent_scope_id: expected.parentScopeId,
          trust_domain: expected.trustDomain,
          state: expected.state,
          version: expected.version,
          created_at: expected.createdAt,
          updated_at: expected.updatedAt
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toScope(row);
    });
  }

  async registerAgent(rawInput: unknown): Promise<AccessAgentRecord> {
    const parsed = RegisterAccessAgentInputSchema.parse(rawInput);
    const input = { ...parsed, createdAt: canonicalTimestamp(parsed.createdAt) };
    const expected = exactAgentInput(input);

    return this.db.transaction().execute(async (transaction) => {
      const existingRow = await transaction
        .selectFrom('access_agents')
        .selectAll()
        .where('agent_id', '=', input.id)
        .executeTakeFirst();
      if (existingRow !== undefined) {
        const existing = toAgent(existingRow);
        if (!isDeepStrictEqual(existing, expected)) {
          throw conflict(
            'ACCESS_AGENT_CONFLICT',
            `Access agent ${input.id} already exists with a different binding`
          );
        }
        return existing;
      }

      const scope = await transaction
        .selectFrom('control_scopes')
        .selectAll()
        .where('scope_id', '=', input.homeScopeId)
        .executeTakeFirst();
      if (
        scope === undefined ||
        scope.state !== 'active' ||
        scope.trust_domain !== input.trustDomain
      ) {
        throw conflict(
          'ACCESS_AGENT_SCOPE_INVALID',
          'Access agent home scope must be active and in the exact trust domain'
        );
      }

      const row = await transaction
        .insertInto('access_agents')
        .values({
          agent_id: expected.id,
          home_scope_id: expected.homeScopeId,
          trust_domain: expected.trustDomain,
          profile_revision: expected.profileRevision,
          state: expected.state,
          version: expected.version,
          created_at: expected.createdAt,
          updated_at: expected.updatedAt
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toAgent(row);
    });
  }

  async registerSleeve(rawInput: unknown): Promise<MemorySleeveRecord> {
    const parsed = RegisterMemorySleeveInputSchema.parse(rawInput);
    const input = {
      ...parsed,
      expiresAt: parsed.expiresAt === null ? null : canonicalTimestamp(parsed.expiresAt),
      createdAt: canonicalTimestamp(parsed.createdAt)
    };
    const expected = exactSleeveInput(input);

    return this.db.transaction().execute(async (transaction) => {
      const existingRow = await transaction
        .selectFrom('memory_sleeves')
        .selectAll()
        .where('sleeve_id', '=', input.id)
        .executeTakeFirst();
      if (existingRow !== undefined) {
        const existing = toSleeve(existingRow);
        if (!isDeepStrictEqual(existing, expected)) {
          throw conflict(
            'MEMORY_SLEEVE_CONFLICT',
            `Memory sleeve ${input.id} already exists with a different binding`
          );
        }
        return existing;
      }

      const owner = await transaction
        .selectFrom('control_scopes')
        .selectAll()
        .where('scope_id', '=', input.ownerScopeId)
        .executeTakeFirst();
      if (owner === undefined || owner.state !== 'active') {
        throw conflict(
          'MEMORY_SLEEVE_SCOPE_INVALID',
          'Memory sleeve requires an active owner scope'
        );
      }

      if (expected.kind === 'agent_scratch') {
        const agentId = input.id.split(':')[1];
        const agent = await transaction
          .selectFrom('access_agents')
          .select(['agent_id', 'home_scope_id', 'state'])
          .where('agent_id', '=', agentId as string)
          .executeTakeFirst();
        if (
          agent === undefined ||
          agent.state !== 'active' ||
          agent.home_scope_id !== input.ownerScopeId
        ) {
          throw conflict(
            'MEMORY_SLEEVE_AGENT_INVALID',
            'Agent scratch sleeve must bind the exact active agent and home scope'
          );
        }
      } else if (expected.kind !== 'shared_approved' && owner.scope_kind !== expected.kind) {
        throw conflict(
          'MEMORY_SLEEVE_KIND_INVALID',
          'Memory sleeve namespace must match its exact owner scope kind'
        );
      }

      const row = await transaction
        .insertInto('memory_sleeves')
        .values({
          sleeve_id: expected.id,
          owner_scope_id: expected.ownerScopeId,
          sleeve_kind: expected.kind,
          max_sensitivity: expected.maxSensitivity,
          partition_key: expected.partitionKey,
          expires_at: expected.expiresAt,
          state: expected.state,
          version: expected.version,
          created_at: expected.createdAt,
          updated_at: expected.updatedAt
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toSleeve(row);
    });
  }

  async findScope(rawId: unknown): Promise<ControlScopeRecord | undefined> {
    const id = ControlScopeIdSchema.parse(rawId);
    const row = await this.db
      .selectFrom('control_scopes')
      .selectAll()
      .where('scope_id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toScope(row);
  }

  async findAgent(rawId: unknown): Promise<AccessAgentRecord | undefined> {
    const id = AccessAgentIdSchema.parse(rawId);
    const row = await this.db
      .selectFrom('access_agents')
      .selectAll()
      .where('agent_id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toAgent(row);
  }

  async findSleeve(rawId: unknown): Promise<MemorySleeveRecord | undefined> {
    const id = MemorySleeveIdSchema.parse(rawId);
    const row = await this.db
      .selectFrom('memory_sleeves')
      .selectAll()
      .where('sleeve_id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toSleeve(row);
  }

  async issueSleeveGrant(rawInput: unknown): Promise<AgentSleeveGrantRecord> {
    const parsed = IssueAgentSleeveGrantInputSchema.parse(rawInput);
    const input: IssueAgentSleeveGrantInput = {
      ...parsed,
      issuedAt: canonicalTimestamp(parsed.issuedAt),
      expiresAt: canonicalTimestamp(parsed.expiresAt)
    };

    return this.db.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom('agent_sleeve_grants')
        .selectAll()
        .where('grant_id', '=', input.id)
        .executeTakeFirst();
      if (existing !== undefined) return this.requireSameSleeveGrant(existing, input);

      const binding = await this.loadSleeveBinding(transaction, input.agentId, input.sleeveId);
      if (
        binding === undefined ||
        binding.agent.state !== 'active' ||
        binding.sleeve.state !== 'active' ||
        binding.scope.state !== 'active' ||
        binding.agent.trust_domain !== binding.scope.trust_domain ||
        binding.agent.version !== input.expectedAgentVersion ||
        binding.scope.version !== input.expectedScopeVersion ||
        binding.sleeve.version !== input.expectedSleeveVersion ||
        !withinSensitivity(
          input.sensitivityCap,
          AccessSensitivitySchema.parse(binding.sleeve.max_sensitivity)
        )
      ) {
        throw conflict(
          'SLEEVE_GRANT_BINDING_INVALID',
          'Sleeve grant does not match current exact agent, scope, sleeve, or sensitivity binding'
        );
      }

      const row = await transaction
        .insertInto('agent_sleeve_grants')
        .values({
          grant_id: input.id,
          agent_id: input.agentId,
          sleeve_id: input.sleeveId,
          authority_layer: input.authorityLayer,
          permission: input.permission,
          purpose: input.purpose,
          sensitivity_cap: input.sensitivityCap,
          expires_at: input.expiresAt,
          state: 'active',
          version: 1,
          bound_agent_version: input.expectedAgentVersion,
          bound_scope_version: input.expectedScopeVersion,
          bound_sleeve_version: input.expectedSleeveVersion,
          created_at: input.issuedAt,
          updated_at: input.issuedAt
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toSleeveGrant(row);
    });
  }

  async issueToolGrant(rawInput: unknown): Promise<AgentToolGrantRecord> {
    const parsed = IssueAgentToolGrantInputSchema.parse(rawInput);
    const input: IssueAgentToolGrantInput = {
      ...parsed,
      issuedAt: canonicalTimestamp(parsed.issuedAt),
      expiresAt: canonicalTimestamp(parsed.expiresAt)
    };

    return this.db.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom('agent_tool_grants')
        .selectAll()
        .where('grant_id', '=', input.id)
        .executeTakeFirst();
      if (existing !== undefined) return this.requireSameToolGrant(existing, input);

      const binding = await transaction
        .selectFrom('access_agents as agent')
        .innerJoin('control_scopes as scope', 'scope.scope_id', 'agent.home_scope_id')
        .select([
          'agent.state as agent_state',
          'agent.version as agent_version',
          'scope.state as scope_state',
          'scope.version as scope_version',
          'agent.trust_domain as agent_domain',
          'scope.trust_domain as scope_domain'
        ])
        .where('agent.agent_id', '=', input.agentId)
        .executeTakeFirst();
      if (
        binding === undefined ||
        binding.agent_state !== 'active' ||
        binding.scope_state !== 'active' ||
        binding.agent_domain !== binding.scope_domain ||
        binding.agent_version !== input.expectedAgentVersion ||
        binding.scope_version !== input.expectedScopeVersion
      ) {
        throw conflict(
          'TOOL_GRANT_BINDING_INVALID',
          'Tool grant does not match current exact agent and scope binding'
        );
      }

      const row = await transaction
        .insertInto('agent_tool_grants')
        .values({
          grant_id: input.id,
          agent_id: input.agentId,
          tool_id: input.toolId,
          authority_layer: input.authorityLayer,
          access: input.access,
          purpose: input.purpose,
          sensitivity_cap: input.sensitivityCap,
          expires_at: input.expiresAt,
          state: 'active',
          version: 1,
          bound_agent_version: input.expectedAgentVersion,
          bound_scope_version: input.expectedScopeVersion,
          created_at: input.issuedAt,
          updated_at: input.issuedAt
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toToolGrant(row);
    });
  }

  async revokeSleeveGrant(rawInput: unknown): Promise<AgentSleeveGrantRecord> {
    const parsed = RevokeAccessRecordInputSchema.parse(rawInput);
    const input: RevokeAccessRecordInput = {
      ...parsed,
      revokedAt: canonicalTimestamp(parsed.revokedAt)
    };
    const row = await this.db
      .updateTable('agent_sleeve_grants')
      .set({ state: 'revoked', version: input.expectedVersion + 1, updated_at: input.revokedAt })
      .where('grant_id', '=', input.id)
      .where('state', '=', 'active')
      .where('version', '=', input.expectedVersion)
      .where('updated_at', '<=', input.revokedAt)
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) {
      throw conflict('SLEEVE_GRANT_VERSION_CONFLICT', 'Sleeve grant checkpoint is stale');
    }
    return toSleeveGrant(row);
  }

  async revokeToolGrant(rawInput: unknown): Promise<AgentToolGrantRecord> {
    const parsed = RevokeAccessRecordInputSchema.parse(rawInput);
    const input: RevokeAccessRecordInput = {
      ...parsed,
      revokedAt: canonicalTimestamp(parsed.revokedAt)
    };
    const row = await this.db
      .updateTable('agent_tool_grants')
      .set({ state: 'revoked', version: input.expectedVersion + 1, updated_at: input.revokedAt })
      .where('grant_id', '=', input.id)
      .where('state', '=', 'active')
      .where('version', '=', input.expectedVersion)
      .where('updated_at', '<=', input.revokedAt)
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) {
      throw conflict('TOOL_GRANT_VERSION_CONFLICT', 'Tool grant checkpoint is stale');
    }
    return toToolGrant(row);
  }

  bindAgent(rawPrincipal: unknown): BoundAgentAccess {
    const principal = AgentAuthorizationPrincipalSchema.parse(rawPrincipal);
    return Object.freeze({
      authorizeMemoryAccess: (rawInput: unknown) => this.authorizeMemoryAccess(principal, rawInput),
      authorizeMemoryRetrieval: (rawInput: unknown) =>
        this.authorizeMemoryRetrieval(principal, rawInput),
      authorizeToolUse: (rawInput: unknown) => this.authorizeToolUse(principal, rawInput),
      runAuthorizedMemoryAccess: async <T>(
        rawInput: unknown,
        access: (authorization: AuthorizedMemoryAccess) => Promise<T>
      ): Promise<T> => {
        const authorization = await this.authorizeMemoryAccess(principal, rawInput);
        return access(authorization);
      },
      runAuthorizedMemoryRetrieval: async <T>(
        rawInput: unknown,
        retrieve: (authorization: AuthorizedMemoryRetrieval) => Promise<T>
      ): Promise<T> => {
        const authorization = await this.authorizeMemoryRetrieval(principal, rawInput);
        return retrieve(authorization);
      }
    });
  }

  async publishSharedApprovedBundle(rawInput: unknown): Promise<SharedApprovedBundleRecord> {
    const parsed = PublishSharedApprovedBundleInputSchema.parse(rawInput);
    const input: PublishSharedApprovedBundleInput = {
      ...parsed,
      reviewedAt: canonicalTimestamp(parsed.reviewedAt),
      expiresAt: canonicalTimestamp(parsed.expiresAt)
    };
    const fragmentsJson = JSON.stringify(input.fragments);
    const expected = SharedApprovedBundleRecordSchema.parse({
      ...input,
      contentSha256: sha256(fragmentsJson),
      state: 'active',
      version: 1,
      createdAt: input.reviewedAt,
      updatedAt: input.reviewedAt
    });

    return this.db.transaction().execute(async (transaction) => {
      const existingRow = await transaction
        .selectFrom('shared_approved_bundles')
        .selectAll()
        .where('bundle_id', '=', input.id)
        .executeTakeFirst();
      if (existingRow !== undefined) {
        const existing = toSharedBundle(existingRow);
        if (!isDeepStrictEqual(existing, expected)) {
          throw conflict(
            'SHARED_BUNDLE_CONFLICT',
            `Shared bundle ${input.id} already exists with a different publication`
          );
        }
        return existing;
      }

      const source = await transaction
        .selectFrom('control_scopes')
        .select(['scope_id', 'state', 'version'])
        .where('scope_id', '=', input.sourceScopeId)
        .executeTakeFirst();
      const target = await transaction
        .selectFrom('memory_sleeves as sleeve')
        .innerJoin('control_scopes as scope', 'scope.scope_id', 'sleeve.owner_scope_id')
        .select([
          'sleeve.sleeve_id as sleeve_id',
          'sleeve.sleeve_kind as sleeve_kind',
          'sleeve.max_sensitivity as max_sensitivity',
          'sleeve.expires_at as sleeve_expires_at',
          'sleeve.state as sleeve_state',
          'sleeve.version as sleeve_version',
          'scope.scope_id as owner_scope_id',
          'scope.state as scope_state',
          'scope.version as scope_version'
        ])
        .where('sleeve.sleeve_id', '=', input.targetSleeveId)
        .executeTakeFirst();

      if (
        source === undefined ||
        target === undefined ||
        source.state !== 'active' ||
        target.scope_state !== 'active' ||
        target.sleeve_state !== 'active' ||
        source.version !== input.expectedSourceScopeVersion ||
        target.scope_version !== input.expectedTargetScopeVersion ||
        target.sleeve_version !== input.expectedTargetSleeveVersion ||
        target.sleeve_kind !== 'shared_approved'
      ) {
        throw conflict(
          'SHARED_BUNDLE_BINDING_INVALID',
          'Shared bundle requires current active source and shared-approved target bindings'
        );
      }
      if (source.scope_id === target.owner_scope_id) {
        throw conflict(
          'SHARED_BUNDLE_NOT_CROSS_SCOPE',
          'Shared bundle publication must be cross-scope'
        );
      }
      if (
        !withinSensitivity(
          input.publishedSensitivity,
          AccessSensitivitySchema.parse(target.max_sensitivity)
        ) ||
        !isUnexpired(input.reviewedAt, target.sleeve_expires_at) ||
        !isUnexpired(input.expiresAt, target.sleeve_expires_at)
      ) {
        throw conflict(
          'SHARED_BUNDLE_POLICY_INVALID',
          'Shared bundle sensitivity or expiry exceeds the approved target sleeve'
        );
      }

      const row = await transaction
        .insertInto('shared_approved_bundles')
        .values({
          bundle_id: expected.id,
          source_scope_id: expected.sourceScopeId,
          source_scope_version: expected.expectedSourceScopeVersion,
          target_sleeve_id: expected.targetSleeveId,
          target_scope_version: expected.expectedTargetScopeVersion,
          target_sleeve_version: expected.expectedTargetSleeveVersion,
          purpose: expected.purpose,
          published_sensitivity: expected.publishedSensitivity,
          fragments_json: fragmentsJson,
          content_sha256: expected.contentSha256,
          reviewed_by: expected.reviewedBy,
          reviewed_at: expected.reviewedAt,
          expires_at: expected.expiresAt,
          state: expected.state,
          version: expected.version,
          created_at: expected.createdAt,
          updated_at: expected.updatedAt
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toSharedBundle(row);
    });
  }

  async listSharedApprovedBundles(
    authorization: unknown,
    limit = 25
  ): Promise<SharedApprovedBundleRecord[]> {
    if (
      typeof authorization !== 'object' ||
      authorization === null ||
      !this.issuedRetrievalCapabilities.has(authorization)
    ) {
      throw new MemoryAccessDeniedError();
    }
    const approved = AuthorizedMemoryRetrievalSchema.parse(authorization);
    if (!isUnexpired(canonicalTimestamp(this.clock().toISOString()), approved.effectiveExpiresAt)) {
      throw new MemoryAccessDeniedError();
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('shared bundle limit must be an integer between 1 and 100');
    }
    const rows = await this.db
      .selectFrom('shared_approved_bundles')
      .selectAll()
      .where('target_sleeve_id', '=', approved.sleeveId)
      .where('target_sleeve_version', '=', approved.sleeveVersion)
      .where('purpose', '=', approved.purpose)
      .where('state', '=', 'active')
      .where('expires_at', '>', approved.authorizedAt)
      .orderBy('reviewed_at', 'desc')
      .orderBy('bundle_id', 'asc')
      .limit(limit)
      .execute();
    return rows
      .map(toSharedBundle)
      .filter((bundle) => withinSensitivity(bundle.publishedSensitivity, approved.sensitivity));
  }

  private async authorizeMemoryRetrieval(
    principal: AgentAuthorizationPrincipal,
    rawInput: unknown
  ): Promise<AuthorizedMemoryRetrieval> {
    const input = AuthorizeMemoryRetrievalInputSchema.parse(rawInput);
    const authorization = await this.authorizeMemoryAccess(principal, input);
    const retrieval = Object.freeze(AuthorizedMemoryRetrievalSchema.parse(authorization));
    this.issuedRetrievalCapabilities.add(retrieval);
    return retrieval;
  }

  private async authorizeMemoryAccess(
    principal: AgentAuthorizationPrincipal,
    rawInput: unknown
  ): Promise<AuthorizedMemoryAccess> {
    const input = AuthorizeMemoryAccessInputSchema.parse(rawInput);
    const authorizedAt = canonicalTimestamp(this.clock().toISOString());
    const [binding, grantRows] = await Promise.all([
      this.loadSleeveBinding(this.db, principal.agentId, input.sleeveId),
      this.db
        .selectFrom('agent_sleeve_grants')
        .selectAll()
        .where('agent_id', '=', principal.agentId)
        .where('sleeve_id', '=', input.sleeveId)
        .where('permission', '=', input.permission)
        .where('state', '=', 'active')
        .execute()
    ]);
    if (
      binding === undefined ||
      binding.agent.state !== 'active' ||
      binding.scope.state !== 'active' ||
      binding.sleeve.state !== 'active' ||
      binding.agent.trust_domain !== binding.scope.trust_domain ||
      binding.agent.version !== principal.expectedAgentVersion ||
      binding.scope.version !== input.expectedOwnerScopeVersion ||
      binding.sleeve.version !== input.expectedSleeveVersion ||
      !isUnexpired(authorizedAt, binding.sleeve.expires_at) ||
      !withinSensitivity(
        input.sensitivity,
        AccessSensitivitySchema.parse(binding.sleeve.max_sensitivity)
      )
    ) {
      throw new MemoryAccessDeniedError();
    }

    const grants = grantRows.map(toSleeveGrant);
    const storedVersions = expectedGrantVersions(grants);
    if (
      storedVersions === undefined ||
      !isDeepStrictEqual(storedVersions, input.grantVersions) ||
      grants.some(
        (grant) =>
          grant.purpose !== input.purpose ||
          grant.boundAgentVersion !== principal.expectedAgentVersion ||
          grant.boundScopeVersion !== input.expectedOwnerScopeVersion ||
          grant.boundSleeveVersion !== input.expectedSleeveVersion ||
          !isUnexpired(authorizedAt, grant.expiresAt) ||
          !withinSensitivity(input.sensitivity, grant.sensitivityCap)
      )
    ) {
      throw new MemoryAccessDeniedError();
    }

    const authorization = Object.freeze(
      AuthorizedMemoryAccessSchema.parse({
        agentId: principal.agentId,
        sleeveId: input.sleeveId,
        ownerScopeId: binding.scope.scope_id,
        partitionKey: binding.sleeve.partition_key,
        permission: input.permission,
        purpose: input.purpose,
        sensitivity: input.sensitivity,
        authorizedAt,
        effectiveExpiresAt: effectiveExpiry([
          ...grants.map(({ expiresAt: expiry }) => expiry),
          ...(binding.sleeve.expires_at === null ? [] : [binding.sleeve.expires_at])
        ]),
        agentVersion: principal.expectedAgentVersion,
        ownerScopeVersion: input.expectedOwnerScopeVersion,
        sleeveVersion: input.expectedSleeveVersion,
        grantVersions: input.grantVersions
      })
    );
    this.issuedRetrievalCapabilities.add(authorization);
    return authorization;
  }

  private async authorizeToolUse(
    principal: AgentAuthorizationPrincipal,
    rawInput: unknown
  ): Promise<AuthorizedToolUse> {
    const input = AuthorizeToolUseInputSchema.parse(rawInput);
    const authorizedAt = canonicalTimestamp(this.clock().toISOString());
    const binding = await this.db
      .selectFrom('access_agents as agent')
      .innerJoin('control_scopes as scope', 'scope.scope_id', 'agent.home_scope_id')
      .select([
        'agent.home_scope_id as home_scope_id',
        'agent.trust_domain as agent_domain',
        'agent.state as agent_state',
        'agent.version as agent_version',
        'scope.trust_domain as scope_domain',
        'scope.state as scope_state',
        'scope.version as scope_version'
      ])
      .where('agent.agent_id', '=', principal.agentId)
      .executeTakeFirst();
    if (
      binding === undefined ||
      binding.agent_state !== 'active' ||
      binding.scope_state !== 'active' ||
      binding.agent_domain !== binding.scope_domain ||
      binding.agent_version !== principal.expectedAgentVersion ||
      binding.scope_version !== input.expectedHomeScopeVersion
    ) {
      throw new ToolAccessDeniedError();
    }

    const rows = await this.db
      .selectFrom('agent_tool_grants')
      .selectAll()
      .where('agent_id', '=', principal.agentId)
      .where('tool_id', '=', input.toolId)
      .where('access', '=', input.access)
      .where('state', '=', 'active')
      .execute();
    const grants = rows.map(toToolGrant);
    const storedVersions = expectedGrantVersions(grants);
    if (
      storedVersions === undefined ||
      !isDeepStrictEqual(storedVersions, input.grantVersions) ||
      grants.some(
        (grant) =>
          grant.purpose !== input.purpose ||
          grant.boundAgentVersion !== principal.expectedAgentVersion ||
          grant.boundScopeVersion !== input.expectedHomeScopeVersion ||
          !isUnexpired(authorizedAt, grant.expiresAt) ||
          !withinSensitivity(input.sensitivity, grant.sensitivityCap)
      )
    ) {
      throw new ToolAccessDeniedError();
    }

    return Object.freeze(
      AuthorizedToolUseSchema.parse({
        agentId: principal.agentId,
        homeScopeId: binding.home_scope_id,
        toolId: input.toolId,
        access: input.access,
        purpose: input.purpose,
        sensitivity: input.sensitivity,
        authorizedAt,
        effectiveExpiresAt: effectiveExpiry(grants.map(({ expiresAt: expiry }) => expiry)),
        agentVersion: principal.expectedAgentVersion,
        homeScopeVersion: input.expectedHomeScopeVersion,
        grantVersions: input.grantVersions
      })
    );
  }

  private async loadSleeveBinding(
    executor: Kysely<JarvisDatabase> | Transaction<JarvisDatabase>,
    agentId: string,
    sleeveId: string
  ) {
    const agent = await executor
      .selectFrom('access_agents')
      .select(['agent_id', 'trust_domain', 'state', 'version'])
      .where('agent_id', '=', agentId)
      .executeTakeFirst();
    const sleeve = await executor
      .selectFrom('memory_sleeves')
      .select([
        'sleeve_id',
        'owner_scope_id',
        'max_sensitivity',
        'partition_key',
        'expires_at',
        'state',
        'version'
      ])
      .where('sleeve_id', '=', sleeveId)
      .executeTakeFirst();

    const scope = await executor
      .selectFrom('control_scopes')
      .select(['scope_id', 'trust_domain', 'state', 'version'])
      .where('scope_id', '=', sleeve?.owner_scope_id ?? 'personal:authorization-denied-placeholder')
      .executeTakeFirst();
    return agent === undefined || sleeve === undefined || scope === undefined
      ? undefined
      : { agent, sleeve, scope };
  }

  private requireSameSleeveGrant(
    existingRow: Selectable<AgentSleeveGrantsTable>,
    input: IssueAgentSleeveGrantInput
  ): AgentSleeveGrantRecord {
    const existing = toSleeveGrant(existingRow);
    const expected = AgentSleeveGrantRecordSchema.parse({
      id: input.id,
      agentId: input.agentId,
      sleeveId: input.sleeveId,
      authorityLayer: input.authorityLayer,
      permission: input.permission,
      purpose: input.purpose,
      sensitivityCap: input.sensitivityCap,
      expiresAt: input.expiresAt,
      state: 'active',
      version: 1,
      boundAgentVersion: input.expectedAgentVersion,
      boundScopeVersion: input.expectedScopeVersion,
      boundSleeveVersion: input.expectedSleeveVersion,
      createdAt: input.issuedAt,
      updatedAt: input.issuedAt
    });
    if (!isDeepStrictEqual(existing, expected)) {
      throw conflict(
        'SLEEVE_GRANT_CONFLICT',
        `Sleeve grant ${input.id} already exists with a different binding`
      );
    }
    return existing;
  }

  private requireSameToolGrant(
    existingRow: Selectable<AgentToolGrantsTable>,
    input: IssueAgentToolGrantInput
  ): AgentToolGrantRecord {
    const existing = toToolGrant(existingRow);
    const expected = AgentToolGrantRecordSchema.parse({
      id: input.id,
      agentId: input.agentId,
      toolId: input.toolId,
      authorityLayer: input.authorityLayer,
      access: input.access,
      purpose: input.purpose,
      sensitivityCap: input.sensitivityCap,
      expiresAt: input.expiresAt,
      state: 'active',
      version: 1,
      boundAgentVersion: input.expectedAgentVersion,
      boundScopeVersion: input.expectedScopeVersion,
      createdAt: input.issuedAt,
      updatedAt: input.issuedAt
    });
    if (!isDeepStrictEqual(existing, expected)) {
      throw conflict(
        'TOOL_GRANT_CONFLICT',
        `Tool grant ${input.id} already exists with a different binding`
      );
    }
    return existing;
  }
}
