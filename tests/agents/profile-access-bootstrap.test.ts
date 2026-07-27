import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AccessControlRepository,
  MemoryAccessDeniedError
} from '../../src/agents/access-control-repository';
import {
  CATALOG_ACCESS_CREATED_AT,
  ProfileAccessBootstrap
} from '../../src/agents/profile-access-bootstrap';
import { listAgentProfiles } from '../../src/agents/profile-catalog';
import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import { KnowledgeScopeRepository } from '../../src/knowledge/scope-repository';

const projectRoot = join(__dirname, '..', '..');

describe('ProfileAccessBootstrap', () => {
  let temporaryRoot: string;
  let context: GlobalDatabaseContext;
  let bootstrap: ProfileAccessBootstrap;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-profile-access-'));
    context = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    bootstrap = new ProfileAccessBootstrap(
      context.db,
      new AccessControlRepository(context.db),
      new KnowledgeScopeRepository(context.db)
    );
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('deterministically installs the catalog with exact scopes, sleeves, and blueprint-only grants', async () => {
    const result = await bootstrap.install();

    expect(result).toMatchObject({
      profileCount: 45,
      controlScopeCount: 3,
      knowledgeScopeCount: 14,
      sleeveCount: 74,
      sleeveGrantCount: 225,
      toolGrantCount: 128,
      authorizationReady: false
    });
    expect(result.catalogSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.controlScopeIds).toEqual([
      'personal:jarvis',
      'agency:agency',
      'task_market:mcp_x402'
    ]);

    const profiles = await context.db
      .selectFrom('access_agents')
      .select(['agent_id', 'home_scope_id', 'profile_revision'])
      .orderBy('agent_id', 'asc')
      .execute();
    expect(profiles).toHaveLength(listAgentProfiles().length);
    expect(profiles).toContainEqual({
      agent_id: 'jarvis',
      home_scope_id: 'personal:jarvis',
      profile_revision: 1
    });
    expect(profiles).toContainEqual({
      agent_id: 'agency-developer',
      home_scope_id: 'agency:agency',
      profile_revision: 1
    });
    expect(profiles).toContainEqual({
      agent_id: 'mcp-x402',
      home_scope_id: 'task_market:mcp_x402',
      profile_revision: 1
    });

    const knowledge = await context.db
      .selectFrom('knowledge_scopes')
      .select(['scope_id', 'parent_scope_id', 'graph_partition'])
      .orderBy('scope_id', 'asc')
      .execute();
    expect(knowledge).toContainEqual({
      scope_id: 'harness:jarvis',
      parent_scope_id: null,
      graph_partition: 'graphify/harness/jarvis'
    });
    expect(knowledge).toContainEqual({
      scope_id: 'project:agency_engineering',
      parent_scope_id: 'harness:jarvis',
      graph_partition: 'graphify/project/agency_engineering'
    });

    const clientSleeves = await context.db
      .selectFrom('memory_sleeves')
      .select('sleeve_id')
      .where('sleeve_id', 'like', 'client:%')
      .execute();
    expect(clientSleeves).toEqual([]);

    const developerSleeveGrants = await context.db
      .selectFrom('agent_sleeve_grants')
      .select(['sleeve_id', 'permission', 'authority_layer'])
      .where('agent_id', '=', 'agency-developer')
      .orderBy('sleeve_id', 'asc')
      .orderBy('permission', 'asc')
      .execute();
    expect(developerSleeveGrants).toEqual([
      { sleeve_id: 'agency:core', permission: 'read', authority_layer: 'blueprint' },
      { sleeve_id: 'agency:engineering', permission: 'propose', authority_layer: 'blueprint' },
      { sleeve_id: 'agency:engineering', permission: 'read', authority_layer: 'blueprint' },
      {
        sleeve_id: 'agent:agency-developer:scratch',
        permission: 'propose',
        authority_layer: 'blueprint'
      },
      {
        sleeve_id: 'agent:agency-developer:scratch',
        permission: 'read',
        authority_layer: 'blueprint'
      }
    ]);

    const access = new AccessControlRepository(context.db).bindAgent({
      agentId: 'agency-developer',
      expectedAgentVersion: 1
    });
    await expect(
      access.authorizeMemoryRetrieval({
        sleeveId: 'agency:engineering',
        expectedSleeveVersion: 1,
        expectedOwnerScopeVersion: 1,
        permission: 'read',
        purpose: 'catalog_memory_read',
        sensitivity: 'internal',
        grantVersions: { blueprint: 1, operator: 1, tenant: 1, channel: 1, run: 1 }
      })
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
  });

  it('is idempotent for the exact manifest and fails closed when durable state drifts', async () => {
    const first = await bootstrap.install();
    await expect(bootstrap.install()).resolves.toEqual(first);

    await context.db
      .updateTable('control_scopes')
      .set({
        state: 'disabled',
        version: 2,
        updated_at: '2026-07-21T00:00:01.000Z'
      })
      .where('scope_id', '=', 'agency:agency')
      .executeTakeFirstOrThrow();

    expect(CATALOG_ACCESS_CREATED_AT).toBe('2026-07-21T00:00:00.000Z');
    await expect(bootstrap.install()).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONTROL_SCOPE_CONFLICT'
    });
    const grantCount = await context.db
      .selectFrom('agent_sleeve_grants')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();
    expect(Number(grantCount.count)).toBe(first.sleeveGrantCount);
  });

  it('rejects an undeclared active blueprint grant instead of silently widening a profile', async () => {
    await bootstrap.install();
    const access = new AccessControlRepository(context.db);
    await access.issueToolGrant({
      id: 'tool-grant:catalog-agency-developer-repo-undeclared-read-blueprint',
      agentId: 'agency-developer',
      toolId: 'repo.undeclared',
      authorityLayer: 'blueprint',
      access: 'read',
      purpose: 'catalog_tool_access',
      sensitivityCap: 'confidential',
      expiresAt: '2027-07-21T00:00:00.000Z',
      expectedAgentVersion: 1,
      expectedScopeVersion: 1,
      issuedAt: CATALOG_ACCESS_CREATED_AT
    });

    await expect(bootstrap.install()).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_ACCESS_DRIFT'
    });
  });
});
