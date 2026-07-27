import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTHORITY_LAYERS,
  type AuthorityLayer,
  type GrantVersionSet
} from '../../src/agents/access-control-contracts';
import { AccessControlRepository } from '../../src/agents/access-control-repository';
import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import { MemoryFragmentRepository } from '../../src/knowledge/memory-fragment-repository';
import { ScopedLexicalRetrievalService } from '../../src/knowledge/lexical-retrieval-service';

const projectRoot = join(__dirname, '..', '..');
const recordedAt = '2026-07-19T12:00:00.000Z';
const evaluatedAt = '2026-07-21T12:00:00.000Z';

function fragment(
  id: string,
  sleeveId: 'client:acme_corp' | 'client:beta_labs',
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    ownerScopeId: sleeveId,
    sleeveId,
    sourceId: `note:${id}`,
    sourceHash: createHash('sha256').update(id, 'utf8').digest('hex'),
    extractionVersion: 'markdown_v1',
    kind: 'fact',
    title: `Memory ${id}`,
    content: 'Quarterly close uses the cobalt reconciliation checklist.',
    tags: ['finance', 'close'],
    validFrom: recordedAt,
    validUntil: null,
    recordedAt,
    confidencePermille: 900,
    sensitivity: 'confidential',
    supersedesFragmentId: null,
    reviewAt: null,
    expiresAt: null,
    retrievalEligible: true,
    ...overrides
  };
}

describe('scoped SQLite lexical retrieval', () => {
  let temporaryRoot: string;
  let context: GlobalDatabaseContext;
  let access: AccessControlRepository;
  let acmeGrantVersions: GrantVersionSet;
  let fragments: MemoryFragmentRepository;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-retrieval-test-'));
    context = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    access = new AccessControlRepository(context.db, () => new Date(evaluatedAt));
    await access.registerScope({
      id: 'agency:agency',
      kind: 'agency',
      subjectId: 'agency',
      parentScopeId: null,
      trustDomain: 'agency',
      createdAt: recordedAt
    });
    await access.registerScope({
      id: 'client:acme_corp',
      kind: 'client',
      subjectId: 'acme_corp',
      parentScopeId: 'agency:agency',
      trustDomain: 'agency',
      createdAt: recordedAt
    });
    await access.registerScope({
      id: 'client:beta_labs',
      kind: 'client',
      subjectId: 'beta_labs',
      parentScopeId: 'agency:agency',
      trustDomain: 'agency',
      createdAt: recordedAt
    });
    await access.registerAgent({
      id: 'agency-developer',
      homeScopeId: 'agency:agency',
      trustDomain: 'agency',
      profileRevision: 1,
      createdAt: recordedAt
    });
    await access.registerSleeve({
      id: 'client:acme_corp',
      ownerScopeId: 'client:acme_corp',
      maxSensitivity: 'confidential',
      expiresAt: null,
      createdAt: recordedAt
    });
    await access.registerSleeve({
      id: 'client:beta_labs',
      ownerScopeId: 'client:beta_labs',
      maxSensitivity: 'confidential',
      expiresAt: null,
      createdAt: recordedAt
    });
    const versions = {} as Record<AuthorityLayer, number>;
    for (const layer of AUTHORITY_LAYERS) {
      const grant = await access.issueSleeveGrant({
        id: `sleeve-grant:agency-developer-acme-read-${layer}`,
        agentId: 'agency-developer',
        sleeveId: 'client:acme_corp',
        authorityLayer: layer,
        permission: 'read',
        purpose: 'retrieval_evaluation',
        sensitivityCap: 'confidential',
        expiresAt: '2026-08-21T12:00:00.000Z',
        expectedAgentVersion: 1,
        expectedScopeVersion: 1,
        expectedSleeveVersion: 1,
        issuedAt: recordedAt
      });
      versions[layer] = grant.version;
    }
    acmeGrantVersions = versions;
    fragments = new MemoryFragmentRepository(context.sqlite);
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  function acmeService() {
    return new ScopedLexicalRetrievalService(
      context.sqlite,
      access.bindAgent({ agentId: 'agency-developer', expectedAgentVersion: 1 })
    );
  }

  function authorization(
    sleeveId = 'client:acme_corp',
    grantVersions: GrantVersionSet = acmeGrantVersions,
    sensitivity: 'public' | 'internal' | 'confidential' = 'confidential'
  ) {
    return {
      sleeveId,
      expectedSleeveVersion: 1,
      expectedOwnerScopeVersion: 1,
      permission: 'read' as const,
      purpose: 'retrieval_evaluation',
      sensitivity,
      grantVersions
    };
  }

  it('creates the FTS5 index and idempotently stores strict typed fragments', async () => {
    const input = fragment('current_close', 'client:acme_corp');
    const first = await fragments.put(input);
    const second = await fragments.put(input);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      id: 'current_close',
      ownerScopeId: 'client:acme_corp',
      sleeveId: 'client:acme_corp',
      sourceId: 'note:current_close',
      supersededByFragmentId: null,
      retrievalEligible: true
    });
    const ftsTable = context.sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('memory_fragments_fts') as { sql: string } | undefined;
    expect(ftsTable?.sql).toContain('fts5');
    expect(
      context.sqlite.prepare('SELECT COUNT(*) AS count FROM memory_fragments_fts').get()
    ).toEqual({ count: 1 });

    await expect(
      fragments.put({ ...input, content: 'A conflicting rewrite under the same immutable ID.' })
    ).rejects.toMatchObject({ code: 'MEMORY_FRAGMENT_CONFLICT', statusCode: 409 });
    await expect(
      fragments.put({ ...input, id: 'unknown_key', credential: 'secret' })
    ).rejects.toThrow();
  });

  it('authorizes the exact principal scope before lookup and never returns another tenant', async () => {
    await fragments.put(fragment('acme_close', 'client:acme_corp'));
    await fragments.put(
      fragment('beta_close', 'client:beta_labs', {
        content: 'Beta cobalt close contains private payroll evidence.'
      })
    );

    const service = acmeService();
    const result = await service.query({
      authorization: authorization(),
      text: 'cobalt close',
      limit: 10
    });

    expect(result.items.map(({ id }) => id)).toEqual(['acme_close']);
    expect(result.items[0]).toMatchObject({
      ownerScopeId: 'client:acme_corp',
      sleeveId: 'client:acme_corp',
      sourceId: 'note:acme_close',
      selectionReason: 'lexical_bm25',
      rank: 1
    });
    expect(result.manifest).toMatchObject({
      algorithm: 'sqlite_fts5_bm25_v1',
      ownerScopeId: 'client:acme_corp',
      sleeveId: 'client:acme_corp',
      evaluatedAt,
      selected: [{ fragmentId: 'acme_close', sourceId: 'note:acme_close', reason: 'lexical_bm25' }]
    });
    expect(result.manifest.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest.queryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('beta_close');
    expect(JSON.stringify(result)).not.toContain('payroll evidence');

    await expect(
      service.query({
        authorization: authorization('client:beta_labs'),
        text: 'cobalt close',
        limit: 10
      })
    ).rejects.toMatchObject({ code: 'MEMORY_ACCESS_DENIED', statusCode: 403 });
    await expect(
      service.query({
        authorization: authorization('client:missing_client'),
        text: 'cobalt close',
        limit: 10
      })
    ).rejects.toMatchObject({ code: 'MEMORY_ACCESS_DENIED', statusCode: 403 });
  });

  it('excludes expired, disabled, not-yet-valid, ended, and superseded evidence', async () => {
    await fragments.put(
      fragment('old_close', 'client:acme_corp', {
        content: 'Cobalt close policy says use the retired worksheet.'
      })
    );
    await fragments.put(
      fragment('new_close', 'client:acme_corp', {
        content: 'Cobalt close policy says use the current reconciliation checklist.',
        supersedesFragmentId: 'old_close'
      })
    );
    await fragments.put(
      fragment('expired_close', 'client:acme_corp', {
        content: 'Cobalt close expired evidence.',
        expiresAt: '2026-07-20T12:00:00.000Z'
      })
    );
    await fragments.put(
      fragment('disabled_close', 'client:acme_corp', {
        content: 'Cobalt close disabled evidence.',
        retrievalEligible: false
      })
    );
    await fragments.put(
      fragment('future_close', 'client:acme_corp', {
        content: 'Cobalt close future evidence.',
        validFrom: '2026-07-22T12:00:00.000Z'
      })
    );
    await fragments.put(
      fragment('ended_close', 'client:acme_corp', {
        content: 'Cobalt close ended evidence.',
        validUntil: '2026-07-20T12:00:00.000Z'
      })
    );

    const result = await acmeService().query({
      authorization: authorization(),
      text: 'cobalt close',
      limit: 10
    });

    expect(result.items.map(({ id }) => id)).toEqual(['new_close']);
    expect(result.manifest.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fragmentId: 'old_close', reason: 'superseded' }),
        expect.objectContaining({ fragmentId: 'expired_close', reason: 'expired' }),
        expect.objectContaining({ fragmentId: 'disabled_close', reason: 'retrieval_disabled' }),
        expect.objectContaining({ fragmentId: 'future_close', reason: 'not_yet_valid' }),
        expect.objectContaining({ fragmentId: 'ended_close', reason: 'validity_ended' })
      ])
    );
    expect(result.manifest.omitted.every((entry) => !('content' in entry))).toBe(true);
  });

  it('uses deterministic BM25 ordering, bounded result omissions, and safe lexical parsing', async () => {
    await fragments.put(
      fragment('dense', 'client:acme_corp', {
        title: 'Cobalt cobalt close',
        content: 'Cobalt close cobalt reconciliation.'
      })
    );
    await fragments.put(
      fragment('sparse', 'client:acme_corp', {
        title: 'Close note',
        content: 'A cobalt reference.'
      })
    );

    const first = await acmeService().query({
      authorization: authorization(),
      text: 'cobalt OR "close" -private',
      limit: 1
    });
    const second = await acmeService().query({
      authorization: authorization(),
      text: 'cobalt OR "close" -private',
      limit: 1
    });

    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.id).toBe('dense');
    expect(first.items[0]?.bm25).toEqual(expect.any(Number));
    expect(first.manifest.omitted).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'result_limit' })])
    );
    expect(second).toEqual(first);

    await expect(
      acmeService().query({
        authorization: authorization(),
        text: '!!!',
        limit: 10
      })
    ).resolves.toMatchObject({ items: [], manifest: { selected: [], omitted: [] } });
  });

  it('enforces the authorized sensitivity cap inside the exact sleeve query', async () => {
    await fragments.put(
      fragment('public_close', 'client:acme_corp', {
        content: 'Cobalt close public checklist.',
        sensitivity: 'public'
      })
    );
    await fragments.put(
      fragment('confidential_close', 'client:acme_corp', {
        content: 'Cobalt close confidential payroll detail.',
        sensitivity: 'confidential'
      })
    );

    const result = await acmeService().query({
      authorization: authorization('client:acme_corp', acmeGrantVersions, 'internal'),
      text: 'cobalt close',
      limit: 10
    });

    expect(result.items.map(({ id }) => id)).toEqual(['public_close']);
    expect(JSON.stringify(result)).not.toContain('confidential_close');
    expect(JSON.stringify(result)).not.toContain('payroll detail');
    await expect(
      acmeService().query({
        authorization: { ...authorization(), permission: 'propose' },
        text: 'cobalt close',
        limit: 10
      })
    ).rejects.toThrow();
  });

  it('rejects invalid temporal metadata and cross-scope supersession', async () => {
    await fragments.put(fragment('beta_prior', 'client:beta_labs'));

    await expect(
      fragments.put(
        fragment('invalid_time', 'client:acme_corp', {
          validUntil: '2026-07-18T12:00:00.000Z'
        })
      )
    ).rejects.toThrow();
    await expect(
      fragments.put(
        fragment('acme_rewrite', 'client:acme_corp', {
          supersedesFragmentId: 'beta_prior'
        })
      )
    ).rejects.toMatchObject({ code: 'MEMORY_SUPERSESSION_FORBIDDEN', statusCode: 409 });
  });

  it('rejects unregistered sleeves, missing/self supersession, and conflicting revisions', async () => {
    await expect(
      fragments.put({
        ...fragment('missing_scope', 'client:acme_corp'),
        ownerScopeId: 'client:missing_client',
        sleeveId: 'client:missing_client'
      })
    ).rejects.toMatchObject({ code: 'MEMORY_SLEEVE_INVALID', statusCode: 409 });
    await expect(
      fragments.put(
        fragment('missing_revision', 'client:acme_corp', {
          supersedesFragmentId: 'never_indexed'
        })
      )
    ).rejects.toMatchObject({ code: 'MEMORY_SUPERSESSION_INVALID', statusCode: 409 });
    await expect(
      fragments.put(
        fragment('self_revision', 'client:acme_corp', {
          supersedesFragmentId: 'self_revision'
        })
      )
    ).rejects.toThrow();

    await fragments.put(fragment('revision_zero', 'client:acme_corp'));
    await fragments.put(
      fragment('revision_one', 'client:acme_corp', {
        supersedesFragmentId: 'revision_zero'
      })
    );
    await expect(
      fragments.put(
        fragment('revision_two', 'client:acme_corp', {
          supersedesFragmentId: 'revision_zero'
        })
      )
    ).rejects.toMatchObject({ code: 'MEMORY_SUPERSESSION_CONFLICT', statusCode: 409 });
  });

  it('rolls back if the supersession compare-and-set cannot commit', async () => {
    await fragments.put(fragment('race_old', 'client:acme_corp'));
    context.sqlite.exec(`
      CREATE TRIGGER suppress_test_supersession
      BEFORE UPDATE OF superseded_by_fragment_id ON memory_fragments
      WHEN old.fragment_id = 'race_old'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);

    await expect(
      fragments.put(fragment('race_new', 'client:acme_corp', { supersedesFragmentId: 'race_old' }))
    ).rejects.toMatchObject({ code: 'MEMORY_SUPERSESSION_CONFLICT', statusCode: 409 });
    expect(
      context.sqlite
        .prepare('SELECT fragment_id FROM memory_fragments WHERE fragment_id = ?')
        .get('race_new')
    ).toBeUndefined();
  });

  it('validates expiry, tag uniqueness, sensitivity caps, and principal registration', async () => {
    await expect(
      fragments.put(
        fragment('bad_expiry', 'client:acme_corp', {
          expiresAt: '2026-07-18T12:00:00.000Z'
        })
      )
    ).rejects.toThrow();
    await expect(
      fragments.put(fragment('bad_tags', 'client:acme_corp', { tags: ['close', 'close'] }))
    ).rejects.toThrow();
    await expect(
      fragments.put(fragment('too_sensitive', 'client:acme_corp', { sensitivity: 'restricted' }))
    ).rejects.toMatchObject({ code: 'MEMORY_SENSITIVITY_INVALID', statusCode: 409 });

    const invalidPrincipal = new ScopedLexicalRetrievalService(
      context.sqlite,
      access.bindAgent({ agentId: 'missing-agent', expectedAgentVersion: 1 })
    );
    await expect(
      invalidPrincipal.query({
        authorization: authorization(),
        text: 'cobalt close',
        limit: 10
      })
    ).rejects.toMatchObject({ code: 'MEMORY_ACCESS_DENIED', statusCode: 403 });
  });
});
