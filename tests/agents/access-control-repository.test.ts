import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTHORITY_LAYERS,
  type AuthorityLayer,
  type AuthorizedMemoryAccess,
  type GrantVersionSet
} from '../../src/agents/access-control-contracts';
import {
  AccessControlRepository,
  MemoryAccessDeniedError,
  ToolAccessDeniedError
} from '../../src/agents/access-control-repository';
import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';

const projectRoot = join(__dirname, '..', '..');
const createdAt = '2026-07-21T12:00:00.000Z';
const expiresAt = '2026-07-21T13:00:00.000Z';
const beforeExpiry = '2026-07-21T12:59:59.999Z';

describe('AccessControlRepository', () => {
  let temporaryRoot: string;
  let filename: string;
  let context: GlobalDatabaseContext;
  let repository: AccessControlRepository;
  let authorizationNow: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-access-control-'));
    filename = join(temporaryRoot, 'jarvis.sqlite');
    authorizationNow = beforeExpiry;
    context = await createDatabase({ projectRoot, filename });
    repository = new AccessControlRepository(context.db, () => new Date(authorizationNow));

    await repository.registerScope({
      id: 'personal:jarvis',
      kind: 'personal',
      subjectId: 'jarvis',
      parentScopeId: null,
      trustDomain: 'personal',
      createdAt
    });
    await repository.registerScope({
      id: 'agency:agency',
      kind: 'agency',
      subjectId: 'agency',
      parentScopeId: 'personal:jarvis',
      trustDomain: 'agency',
      createdAt
    });
    await repository.registerScope({
      id: 'project:alpha',
      kind: 'project',
      subjectId: 'alpha',
      parentScopeId: 'agency:agency',
      trustDomain: 'agency',
      createdAt
    });
    await repository.registerAgent({
      id: 'jarvis',
      homeScopeId: 'personal:jarvis',
      trustDomain: 'personal',
      profileRevision: 1,
      createdAt
    });
    await repository.registerAgent({
      id: 'agency-developer',
      homeScopeId: 'agency:agency',
      trustDomain: 'agency',
      profileRevision: 3,
      createdAt
    });
    await repository.registerSleeve({
      id: 'agency:coordination',
      ownerScopeId: 'agency:agency',
      maxSensitivity: 'confidential',
      expiresAt: null,
      createdAt
    });
    await repository.registerSleeve({
      id: 'project:alpha_private',
      ownerScopeId: 'project:alpha',
      maxSensitivity: 'private',
      expiresAt: null,
      createdAt
    });
    await repository.registerSleeve({
      id: 'shared:jarvis_handoffs',
      ownerScopeId: 'personal:jarvis',
      maxSensitivity: 'internal',
      expiresAt: '2026-08-21T12:00:00.000Z',
      createdAt
    });
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  async function grantSleeveLayers(options?: {
    agentId?: string;
    sleeveId?: string;
    permission?: 'read' | 'propose';
    purpose?: string;
    cap?: 'public' | 'internal' | 'confidential' | 'private' | 'restricted';
    layers?: readonly AuthorityLayer[];
    expectedAgentVersion?: number;
    expectedScopeVersion?: number;
    expectedSleeveVersion?: number;
  }): Promise<GrantVersionSet> {
    const agentId = options?.agentId ?? 'agency-developer';
    const sleeveId = options?.sleeveId ?? 'agency:coordination';
    const permission = options?.permission ?? 'read';
    const purpose = options?.purpose ?? 'agency_delivery_review';
    const layers = options?.layers ?? AUTHORITY_LAYERS;
    const versions = {} as Record<AuthorityLayer, number>;

    for (const layer of layers) {
      const grant = await repository.issueSleeveGrant({
        id: `sleeve-grant:${agentId}-${sleeveId.replaceAll(':', '-')}-${permission}-${layer}`,
        agentId,
        sleeveId,
        authorityLayer: layer,
        permission,
        purpose,
        sensitivityCap: options?.cap ?? 'confidential',
        expiresAt,
        expectedAgentVersion: options?.expectedAgentVersion ?? 1,
        expectedScopeVersion: options?.expectedScopeVersion ?? 1,
        expectedSleeveVersion: options?.expectedSleeveVersion ?? 1,
        issuedAt: createdAt
      });
      versions[layer] = grant.version;
    }
    return versions;
  }

  async function grantToolLayers(options?: {
    access?: 'read' | 'propose' | 'execute';
    purpose?: string;
    cap?: 'public' | 'internal' | 'confidential' | 'private' | 'restricted';
    layers?: readonly AuthorityLayer[];
  }): Promise<GrantVersionSet> {
    const access = options?.access ?? 'read';
    const versions = {} as Record<AuthorityLayer, number>;
    for (const layer of options?.layers ?? AUTHORITY_LAYERS) {
      const grant = await repository.issueToolGrant({
        id: `tool-grant:agency-developer-repo-inspect-${access}-${layer}`,
        agentId: 'agency-developer',
        toolId: 'repo.inspect',
        authorityLayer: layer,
        access,
        purpose: options?.purpose ?? 'agency_delivery_review',
        sensitivityCap: options?.cap ?? 'confidential',
        expiresAt,
        expectedAgentVersion: 1,
        expectedScopeVersion: 1,
        issuedAt: createdAt
      });
      versions[layer] = grant.version;
    }
    return versions;
  }

  it('persists strict idempotent scopes, agents, and derived sleeve partitions across reloads', async () => {
    await expect(
      repository.registerScope({
        id: 'agency:agency',
        kind: 'agency',
        subjectId: 'agency',
        parentScopeId: 'personal:jarvis',
        trustDomain: 'agency',
        createdAt
      })
    ).resolves.toMatchObject({ id: 'agency:agency', version: 1 });
    await expect(
      repository.registerScope({
        id: 'agency:agency',
        kind: 'agency',
        subjectId: 'agency',
        parentScopeId: null,
        trustDomain: 'agency',
        createdAt
      })
    ).rejects.toThrow(/different binding/iu);
    await expect(
      repository.registerAgent({
        id: 'cross-domain-agent',
        homeScopeId: 'personal:jarvis',
        trustDomain: 'agency',
        profileRevision: 1,
        createdAt
      })
    ).rejects.toThrow(/trust domain/iu);

    await context.destroy();
    context = await createDatabase({ projectRoot, filename });
    repository = new AccessControlRepository(context.db, () => new Date(authorizationNow));

    await expect(repository.findScope('project:alpha')).resolves.toMatchObject({
      parentScopeId: 'agency:agency',
      trustDomain: 'agency'
    });
    await expect(repository.findAgent('agency-developer')).resolves.toMatchObject({
      homeScopeId: 'agency:agency',
      profileRevision: 3
    });
    await expect(repository.findSleeve('agency:coordination')).resolves.toMatchObject({
      partitionKey: 'memory/sleeves/agency/coordination',
      maxSensitivity: 'confidential'
    });
  });

  it('grants no access through parent/child containment and returns one generic denial', async () => {
    const versions = await grantSleeveLayers();
    const authorizer = repository.bindAgent({
      agentId: 'agency-developer',
      expectedAgentVersion: 1
    });
    await expect(
      authorizer.authorizeMemoryRetrieval({
        sleeveId: 'agency:coordination',
        expectedSleeveVersion: 1,
        expectedOwnerScopeVersion: 1,
        permission: 'read',
        purpose: 'agency_delivery_review',
        sensitivity: 'internal',
        grantVersions: versions
      })
    ).resolves.toMatchObject({
      agentId: 'agency-developer',
      sleeveId: 'agency:coordination',
      partitionKey: 'memory/sleeves/agency/coordination',
      effectiveExpiresAt: expiresAt
    });

    const childError = await authorizer
      .authorizeMemoryRetrieval({
        sleeveId: 'project:alpha_private',
        expectedSleeveVersion: 1,
        expectedOwnerScopeVersion: 1,
        permission: 'read',
        purpose: 'agency_delivery_review',
        sensitivity: 'internal',
        grantVersions: versions
      })
      .catch((error: unknown) => error);
    const missingError = await authorizer
      .authorizeMemoryRetrieval({
        sleeveId: 'project:not_registered',
        expectedSleeveVersion: 1,
        expectedOwnerScopeVersion: 1,
        permission: 'read',
        purpose: 'agency_delivery_review',
        sensitivity: 'internal',
        grantVersions: versions
      })
      .catch((error: unknown) => error);

    expect(childError).toBeInstanceOf(MemoryAccessDeniedError);
    expect(missingError).toBeInstanceOf(MemoryAccessDeniedError);
    expect(childError).toMatchObject({
      statusCode: 403,
      code: 'MEMORY_ACCESS_DENIED',
      message: 'Memory access is not authorized'
    });
    expect(missingError).toMatchObject({
      statusCode: 403,
      code: 'MEMORY_ACCESS_DENIED',
      message: 'Memory access is not authorized'
    });
  });

  it('authorizes before invoking retrieval and never calls a resolver on denial', async () => {
    const versions = await grantSleeveLayers({ layers: ['blueprint', 'operator', 'tenant'] });
    const authorizer = repository.bindAgent({
      agentId: 'agency-developer',
      expectedAgentVersion: 1
    });
    const retrieve = vi.fn(() => Promise.resolve(['must never run']));

    await expect(
      authorizer.runAuthorizedMemoryRetrieval(
        {
          sleeveId: 'agency:coordination',
          expectedSleeveVersion: 1,
          expectedOwnerScopeVersion: 1,
          permission: 'read',
          purpose: 'agency_delivery_review',
          sensitivity: 'internal',
          grantVersions: { ...versions, channel: 1, run: 1 }
        },
        retrieve
      )
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('authorizes exact-sleeve proposals without widening retrieval and rechecks every layer', async () => {
    const versions = await grantSleeveLayers({ permission: 'propose', cap: 'internal' });
    const authorizer = repository.bindAgent({
      agentId: 'agency-developer',
      expectedAgentVersion: 1
    });
    const base = {
      sleeveId: 'agency:coordination',
      expectedSleeveVersion: 1,
      expectedOwnerScopeVersion: 1,
      permission: 'propose' as const,
      purpose: 'agency_delivery_review',
      sensitivity: 'internal' as const,
      grantVersions: versions
    };
    const propose = vi.fn((authorization: AuthorizedMemoryAccess) =>
      Promise.resolve(authorization.permission)
    );

    await expect(authorizer.authorizeMemoryAccess(base)).resolves.toMatchObject({
      agentId: 'agency-developer',
      ownerScopeId: 'agency:agency',
      sleeveId: 'agency:coordination',
      permission: 'propose',
      effectiveExpiresAt: expiresAt
    });
    await expect(authorizer.runAuthorizedMemoryAccess(base, propose)).resolves.toBe('propose');
    expect(propose).toHaveBeenCalledTimes(1);

    await expect(authorizer.authorizeMemoryRetrieval(base)).rejects.toThrow();
    await expect(
      authorizer.authorizeMemoryAccess({ ...base, sensitivity: 'confidential' })
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
    await expect(
      authorizer.authorizeMemoryAccess({
        ...base,
        grantVersions: { ...versions, run: 99 }
      })
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);

    authorizationNow = expiresAt;
    await expect(authorizer.authorizeMemoryAccess(base)).rejects.toBeInstanceOf(
      MemoryAccessDeniedError
    );
    authorizationNow = beforeExpiry;

    await repository.revokeSleeveGrant({
      id: 'sleeve-grant:agency-developer-agency-coordination-propose-run',
      expectedVersion: 1,
      revokedAt: '2026-07-21T12:30:00.000Z'
    });
    const denied = vi.fn(() => Promise.resolve('must never run'));
    await expect(authorizer.runAuthorizedMemoryAccess(base, denied)).rejects.toBeInstanceOf(
      MemoryAccessDeniedError
    );
    expect(denied).not.toHaveBeenCalled();
  });

  it('intersects every layer across purpose, sensitivity, expiry, and captured versions', async () => {
    const versions = await grantSleeveLayers({ cap: 'internal' });
    const authorizer = repository.bindAgent({
      agentId: 'agency-developer',
      expectedAgentVersion: 1
    });
    const base = {
      sleeveId: 'agency:coordination',
      expectedSleeveVersion: 1,
      expectedOwnerScopeVersion: 1,
      permission: 'read' as const,
      purpose: 'agency_delivery_review',
      sensitivity: 'internal' as const,
      grantVersions: versions
    };

    await expect(authorizer.authorizeMemoryRetrieval(base)).resolves.toMatchObject({
      sensitivity: 'internal',
      grantVersions: versions
    });
    await expect(
      authorizer.authorizeMemoryRetrieval({ ...base, purpose: 'unrelated_work' })
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
    await expect(
      authorizer.authorizeMemoryRetrieval({ ...base, sensitivity: 'confidential' })
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
    await expect(
      authorizer.authorizeMemoryRetrieval({
        ...base,
        grantVersions: { ...versions, run: 99 }
      })
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
    await expect(
      authorizer.authorizeMemoryRetrieval({ ...base, expectedSleeveVersion: 2 })
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
    authorizationNow = expiresAt;
    await expect(authorizer.authorizeMemoryRetrieval(base)).rejects.toBeInstanceOf(
      MemoryAccessDeniedError
    );
    authorizationNow = beforeExpiry;

    await repository.revokeSleeveGrant({
      id: 'sleeve-grant:agency-developer-agency-coordination-read-operator',
      expectedVersion: 1,
      revokedAt: '2026-07-21T12:30:00.000Z'
    });
    await expect(authorizer.authorizeMemoryRetrieval(base)).rejects.toBeInstanceOf(
      MemoryAccessDeniedError
    );
  });

  it('applies the same five-layer intersection to exact tool access without implied execute', async () => {
    const versions = await grantToolLayers({ access: 'read', cap: 'internal' });
    const authorizer = repository.bindAgent({
      agentId: 'agency-developer',
      expectedAgentVersion: 1
    });
    const base = {
      toolId: 'repo.inspect',
      expectedHomeScopeVersion: 1,
      access: 'read' as const,
      purpose: 'agency_delivery_review',
      sensitivity: 'internal' as const,
      grantVersions: versions
    };

    await expect(authorizer.authorizeToolUse(base)).resolves.toMatchObject({
      agentId: 'agency-developer',
      toolId: 'repo.inspect',
      access: 'read',
      effectiveExpiresAt: expiresAt
    });
    await expect(
      authorizer.authorizeToolUse({ ...base, access: 'execute' })
    ).rejects.toBeInstanceOf(ToolAccessDeniedError);
    await expect(
      authorizer.authorizeToolUse({ ...base, sensitivity: 'confidential' })
    ).rejects.toBeInstanceOf(ToolAccessDeniedError);
    authorizationNow = expiresAt;
    await expect(authorizer.authorizeToolUse(base)).rejects.toBeInstanceOf(ToolAccessDeniedError);
    authorizationNow = beforeExpiry;
  });

  it('enforces durable immutable bindings, versioned revocation, and one active layer in SQL', async () => {
    await grantSleeveLayers({ layers: ['blueprint'] });

    expect(() =>
      context.sqlite
        .prepare(
          "UPDATE control_scopes SET parent_scope_id = NULL, version = 2 WHERE scope_id = 'agency:agency'"
        )
        .run()
    ).toThrow(/immutable binding/iu);
    expect(() =>
      context.sqlite
        .prepare("DELETE FROM memory_sleeves WHERE sleeve_id = 'agency:coordination'")
        .run()
    ).toThrow(/cannot be deleted/iu);
    expect(() =>
      context.sqlite
        .prepare(
          "UPDATE agent_sleeve_grants SET purpose = 'changed', state = 'revoked', version = 2 WHERE authority_layer = 'blueprint'"
        )
        .run()
    ).toThrow(/immutable binding/iu);

    await expect(
      repository.issueSleeveGrant({
        id: 'sleeve-grant:duplicate-active-blueprint',
        agentId: 'agency-developer',
        sleeveId: 'agency:coordination',
        authorityLayer: 'blueprint',
        permission: 'read',
        purpose: 'agency_delivery_review',
        sensitivityCap: 'confidential',
        expiresAt,
        expectedAgentVersion: 1,
        expectedScopeVersion: 1,
        expectedSleeveVersion: 1,
        issuedAt: createdAt
      })
    ).rejects.toThrow(/unique/iu);

    const revoked = await repository.revokeSleeveGrant({
      id: 'sleeve-grant:agency-developer-agency-coordination-read-blueprint',
      expectedVersion: 1,
      revokedAt: '2026-07-21T12:30:00.000Z'
    });
    expect(revoked).toMatchObject({ state: 'revoked', version: 2 });
    await expect(
      repository.revokeSleeveGrant({
        id: revoked.id,
        expectedVersion: 1,
        revokedAt: '2026-07-21T12:31:00.000Z'
      })
    ).rejects.toThrow(/stale/iu);
  });

  it('publishes only reviewed cross-scope materialized bundles into shared-approved sleeves', async () => {
    const bundle = await repository.publishSharedApprovedBundle({
      id: 'shared-bundle:agency-to-jarvis-001',
      sourceScopeId: 'agency:agency',
      expectedSourceScopeVersion: 1,
      targetSleeveId: 'shared:jarvis_handoffs',
      expectedTargetScopeVersion: 1,
      expectedTargetSleeveVersion: 1,
      purpose: 'jarvis_agency_handoff',
      publishedSensitivity: 'internal',
      fragments: [
        {
          id: 'fragment:agency-summary-001',
          sourceDocumentId: 'decision:agency-offer-001',
          sourceVersion: 3,
          materializedText: 'A reviewed and sanitized offer summary.',
          provenanceRef: 'audit:review-001'
        }
      ],
      reviewedBy: 'operator:jack_hunter',
      reviewedAt: createdAt,
      expiresAt: '2026-07-28T12:00:00.000Z'
    });
    expect(bundle).toMatchObject({
      targetSleeveId: 'shared:jarvis_handoffs',
      state: 'active',
      version: 1
    });
    expect(bundle.contentSha256).toMatch(/^[a-f0-9]{64}$/u);

    const versions = await grantSleeveLayers({
      agentId: 'jarvis',
      sleeveId: 'shared:jarvis_handoffs',
      purpose: 'jarvis_agency_handoff',
      cap: 'internal'
    });
    const authorization = await repository
      .bindAgent({ agentId: 'jarvis', expectedAgentVersion: 1 })
      .authorizeMemoryRetrieval({
        sleeveId: 'shared:jarvis_handoffs',
        expectedSleeveVersion: 1,
        expectedOwnerScopeVersion: 1,
        permission: 'read',
        purpose: 'jarvis_agency_handoff',
        sensitivity: 'internal',
        grantVersions: versions
      });
    await expect(repository.listSharedApprovedBundles(authorization, 10)).resolves.toEqual([
      expect.objectContaining({ id: 'shared-bundle:agency-to-jarvis-001' })
    ]);

    authorizationNow = expiresAt;
    await expect(repository.listSharedApprovedBundles(authorization, 10)).rejects.toBeInstanceOf(
      MemoryAccessDeniedError
    );
    authorizationNow = beforeExpiry;

    await expect(
      repository.listSharedApprovedBundles(
        { ...authorization, sleeveId: 'agency:coordination' },
        10
      )
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
    await expect(
      repository.publishSharedApprovedBundle({
        id: 'shared-bundle:invalid-target',
        sourceScopeId: 'personal:jarvis',
        expectedSourceScopeVersion: 1,
        targetSleeveId: 'shared:jarvis_handoffs',
        expectedTargetScopeVersion: 1,
        expectedTargetSleeveVersion: 1,
        purpose: 'jarvis_agency_handoff',
        publishedSensitivity: 'internal',
        fragments: [
          {
            id: 'fragment:invalid-target',
            sourceDocumentId: 'memory:personal',
            sourceVersion: 1,
            materializedText: 'This is not cross-scope.',
            provenanceRef: 'audit:review-002'
          }
        ],
        reviewedBy: 'operator:jack_hunter',
        reviewedAt: createdAt,
        expiresAt: '2026-07-28T12:00:00.000Z'
      })
    ).rejects.toThrow(/cross-scope/iu);
  });
});
