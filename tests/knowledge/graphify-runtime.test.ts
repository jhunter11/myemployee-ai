import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { KnowledgeScopeRecord } from '../../src/knowledge/contracts';
import {
  NodeGraphifyProcessRunner,
  ScopedGraphifyRuntime,
  type GraphifyProcessRequest,
  type GraphifyProcessResult,
  type GraphifyProcessRunner
} from '../../src/knowledge/graphify-runtime';

const createdAt = '2026-07-18T22:00:00.000Z';

function scope(
  kind: 'harness' | 'project' | 'client',
  subjectId: string,
  parentScopeId: KnowledgeScopeRecord['parentScopeId'] = null
): KnowledgeScopeRecord {
  return {
    id: `${kind}:${subjectId}`,
    kind,
    subjectId,
    parentScopeId,
    clientId: kind === 'client' ? subjectId : null,
    rootKey: `knowledge/${kind}/${subjectId}`,
    graphPartition: `graphify/${kind}/${subjectId}`,
    createdAt
  };
}

function success(stdout = ''): GraphifyProcessResult {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    signal: null,
    termination: null
  };
}

class FakeGraphifyRunner implements GraphifyProcessRunner {
  readonly requests: GraphifyProcessRequest[] = [];
  versionOutput = 'graphify 0.8.36\n';
  queryOutput = [
    "Traversal: BFS depth=2 | Start: ['Planner'] | 2 nodes found",
    '',
    'NODE Planner [src=/Users/operator/private/planner.ts loc=L9 community=7]',
    'NODE Worker [src=clients/acme_corp/private/worker.ts loc=L2 community=]',
    'EDGE Planner --calls [EXTRACTED context=call]--> Worker'
  ].join('\n');
  queryFailure: Error | undefined;

  async run(request: GraphifyProcessRequest): Promise<GraphifyProcessResult> {
    this.requests.push(request);
    if (request.args[0] === '--version') return success(this.versionOutput);

    if (request.args[0] === 'extract') {
      const outFlag = request.args.indexOf('--out');
      const outputRoot = request.args[outFlag + 1];
      if (outputRoot === undefined) throw new Error('missing test output root');
      const graphDirectory = join(outputRoot, 'graphify-out');
      await mkdir(graphDirectory, { recursive: true });
      await writeFile(
        join(graphDirectory, 'graph.json'),
        JSON.stringify({
          nodes: [
            {
              id: 'file:planner',
              label: 'Planner',
              source_file: '/Users/operator/private/planner.ts'
            }
          ],
          edges: []
        })
      );
      return success('[graphify extract] wrote a private graph\n');
    }

    if (request.args[0] === 'query') {
      if (this.queryFailure !== undefined) throw this.queryFailure;
      return success(this.queryOutput);
    }
    throw new Error(`unexpected fake command ${request.args[0] ?? ''}`);
  }
}

describe('scoped Graphify runtime', () => {
  let temporaryRoot: string;
  let executable: string;
  let executableSha256: string;
  let storageRoot: string;
  let sourceRoot: string;
  let projectSourceRoot: string;
  let clientRoot: string;
  let runner: FakeGraphifyRunner;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-graphify-runtime-'));
    executable = join(temporaryRoot, 'bin', 'graphify');
    storageRoot = join(temporaryRoot, 'state', 'graphs');
    sourceRoot = join(temporaryRoot, 'repository', 'src');
    projectSourceRoot = join(temporaryRoot, 'repository', 'project-code', 'ai-agency');
    clientRoot = join(temporaryRoot, 'repository', 'clients');
    await Promise.all([
      mkdir(dirname(executable), { recursive: true }),
      mkdir(sourceRoot, { recursive: true }),
      mkdir(projectSourceRoot, { recursive: true }),
      mkdir(join(clientRoot, 'acme_corp'), { recursive: true })
    ]);
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o755);
    executableSha256 = createHash('sha256')
      .update(await readFile(executable))
      .digest('hex');
    runner = new FakeGraphifyRunner();
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  function runtime(
    overrides: Partial<ConstructorParameters<typeof ScopedGraphifyRuntime>[0]> = {}
  ): ScopedGraphifyRuntime {
    return new ScopedGraphifyRuntime({
      executable,
      expectedVersion: '0.8.36',
      expectedExecutableSha256: executableSha256,
      storageRoot,
      clientRoot,
      bindings: [
        { scope: scope('harness', 'jarvis'), corpusRoot: sourceRoot },
        {
          scope: scope('project', 'ai_agency', 'harness:jarvis'),
          corpusRoot: projectSourceRoot
        },
        {
          scope: scope('client', 'acme_corp', 'project:ai_agency')
        }
      ],
      runner,
      now: () => createdAt,
      ...overrides
    });
  }

  it('builds separate private roots derived from registered partitions with fixed deterministic commands', async () => {
    const graphify = runtime();

    const harnessAudit = await graphify.index('graphify/harness/jarvis');
    const projectAudit = await graphify.index('graphify/project/ai_agency');
    const clientAudit = await graphify.index('graphify/client/acme_corp');

    expect(harnessAudit).toMatchObject({
      graphPartition: 'graphify/harness/jarvis',
      graphifyVersion: '0.8.36',
      nodes: 1,
      edges: 0,
      indexedAt: createdAt
    });
    expect(clientAudit).toMatchObject({
      graphPartition: 'graphify/client/acme_corp',
      graphifyVersion: '0.8.36',
      nodes: 1,
      edges: 0
    });
    expect(projectAudit).toMatchObject({
      graphPartition: 'graphify/project/ai_agency',
      graphifyVersion: '0.8.36',
      nodes: 1,
      edges: 0
    });
    expect(JSON.stringify([harnessAudit, projectAudit, clientAudit])).not.toContain(temporaryRoot);

    const extracts = runner.requests.filter((request) => request.args[0] === 'extract');
    expect(extracts).toHaveLength(3);
    const outputRoots = extracts.map((request) => {
      const index = request.args.indexOf('--out');
      return request.args[index + 1] ?? '';
    });
    expect(new Set(outputRoots).size).toBe(3);
    const canonicalStorage = await realpath(storageRoot);
    expect(
      outputRoots.every((root) => relative(canonicalStorage, root).startsWith('..') === false)
    ).toBe(true);
    const privateRelativeRoots = outputRoots.map((root) => relative(canonicalStorage, root));
    expect(privateRelativeRoots.join('\n')).not.toContain('jarvis');
    expect(privateRelativeRoots.join('\n')).not.toContain('acme_corp');

    expect(extracts.map((request) => request.args[1])).toEqual([
      await realpath(sourceRoot),
      await realpath(projectSourceRoot),
      await realpath(join(clientRoot, 'acme_corp'))
    ]);
    for (const request of extracts) {
      expect(request.args).toEqual(
        expect.arrayContaining(['extract', '--no-cluster', '--max-workers', '1'])
      );
      expect(request.args).not.toEqual(expect.arrayContaining(['--mcp', '--global', '--backend']));
      expect(request.env).toMatchObject({
        GRAPHIFY_QUERY_LOG_DISABLE: '1',
        GRAPHIFY_NO_TIPS: '1',
        PYTHONHASHSEED: '0',
        TZ: 'UTC'
      });
      expect(request.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(request.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(request.env).not.toHaveProperty('GEMINI_API_KEY');
      expect(request.env.HOME).toContain(storageRoot);
      expect(request.env.GRAPHIFY_OUT).toContain(storageRoot);
    }
    expect(new Set(extracts.map((request) => request.env.HOME)).size).toBe(3);
  });

  it('returns only bounded path-free graph records and never exposes the raw Graphify command', async () => {
    const graphify = runtime({ maxQueryOutputBytes: 8_192, maxExcerptCharacters: 180 });
    await graphify.index('graphify/client/acme_corp');

    const adapter = graphify.resolve('graphify/client/acme_corp');
    expect(adapter).toBeDefined();
    const items = await adapter?.query({
      graphPartition: 'graphify/client/acme_corp',
      text: '../../caller/project_path /Users/caller/other-repo',
      projection: 'content',
      limit: 2
    });

    expect(items).toHaveLength(2);
    expect(items?.[0]).toMatchObject({
      title: 'Planner',
      kind: 'symbol',
      tags: ['graphify', 'community_7'],
      excerpt: 'Planner calls Worker.'
    });
    expect(items?.[1]).toMatchObject({ title: 'Worker', tags: ['graphify'] });
    expect(JSON.stringify(items)).not.toContain('/Users');
    expect(JSON.stringify(items)).not.toContain('clients/acme_corp');
    expect(JSON.stringify(items)).not.toContain('project_path');
    expect(JSON.stringify(items)).not.toContain('--graph');
    expect(JSON.stringify(items)).not.toContain(executable);
    expect(
      items?.every((item) =>
        typeof item === 'object' && item !== null && 'excerpt' in item
          ? String(item.excerpt).length <= 180
          : true
      )
    ).toBe(true);

    const query = [...runner.requests]
      .reverse()
      .find((request: GraphifyProcessRequest) => request.args[0] === 'query');
    expect(query).toBeDefined();
    expect(query?.args[1]).toBe('../../caller/project_path /Users/caller/other-repo');
    expect(query?.args).toEqual(
      expect.arrayContaining(['--budget', expect.any(String), '--graph', expect.any(String)])
    );
    expect(query?.env.GRAPHIFY_QUERY_LOG_DISABLE).toBe('1');
    expect(query?.maxOutputBytes).toBe(8_192);
    expect(query?.args).not.toContain('--mcp');

    const graphFlag = query?.args.indexOf('--graph') ?? -1;
    const privateGraph = query?.args[graphFlag + 1];
    expect(privateGraph).toBeDefined();
    expect(privateGraph).not.toContain('acme_corp');
    const metadata = await lstat(privateGraph ?? '');
    expect(metadata.isFile()).toBe(true);
    expect(metadata.mode & 0o077).toBe(0);
  });

  it('resolves only exact registered partitions and keeps query logging disabled in isolation metadata', () => {
    const graphify = runtime();

    expect(graphify.resolve('graphify/client/acme_corp')?.isolation).toEqual({
      graphPartition: 'graphify/client/acme_corp',
      queryLogging: {
        mode: 'disabled',
        control: 'GRAPHIFY_QUERY_LOG_DISABLE=1'
      }
    });
    expect(graphify.resolve('graphify/project/ai_agency')?.isolation.graphPartition).toBe(
      'graphify/project/ai_agency'
    );
    expect(graphify.resolve('graphify/client/beta_labs')).toBeUndefined();
    expect(graphify.resolve('graphify/project/task_market')).toBeUndefined();
  });

  it('derives an exact client corpus and fails closed on symlinks or cross-scope corpus overlap', async () => {
    const external = join(temporaryRoot, 'external-private');
    await mkdir(external);
    await symlink(external, join(clientRoot, 'acme_corp', 'escape'));

    await expect(runtime().index('graphify/client/acme_corp')).rejects.toMatchObject({
      code: 'GRAPHIFY_CORPUS_INVALID',
      statusCode: 503,
      message: 'Scoped Graphify corpus is unavailable'
    });
    expect(runner.requests.some((request) => request.args[0] === 'extract')).toBe(false);

    expect(
      () =>
        new ScopedGraphifyRuntime({
          executable,
          expectedVersion: '0.8.36',
          expectedExecutableSha256: executableSha256,
          storageRoot,
          clientRoot,
          bindings: [
            {
              scope: scope('client', 'acme_corp', 'project:ai_agency'),
              corpusRoot: external
            }
          ],
          runner
        })
    ).toThrow();

    const overlapping = runtime({
      bindings: [{ scope: scope('harness', 'jarvis'), corpusRoot: dirname(clientRoot) }]
    });
    await expect(overlapping.index('graphify/harness/jarvis')).rejects.toMatchObject({
      code: 'GRAPHIFY_CORPUS_INVALID',
      statusCode: 503
    });
  });

  it('audits the executable identity and exact version without returning its path', async () => {
    const graphify = runtime();

    await expect(graphify.audit()).resolves.toEqual({
      runtime: 'graphify',
      version: '0.8.36',
      executableSha256,
      checkedAt: createdAt,
      queryLogging: 'disabled'
    });
    expect(JSON.stringify(await graphify.audit())).not.toContain(temporaryRoot);

    runner.versionOutput = 'graphify 0.9.20\n';
    const wrongVersion = await graphify.audit().catch((error: unknown) => error);
    expect(wrongVersion).toMatchObject({
      code: 'GRAPHIFY_VERSION_MISMATCH',
      statusCode: 503,
      message: 'Scoped Graphify runtime version is not approved'
    });
    expect(JSON.stringify(wrongVersion)).not.toContain(executable);

    const wrongDigest = runtime({ expectedExecutableSha256: '0'.repeat(64) });
    await expect(wrongDigest.audit()).rejects.toMatchObject({
      code: 'GRAPHIFY_EXECUTABLE_MISMATCH',
      statusCode: 503
    });
  });

  it('fails closed for unavailable indexes, oversized output, and path-bearing process failures', async () => {
    const graphify = runtime({ maxQueryOutputBytes: 512 });
    const adapter = graphify.resolve('graphify/client/acme_corp');

    await expect(
      adapter?.query({
        graphPartition: 'graphify/client/acme_corp',
        text: 'worker',
        projection: 'metadata',
        limit: 2
      })
    ).rejects.toMatchObject({
      code: 'GRAPHIFY_INDEX_UNAVAILABLE',
      message: 'Scoped Graphify index is unavailable'
    });

    await graphify.index('graphify/client/acme_corp');
    runner.queryOutput = 'x'.repeat(513);
    await expect(
      adapter?.query({
        graphPartition: 'graphify/client/acme_corp',
        text: 'worker',
        projection: 'content',
        limit: 2
      })
    ).rejects.toMatchObject({ code: 'GRAPHIFY_QUERY_OUTPUT_INVALID', statusCode: 502 });

    runner.queryOutput = 'NODE Worker [src=worker.ts loc=L1 community=1]';
    runner.queryFailure = new Error(
      'failed argv --graph /Users/operator/clients/acme_corp private customer secret'
    );
    const failure = await adapter
      ?.query({
        graphPartition: 'graphify/client/acme_corp',
        text: 'worker',
        projection: 'metadata',
        limit: 2
      })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'GRAPHIFY_QUERY_FAILED',
      statusCode: 502,
      message: 'Scoped Graphify query failed'
    });
    expect(JSON.stringify(failure)).not.toContain('/Users/operator');
    expect(JSON.stringify(failure)).not.toContain('private customer secret');
    expect(JSON.stringify(failure)).not.toContain('--graph');
  });

  it('bounds and times out the production process runner without invoking a shell', async () => {
    const processRunner = new NodeGraphifyProcessRunner();
    const environment = {
      HOME: temporaryRoot,
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
      TMPDIR: temporaryRoot
    };

    const oversized = await processRunner.run({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(4096))"],
      cwd: temporaryRoot,
      env: environment,
      timeoutMs: 2_000,
      maxOutputBytes: 128
    });
    expect(oversized).toMatchObject({ termination: 'output_limit' });
    expect(oversized.stdout.length + oversized.stderr.length).toBeLessThanOrEqual(128);

    const timedOut = await processRunner.run({
      executable: process.execPath,
      args: ['-e', 'for (;;) {}'],
      cwd: temporaryRoot,
      env: environment,
      timeoutMs: 25,
      maxOutputBytes: 128
    });
    expect(timedOut).toMatchObject({ termination: 'timeout' });
  });
});
