import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AUTHORITY_LAYERS,
  type AuthorityLayer,
  type GrantVersionSet
} from '../../../src/agents/access-control-contracts';
import { AccessControlRepository } from '../../../src/agents/access-control-repository';
import { createDatabase, type GlobalDatabaseContext } from '../../../src/db/database';

export const RECORDED_AT = '2026-07-19T12:00:00.000Z';
export const EVALUATED_AT = '2026-07-21T12:00:00.000Z';
export const SLEEVE_ID = 'client:acme_corp';
export const OWNER_SCOPE_ID = 'client:acme_corp';
export const AGENT_ID = 'agency-developer';

export interface MemorySystemHarness {
  context: GlobalDatabaseContext;
  access: AccessControlRepository;
  grantVersions: GrantVersionSet;
  proposeGrantVersions: GrantVersionSet;
  boundAccess: ReturnType<AccessControlRepository['bindAgent']>;
  cleanup(): Promise<void>;
}

/**
 * Stands up a global database with one agency scope, one client scope/sleeve, a
 * registered agent, and read grants across every authority layer — the minimum
 * needed to exercise an authorized memory backend. Mirrors the setup in
 * tests/knowledge/lexical-retrieval.test.ts.
 */
export async function createMemorySystemHarness(): Promise<MemorySystemHarness> {
  const projectRoot = join(__dirname, '..', '..', '..');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-memory-system-'));
  const context = await createDatabase({
    projectRoot,
    filename: join(temporaryRoot, 'jarvis.sqlite')
  });
  const access = new AccessControlRepository(context.db, () => new Date(EVALUATED_AT));

  await access.registerScope({
    id: 'agency:agency',
    kind: 'agency',
    subjectId: 'agency',
    parentScopeId: null,
    trustDomain: 'agency',
    createdAt: RECORDED_AT
  });
  await access.registerScope({
    id: OWNER_SCOPE_ID,
    kind: 'client',
    subjectId: 'acme_corp',
    parentScopeId: 'agency:agency',
    trustDomain: 'agency',
    createdAt: RECORDED_AT
  });
  await access.registerAgent({
    id: AGENT_ID,
    homeScopeId: 'agency:agency',
    trustDomain: 'agency',
    profileRevision: 1,
    createdAt: RECORDED_AT
  });
  await access.registerSleeve({
    id: SLEEVE_ID,
    ownerScopeId: OWNER_SCOPE_ID,
    maxSensitivity: 'confidential',
    expiresAt: null,
    createdAt: RECORDED_AT
  });

  const versions = {} as Record<AuthorityLayer, number>;
  const proposeVersions = {} as Record<AuthorityLayer, number>;
  for (const layer of AUTHORITY_LAYERS) {
    const grant = await access.issueSleeveGrant({
      id: `sleeve-grant:${AGENT_ID}-acme-read-${layer}`,
      agentId: AGENT_ID,
      sleeveId: SLEEVE_ID,
      authorityLayer: layer,
      permission: 'read',
      purpose: 'memory_system_test',
      sensitivityCap: 'confidential',
      expiresAt: '2026-08-21T12:00:00.000Z',
      expectedAgentVersion: 1,
      expectedScopeVersion: 1,
      expectedSleeveVersion: 1,
      issuedAt: RECORDED_AT
    });
    versions[layer] = grant.version;

    const proposeGrant = await access.issueSleeveGrant({
      id: `sleeve-grant:${AGENT_ID}-acme-propose-${layer}`,
      agentId: AGENT_ID,
      sleeveId: SLEEVE_ID,
      authorityLayer: layer,
      permission: 'propose',
      purpose: 'memory_system_propose',
      sensitivityCap: 'confidential',
      expiresAt: '2026-08-21T12:00:00.000Z',
      expectedAgentVersion: 1,
      expectedScopeVersion: 1,
      expectedSleeveVersion: 1,
      issuedAt: RECORDED_AT
    });
    proposeVersions[layer] = proposeGrant.version;
  }

  return {
    context,
    access,
    grantVersions: versions,
    proposeGrantVersions: proposeVersions,
    boundAccess: access.bindAgent({ agentId: AGENT_ID, expectedAgentVersion: 1 }),
    async cleanup() {
      await context.destroy();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  };
}

export function retrievalAuthorization(grantVersions: GrantVersionSet) {
  return {
    sleeveId: SLEEVE_ID,
    expectedSleeveVersion: 1,
    expectedOwnerScopeVersion: 1,
    permission: 'read' as const,
    purpose: 'memory_system_test',
    sensitivity: 'confidential' as const,
    grantVersions
  };
}

export function fragmentInput(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ownerScopeId: OWNER_SCOPE_ID,
    sleeveId: SLEEVE_ID,
    sourceId: `note:${id}`,
    sourceHash: createHash('sha256').update(id, 'utf8').digest('hex'),
    extractionVersion: 'markdown_v1',
    kind: 'fact',
    title: `Memory ${id}`,
    content: 'Quarterly close uses the cobalt reconciliation checklist.',
    tags: ['finance', 'close'],
    validFrom: RECORDED_AT,
    validUntil: null,
    recordedAt: RECORDED_AT,
    confidencePermille: 900,
    sensitivity: 'confidential',
    supersedesFragmentId: null,
    reviewAt: null,
    expiresAt: null,
    retrievalEligible: true,
    ...overrides
  };
}
