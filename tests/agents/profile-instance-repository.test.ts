import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccessControlRepository } from '../../src/agents/access-control-repository';
import { ProfileAccessBootstrap } from '../../src/agents/profile-access-bootstrap';
import { planProfileInstance } from '../../src/agents/profile-instance-planner';
import {
  ProfileInstanceRepository,
  type ProfileInstanceRecord
} from '../../src/agents/profile-instance-repository';
import { ClientRepository } from '../../src/db/client-repository';
import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import type { ControlScopeRecord } from '../../src/agents/access-control-contracts';
import type { KnowledgeScopeRecord } from '../../src/knowledge/contracts';
import { KnowledgeScopeRepository } from '../../src/knowledge/scope-repository';

const projectRoot = join(__dirname, '..', '..');
const createdAt = '2026-07-25T20:00:00.000Z';
const expiresAt = '2026-07-25T22:00:00.000Z';
const afterLease = '2026-07-25T23:00:00.000Z';
const withinLease = '2026-07-25T21:00:00.000Z';

const INSTANCE_COLUMNS = [
  'instance_id',
  'recipe_id',
  'recipe_sha256',
  'scope_id',
  'scope_version',
  'knowledge_scope_id',
  'manifest_json',
  'manifest_sha256',
  'approved_by',
  'state',
  'version',
  'created_at',
  'expires_at',
  'activated_at',
  'expired_at',
  'updated_at'
];

/**
 * Indexed columns a stored row carries alongside its manifest. Each case writes
 * an intact, correctly digested manifest whose column no longer agrees with it —
 * the drift a hand-edited or partially restored database would show.
 */
const COLUMN_DRIFTS: ReadonlyArray<{ name: string; column: string; value: string | number }> = [
  { name: 'recipe', column: 'recipe_id', value: 'finance' },
  { name: 'recipe digest', column: 'recipe_sha256', value: 'd'.repeat(64) },
  { name: 'scope version', column: 'scope_version', value: 2 },
  { name: 'approving operator', column: 'approved_by', value: 'operator:someone_else' }
];

describe('ProfileInstanceRepository', () => {
  let temporaryRoot: string;
  let context: GlobalDatabaseContext;
  let access: AccessControlRepository;
  let knowledgeScopes: KnowledgeScopeRepository;
  let instances: ProfileInstanceRepository;
  let controlScope: ControlScopeRecord;
  let knowledgeScope: KnowledgeScopeRecord;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-instance-repository-'));
    context = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    access = new AccessControlRepository(context.db);
    knowledgeScopes = new KnowledgeScopeRepository(context.db);
    instances = new ProfileInstanceRepository(context.db, () => createdAt);

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

    const resolvedControl = await access.findScope('client:acme_corp');
    const resolvedKnowledge = await knowledgeScopes.findById('client:acme_corp');
    if (resolvedControl === undefined || resolvedKnowledge === undefined) {
      throw new Error('Missing exact scope fixtures');
    }
    controlScope = resolvedControl;
    knowledgeScope = resolvedKnowledge;
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  function plan(recipeId = 'marketing', leaseExpiresAt = expiresAt) {
    return planProfileInstance({
      recipeId,
      scope: controlScope,
      knowledgeScope,
      approvedBy: 'operator:jack_hunter',
      createdAt,
      expiresAt: leaseExpiresAt
    });
  }

  async function planned(recipeId = 'marketing'): Promise<ProfileInstanceRecord> {
    return instances.plan(plan(recipeId));
  }

  it('rejects a manifest whose digest does not match its canonical content', async () => {
    await expect(
      instances.plan({ manifest: plan().manifest, manifestSha256: 'a'.repeat(64) })
    ).rejects.toMatchObject({ code: 'PROFILE_INSTANCE_CONFLICT', statusCode: 409 });
  });

  it('replays an identical plan and reports unknown identities as absent', async () => {
    const first = await planned();
    await expect(instances.plan(plan())).resolves.toEqual(first);
    await expect(instances.findById(`profile-instance:${'0'.repeat(32)}`)).resolves.toBeUndefined();
    await expect(
      instances.findByRecipeScope('finance', 'client:acme_corp')
    ).resolves.toBeUndefined();
  });

  it('walks a state in keyset pages without repeating or omitting an instance', async () => {
    const first = await planned('finance');
    const second = await planned('marketing');
    const ordered = [first, second].sort((a, b) =>
      a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0
    );

    const page = await instances.listByState('planned', 1);
    expect(page.map(({ instanceId }) => instanceId)).toEqual([ordered[0]?.instanceId]);

    const next = await instances.listByState('planned', 1, {
      createdAt: ordered[0]?.createdAt ?? createdAt,
      instanceId: ordered[0]?.instanceId ?? ''
    });
    expect(next.map(({ instanceId }) => instanceId)).toEqual([ordered[1]?.instanceId]);

    const exhausted = await instances.listByState('planned', 1, {
      createdAt: ordered[1]?.createdAt ?? createdAt,
      instanceId: ordered[1]?.instanceId ?? ''
    });
    expect(exhausted).toEqual([]);
    await expect(instances.listByState('expired')).resolves.toEqual([]);
  });

  it('fails closed on every ungoverned activation', async () => {
    const record = await planned();
    await expect(
      instances.activate(`profile-instance:${'0'.repeat(32)}`, 1, withinLease)
    ).rejects.toMatchObject({ code: 'PROFILE_INSTANCE_CONFLICT' });
    await expect(instances.activate(record.instanceId, 2, withinLease)).rejects.toMatchObject({
      code: 'PROFILE_INSTANCE_CONFLICT'
    });
    await expect(instances.activate(record.instanceId, 1, afterLease)).rejects.toMatchObject({
      code: 'PROFILE_INSTANCE_CONFLICT'
    });
    await expect(
      instances.activate(record.instanceId, 1, '2026-07-25T19:00:00.000Z')
    ).rejects.toMatchObject({ code: 'PROFILE_INSTANCE_CONFLICT' });

    const active = await instances.activate(record.instanceId, 1, withinLease);
    expect(active).toMatchObject({ state: 'active', version: 2, activatedAt: withinLease });
    // A second activation of the same lease is not a governed transition.
    await expect(instances.activate(record.instanceId, 2, withinLease)).rejects.toMatchObject({
      code: 'PROFILE_INSTANCE_CONFLICT'
    });
  });

  it('quarantines a planned lease at version 2 and frees its recipe scope', async () => {
    const record = await planned();

    await expect(instances.expire(record.instanceId, 1, withinLease)).rejects.toMatchObject({
      code: 'PROFILE_INSTANCE_CONFLICT'
    });
    await expect(instances.expire(record.instanceId, 2, afterLease)).rejects.toMatchObject({
      code: 'PROFILE_INSTANCE_CONFLICT'
    });
    await expect(
      instances.expire(`profile-instance:${'0'.repeat(32)}`, 1, afterLease)
    ).rejects.toMatchObject({ code: 'PROFILE_INSTANCE_CONFLICT' });

    const expired = await instances.expire(record.instanceId, 1, afterLease);
    expect(expired).toMatchObject({
      state: 'expired',
      version: 2,
      activatedAt: null,
      expiredAt: afterLease,
      updatedAt: afterLease
    });
    // Quarantine is terminal, and the scope now reads as free for a renewal.
    await expect(instances.expire(record.instanceId, 2, afterLease)).rejects.toMatchObject({
      code: 'PROFILE_INSTANCE_CONFLICT'
    });
    await expect(
      instances.findByRecipeScope('marketing', 'client:acme_corp')
    ).resolves.toBeUndefined();
    await expect(instances.findById(record.instanceId)).resolves.toMatchObject({
      state: 'expired'
    });
  });

  it('quarantines an active lease at version 3 and keeps its activation timestamp', async () => {
    const record = await planned();
    await instances.activate(record.instanceId, 1, withinLease);

    const expired = await instances.expire(record.instanceId, 2, afterLease);
    expect(expired).toMatchObject({
      state: 'expired',
      version: 3,
      activatedAt: withinLease,
      expiredAt: afterLease
    });
  });

  it('exposes an instance profile only while its lease is active and unexpired', async () => {
    const record = await planned();
    const agentId = record.manifest.members[0]?.profile.id ?? '';

    await expect(instances.findAgentProfile(agentId)).resolves.toBeUndefined();
    await instances.activate(record.instanceId, 1, withinLease);
    await expect(instances.findAgentProfile(agentId)).resolves.toMatchObject({ id: agentId });

    // Past the lease window the same active row stops resolving.
    const afterExpiry = new ProfileInstanceRepository(context.db, () => afterLease);
    await expect(afterExpiry.findAgentProfile(agentId)).resolves.toBeUndefined();
    // And so does a quarantined one.
    await instances.expire(record.instanceId, 2, afterLease);
    await expect(instances.findAgentProfile(agentId)).resolves.toBeUndefined();
  });

  it('refuses to rewrite the approved snapshot of a stored lease', async () => {
    const record = await planned();
    expect(() =>
      context.sqlite
        .prepare('UPDATE agent_profile_instances SET manifest_sha256 = ? WHERE instance_id = ?')
        .run('b'.repeat(64), record.instanceId)
    ).toThrow(/not governed/u);
  });

  it('refuses a second, differently approved lease for a scope that already has one', async () => {
    await planned();
    // Same recipe scope, a different lease window — so a different manifest.
    await expect(
      instances.plan(plan('marketing', '2026-07-26T04:00:00.000Z'))
    ).rejects.toMatchObject({ code: 'PROFILE_INSTANCE_CONFLICT' });
  });

  it('refuses a plan whose identity and recipe scope resolve to different records', async () => {
    await planned('marketing');
    const conflicting = plan('marketing', '2026-07-26T04:00:00.000Z');
    // A row claiming this identity while belonging to another recipe: the plan's
    // two lookups now disagree about which record it is.
    context.sqlite
      .prepare(
        `INSERT INTO agent_profile_instances (${INSTANCE_COLUMNS.join(', ')})
         VALUES (?, 'finance', ?, 'client:acme_corp', 1, 'client:acme_corp', '{}', ?, 'operator:jack_hunter', 'planned', 1, ?, ?, NULL, NULL, ?)`
      )
      .run(
        conflicting.manifest.instanceId,
        'd'.repeat(64),
        'e'.repeat(64),
        createdAt,
        expiresAt,
        createdAt
      );

    await expect(instances.plan(conflicting)).rejects.toMatchObject({
      code: 'PROFILE_INSTANCE_CONFLICT'
    });
  });

  it('refuses to write a lease straight into the quarantined state', () => {
    const { manifest, manifestSha256 } = plan();
    // Leases must begin planned; the read-side expiry invariants exist for a
    // corrupted file, not for anything SQL can produce.
    expect(() =>
      context.sqlite
        .prepare(
          `INSERT INTO agent_profile_instances (${INSTANCE_COLUMNS.join(', ')})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'expired', 3, ?, ?, NULL, ?, ?)`
        )
        .run(
          manifest.instanceId,
          manifest.recipeId,
          manifest.recipeSha256,
          manifest.scope.id,
          manifest.scope.version,
          manifest.knowledgeScope.id,
          JSON.stringify(manifest),
          manifestSha256,
          manifest.approvedBy,
          manifest.createdAt,
          manifest.expiresAt,
          afterLease,
          afterLease
        )
    ).toThrow(/must begin in the planned state/u);
  });

  it('rejects identities and page sizes outside their bounded shape', async () => {
    await expect(instances.findById('not-an-instance-id')).rejects.toBeDefined();
    await expect(instances.listByState('planned', 0)).rejects.toBeDefined();
    await expect(instances.listByState('planned', 101)).rejects.toBeDefined();
    await expect(instances.activate('not-an-instance-id', 1, withinLease)).rejects.toBeDefined();
    await expect(instances.expire('not-an-instance-id', 1, afterLease)).rejects.toBeDefined();
    await expect(
      instances.findAgentProfile('pi-agency-marketing-0123456789abcdef')
    ).resolves.toBeUndefined();
  });

  it.each(COLUMN_DRIFTS)(
    'treats a stored row whose $name disagrees with its manifest as corrupt',
    async ({ column, value }) => {
      const { manifest, manifestSha256 } = plan();
      const row: Record<string, string | number | null> = {
        instance_id: manifest.instanceId,
        recipe_id: manifest.recipeId,
        recipe_sha256: manifest.recipeSha256,
        scope_id: manifest.scope.id,
        scope_version: manifest.scope.version,
        knowledge_scope_id: manifest.knowledgeScope.id,
        manifest_json: JSON.stringify(manifest),
        manifest_sha256: manifestSha256,
        approved_by: manifest.approvedBy,
        state: 'planned',
        version: 1,
        created_at: manifest.createdAt,
        expires_at: manifest.expiresAt,
        activated_at: null,
        expired_at: null,
        updated_at: manifest.createdAt
      };
      row[column] = value;

      context.sqlite
        .prepare(
          `INSERT INTO agent_profile_instances (${INSTANCE_COLUMNS.join(', ')}) VALUES (${INSTANCE_COLUMNS.map(
            () => '?'
          ).join(', ')})`
        )
        .run(INSTANCE_COLUMNS.map((name) => row[name] ?? null));

      await expect(instances.findById(manifest.instanceId)).rejects.toMatchObject({
        code: 'PROFILE_INSTANCE_CORRUPT'
      });
    }
  );

  it('treats a stored instance missing its member snapshots as corrupt', async () => {
    const { manifest, manifestSha256 } = plan('marketing', '2026-07-26T06:00:00.000Z');
    context.sqlite
      .prepare(
        `INSERT INTO agent_profile_instances (instance_id, recipe_id, recipe_sha256, scope_id, scope_version, knowledge_scope_id, manifest_json, manifest_sha256, approved_by, state, version, created_at, expires_at, activated_at, expired_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', 1, ?, ?, NULL, NULL, ?)`
      )
      .run(
        manifest.instanceId,
        manifest.recipeId,
        manifest.recipeSha256,
        manifest.scope.id,
        manifest.scope.version,
        manifest.knowledgeScope.id,
        JSON.stringify(manifest),
        manifestSha256,
        manifest.approvedBy,
        manifest.createdAt,
        manifest.expiresAt,
        manifest.createdAt
      );

    await expect(instances.findById(manifest.instanceId)).rejects.toMatchObject({
      code: 'PROFILE_INSTANCE_CORRUPT'
    });
  });

  it('reports a stored instance whose digest does not cover its manifest as corrupt', async () => {
    // Written straight past the repository, as a corrupted file or a foreign
    // writer would leave it: the row is well-formed but its recorded digest does
    // not cover the stored manifest, so every read must fail closed.
    const instanceId = `profile-instance:${'c'.repeat(32)}`;
    context.sqlite
      .prepare(
        `INSERT INTO agent_profile_instances (instance_id, recipe_id, recipe_sha256, scope_id, scope_version, knowledge_scope_id, manifest_json, manifest_sha256, approved_by, state, version, created_at, expires_at, activated_at, expired_at, updated_at)
         VALUES (?, 'marketing', ?, 'client:acme_corp', 1, 'client:acme_corp', '{}', ?, 'operator:jack_hunter', 'planned', 1, ?, ?, NULL, NULL, ?)`
      )
      .run(instanceId, 'a'.repeat(64), 'b'.repeat(64), createdAt, expiresAt, createdAt);

    await expect(instances.findById(instanceId)).rejects.toMatchObject({
      code: 'PROFILE_INSTANCE_CORRUPT',
      statusCode: 500
    });
    await expect(instances.listByState('planned')).rejects.toMatchObject({
      code: 'PROFILE_INSTANCE_CORRUPT'
    });
  });
});
