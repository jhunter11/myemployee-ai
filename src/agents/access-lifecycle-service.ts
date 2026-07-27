import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { Kysely, Selectable, Transaction } from 'kysely';

import type {
  AccessLifecycleEventsTable,
  AgentSleeveGrantsTable,
  AgentToolGrantsTable,
  JarvisDatabase,
  SharedApprovedBundlesTable
} from '../db/types';
import { AppError } from '../utils/errors';
import {
  AccessLifecycleEventSchema,
  AccessLifecycleProjectionInputSchema,
  ReplaceGrantInputSchema,
  ReplaceSharedBundleInputSchema,
  RevokeGrantInputSchema,
  RevokeSharedBundleInputSchema,
  VerifiedOperatorIdentitySchema,
  type AccessLifecycleAction,
  type AccessLifecycleEvent,
  type AccessLifecycleProjectionInput,
  type AccessLifecycleResourceKind,
  type ReplaceGrantInput,
  type ReplaceSharedBundleInput,
  type RevokeGrantInput,
  type RevokeSharedBundleInput,
  type VerifiedOperatorIdentity
} from './access-lifecycle-contracts';
import {
  AccessSensitivitySchema,
  AgentSleeveGrantRecordSchema,
  AgentToolGrantRecordSchema,
  IssueAgentSleeveGrantInputSchema,
  IssueAgentToolGrantInputSchema,
  PublishSharedApprovedBundleInputSchema,
  SharedApprovedBundleRecordSchema,
  type AccessSensitivity,
  type AgentSleeveGrantRecord,
  type AgentToolGrantRecord,
  type IssueAgentSleeveGrantInput,
  type IssueAgentToolGrantInput,
  type PublishSharedApprovedBundleInput,
  type SharedApprovedBundleRecord
} from './access-control-contracts';

type DatabaseExecutor = Kysely<JarvisDatabase> | Transaction<JarvisDatabase>;

const sensitivityRank: Readonly<Record<AccessSensitivity, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  private: 3,
  restricted: 4
};

interface EventSpec {
  resourceKind: AccessLifecycleResourceKind;
  resourceId: string;
  action: AccessLifecycleAction;
  replacementResourceId: string | null;
  priorVersion: number;
  resultingVersion: number;
  actorId: string;
  reason: string;
  occurredAt: string;
}

export interface GrantLifecycleResult {
  current: AgentSleeveGrantRecord | AgentToolGrantRecord;
  replacement?: AgentSleeveGrantRecord | AgentToolGrantRecord;
  evidence: AccessLifecycleEvent;
}

export interface SharedBundleLifecycleResult {
  current: SharedApprovedBundleRecord;
  replacement?: SharedApprovedBundleRecord;
  evidence: AccessLifecycleEvent;
}

export interface AccessLifecycleProjection {
  generatedAt: string;
  totalCount: number;
  returnedCount: number;
  items: AccessLifecycleEvent[];
}

export interface BoundOperatorAccessLifecycle {
  revokeGrant(rawInput: unknown): Promise<GrantLifecycleResult>;
  replaceGrant(rawInput: unknown): Promise<GrantLifecycleResult>;
  revokeSharedBundle(rawInput: unknown): Promise<SharedBundleLifecycleResult>;
  replaceSharedBundle(rawInput: unknown): Promise<SharedBundleLifecycleResult>;
  project(rawInput?: unknown): Promise<AccessLifecycleProjection>;
}

export type OperatorIdentityVerifier = (candidate: unknown) => VerifiedOperatorIdentity | undefined;

function conflict(code: string, message: string): AppError {
  return new AppError(409, code, message);
}

function canonicalTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function withinSensitivity(requested: AccessSensitivity, cap: AccessSensitivity): boolean {
  return sensitivityRank[requested] <= sensitivityRank[cap];
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

function toEvent(row: Selectable<AccessLifecycleEventsTable>): AccessLifecycleEvent {
  return AccessLifecycleEventSchema.parse({
    sequence: row.event_sequence,
    id: row.event_id,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    action: row.action,
    replacementResourceId: row.replacement_resource_id,
    priorVersion: row.prior_version,
    resultingVersion: row.resulting_version,
    actorId: row.actor_id,
    reason: row.reason,
    evidenceSha256: row.evidence_sha256,
    occurredAt: row.occurred_at
  });
}

function eventIdentity(spec: EventSpec): { id: string; digest: string } {
  const digest = sha256(JSON.stringify(spec));
  return { id: `access-event:${digest}`, digest };
}

function eventMatchesSpec(event: AccessLifecycleEvent, spec: EventSpec): boolean {
  return isDeepStrictEqual(
    {
      resourceKind: event.resourceKind,
      resourceId: event.resourceId,
      action: event.action,
      replacementResourceId: event.replacementResourceId,
      priorVersion: event.priorVersion,
      resultingVersion: event.resultingVersion,
      actorId: event.actorId,
      reason: event.reason,
      occurredAt: event.occurredAt
    },
    spec
  );
}

async function findEvent(
  executor: DatabaseExecutor,
  spec: EventSpec
): Promise<AccessLifecycleEvent | undefined> {
  const identity = eventIdentity(spec);
  const row = await executor
    .selectFrom('access_lifecycle_events')
    .selectAll()
    .where('event_id', '=', identity.id)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const event = toEvent(row);
  if (event.evidenceSha256 !== identity.digest || !eventMatchesSpec(event, spec)) {
    throw new AppError(
      500,
      'ACCESS_LIFECYCLE_EVIDENCE_CORRUPT',
      'Stored access lifecycle evidence does not match its deterministic identity'
    );
  }
  return event;
}

async function appendEvent(
  transaction: Transaction<JarvisDatabase>,
  spec: EventSpec
): Promise<AccessLifecycleEvent> {
  const identity = eventIdentity(spec);
  const row = await transaction
    .insertInto('access_lifecycle_events')
    .values({
      event_id: identity.id,
      resource_kind: spec.resourceKind,
      resource_id: spec.resourceId,
      action: spec.action,
      replacement_resource_id: spec.replacementResourceId,
      prior_version: spec.priorVersion,
      resulting_version: spec.resultingVersion,
      actor_id: spec.actorId,
      reason: spec.reason,
      evidence_sha256: identity.digest,
      occurred_at: spec.occurredAt
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toEvent(row);
}

function canonicalRevokeGrant(rawInput: unknown): RevokeGrantInput {
  const parsed = RevokeGrantInputSchema.parse(rawInput);
  return { ...parsed, occurredAt: canonicalTimestamp(parsed.occurredAt) };
}

function canonicalReplaceGrant(rawInput: unknown): ReplaceGrantInput {
  const parsed = ReplaceGrantInputSchema.parse(rawInput);
  if (parsed.resourceKind === 'sleeve_grant') {
    return {
      ...parsed,
      occurredAt: canonicalTimestamp(parsed.occurredAt),
      replacement: IssueAgentSleeveGrantInputSchema.parse({
        ...parsed.replacement,
        issuedAt: canonicalTimestamp(parsed.replacement.issuedAt),
        expiresAt: canonicalTimestamp(parsed.replacement.expiresAt)
      })
    };
  }
  return {
    ...parsed,
    occurredAt: canonicalTimestamp(parsed.occurredAt),
    replacement: IssueAgentToolGrantInputSchema.parse({
      ...parsed.replacement,
      issuedAt: canonicalTimestamp(parsed.replacement.issuedAt),
      expiresAt: canonicalTimestamp(parsed.replacement.expiresAt)
    })
  };
}

function canonicalRevokeBundle(rawInput: unknown): RevokeSharedBundleInput {
  const parsed = RevokeSharedBundleInputSchema.parse(rawInput);
  return { ...parsed, occurredAt: canonicalTimestamp(parsed.occurredAt) };
}

function canonicalReplaceBundle(rawInput: unknown): ReplaceSharedBundleInput {
  const parsed = ReplaceSharedBundleInputSchema.parse(rawInput);
  return {
    ...parsed,
    occurredAt: canonicalTimestamp(parsed.occurredAt),
    replacement: PublishSharedApprovedBundleInputSchema.parse({
      ...parsed.replacement,
      reviewedAt: canonicalTimestamp(parsed.replacement.reviewedAt),
      expiresAt: canonicalTimestamp(parsed.replacement.expiresAt)
    })
  };
}

function eventSpec(
  operator: VerifiedOperatorIdentity,
  input: { id: string; expectedVersion: number; reason: string; occurredAt: string },
  resourceKind: AccessLifecycleResourceKind,
  action: AccessLifecycleAction,
  replacementResourceId: string | null
): EventSpec {
  return {
    resourceKind,
    resourceId: input.id,
    action,
    replacementResourceId,
    priorVersion: input.expectedVersion,
    resultingVersion: input.expectedVersion + 1,
    actorId: operator.id,
    reason: input.reason,
    occurredAt: input.occurredAt
  };
}

function assertReplacementIdentity(
  currentId: string,
  replacementId: string,
  issuedAt: string,
  occurredAt: string
): void {
  if (currentId === replacementId || issuedAt !== occurredAt) {
    throw conflict(
      'ACCESS_REPLACEMENT_BINDING_DRIFT',
      'Replacement requires a new ID and an issuance timestamp equal to the lifecycle event'
    );
  }
}

export class AccessLifecycleService {
  constructor(
    private readonly db: Kysely<JarvisDatabase>,
    private readonly verifyOperator: OperatorIdentityVerifier,
    private readonly clock: () => Date = () => new Date()
  ) {}

  bindOperator(rawCandidate: unknown): BoundOperatorAccessLifecycle {
    const verified = this.verifyOperator(rawCandidate);
    if (verified === undefined) {
      throw new AppError(403, 'ACCESS_OPERATOR_REQUIRED', 'Operator verification is required');
    }
    const operator = VerifiedOperatorIdentitySchema.parse(verified);
    return Object.freeze({
      revokeGrant: (rawInput: unknown) => this.revokeGrant(operator, rawInput),
      replaceGrant: (rawInput: unknown) => this.replaceGrant(operator, rawInput),
      revokeSharedBundle: (rawInput: unknown) => this.revokeSharedBundle(operator, rawInput),
      replaceSharedBundle: (rawInput: unknown) => this.replaceSharedBundle(operator, rawInput),
      project: (rawInput: unknown = {}) => this.project(operator, rawInput)
    });
  }

  private async revokeGrant(
    operator: VerifiedOperatorIdentity,
    rawInput: unknown
  ): Promise<GrantLifecycleResult> {
    const input = canonicalRevokeGrant(rawInput);
    const spec = eventSpec(operator, input, input.resourceKind, 'revoked', null);
    return this.db.transaction().execute(async (transaction) => {
      const existingEvent = await findEvent(transaction, spec);
      if (input.resourceKind === 'sleeve_grant') {
        const currentRow = await transaction
          .selectFrom('agent_sleeve_grants')
          .selectAll()
          .where('grant_id', '=', input.id)
          .executeTakeFirst();
        if (existingEvent !== undefined) {
          if (currentRow === undefined)
            throw new AppError(
              500,
              'ACCESS_LIFECYCLE_RECORD_MISSING',
              'Revoked grant record is missing'
            );
          return { current: toSleeveGrant(currentRow), evidence: existingEvent };
        }
        if (
          currentRow === undefined ||
          currentRow.state !== 'active' ||
          currentRow.version !== input.expectedVersion ||
          currentRow.updated_at > input.occurredAt
        ) {
          throw conflict(
            'ACCESS_LIFECYCLE_VERSION_CONFLICT',
            'Grant lifecycle checkpoint is stale'
          );
        }
        const updated = await transaction
          .updateTable('agent_sleeve_grants')
          .set({ state: 'revoked', version: spec.resultingVersion, updated_at: input.occurredAt })
          .where('grant_id', '=', input.id)
          .where('state', '=', 'active')
          .where('version', '=', input.expectedVersion)
          .returningAll()
          .executeTakeFirstOrThrow();
        return { current: toSleeveGrant(updated), evidence: await appendEvent(transaction, spec) };
      }

      const currentRow = await transaction
        .selectFrom('agent_tool_grants')
        .selectAll()
        .where('grant_id', '=', input.id)
        .executeTakeFirst();
      if (existingEvent !== undefined) {
        if (currentRow === undefined)
          throw new AppError(
            500,
            'ACCESS_LIFECYCLE_RECORD_MISSING',
            'Revoked grant record is missing'
          );
        return { current: toToolGrant(currentRow), evidence: existingEvent };
      }
      if (
        currentRow === undefined ||
        currentRow.state !== 'active' ||
        currentRow.version !== input.expectedVersion ||
        currentRow.updated_at > input.occurredAt
      ) {
        throw conflict('ACCESS_LIFECYCLE_VERSION_CONFLICT', 'Grant lifecycle checkpoint is stale');
      }
      const updated = await transaction
        .updateTable('agent_tool_grants')
        .set({ state: 'revoked', version: spec.resultingVersion, updated_at: input.occurredAt })
        .where('grant_id', '=', input.id)
        .where('state', '=', 'active')
        .where('version', '=', input.expectedVersion)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { current: toToolGrant(updated), evidence: await appendEvent(transaction, spec) };
    });
  }

  private async replaceGrant(
    operator: VerifiedOperatorIdentity,
    rawInput: unknown
  ): Promise<GrantLifecycleResult> {
    const input = canonicalReplaceGrant(rawInput);
    const spec = eventSpec(operator, input, input.resourceKind, 'replaced', input.replacement.id);
    return input.resourceKind === 'sleeve_grant'
      ? this.replaceSleeveGrant(input, spec)
      : this.replaceToolGrant(input, spec);
  }

  private async replaceSleeveGrant(
    input: Extract<ReplaceGrantInput, { resourceKind: 'sleeve_grant' }>,
    spec: EventSpec
  ): Promise<GrantLifecycleResult> {
    const replacement: IssueAgentSleeveGrantInput = input.replacement;
    assertReplacementIdentity(input.id, replacement.id, replacement.issuedAt, input.occurredAt);
    return this.db.transaction().execute(async (transaction) => {
      const existingEvent = await findEvent(transaction, spec);
      const [currentRow, replacementRow] = await Promise.all([
        transaction
          .selectFrom('agent_sleeve_grants')
          .selectAll()
          .where('grant_id', '=', input.id)
          .executeTakeFirst(),
        transaction
          .selectFrom('agent_sleeve_grants')
          .selectAll()
          .where('grant_id', '=', replacement.id)
          .executeTakeFirst()
      ]);
      if (existingEvent !== undefined) {
        if (currentRow === undefined || replacementRow === undefined) {
          throw new AppError(
            500,
            'ACCESS_LIFECYCLE_RECORD_MISSING',
            'Replacement grant record is missing'
          );
        }
        return {
          current: toSleeveGrant(currentRow),
          replacement: toSleeveGrant(replacementRow),
          evidence: existingEvent
        };
      }
      if (
        currentRow === undefined ||
        currentRow.state !== 'active' ||
        currentRow.version !== input.expectedVersion ||
        currentRow.updated_at > input.occurredAt
      ) {
        throw conflict('ACCESS_LIFECYCLE_VERSION_CONFLICT', 'Grant lifecycle checkpoint is stale');
      }
      if (replacementRow !== undefined) {
        throw conflict('ACCESS_REPLACEMENT_CONFLICT', 'Replacement grant ID already exists');
      }
      if (
        currentRow.agent_id !== replacement.agentId ||
        currentRow.sleeve_id !== replacement.sleeveId ||
        currentRow.authority_layer !== replacement.authorityLayer ||
        currentRow.permission !== replacement.permission ||
        currentRow.purpose !== replacement.purpose ||
        !withinSensitivity(
          replacement.sensitivityCap,
          AccessSensitivitySchema.parse(currentRow.sensitivity_cap)
        )
      ) {
        throw conflict(
          'ACCESS_REPLACEMENT_BINDING_DRIFT',
          'Replacement grant changes its exact authorization binding or widens sensitivity'
        );
      }
      const [agentBinding, sleeveBinding] = await Promise.all([
        transaction
          .selectFrom('access_agents')
          .select(['state', 'version', 'trust_domain'])
          .where('agent_id', '=', replacement.agentId)
          .executeTakeFirst(),
        transaction
          .selectFrom('memory_sleeves as sleeve')
          .innerJoin('control_scopes as scope', 'scope.scope_id', 'sleeve.owner_scope_id')
          .select([
            'sleeve.state as sleeve_state',
            'sleeve.version as sleeve_version',
            'sleeve.max_sensitivity as sleeve_sensitivity',
            'scope.state as scope_state',
            'scope.version as scope_version',
            'scope.trust_domain as scope_domain'
          ])
          .where('sleeve.sleeve_id', '=', replacement.sleeveId)
          .executeTakeFirst()
      ]);
      if (
        agentBinding === undefined ||
        sleeveBinding === undefined ||
        agentBinding.state !== 'active' ||
        sleeveBinding.sleeve_state !== 'active' ||
        sleeveBinding.scope_state !== 'active' ||
        agentBinding.trust_domain !== sleeveBinding.scope_domain ||
        agentBinding.version !== replacement.expectedAgentVersion ||
        sleeveBinding.scope_version !== replacement.expectedScopeVersion ||
        sleeveBinding.sleeve_version !== replacement.expectedSleeveVersion ||
        !withinSensitivity(
          replacement.sensitivityCap,
          AccessSensitivitySchema.parse(sleeveBinding.sleeve_sensitivity)
        )
      ) {
        throw conflict(
          'ACCESS_REPLACEMENT_BINDING_INVALID',
          'Replacement grant does not match current exact agent, scope, and sleeve versions'
        );
      }

      const current = await transaction
        .updateTable('agent_sleeve_grants')
        .set({ state: 'revoked', version: spec.resultingVersion, updated_at: input.occurredAt })
        .where('grant_id', '=', input.id)
        .where('state', '=', 'active')
        .where('version', '=', input.expectedVersion)
        .returningAll()
        .executeTakeFirstOrThrow();
      const inserted = await transaction
        .insertInto('agent_sleeve_grants')
        .values({
          grant_id: replacement.id,
          agent_id: replacement.agentId,
          sleeve_id: replacement.sleeveId,
          authority_layer: replacement.authorityLayer,
          permission: replacement.permission,
          purpose: replacement.purpose,
          sensitivity_cap: replacement.sensitivityCap,
          expires_at: replacement.expiresAt,
          state: 'active',
          version: 1,
          bound_agent_version: replacement.expectedAgentVersion,
          bound_scope_version: replacement.expectedScopeVersion,
          bound_sleeve_version: replacement.expectedSleeveVersion,
          created_at: replacement.issuedAt,
          updated_at: replacement.issuedAt
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return {
        current: toSleeveGrant(current),
        replacement: toSleeveGrant(inserted),
        evidence: await appendEvent(transaction, spec)
      };
    });
  }

  private async replaceToolGrant(
    input: Extract<ReplaceGrantInput, { resourceKind: 'tool_grant' }>,
    spec: EventSpec
  ): Promise<GrantLifecycleResult> {
    const replacement: IssueAgentToolGrantInput = input.replacement;
    assertReplacementIdentity(input.id, replacement.id, replacement.issuedAt, input.occurredAt);
    return this.db.transaction().execute(async (transaction) => {
      const existingEvent = await findEvent(transaction, spec);
      const [currentRow, replacementRow] = await Promise.all([
        transaction
          .selectFrom('agent_tool_grants')
          .selectAll()
          .where('grant_id', '=', input.id)
          .executeTakeFirst(),
        transaction
          .selectFrom('agent_tool_grants')
          .selectAll()
          .where('grant_id', '=', replacement.id)
          .executeTakeFirst()
      ]);
      if (existingEvent !== undefined) {
        if (currentRow === undefined || replacementRow === undefined) {
          throw new AppError(
            500,
            'ACCESS_LIFECYCLE_RECORD_MISSING',
            'Replacement grant record is missing'
          );
        }
        return {
          current: toToolGrant(currentRow),
          replacement: toToolGrant(replacementRow),
          evidence: existingEvent
        };
      }
      if (
        currentRow === undefined ||
        currentRow.state !== 'active' ||
        currentRow.version !== input.expectedVersion ||
        currentRow.updated_at > input.occurredAt
      ) {
        throw conflict('ACCESS_LIFECYCLE_VERSION_CONFLICT', 'Grant lifecycle checkpoint is stale');
      }
      if (replacementRow !== undefined) {
        throw conflict('ACCESS_REPLACEMENT_CONFLICT', 'Replacement grant ID already exists');
      }
      if (
        currentRow.agent_id !== replacement.agentId ||
        currentRow.tool_id !== replacement.toolId ||
        currentRow.authority_layer !== replacement.authorityLayer ||
        currentRow.access !== replacement.access ||
        currentRow.purpose !== replacement.purpose ||
        !withinSensitivity(
          replacement.sensitivityCap,
          AccessSensitivitySchema.parse(currentRow.sensitivity_cap)
        )
      ) {
        throw conflict(
          'ACCESS_REPLACEMENT_BINDING_DRIFT',
          'Replacement grant changes its exact authorization binding or widens sensitivity'
        );
      }
      const binding = await transaction
        .selectFrom('access_agents as agent')
        .innerJoin('control_scopes as scope', 'scope.scope_id', 'agent.home_scope_id')
        .select([
          'agent.state as agent_state',
          'agent.version as agent_version',
          'agent.trust_domain as agent_domain',
          'scope.state as scope_state',
          'scope.version as scope_version',
          'scope.trust_domain as scope_domain'
        ])
        .where('agent.agent_id', '=', replacement.agentId)
        .executeTakeFirst();
      if (
        binding === undefined ||
        binding.agent_state !== 'active' ||
        binding.scope_state !== 'active' ||
        binding.agent_domain !== binding.scope_domain ||
        binding.agent_version !== replacement.expectedAgentVersion ||
        binding.scope_version !== replacement.expectedScopeVersion
      ) {
        throw conflict(
          'ACCESS_REPLACEMENT_BINDING_INVALID',
          'Replacement tool grant does not match current exact agent and scope versions'
        );
      }
      const current = await transaction
        .updateTable('agent_tool_grants')
        .set({ state: 'revoked', version: spec.resultingVersion, updated_at: input.occurredAt })
        .where('grant_id', '=', input.id)
        .where('state', '=', 'active')
        .where('version', '=', input.expectedVersion)
        .returningAll()
        .executeTakeFirstOrThrow();
      const inserted = await transaction
        .insertInto('agent_tool_grants')
        .values({
          grant_id: replacement.id,
          agent_id: replacement.agentId,
          tool_id: replacement.toolId,
          authority_layer: replacement.authorityLayer,
          access: replacement.access,
          purpose: replacement.purpose,
          sensitivity_cap: replacement.sensitivityCap,
          expires_at: replacement.expiresAt,
          state: 'active',
          version: 1,
          bound_agent_version: replacement.expectedAgentVersion,
          bound_scope_version: replacement.expectedScopeVersion,
          created_at: replacement.issuedAt,
          updated_at: replacement.issuedAt
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return {
        current: toToolGrant(current),
        replacement: toToolGrant(inserted),
        evidence: await appendEvent(transaction, spec)
      };
    });
  }

  private async revokeSharedBundle(
    operator: VerifiedOperatorIdentity,
    rawInput: unknown
  ): Promise<SharedBundleLifecycleResult> {
    const input = canonicalRevokeBundle(rawInput);
    const spec = eventSpec(operator, input, 'shared_bundle', 'revoked', null);
    return this.db.transaction().execute(async (transaction) => {
      const existingEvent = await findEvent(transaction, spec);
      const currentRow = await transaction
        .selectFrom('shared_approved_bundles')
        .selectAll()
        .where('bundle_id', '=', input.id)
        .executeTakeFirst();
      if (existingEvent !== undefined) {
        if (currentRow === undefined)
          throw new AppError(
            500,
            'ACCESS_LIFECYCLE_RECORD_MISSING',
            'Revoked shared bundle is missing'
          );
        return { current: toSharedBundle(currentRow), evidence: existingEvent };
      }
      if (
        currentRow === undefined ||
        currentRow.state !== 'active' ||
        currentRow.version !== input.expectedVersion ||
        currentRow.updated_at > input.occurredAt
      ) {
        throw conflict(
          'ACCESS_LIFECYCLE_VERSION_CONFLICT',
          'Shared bundle lifecycle checkpoint is stale'
        );
      }
      const current = await transaction
        .updateTable('shared_approved_bundles')
        .set({ state: 'revoked', version: spec.resultingVersion, updated_at: input.occurredAt })
        .where('bundle_id', '=', input.id)
        .where('state', '=', 'active')
        .where('version', '=', input.expectedVersion)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { current: toSharedBundle(current), evidence: await appendEvent(transaction, spec) };
    });
  }

  private async replaceSharedBundle(
    operator: VerifiedOperatorIdentity,
    rawInput: unknown
  ): Promise<SharedBundleLifecycleResult> {
    const input = canonicalReplaceBundle(rawInput);
    const replacement: PublishSharedApprovedBundleInput = input.replacement;
    assertReplacementIdentity(input.id, replacement.id, replacement.reviewedAt, input.occurredAt);
    if (replacement.reviewedBy !== operator.id) {
      throw new AppError(
        403,
        'ACCESS_OPERATOR_MISMATCH',
        'Shared bundle reviewer must be the verified operator'
      );
    }
    const spec = eventSpec(operator, input, 'shared_bundle', 'replaced', replacement.id);
    return this.db.transaction().execute(async (transaction) => {
      const existingEvent = await findEvent(transaction, spec);
      const [currentRow, replacementRow] = await Promise.all([
        transaction
          .selectFrom('shared_approved_bundles')
          .selectAll()
          .where('bundle_id', '=', input.id)
          .executeTakeFirst(),
        transaction
          .selectFrom('shared_approved_bundles')
          .selectAll()
          .where('bundle_id', '=', replacement.id)
          .executeTakeFirst()
      ]);
      if (existingEvent !== undefined) {
        if (currentRow === undefined || replacementRow === undefined) {
          throw new AppError(
            500,
            'ACCESS_LIFECYCLE_RECORD_MISSING',
            'Replacement shared bundle is missing'
          );
        }
        return {
          current: toSharedBundle(currentRow),
          replacement: toSharedBundle(replacementRow),
          evidence: existingEvent
        };
      }
      if (
        currentRow === undefined ||
        currentRow.state !== 'active' ||
        currentRow.version !== input.expectedVersion ||
        currentRow.updated_at > input.occurredAt
      ) {
        throw conflict(
          'ACCESS_LIFECYCLE_VERSION_CONFLICT',
          'Shared bundle lifecycle checkpoint is stale'
        );
      }
      if (replacementRow !== undefined) {
        throw conflict(
          'ACCESS_REPLACEMENT_CONFLICT',
          'Replacement shared bundle ID already exists'
        );
      }
      if (
        currentRow.source_scope_id !== replacement.sourceScopeId ||
        currentRow.target_sleeve_id !== replacement.targetSleeveId ||
        currentRow.purpose !== replacement.purpose ||
        !withinSensitivity(
          replacement.publishedSensitivity,
          AccessSensitivitySchema.parse(currentRow.published_sensitivity)
        )
      ) {
        throw conflict(
          'ACCESS_REPLACEMENT_BINDING_DRIFT',
          'Replacement shared bundle changes its exact route, purpose, or widens sensitivity'
        );
      }
      const [source, target] = await Promise.all([
        transaction
          .selectFrom('control_scopes')
          .select(['scope_id', 'state', 'version'])
          .where('scope_id', '=', replacement.sourceScopeId)
          .executeTakeFirst(),
        transaction
          .selectFrom('memory_sleeves as sleeve')
          .innerJoin('control_scopes as scope', 'scope.scope_id', 'sleeve.owner_scope_id')
          .select([
            'sleeve.sleeve_kind as sleeve_kind',
            'sleeve.max_sensitivity as max_sensitivity',
            'sleeve.expires_at as sleeve_expires_at',
            'sleeve.state as sleeve_state',
            'sleeve.version as sleeve_version',
            'scope.scope_id as owner_scope_id',
            'scope.state as scope_state',
            'scope.version as scope_version'
          ])
          .where('sleeve.sleeve_id', '=', replacement.targetSleeveId)
          .executeTakeFirst()
      ]);
      const sleeveExpiry = target?.sleeve_expires_at;
      if (
        source === undefined ||
        target === undefined ||
        source.state !== 'active' ||
        target.scope_state !== 'active' ||
        target.sleeve_state !== 'active' ||
        source.version !== replacement.expectedSourceScopeVersion ||
        target.scope_version !== replacement.expectedTargetScopeVersion ||
        target.sleeve_version !== replacement.expectedTargetSleeveVersion ||
        target.sleeve_kind !== 'shared_approved' ||
        source.scope_id === target.owner_scope_id ||
        !withinSensitivity(
          replacement.publishedSensitivity,
          AccessSensitivitySchema.parse(target.max_sensitivity)
        ) ||
        (typeof sleeveExpiry === 'string' &&
          (Date.parse(replacement.reviewedAt) >= Date.parse(sleeveExpiry) ||
            Date.parse(replacement.expiresAt) >= Date.parse(sleeveExpiry)))
      ) {
        throw conflict(
          'ACCESS_REPLACEMENT_BINDING_INVALID',
          'Replacement shared bundle does not match current exact source, scope, sleeve, sensitivity, or expiry policy'
        );
      }

      const fragmentsJson = JSON.stringify(replacement.fragments);
      const contentSha256 = sha256(fragmentsJson);
      const current = await transaction
        .updateTable('shared_approved_bundles')
        .set({ state: 'revoked', version: spec.resultingVersion, updated_at: input.occurredAt })
        .where('bundle_id', '=', input.id)
        .where('state', '=', 'active')
        .where('version', '=', input.expectedVersion)
        .returningAll()
        .executeTakeFirstOrThrow();
      const inserted = await transaction
        .insertInto('shared_approved_bundles')
        .values({
          bundle_id: replacement.id,
          source_scope_id: replacement.sourceScopeId,
          source_scope_version: replacement.expectedSourceScopeVersion,
          target_sleeve_id: replacement.targetSleeveId,
          target_scope_version: replacement.expectedTargetScopeVersion,
          target_sleeve_version: replacement.expectedTargetSleeveVersion,
          purpose: replacement.purpose,
          published_sensitivity: replacement.publishedSensitivity,
          fragments_json: fragmentsJson,
          content_sha256: contentSha256,
          reviewed_by: replacement.reviewedBy,
          reviewed_at: replacement.reviewedAt,
          expires_at: replacement.expiresAt,
          state: 'active',
          version: 1,
          created_at: replacement.reviewedAt,
          updated_at: replacement.reviewedAt
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return {
        current: toSharedBundle(current),
        replacement: toSharedBundle(inserted),
        evidence: await appendEvent(transaction, spec)
      };
    });
  }

  private async project(
    _operator: VerifiedOperatorIdentity,
    rawInput: unknown
  ): Promise<AccessLifecycleProjection> {
    const input: AccessLifecycleProjectionInput =
      AccessLifecycleProjectionInputSchema.parse(rawInput);
    const rows = await this.db
      .selectFrom('access_lifecycle_events')
      .selectAll()
      .$if(input.resourceKind !== undefined, (query) =>
        query.where('resource_kind', '=', input.resourceKind as AccessLifecycleResourceKind)
      )
      .$if(input.resourceId !== undefined, (query) =>
        query.where('resource_id', '=', input.resourceId as string)
      )
      .orderBy('event_sequence', 'desc')
      .limit(input.limit)
      .execute();
    const count = await this.db
      .selectFrom('access_lifecycle_events')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .$if(input.resourceKind !== undefined, (query) =>
        query.where('resource_kind', '=', input.resourceKind as AccessLifecycleResourceKind)
      )
      .$if(input.resourceId !== undefined, (query) =>
        query.where('resource_id', '=', input.resourceId as string)
      )
      .executeTakeFirstOrThrow();
    const items = rows.map(toEvent);
    return {
      generatedAt: canonicalTimestamp(this.clock().toISOString()),
      totalCount: Number(count.count),
      returnedCount: items.length,
      items
    };
  }
}
