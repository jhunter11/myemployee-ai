import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClientRepository } from '../../src/db/client-repository';
import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import {
  type KnowledgeAdapterQuery,
  type KnowledgeGraphPartition,
  type KnowledgePrincipal,
  type ScopedKnowledgeAdapter,
  type ScopedKnowledgeAdapterResolver
} from '../../src/knowledge/contracts';
import { KnowledgeQueryService } from '../../src/knowledge/query-service';
import { KnowledgeScopeRepository } from '../../src/knowledge/scope-repository';
import { AppError } from '../../src/utils/errors';

const projectRoot = join(__dirname, '..', '..');
const createdAt = '2026-07-18T20:00:00.000Z';

class RecordingAdapter implements ScopedKnowledgeAdapter {
  readonly isolation;
  readonly query = vi.fn<(input: KnowledgeAdapterQuery) => Promise<readonly unknown[]>>();

  constructor(graphPartition: KnowledgeGraphPartition = 'graphify/client/acme_corp') {
    this.isolation = {
      graphPartition,
      queryLogging: {
        mode: 'disabled' as const,
        control: 'GRAPHIFY_QUERY_LOG_DISABLE=1' as const
      }
    };
  }
}

class RecordingResolver implements ScopedKnowledgeAdapterResolver {
  readonly resolve = vi.fn(() => this.adapter);

  constructor(readonly adapter: RecordingAdapter) {}
}

describe('hierarchy-scoped knowledge', () => {
  let temporaryRoot: string;
  let context: GlobalDatabaseContext;
  let scopes: KnowledgeScopeRepository;
  let adapter: RecordingAdapter;
  let resolver: RecordingResolver;

  function serviceFor(principal: KnowledgePrincipal): KnowledgeQueryService {
    return new KnowledgeQueryService(scopes, resolver, principal);
  }

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-knowledge-test-'));
    context = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    scopes = new KnowledgeScopeRepository(context.db);
    adapter = new RecordingAdapter();
    resolver = new RecordingResolver(adapter);

    const clients = new ClientRepository(context.db);
    await clients.create({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing',
      status: 'active',
      createdAt
    });
    await clients.create({
      id: 'beta_labs',
      name: 'Beta Labs',
      profile: 'data_processing',
      status: 'active',
      createdAt
    });
    await clients.create({
      id: 'gamma_labs',
      name: 'Gamma Labs',
      profile: 'data_processing',
      status: 'active',
      createdAt
    });

    await scopes.register({ kind: 'harness', subjectId: 'jarvis', createdAt });
    await scopes.register({
      kind: 'project',
      subjectId: 'ai_agency',
      parentScopeId: 'harness:jarvis',
      createdAt
    });
    await scopes.register({
      kind: 'project',
      subjectId: 'task_market',
      parentScopeId: 'harness:jarvis',
      createdAt
    });
    await scopes.register({
      kind: 'client',
      clientId: 'acme_corp',
      parentScopeId: 'project:ai_agency',
      createdAt
    });
    await scopes.register({
      kind: 'client',
      clientId: 'beta_labs',
      parentScopeId: 'project:ai_agency',
      createdAt
    });
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('derives strict logical roots and distinct Graphify partitions without physical paths', async () => {
    await expect(scopes.findById('harness:jarvis')).resolves.toMatchObject({
      id: 'harness:jarvis',
      kind: 'harness',
      rootKey: 'knowledge/harness/jarvis',
      graphPartition: 'graphify/harness/jarvis',
      parentScopeId: null,
      clientId: null
    });
    await expect(scopes.findById('project:ai_agency')).resolves.toMatchObject({
      rootKey: 'knowledge/project/ai_agency',
      graphPartition: 'graphify/project/ai_agency',
      parentScopeId: 'harness:jarvis'
    });
    await expect(scopes.findById('client:acme_corp')).resolves.toMatchObject({
      rootKey: 'knowledge/client/acme_corp',
      graphPartition: 'graphify/client/acme_corp',
      parentScopeId: 'project:ai_agency',
      clientId: 'acme_corp'
    });

    const columns = context.sqlite.prepare('PRAGMA table_info(knowledge_scopes)').all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).not.toContain('project_path');
    expect(columns.map((column) => column.name)).not.toContain('filesystem_path');
  });

  it('lists the two project lanes and their clients as a bounded hierarchy', async () => {
    await expect(scopes.listChildren('harness:jarvis')).resolves.toMatchObject([
      { id: 'project:ai_agency', parentScopeId: 'harness:jarvis' },
      { id: 'project:task_market', parentScopeId: 'harness:jarvis' }
    ]);
    await expect(scopes.listChildren('project:ai_agency')).resolves.toMatchObject([
      { id: 'client:acme_corp', parentScopeId: 'project:ai_agency' },
      { id: 'client:beta_labs', parentScopeId: 'project:ai_agency' }
    ]);
    await expect(scopes.listChildren('harness:jarvis', 0)).rejects.toBeInstanceOf(RangeError);
  });

  it('is idempotent for an exact registration and rejects hierarchy conflicts', async () => {
    const input = {
      kind: 'project' as const,
      subjectId: 'ai_agency',
      parentScopeId: 'harness:jarvis' as const,
      createdAt
    };

    const existing = await scopes.register(input);
    await expect(scopes.register(input)).resolves.toEqual(existing);
    await expect(
      scopes.register({ ...input, parentScopeId: 'harness:missing' })
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_SCOPE_CONFLICT', statusCode: 409 });

    await expect(
      scopes.register({
        kind: 'project',
        subjectId: '../escape',
        parentScopeId: 'harness:jarvis',
        createdAt,
        projectPath: '/Users/operator/private'
      } as never)
    ).rejects.toThrow();
  });

  it('enforces deterministic logical roots against direct database writes', () => {
    const update = context.sqlite.prepare(
      'UPDATE knowledge_scopes SET root_key = ?, graph_partition = ? WHERE scope_id = ?'
    );

    expect(() =>
      update.run(
        '/Users/operator/ai-agency-jarvis',
        'graphify/client/acme_corp',
        'client:acme_corp'
      )
    ).toThrow();
    expect(() =>
      update.run('knowledge/client/acme_corp', '../shared-graph', 'client:acme_corp')
    ).toThrow();
  });

  it('rejects invalid parents and client identities before creating a scope', async () => {
    await expect(
      scopes.register({
        kind: 'project',
        subjectId: 'orphan_project',
        parentScopeId: 'harness:missing',
        createdAt
      })
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_PARENT_INVALID', statusCode: 409 });
    await expect(
      scopes.register({
        kind: 'client',
        clientId: 'missing_client',
        parentScopeId: 'project:ai_agency',
        createdAt
      })
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_CLIENT_INVALID', statusCode: 409 });
    await expect(
      scopes.register({
        kind: 'client',
        clientId: 'gamma_labs',
        parentScopeId: 'harness:jarvis',
        createdAt
      })
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_PARENT_INVALID', statusCode: 409 });
  });

  it('lets a client query only its exact partition and returns a bounded, redacted excerpt', async () => {
    adapter.query.mockResolvedValue([
      {
        documentId: 'runbook_001',
        title: 'Daily report runbook',
        kind: 'runbook',
        updatedAt: createdAt,
        score: 0.91,
        tags: ['automation'],
        excerpt: 'Only this client can read this excerpt.',
        content: 'unbounded private content',
        sourcePath: '/Users/operator/clients/acme_corp/runbook.md',
        metadata: { secret: 'must-not-escape' }
      }
    ]);

    const result = await serviceFor({ kind: 'client', scopeId: 'client:acme_corp' }).query({
      scopeId: 'client:acme_corp',
      text: 'daily report',
      projection: 'content',
      limit: 5
    });

    expect(resolver.resolve).toHaveBeenCalledWith('graphify/client/acme_corp');
    expect(adapter.query).toHaveBeenCalledWith({
      graphPartition: 'graphify/client/acme_corp',
      text: 'daily report',
      projection: 'content',
      limit: 5
    });
    expect(result).toEqual({
      scopeId: 'client:acme_corp',
      projection: 'content',
      redacted: false,
      items: [
        {
          documentId: 'runbook_001',
          title: 'Daily report runbook',
          kind: 'runbook',
          updatedAt: createdAt,
          score: 0.91,
          tags: ['automation'],
          excerpt: 'Only this client can read this excerpt.'
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain('/Users/operator');
    expect(JSON.stringify(result)).not.toContain('must-not-escape');
    expect(JSON.stringify(result)).not.toContain('unbounded private content');
  });

  it.each([
    'harness:jarvis',
    'project:ai_agency',
    'client:beta_labs',
    'project:task_market'
  ] as const)('denies a client query selecting %s before resolving an adapter', async (scopeId) => {
    await expect(
      serviceFor({ kind: 'client', scopeId: 'client:acme_corp' }).query({
        scopeId,
        text: 'anything',
        projection: 'metadata',
        limit: 5
      })
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_SCOPE_FORBIDDEN', statusCode: 403 });

    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(adapter.query).not.toHaveBeenCalled();
  });

  it('downgrades ancestor queries to metadata and redacts content-shaped adapter fields', async () => {
    adapter.query.mockResolvedValue([
      {
        documentId: 'module_001',
        title: 'Worker module',
        kind: 'code',
        updatedAt: createdAt,
        score: 0.8,
        tags: ['worker'],
        excerpt: 'private child content',
        content: 'more private content',
        sourcePath: '/private/repository/src/worker.ts'
      }
    ]);

    const result = await serviceFor({ kind: 'harness', scopeId: 'harness:jarvis' }).query({
      scopeId: 'client:acme_corp',
      text: 'worker module',
      projection: 'content',
      limit: 5
    });

    expect(adapter.query).toHaveBeenCalledWith(expect.objectContaining({ projection: 'metadata' }));
    expect(result).toEqual({
      scopeId: 'client:acme_corp',
      projection: 'metadata',
      redacted: true,
      items: [
        {
          documentId: 'module_001',
          title: 'Worker module',
          kind: 'code',
          updatedAt: createdAt,
          score: 0.8,
          tags: ['worker']
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('permits a project to inspect direct client metadata but denies sibling projects', async () => {
    adapter.query.mockResolvedValue([]);

    await expect(
      serviceFor({ kind: 'project', scopeId: 'project:ai_agency' }).query({
        scopeId: 'client:acme_corp',
        text: 'status',
        projection: 'metadata',
        limit: 5
      })
    ).resolves.toMatchObject({ projection: 'metadata', redacted: true });

    resolver.resolve.mockClear();
    await expect(
      serviceFor({ kind: 'project', scopeId: 'project:ai_agency' }).query({
        scopeId: 'project:task_market',
        text: 'status',
        projection: 'metadata',
        limit: 5
      })
    ).rejects.toBeInstanceOf(AppError);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('rejects a forged principal kind and malformed adapter records', async () => {
    await expect(
      serviceFor({ kind: 'harness', scopeId: 'client:acme_corp' }).query({
        scopeId: 'client:acme_corp',
        text: 'secrets',
        projection: 'content',
        limit: 5
      })
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_PRINCIPAL_INVALID', statusCode: 403 });

    adapter.query.mockResolvedValue([
      {
        documentId: '../unsafe/path',
        title: 'Unsafe',
        kind: 'code',
        updatedAt: createdAt,
        score: 1,
        excerpt: 'content'
      }
    ]);
    await expect(
      serviceFor({ kind: 'client', scopeId: 'client:acme_corp' }).query({
        scopeId: 'client:acme_corp',
        text: 'unsafe',
        projection: 'content',
        limit: 5
      })
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_ADAPTER_INVALID', statusCode: 502 });
  });

  it('rejects query-time physical paths and reports missing partition adapters honestly', async () => {
    await expect(
      serviceFor({ kind: 'client', scopeId: 'client:acme_corp' }).query({
        scopeId: 'client:acme_corp',
        text: 'unsafe request',
        projection: 'metadata',
        limit: 5,
        projectPath: '/Users/operator/ai-agency-jarvis'
      } as never)
    ).rejects.toThrow();
    expect(resolver.resolve).not.toHaveBeenCalled();

    const unavailable = new KnowledgeQueryService(
      scopes,
      { resolve: () => undefined },
      { kind: 'client', scopeId: 'client:acme_corp' }
    );
    await expect(
      unavailable.query({
        scopeId: 'client:acme_corp',
        text: 'valid request',
        projection: 'metadata',
        limit: 5
      })
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_ADAPTER_UNAVAILABLE', statusCode: 503 });
  });

  it('rejects a client adapter bound to the shared harness graph before querying it', async () => {
    const harnessAdapter = new RecordingAdapter('graphify/harness/jarvis');
    const mismatched = new KnowledgeQueryService(
      scopes,
      { resolve: () => harnessAdapter },
      { kind: 'client', scopeId: 'client:acme_corp' }
    );

    await expect(
      mismatched.query({
        scopeId: 'client:acme_corp',
        text: 'client-only code',
        projection: 'metadata',
        limit: 5
      })
    ).rejects.toMatchObject({
      code: 'KNOWLEDGE_ADAPTER_ISOLATION_INVALID',
      statusCode: 503
    });
    expect(harnessAdapter.query).not.toHaveBeenCalled();
  });

  it('requires an explicit safe Graphify query-log control', async () => {
    const query = vi.fn<ScopedKnowledgeAdapter['query']>();
    const unsafeAdapter = {
      isolation: {
        graphPartition: 'graphify/client/acme_corp',
        queryLogging: { mode: 'disabled' }
      },
      query
    } as unknown as ScopedKnowledgeAdapter;
    const unsafe = new KnowledgeQueryService(
      scopes,
      { resolve: () => unsafeAdapter },
      { kind: 'client', scopeId: 'client:acme_corp' }
    );

    await expect(
      unsafe.query({
        scopeId: 'client:acme_corp',
        text: 'client-only code',
        projection: 'metadata',
        limit: 5
      })
    ).rejects.toMatchObject({
      code: 'KNOWLEDGE_ADAPTER_ISOLATION_INVALID',
      statusCode: 503
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('redacts adapter failures that contain paths or tenant content', async () => {
    adapter.query.mockRejectedValue(
      new Error('Graph failed for /Users/operator/clients/acme_corp: private customer secret')
    );

    const failure = serviceFor({ kind: 'client', scopeId: 'client:acme_corp' }).query({
      scopeId: 'client:acme_corp',
      text: 'client-only code',
      projection: 'metadata',
      limit: 5
    });
    const error = await failure.catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: 'KNOWLEDGE_QUERY_FAILED',
      statusCode: 502,
      message: 'Scoped knowledge query failed'
    });
    expect(JSON.stringify(error)).not.toContain('/Users/operator');
    expect(JSON.stringify(error)).not.toContain('private customer secret');
  });
});
