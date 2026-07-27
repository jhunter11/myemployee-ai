import { createHash } from 'node:crypto';

import type { Kysely } from 'kysely';

import type { JarvisDatabase } from '../db/types';
import type { KnowledgeScopeId, RegisterKnowledgeScopeInput } from '../knowledge/contracts';
import type { KnowledgeScopeRepository } from '../knowledge/scope-repository';
import { AppError } from '../utils/errors';
import type {
  AccessSensitivity,
  ControlScopeId,
  IssueAgentSleeveGrantInput,
  IssueAgentToolGrantInput,
  RegisterControlScopeInput,
  RegisterMemorySleeveInput
} from './access-control-contracts';
import type { AccessControlRepository } from './access-control-repository';
import { listAgentProfiles, type AgentProfile, type AgentSleeveId } from './profile-catalog';

export const CATALOG_ACCESS_CREATED_AT = '2026-07-21T00:00:00.000Z';
export const CATALOG_ACCESS_EXPIRES_AT = '2027-07-21T00:00:00.000Z';

const CONTROL_SCOPES: readonly RegisterControlScopeInput[] = [
  {
    id: 'personal:jarvis',
    kind: 'personal',
    subjectId: 'jarvis',
    parentScopeId: null,
    trustDomain: 'personal',
    createdAt: CATALOG_ACCESS_CREATED_AT
  },
  {
    id: 'agency:agency',
    kind: 'agency',
    subjectId: 'agency',
    parentScopeId: 'personal:jarvis',
    trustDomain: 'agency',
    createdAt: CATALOG_ACCESS_CREATED_AT
  },
  {
    id: 'task_market:mcp_x402',
    kind: 'task_market',
    subjectId: 'mcp_x402',
    parentScopeId: 'personal:jarvis',
    trustDomain: 'task_market',
    createdAt: CATALOG_ACCESS_CREATED_AT
  }
];

const HOME_SCOPE_BY_DOMAIN = {
  personal: 'personal:jarvis',
  agency: 'agency:agency',
  task_market: 'task_market:mcp_x402'
} as const satisfies Record<AgentProfile['trustDomain'], ControlScopeId>;

const SENSITIVITY_BY_DOMAIN = {
  personal: 'private',
  agency: 'confidential',
  task_market: 'internal'
} as const satisfies Record<AgentProfile['trustDomain'], AccessSensitivity>;

export interface ProfileAccessBootstrapResult {
  catalogSha256: string;
  profileCount: number;
  controlScopeCount: number;
  knowledgeScopeCount: number;
  sleeveCount: number;
  sleeveGrantCount: number;
  toolGrantCount: number;
  authorizationReady: false;
  controlScopeIds: ControlScopeId[];
  knowledgeScopeIds: KnowledgeScopeId[];
}

interface CatalogAccessManifest {
  profiles: readonly AgentProfile[];
  knowledgeScopes: RegisterKnowledgeScopeInput[];
  sleeves: RegisterMemorySleeveInput[];
  sleeveGrants: IssueAgentSleeveGrantInput[];
  toolGrants: IssueAgentToolGrantInput[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeIdPart(value: string): string {
  return value.replaceAll(/[.:-]/gu, '-');
}

function ownerScopeId(profile: AgentProfile, sleeveId: AgentSleeveId): ControlScopeId {
  if (sleeveId.startsWith('agent:')) return HOME_SCOPE_BY_DOMAIN[profile.trustDomain];
  if (sleeveId === 'shared:jarvis_handoffs') return 'personal:jarvis';
  if (sleeveId.startsWith(`${profile.trustDomain}:`)) {
    return HOME_SCOPE_BY_DOMAIN[profile.trustDomain];
  }
  throw new AppError(
    409,
    'CATALOG_ACCESS_SCOPE_INVALID',
    `Catalog sleeve ${sleeveId} is not owned by profile ${profile.id}`
  );
}

function sleeveSensitivity(profile: AgentProfile, sleeveId: AgentSleeveId): AccessSensitivity {
  if (sleeveId === 'shared:jarvis_handoffs') return 'internal';
  return SENSITIVITY_BY_DOMAIN[profile.trustDomain];
}

function knowledgeScopeInput(scopeId: KnowledgeScopeId): RegisterKnowledgeScopeInput {
  const [kind, subjectId] = scopeId.split(':') as ['harness' | 'project', string];
  if (kind === 'harness') {
    return { kind, subjectId, createdAt: CATALOG_ACCESS_CREATED_AT };
  }
  return {
    kind,
    subjectId,
    parentScopeId: 'harness:jarvis',
    createdAt: CATALOG_ACCESS_CREATED_AT
  };
}

function createManifest(): CatalogAccessManifest {
  const profiles = listAgentProfiles();
  const knowledgeScopes = [
    'harness:jarvis',
    ...new Set(
      profiles
        .map(({ knowledge }) => knowledge.scopeId)
        .filter((scopeId) => scopeId !== 'harness:jarvis')
    )
  ].map(knowledgeScopeInput);
  const sleeves = new Map<string, RegisterMemorySleeveInput>();
  const sleeveGrants = new Map<string, IssueAgentSleeveGrantInput>();
  const toolGrants = new Map<string, IssueAgentToolGrantInput>();

  for (const profile of profiles) {
    const scratch = profile.memory.scratchSleeveId;
    const declared = new Set<AgentSleeveId>([
      scratch,
      ...profile.memory.readableSleeveIds,
      ...profile.memory.proposeWritableSleeveIds
    ]);
    for (const sleeveId of declared) {
      if (sleeveId.startsWith('client:')) {
        throw new AppError(
          409,
          'CATALOG_CLIENT_SLEEVE_FORBIDDEN',
          'Static profiles cannot bootstrap client sleeve access'
        );
      }
      const candidate: RegisterMemorySleeveInput = {
        id: sleeveId,
        ownerScopeId: ownerScopeId(profile, sleeveId),
        maxSensitivity: sleeveSensitivity(profile, sleeveId),
        expiresAt: null,
        createdAt: CATALOG_ACCESS_CREATED_AT
      };
      const existing = sleeves.get(sleeveId);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(candidate)) {
        throw new AppError(
          409,
          'CATALOG_SLEEVE_DRIFT',
          `Catalog sleeve ${sleeveId} has conflicting ownership or sensitivity`
        );
      }
      sleeves.set(sleeveId, candidate);
    }

    const permissions = [
      ...profile.memory.readableSleeveIds.map((sleeveId) => ({
        sleeveId,
        permission: 'read' as const
      })),
      ...profile.memory.proposeWritableSleeveIds.map((sleeveId) => ({
        sleeveId,
        permission: 'propose' as const
      })),
      { sleeveId: scratch, permission: 'read' as const },
      { sleeveId: scratch, permission: 'propose' as const }
    ];
    for (const { sleeveId, permission } of permissions) {
      const id = `sleeve-grant:catalog-${profile.id}-${safeIdPart(sleeveId)}-${permission}-blueprint`;
      sleeveGrants.set(id, {
        id,
        agentId: profile.id,
        sleeveId,
        authorityLayer: 'blueprint',
        permission,
        purpose: permission === 'read' ? 'catalog_memory_read' : 'catalog_memory_propose',
        sensitivityCap: sleeveSensitivity(profile, sleeveId),
        expiresAt: CATALOG_ACCESS_EXPIRES_AT,
        expectedAgentVersion: 1,
        expectedScopeVersion: 1,
        expectedSleeveVersion: 1,
        issuedAt: CATALOG_ACCESS_CREATED_AT
      });
    }

    for (const tool of profile.toolGrants) {
      const id = `tool-grant:catalog-${profile.id}-${safeIdPart(tool.id)}-${tool.access}-blueprint`;
      toolGrants.set(id, {
        id,
        agentId: profile.id,
        toolId: tool.id,
        authorityLayer: 'blueprint',
        access: tool.access,
        purpose: 'catalog_tool_access',
        sensitivityCap: SENSITIVITY_BY_DOMAIN[profile.trustDomain],
        expiresAt: CATALOG_ACCESS_EXPIRES_AT,
        expectedAgentVersion: 1,
        expectedScopeVersion: 1,
        issuedAt: CATALOG_ACCESS_CREATED_AT
      });
    }
  }

  return {
    profiles,
    knowledgeScopes,
    sleeves: [...sleeves.values()],
    sleeveGrants: [...sleeveGrants.values()],
    toolGrants: [...toolGrants.values()]
  };
}

function sameIdSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const expectedSet = new Set(expected);
  return actual.every((id) => expectedSet.has(id));
}

export class ProfileAccessBootstrap {
  constructor(
    private readonly db: Kysely<JarvisDatabase>,
    private readonly access: AccessControlRepository,
    private readonly knowledgeScopes: KnowledgeScopeRepository
  ) {}

  async install(): Promise<ProfileAccessBootstrapResult> {
    const manifest = createManifest();

    for (const scope of CONTROL_SCOPES) await this.access.registerScope(scope);
    for (const scope of manifest.knowledgeScopes) await this.knowledgeScopes.register(scope);
    for (const profile of manifest.profiles) {
      await this.access.registerAgent({
        id: profile.id,
        homeScopeId: HOME_SCOPE_BY_DOMAIN[profile.trustDomain],
        trustDomain: profile.trustDomain,
        profileRevision: profile.revision,
        createdAt: CATALOG_ACCESS_CREATED_AT
      });
    }
    for (const sleeve of manifest.sleeves) await this.access.registerSleeve(sleeve);
    for (const grant of manifest.sleeveGrants) await this.access.issueSleeveGrant(grant);
    for (const grant of manifest.toolGrants) await this.access.issueToolGrant(grant);

    const catalogAgentIds = manifest.profiles.map(({ id }) => id);
    const [actualSleeveGrants, actualToolGrants] = await Promise.all([
      this.db
        .selectFrom('agent_sleeve_grants')
        .select('grant_id')
        .where('agent_id', 'in', catalogAgentIds)
        .where('authority_layer', '=', 'blueprint')
        .where('state', '=', 'active')
        .execute(),
      this.db
        .selectFrom('agent_tool_grants')
        .select('grant_id')
        .where('agent_id', 'in', catalogAgentIds)
        .where('authority_layer', '=', 'blueprint')
        .where('state', '=', 'active')
        .execute()
    ]);
    if (
      !sameIdSet(
        actualSleeveGrants.map(({ grant_id }) => grant_id),
        manifest.sleeveGrants.map(({ id }) => id)
      ) ||
      !sameIdSet(
        actualToolGrants.map(({ grant_id }) => grant_id),
        manifest.toolGrants.map(({ id }) => id)
      )
    ) {
      throw new AppError(
        409,
        'CATALOG_ACCESS_DRIFT',
        'Active catalog blueprint grants differ from the approved profile manifest'
      );
    }

    return {
      catalogSha256: sha256(JSON.stringify(manifest.profiles)),
      profileCount: manifest.profiles.length,
      controlScopeCount: CONTROL_SCOPES.length,
      knowledgeScopeCount: manifest.knowledgeScopes.length,
      sleeveCount: manifest.sleeves.length,
      sleeveGrantCount: manifest.sleeveGrants.length,
      toolGrantCount: manifest.toolGrants.length,
      authorizationReady: false,
      controlScopeIds: CONTROL_SCOPES.map(({ id }) => id),
      knowledgeScopeIds: manifest.knowledgeScopes.map((scope) =>
        scope.kind === 'client' ? `client:${scope.clientId}` : `${scope.kind}:${scope.subjectId}`
      )
    };
  }
}
