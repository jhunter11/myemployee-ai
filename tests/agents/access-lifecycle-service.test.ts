import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccessLifecycleService } from '../../src/agents/access-lifecycle-service';
import { AccessControlRepository } from '../../src/agents/access-control-repository';
import { ProfileAccessBootstrap } from '../../src/agents/profile-access-bootstrap';
import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import { KnowledgeScopeRepository } from '../../src/knowledge/scope-repository';

const projectRoot = join(__dirname, '..', '..');
const occurredAt = '2026-07-21T01:00:00.000Z';
const operatorSession = Object.freeze({ session: 'verified-operator-session' });

describe('AccessLifecycleService', () => {
  let temporaryRoot: string;
  let context: GlobalDatabaseContext;
  let repository: AccessControlRepository;
  let lifecycle: AccessLifecycleService;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-access-lifecycle-'));
    context = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    context.sqlite.exec(
      await readFile(
        join(projectRoot, 'src', 'db', 'migrations', '016_profile_access_lifecycle_audit.sql'),
        'utf8'
      )
    );
    repository = new AccessControlRepository(context.db);
    await new ProfileAccessBootstrap(
      context.db,
      repository,
      new KnowledgeScopeRepository(context.db)
    ).install();
    lifecycle = new AccessLifecycleService(context.db, (candidate) =>
      candidate === operatorSession ? { id: 'operator:jack_hunter' } : undefined
    );
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('binds only a verified operator and records an idempotent append-only grant revocation', async () => {
    expect(() => lifecycle.bindOperator({ kind: 'operator', id: 'operator:jack_hunter' })).toThrow(
      /operator verification/iu
    );
    const operator = lifecycle.bindOperator(operatorSession);
    const input = {
      resourceKind: 'sleeve_grant' as const,
      id: 'sleeve-grant:catalog-agency-developer-agency-engineering-read-blueprint',
      expectedVersion: 1,
      reason: 'profile_access_removed',
      occurredAt
    };

    const first = await operator.revokeGrant(input);
    expect(first.current).toMatchObject({
      id: input.id,
      state: 'revoked',
      version: 2
    });
    expect(first.evidence).toMatchObject({
      resourceKind: 'sleeve_grant',
      resourceId: input.id,
      action: 'revoked',
      replacementResourceId: null,
      priorVersion: 1,
      resultingVersion: 2,
      actorId: 'operator:jack_hunter',
      reason: 'profile_access_removed'
    });
    expect(first.evidence.evidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(operator.revokeGrant(input)).resolves.toEqual(first);

    const projection = await operator.project({ resourceId: input.id, limit: 10 });
    expect(projection.totalCount).toBe(1);
    expect(projection.items).toEqual([first.evidence]);
    expect(JSON.stringify(projection)).not.toMatch(/fragments|materializedText/iu);

    expect(() =>
      context.sqlite
        .prepare('UPDATE access_lifecycle_events SET reason = ? WHERE event_id = ?')
        .run('tampered', first.evidence.id)
    ).toThrow(/append-only/iu);
    expect(() =>
      context.sqlite
        .prepare('DELETE FROM access_lifecycle_events WHERE event_id = ?')
        .run(first.evidence.id)
    ).toThrow(/append-only/iu);
  });

  it('atomically replaces an exact sleeve grant without accepting binding drift', async () => {
    const old = await repository.issueSleeveGrant({
      id: 'sleeve-grant:agency-developer-engineering-read-operator-v1',
      agentId: 'agency-developer',
      sleeveId: 'agency:engineering',
      authorityLayer: 'operator',
      permission: 'read',
      purpose: 'catalog_memory_read',
      sensitivityCap: 'confidential',
      expiresAt: '2026-08-21T00:00:00.000Z',
      expectedAgentVersion: 1,
      expectedScopeVersion: 1,
      expectedSleeveVersion: 1,
      issuedAt: '2026-07-21T00:30:00.000Z'
    });
    const operator = lifecycle.bindOperator(operatorSession);
    const replacement = {
      id: 'sleeve-grant:agency-developer-engineering-read-operator-v2',
      agentId: 'agency-developer',
      sleeveId: 'agency:engineering',
      authorityLayer: 'operator' as const,
      permission: 'read' as const,
      purpose: 'catalog_memory_read',
      sensitivityCap: 'confidential' as const,
      expiresAt: '2026-09-21T00:00:00.000Z',
      expectedAgentVersion: 1,
      expectedScopeVersion: 1,
      expectedSleeveVersion: 1,
      issuedAt: occurredAt
    };

    const result = await operator.replaceGrant({
      resourceKind: 'sleeve_grant',
      id: old.id,
      expectedVersion: old.version,
      reason: 'operator_grant_rotation',
      occurredAt,
      replacement
    });
    expect(result.current).toMatchObject({ id: old.id, state: 'revoked', version: 2 });
    expect(result.replacement).toMatchObject({
      id: replacement.id,
      state: 'active',
      version: 1
    });
    expect(result.evidence).toMatchObject({
      action: 'replaced',
      replacementResourceId: replacement.id
    });

    await expect(
      operator.replaceGrant({
        resourceKind: 'sleeve_grant',
        id: replacement.id,
        expectedVersion: 1,
        reason: 'operator_grant_rotation',
        occurredAt: '2026-07-21T02:00:00.000Z',
        replacement: {
          ...replacement,
          id: 'sleeve-grant:agency-developer-growth-read-operator-v3',
          sleeveId: 'agency:growth',
          issuedAt: '2026-07-21T02:00:00.000Z'
        }
      })
    ).rejects.toMatchObject({ code: 'ACCESS_REPLACEMENT_BINDING_DRIFT' });
    await expect(repository.findSleeve('agency:growth')).resolves.toBeDefined();
    const stillActive = await context.db
      .selectFrom('agent_sleeve_grants')
      .select(['state', 'version'])
      .where('grant_id', '=', replacement.id)
      .executeTakeFirstOrThrow();
    expect(stillActive).toEqual({ state: 'active', version: 1 });
  });

  it('uses the same exact-binding lifecycle for tool grant replacement', async () => {
    const old = await repository.issueToolGrant({
      id: 'tool-grant:agency-developer-repo-inspect-operator-v1',
      agentId: 'agency-developer',
      toolId: 'repo.inspect',
      authorityLayer: 'operator',
      access: 'read',
      purpose: 'catalog_tool_access',
      sensitivityCap: 'confidential',
      expiresAt: '2026-08-21T00:00:00.000Z',
      expectedAgentVersion: 1,
      expectedScopeVersion: 1,
      issuedAt: '2026-07-21T00:30:00.000Z'
    });
    const operator = lifecycle.bindOperator(operatorSession);
    const result = await operator.replaceGrant({
      resourceKind: 'tool_grant',
      id: old.id,
      expectedVersion: old.version,
      reason: 'operator_grant_rotation',
      occurredAt,
      replacement: {
        id: 'tool-grant:agency-developer-repo-inspect-operator-v2',
        agentId: 'agency-developer',
        toolId: 'repo.inspect',
        authorityLayer: 'operator',
        access: 'read',
        purpose: 'catalog_tool_access',
        sensitivityCap: 'internal',
        expiresAt: '2026-09-21T00:00:00.000Z',
        expectedAgentVersion: 1,
        expectedScopeVersion: 1,
        issuedAt: occurredAt
      }
    });

    expect(result.current).toMatchObject({ id: old.id, state: 'revoked', version: 2 });
    expect(result.replacement).toMatchObject({
      id: 'tool-grant:agency-developer-repo-inspect-operator-v2',
      state: 'active',
      sensitivityCap: 'internal'
    });
    expect(result.evidence).toMatchObject({
      resourceKind: 'tool_grant',
      action: 'replaced'
    });
  });

  it('atomically replaces and revokes reviewed shared bundles with redacted operator evidence', async () => {
    const old = await repository.publishSharedApprovedBundle({
      id: 'shared-bundle:agency-handoff-v1',
      sourceScopeId: 'agency:agency',
      expectedSourceScopeVersion: 1,
      targetSleeveId: 'shared:jarvis_handoffs',
      expectedTargetScopeVersion: 1,
      expectedTargetSleeveVersion: 1,
      purpose: 'reviewed_handoff',
      publishedSensitivity: 'internal',
      fragments: [
        {
          id: 'fragment:agency-handoff-v1',
          sourceDocumentId: 'agency.result.v1',
          sourceVersion: 1,
          materializedText: 'Sensitive reviewed handoff text must not enter lifecycle evidence.',
          provenanceRef: 'evidence:agency-result-v1'
        }
      ],
      reviewedBy: 'operator:jack_hunter',
      reviewedAt: '2026-07-21T00:30:00.000Z',
      expiresAt: '2026-08-21T00:00:00.000Z'
    });
    const operator = lifecycle.bindOperator(operatorSession);
    const replacement = {
      id: 'shared-bundle:agency-handoff-v2',
      sourceScopeId: 'agency:agency',
      expectedSourceScopeVersion: 1,
      targetSleeveId: 'shared:jarvis_handoffs',
      expectedTargetScopeVersion: 1,
      expectedTargetSleeveVersion: 1,
      purpose: 'reviewed_handoff',
      publishedSensitivity: 'internal' as const,
      fragments: [
        {
          id: 'fragment:agency-handoff-v2',
          sourceDocumentId: 'agency.result.v2',
          sourceVersion: 2,
          materializedText: 'Replacement content remains only in the approved bundle table.',
          provenanceRef: 'evidence:agency-result-v2'
        }
      ],
      reviewedBy: 'operator:jack_hunter',
      reviewedAt: occurredAt,
      expiresAt: '2026-09-21T00:00:00.000Z'
    };

    const replaced = await operator.replaceSharedBundle({
      id: old.id,
      expectedVersion: old.version,
      reason: 'reviewed_handoff_superseded',
      occurredAt,
      replacement
    });
    expect(replaced.current).toMatchObject({ id: old.id, state: 'revoked', version: 2 });
    expect(replaced.replacement).toMatchObject({ id: replacement.id, state: 'active' });
    expect(JSON.stringify(replaced.evidence)).not.toContain('Replacement content');

    const revoked = await operator.revokeSharedBundle({
      id: replacement.id,
      expectedVersion: 1,
      reason: 'reviewed_handoff_withdrawn',
      occurredAt: '2026-07-21T02:00:00.000Z'
    });
    expect(revoked.current).toMatchObject({ id: replacement.id, state: 'revoked', version: 2 });
    const projection = await operator.project({ resourceKind: 'shared_bundle', limit: 10 });
    expect(projection.items.map(({ action }) => action)).toEqual(['revoked', 'replaced']);
  });
});
