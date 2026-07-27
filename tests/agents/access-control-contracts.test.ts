import { describe, expect, it } from 'vitest';

import {
  AUTHORITY_LAYERS,
  AccessSensitivitySchema,
  AgentSleeveGrantRecordSchema,
  AuthorizeMemoryAccessInputSchema,
  AuthorizeMemoryRetrievalInputSchema,
  AuthorizedMemoryAccessSchema,
  ControlScopeRecordSchema,
  MemorySleeveIdSchema,
  PublishSharedApprovedBundleInputSchema,
  SharedApprovedBundleRecordSchema
} from '../../src/agents/access-control-contracts';

const at = '2026-07-21T12:00:00.000Z';

describe('durable scope, sleeve, and grant contracts', () => {
  it('uses a closed five-layer authority intersection and ordered sensitivity vocabulary', () => {
    expect(AUTHORITY_LAYERS).toEqual(['blueprint', 'operator', 'tenant', 'channel', 'run']);
    expect(AccessSensitivitySchema.options).toEqual([
      'public',
      'internal',
      'confidential',
      'private',
      'restricted'
    ]);
  });

  it('derives strict scope identities and rejects extensible or inconsistent records', () => {
    expect(
      ControlScopeRecordSchema.parse({
        id: 'agency:agency',
        kind: 'agency',
        subjectId: 'agency',
        parentScopeId: 'personal:jarvis',
        trustDomain: 'agency',
        state: 'active',
        version: 1,
        createdAt: at,
        updatedAt: at
      })
    ).toMatchObject({ id: 'agency:agency', version: 1 });

    expect(() =>
      ControlScopeRecordSchema.parse({
        id: 'agency:wrong',
        kind: 'agency',
        subjectId: 'agency',
        parentScopeId: null,
        trustDomain: 'agency',
        state: 'active',
        version: 1,
        createdAt: at,
        updatedAt: at
      })
    ).toThrow(/derived/iu);
    expect(() =>
      ControlScopeRecordSchema.parse({
        id: 'agency:agency',
        kind: 'agency',
        subjectId: 'agency',
        parentScopeId: null,
        trustDomain: 'agency',
        state: 'active',
        version: 1,
        createdAt: at,
        updatedAt: at,
        arbitraryAuthority: true
      })
    ).toThrow();
  });

  it('accepts approved sleeve namespaces while rejecting paths and guessed forms', () => {
    expect(MemorySleeveIdSchema.parse('personal:jarvis')).toBe('personal:jarvis');
    expect(MemorySleeveIdSchema.parse('agency:coordination')).toBe('agency:coordination');
    expect(MemorySleeveIdSchema.parse('task_market:coordination')).toBe('task_market:coordination');
    expect(MemorySleeveIdSchema.parse('shared:jarvis_handoffs')).toBe('shared:jarvis_handoffs');
    expect(MemorySleeveIdSchema.parse('client:acme_corp')).toBe('client:acme_corp');
    expect(MemorySleeveIdSchema.parse('agent:agency-developer:scratch')).toBe(
      'agent:agency-developer:scratch'
    );
    expect(() => MemorySleeveIdSchema.parse('client:../escape')).toThrow();
    expect(() => MemorySleeveIdSchema.parse('agent:agency-developer:private')).toThrow();
  });

  it('requires immutable grant bindings, purpose, cap, expiry, and positive versions', () => {
    expect(
      AgentSleeveGrantRecordSchema.parse({
        id: 'sleeve-grant:agency-read-blueprint',
        agentId: 'agency-developer',
        sleeveId: 'agency:coordination',
        authorityLayer: 'blueprint',
        permission: 'read',
        purpose: 'agency_delivery_review',
        sensitivityCap: 'confidential',
        expiresAt: '2026-07-21T13:00:00.000Z',
        state: 'active',
        version: 1,
        boundAgentVersion: 3,
        boundScopeVersion: 2,
        boundSleeveVersion: 4,
        createdAt: at,
        updatedAt: at
      })
    ).toMatchObject({ authorityLayer: 'blueprint', permission: 'read' });
  });

  it('requires every grant version at retrieval time and forbids caller-selected agent identity', () => {
    const request = AuthorizeMemoryRetrievalInputSchema.parse({
      sleeveId: 'agency:coordination',
      expectedSleeveVersion: 4,
      expectedOwnerScopeVersion: 2,
      permission: 'read',
      purpose: 'agency_delivery_review',
      sensitivity: 'internal',
      grantVersions: {
        blueprint: 1,
        operator: 2,
        tenant: 1,
        channel: 5,
        run: 8
      }
    });
    expect(request.grantVersions.run).toBe(8);
    expect(() =>
      AuthorizeMemoryRetrievalInputSchema.parse({ ...request, agentId: 'jarvis' })
    ).toThrow();
    expect(() => AuthorizeMemoryRetrievalInputSchema.parse({ ...request, at })).toThrow();
    expect(() =>
      AuthorizeMemoryRetrievalInputSchema.parse({ ...request, permission: 'propose' })
    ).toThrow();
    expect(() =>
      AuthorizeMemoryRetrievalInputSchema.parse({
        ...request,
        grantVersions: { blueprint: 1, operator: 2, tenant: 1, channel: 5 }
      })
    ).toThrow();
  });

  it('authorizes exact-sleeve read or propose without widening the retrieval contract', () => {
    const request = {
      sleeveId: 'agency:coordination',
      expectedSleeveVersion: 4,
      expectedOwnerScopeVersion: 2,
      permission: 'propose' as const,
      purpose: 'agency_delivery_review',
      sensitivity: 'internal' as const,
      grantVersions: {
        blueprint: 1,
        operator: 2,
        tenant: 1,
        channel: 5,
        run: 8
      }
    };

    expect(AuthorizeMemoryAccessInputSchema.parse(request).permission).toBe('propose');
    expect(
      AuthorizeMemoryAccessInputSchema.parse({ ...request, permission: 'read' }).permission
    ).toBe('read');
    expect(() =>
      AuthorizeMemoryAccessInputSchema.parse({ ...request, agentId: 'agency-developer' })
    ).toThrow();
    expect(() =>
      AuthorizeMemoryRetrievalInputSchema.parse({ ...request, permission: 'propose' })
    ).toThrow();

    expect(
      AuthorizedMemoryAccessSchema.parse({
        agentId: 'agency-developer',
        sleeveId: 'agency:coordination',
        ownerScopeId: 'agency:agency',
        partitionKey: 'memory/sleeves/agency/coordination',
        permission: 'propose',
        purpose: 'agency_delivery_review',
        sensitivity: 'internal',
        authorizedAt: at,
        effectiveExpiresAt: '2026-07-21T13:00:00.000Z',
        agentVersion: 3,
        ownerScopeVersion: 2,
        sleeveVersion: 4,
        grantVersions: request.grantVersions
      }).permission
    ).toBe('propose');
  });

  it('requires reviewed, expiring, materialized shared fragments without paths or live pointers', () => {
    const input = PublishSharedApprovedBundleInputSchema.parse({
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
          id: 'fragment:summary-001',
          sourceDocumentId: 'decision:agency-offer-001',
          sourceVersion: 3,
          materializedText: 'The reviewed offer summary contains no client-private content.',
          provenanceRef: 'audit:review-001'
        }
      ],
      reviewedBy: 'operator:jack_hunter',
      reviewedAt: at,
      expiresAt: '2026-07-28T12:00:00.000Z'
    });
    expect(input.fragments[0]?.materializedText).toContain('reviewed offer summary');
    expect(() =>
      PublishSharedApprovedBundleInputSchema.parse({
        ...input,
        sourcePath: '/clients/acme/private.md'
      })
    ).toThrow();
    expect(() =>
      PublishSharedApprovedBundleInputSchema.parse({
        ...input,
        fragments: [{ ...input.fragments[0], livePointer: 'client:acme_corp' }]
      })
    ).toThrow();

    expect(
      SharedApprovedBundleRecordSchema.safeParse({
        ...input,
        contentSha256: 'a'.repeat(64),
        state: 'active',
        version: 1,
        createdAt: at,
        updatedAt: at
      }).success
    ).toBe(true);
  });
});
