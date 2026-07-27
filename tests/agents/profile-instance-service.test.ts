import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccessControlRepository } from '../../src/agents/access-control-repository';
import { ProfileAccessBootstrap } from '../../src/agents/profile-access-bootstrap';
import { ProfileInstanceRepository } from '../../src/agents/profile-instance-repository';
import { ProfileInstanceManifestSchema } from '../../src/agents/profile-instance-contracts';
import { planProfileInstance } from '../../src/agents/profile-instance-planner';
import { ProfileInstanceService } from '../../src/agents/profile-instance-service';
import { ClientRepository } from '../../src/db/client-repository';
import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import { KnowledgeScopeRepository } from '../../src/knowledge/scope-repository';

const projectRoot = join(__dirname, '..', '..');
const createdAt = '2026-07-25T20:00:00.000Z';
const expiresAt = '2026-07-25T22:00:00.000Z';

describe('ProfileInstanceService', () => {
  let temporaryRoot: string;
  let context: GlobalDatabaseContext;
  let access: AccessControlRepository;
  let knowledgeScopes: KnowledgeScopeRepository;
  let instances: ProfileInstanceRepository;
  let service: ProfileInstanceService;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-profile-instance-'));
    context = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    access = new AccessControlRepository(context.db);
    knowledgeScopes = new KnowledgeScopeRepository(context.db);
    instances = new ProfileInstanceRepository(context.db, () => createdAt);
    service = new ProfileInstanceService({
      db: context.db,
      access,
      knowledgeScopes,
      instances,
      now: () => createdAt
    });

    await new ProfileAccessBootstrap(context.db, access, knowledgeScopes).install();
    await new ClientRepository(context.db).create({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing',
      status: 'active',
      createdAt
    });
    await access.registerScope({
      id: 'client:acme_corp',
      kind: 'client',
      subjectId: 'acme_corp',
      parentScopeId: 'agency:agency',
      trustDomain: 'agency',
      createdAt
    });
    await knowledgeScopes.register({
      kind: 'client',
      clientId: 'acme_corp',
      parentScopeId: 'project:agency_operations',
      createdAt
    });
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  function request(recipeId = 'marketing', requestedExpiresAt: string = expiresAt) {
    return {
      recipeId,
      scopeId: 'client:acme_corp',
      expectedScopeVersion: 1,
      knowledgeScopeId: 'client:acme_corp',
      approvedBy: 'operator:jack_hunter',
      expiresAt: requestedExpiresAt
    };
  }

  it('plans, provisions, audits, and activates one exact blueprint-only instance', async () => {
    const result = await service.instantiate(request());

    expect(result).toMatchObject({
      recipeId: 'marketing',
      scopeId: 'client:acme_corp',
      scopeVersion: 1,
      profileCount: 4,
      blueprintReady: true,
      authorizationReady: false
    });
    expect(result.instanceId).toMatch(/^profile-instance:[a-f0-9]{32}$/u);
    expect(result.recipeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.instanceManifestSha256).toMatch(/^[a-f0-9]{64}$/u);

    const stored = await instances.findById(result.instanceId);
    expect(stored).toMatchObject({
      state: 'active',
      version: 2,
      manifestSha256: result.instanceManifestSha256
    });
    expect(stored?.manifest.members.map(({ profile }) => profile)).toEqual(result.profiles);
    await expect(
      new ProfileInstanceRepository(context.db, () => expiresAt).findAgentProfile(
        result.profiles[0]?.id ?? ''
      )
    ).resolves.toBeUndefined();

    const agentRows = await context.db
      .selectFrom('access_agents')
      .select(['agent_id', 'home_scope_id'])
      .where(
        'agent_id',
        'in',
        result.profiles.map(({ id }) => id)
      )
      .execute();
    expect(agentRows).toHaveLength(4);
    expect(agentRows.every(({ home_scope_id }) => home_scope_id === 'client:acme_corp')).toBe(true);

    const scopedSleeves = await context.db
      .selectFrom('memory_sleeves')
      .select(['sleeve_id', 'owner_scope_id'])
      .where('owner_scope_id', '=', 'client:acme_corp')
      .execute();
    expect(scopedSleeves.length).toBe(result.sleeveCount);
    expect(scopedSleeves.every(({ sleeve_id }) => !sleeve_id.startsWith('agency:'))).toBe(true);

    const dynamicGrants = await context.db
      .selectFrom('agent_sleeve_grants')
      .select(['authority_layer', 'sleeve_id'])
      .where(
        'agent_id',
        'in',
        result.profiles.map(({ id }) => id)
      )
      .execute();
    expect(dynamicGrants).toHaveLength(result.sleeveGrantCount);
    expect(dynamicGrants.every(({ authority_layer }) => authority_layer === 'blueprint')).toBe(
      true
    );
    expect(dynamicGrants.some(({ sleeve_id }) => sleeve_id === 'agency:core')).toBe(false);
  });

  it('converges idempotently for repeated and concurrent exact installation', async () => {
    const [first, second] = await Promise.all([
      service.instantiate(request()),
      service.instantiate(request())
    ]);
    expect(second).toEqual(first);
    await expect(service.instantiate(request())).resolves.toEqual(first);
    await expect(
      new ProfileInstanceService({
        db: context.db,
        access,
        knowledgeScopes,
        instances,
        now: () => '2026-07-25T20:01:00.000Z'
      }).instantiate(request())
    ).resolves.toEqual(first);

    const manifests = await context.db
      .selectFrom('agent_profile_instances')
      .select('instance_id')
      .execute();
    expect(manifests).toEqual([{ instance_id: first.instanceId }]);
  });

  it('keeps planned profiles invisible and completes them from the stored snapshot on restart', async () => {
    const controlScope = await access.findScope('client:acme_corp');
    const knowledgeScope = await knowledgeScopes.findById('client:acme_corp');
    if (controlScope === undefined || knowledgeScope === undefined) {
      throw new Error('Missing exact scope fixtures');
    }
    const planned = planProfileInstance({
      recipeId: 'marketing',
      scope: controlScope,
      knowledgeScope,
      approvedBy: 'operator:jack_hunter',
      createdAt,
      expiresAt
    });
    const record = await instances.plan(planned);
    const dynamicAgentId = planned.manifest.members[0]?.profile.id;
    if (dynamicAgentId === undefined) throw new Error('Missing planned profile');

    expect(record.state).toBe('planned');
    await expect(instances.findAgentProfile(dynamicAgentId)).resolves.toBeUndefined();

    const restarted = new ProfileInstanceService({
      db: context.db,
      access: new AccessControlRepository(context.db),
      knowledgeScopes: new KnowledgeScopeRepository(context.db),
      instances: new ProfileInstanceRepository(context.db, () => createdAt),
      now: () => createdAt
    });
    await expect(restarted.initialize()).resolves.toEqual({
      expiredCount: 0,
      resumedCount: 1,
      auditedCount: 1
    });
    await expect(
      new ProfileInstanceRepository(context.db, () => createdAt).findAgentProfile(dynamicAgentId)
    ).resolves.toMatchObject({ id: dynamicAgentId, lifecycle: 'template' });
  });

  it('fails closed on stale bindings and undeclared blueprint authority', async () => {
    await expect(
      service.instantiate({ ...request(), expectedScopeVersion: 2 })
    ).rejects.toMatchObject({
      code: 'PROFILE_INSTANCE_SCOPE_INVALID',
      statusCode: 409
    });

    const result = await service.instantiate(request());
    const agentId = result.profiles[0]?.id;
    if (agentId === undefined) throw new Error('Missing instance profile');
    await access.issueToolGrant({
      id: `tool-grant:instance-undeclared-${agentId}`,
      agentId,
      toolId: 'agency.undeclared',
      authorityLayer: 'blueprint',
      access: 'read',
      purpose: 'instance_tool_access',
      sensitivityCap: 'confidential',
      expiresAt,
      expectedAgentVersion: 1,
      expectedScopeVersion: 1,
      issuedAt: createdAt
    });

    await expect(service.initialize()).rejects.toMatchObject({
      code: 'PROFILE_INSTANCE_ACCESS_DRIFT',
      statusCode: 409
    });
  });

  it('rejects a rehashed manifest containing authority undeclared by its profiles', async () => {
    const controlScope = await access.findScope('client:acme_corp');
    const knowledgeScope = await knowledgeScopes.findById('client:acme_corp');
    if (controlScope === undefined || knowledgeScope === undefined) {
      throw new Error('Missing exact scope fixtures');
    }
    const planned = planProfileInstance({
      recipeId: 'marketing',
      scope: controlScope,
      knowledgeScope,
      approvedBy: 'operator:jack_hunter',
      createdAt,
      expiresAt
    });
    const tampered = structuredClone(planned.manifest);
    const template = tampered.toolGrants[0];
    if (template === undefined) throw new Error('Missing tool grant fixture');
    tampered.toolGrants.push({
      ...template,
      id: `tool-grant:instance-${'f'.repeat(40)}`,
      toolId: 'agency.undeclared'
    });
    const manifestSha256 = createHash('sha256')
      .update(JSON.stringify(tampered), 'utf8')
      .digest('hex');

    expect(ProfileInstanceManifestSchema.safeParse(tampered).success).toBe(false);
    await expect(instances.plan({ manifest: tampered, manifestSha256 })).rejects.toBeDefined();
  });

  it('quarantines an expired planned lease and renews the same recipe scope', async () => {
    const controlScope = await access.findScope('client:acme_corp');
    const knowledgeScope = await knowledgeScopes.findById('client:acme_corp');
    if (controlScope === undefined || knowledgeScope === undefined) {
      throw new Error('Missing exact scope fixtures');
    }
    const planned = planProfileInstance({
      recipeId: 'marketing',
      scope: controlScope,
      knowledgeScope,
      approvedBy: 'operator:jack_hunter',
      createdAt,
      expiresAt
    });
    await instances.plan(planned);

    const restartedAt = '2026-07-25T23:00:00.000Z';
    const renewedExpiresAt = '2026-07-26T01:00:00.000Z';
    const renewedInstances = new ProfileInstanceRepository(context.db, () => restartedAt);
    const restarted = new ProfileInstanceService({
      db: context.db,
      access: new AccessControlRepository(context.db),
      knowledgeScopes: new KnowledgeScopeRepository(context.db),
      instances: renewedInstances,
      now: () => restartedAt
    });

    await expect(restarted.initialize()).resolves.toEqual({
      expiredCount: 1,
      resumedCount: 0,
      auditedCount: 0
    });
    await expect(instances.findById(planned.manifest.instanceId)).resolves.toMatchObject({
      state: 'expired',
      version: 2,
      activatedAt: null,
      expiredAt: restartedAt
    });

    const renewed = await restarted.instantiate(request('marketing', renewedExpiresAt));
    expect(renewed.instanceId).not.toBe(planned.manifest.instanceId);
    await expect(renewedInstances.findById(renewed.instanceId)).resolves.toMatchObject({
      state: 'active',
      version: 2
    });
  });

  it('paginates startup recovery without omitting planned or active instances', async () => {
    const controlScope = await access.findScope('client:acme_corp');
    const knowledgeScope = await knowledgeScopes.findById('client:acme_corp');
    if (controlScope === undefined || knowledgeScope === undefined) {
      throw new Error('Missing exact scope fixtures');
    }
    for (const recipeId of ['finance', 'marketing'] as const) {
      await instances.plan(
        planProfileInstance({
          recipeId,
          scope: controlScope,
          knowledgeScope,
          approvedBy: 'operator:jack_hunter',
          createdAt,
          expiresAt
        })
      );
    }

    const restarted = new ProfileInstanceService({
      db: context.db,
      access,
      knowledgeScopes,
      instances,
      recoveryBatchSize: 1,
      now: () => createdAt
    });
    await expect(restarted.initialize()).resolves.toEqual({
      expiredCount: 0,
      resumedCount: 2,
      auditedCount: 2
    });
  });

  it('quarantines an installed lease once its window closes instead of auditing it', async () => {
    const installed = await service.instantiate(request());
    const agentId = installed.profiles[0]?.id ?? '';
    const restartedAt = '2026-07-25T23:00:00.000Z';

    const restarted = new ProfileInstanceService({
      db: context.db,
      access,
      knowledgeScopes,
      instances: new ProfileInstanceRepository(context.db, () => restartedAt),
      now: () => restartedAt
    });
    await expect(restarted.initialize()).resolves.toEqual({
      expiredCount: 1,
      resumedCount: 0,
      auditedCount: 0
    });
    await expect(instances.findById(installed.instanceId)).resolves.toMatchObject({
      state: 'expired',
      version: 3,
      expiredAt: restartedAt
    });
    // The lease is closed, so its profiles stop resolving for conversations.
    await expect(
      new ProfileInstanceRepository(context.db, () => restartedAt).findAgentProfile(agentId)
    ).resolves.toBeUndefined();
  });

  it('refuses a lease that never opens or names a scope it cannot bind', async () => {
    await expect(service.instantiate(request('marketing', createdAt))).rejects.toMatchObject({
      code: 'PROFILE_INSTANCE_EXPIRY_INVALID',
      statusCode: 409
    });

    await expect(
      service.instantiate({ ...request(), knowledgeScopeId: 'project:unregistered_subject' })
    ).rejects.toMatchObject({
      code: 'PROFILE_INSTANCE_KNOWLEDGE_SCOPE_INVALID',
      statusCode: 409
    });
  });

  it('refuses a scope that is not a descendant of the recipe parent home scope', async () => {
    // A registered, active scope in the right trust domain — but rooted outside
    // the static parent profile's home scope, so nothing may be installed into it.
    await new ClientRepository(context.db).create({
      id: 'orphan_corp',
      name: 'Orphan Corporation',
      profile: 'data_processing',
      status: 'active',
      createdAt
    });
    await access.registerScope({
      id: 'client:orphan_corp',
      kind: 'client',
      subjectId: 'orphan_corp',
      parentScopeId: null,
      trustDomain: 'agency',
      createdAt
    });
    await knowledgeScopes.register({
      kind: 'client',
      clientId: 'orphan_corp',
      parentScopeId: 'project:agency_operations',
      createdAt
    });

    await expect(
      service.instantiate({
        ...request(),
        scopeId: 'client:orphan_corp',
        knowledgeScopeId: 'client:orphan_corp'
      })
    ).rejects.toMatchObject({ code: 'PROFILE_INSTANCE_SCOPE_INVALID', statusCode: 409 });
  });

  it('refuses a recovery batch size outside the bounded page range', () => {
    for (const recoveryBatchSize of [0, 101, 1.5]) {
      expect(
        () =>
          new ProfileInstanceService({
            db: context.db,
            access,
            knowledgeScopes,
            instances,
            recoveryBatchSize,
            now: () => createdAt
          })
      ).toThrow();
    }
  });
});
