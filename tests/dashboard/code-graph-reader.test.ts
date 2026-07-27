import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DashboardCodeGraphReader } from '../../src/dashboard/code-graph-reader';

const builtCommit = 'a'.repeat(40);
const currentCommit = 'b'.repeat(40);
const execFile = promisify(execFileCallback);

function node(
  id: string,
  label: string,
  sourceFile: string,
  sourceLocation: string,
  community: number
) {
  return {
    label,
    file_type: 'code',
    source_file: sourceFile,
    source_location: sourceLocation,
    _origin: 'ast',
    id,
    community,
    norm_label: label.toLowerCase()
  };
}

function link(
  source: string,
  target: string,
  relation: string,
  confidence: 'EXTRACTED' | 'INFERRED' = 'EXTRACTED'
) {
  return {
    relation,
    confidence,
    source_file: 'dashboard/routes.ts',
    source_location: 'L12',
    weight: 1,
    source,
    target,
    confidence_score: confidence === 'EXTRACTED' ? 1 : 0.8,
    context: 'raw Graphify context must never cross the dashboard boundary'
  };
}

function graphifyFixture(overrides: Record<string, unknown> = {}) {
  return {
    directed: false,
    multigraph: false,
    graph: {},
    nodes: [
      node('dashboard_routes', 'routes.ts', 'dashboard/routes.ts', 'L1', 2),
      node('dashboard_routes_install', 'installDashboardRoutes', 'dashboard/routes.ts', 'L12', 2)
    ],
    links: [
      link('dashboard_routes', 'dashboard_routes_install', 'contains'),
      link('dashboard_routes_install', 'dashboard_routes', 'references', 'INFERRED')
    ],
    hyperedges: [],
    built_at_commit: builtCommit,
    ...overrides
  };
}

describe('dashboard Graphify code graph reader', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'jarvis-code-graph-'));
    await mkdir(join(projectRoot, 'graphify-out'), { recursive: true });
    await mkdir(join(projectRoot, '.git', 'refs', 'heads'), { recursive: true });
    await writeFile(join(projectRoot, '.git', 'HEAD'), 'ref: refs/heads/test\n');
    await writeFile(join(projectRoot, '.git', 'refs', 'heads', 'test'), `${currentCommit}\n`);
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function writeGraph(value: unknown): Promise<void> {
    await writeFile(join(projectRoot, 'graphify-out', 'graph.json'), `${JSON.stringify(value)}\n`);
  }

  it('projects only bounded structural AST data and reports revision drift', async () => {
    await writeGraph(graphifyFixture());

    const snapshot = await new DashboardCodeGraphReader({ projectRoot }).read();

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      source: 'graphify',
      scope: 'harness',
      builtAtCommit: builtCommit,
      currentCommit,
      revisionStatus: 'stale',
      totalNodeCount: 2,
      totalEdgeCount: 2,
      omittedNonStructuralEdgeCount: 1,
      nodes: [
        {
          id: 'dashboard_routes',
          title: 'routes.ts',
          type: 'code',
          path: 'src/dashboard/routes.ts',
          line: 1,
          community: 2
        },
        {
          id: 'dashboard_routes_install',
          title: 'installDashboardRoutes',
          type: 'code',
          path: 'src/dashboard/routes.ts',
          line: 12,
          community: 2
        }
      ],
      edges: [
        {
          from: 'dashboard_routes',
          to: 'dashboard_routes_install',
          relation: 'contains'
        }
      ]
    });
    expect(snapshot.indexedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(projectRoot);
    expect(serialized).not.toContain('context');
    expect(serialized).not.toContain('confidence');
    expect(serialized).not.toContain('_origin');
    expect(serialized).not.toContain('norm_label');
  });

  it.each([
    [
      'duplicate node IDs',
      graphifyFixture({
        nodes: [node('same', 'A', 'a.ts', 'L1', 1), node('same', 'B', 'b.ts', 'L2', 1)]
      })
    ],
    [
      'dangling adjacency',
      graphifyFixture({ links: [link('dashboard_routes', 'missing', 'calls')] })
    ],
    [
      'path traversal',
      graphifyFixture({
        nodes: [node('bad', 'Bad', '../clients/acme/secret.ts', 'L1', 1)],
        links: []
      })
    ],
    [
      'absolute paths',
      graphifyFixture({ nodes: [node('bad', 'Bad', '/tmp/private.ts', 'L1', 1)], links: [] })
    ],
    ['unknown raw fields', { ...graphifyFixture(), project_path: '/private/repository' }]
  ])('fails closed for %s', async (_label, fixture) => {
    await writeGraph(fixture);

    await expect(new DashboardCodeGraphReader({ projectRoot }).read()).rejects.toMatchObject({
      statusCode: 503,
      code: 'DASHBOARD_CODE_GRAPH_UNAVAILABLE',
      message: 'The harness code graph is unavailable'
    });
  });

  it('rejects a symlinked artifact instead of following it', async () => {
    const outside = join(projectRoot, 'outside.json');
    await writeFile(outside, JSON.stringify(graphifyFixture()));
    await symlink(outside, join(projectRoot, 'graphify-out', 'graph.json'));

    await expect(new DashboardCodeGraphReader({ projectRoot }).read()).rejects.toMatchObject({
      statusCode: 503,
      code: 'DASHBOARD_CODE_GRAPH_UNAVAILABLE'
    });
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a FIFO artifact without waiting for a writer',
    async () => {
      const graphPath = join(projectRoot, 'graphify-out', 'graph.json');
      await execFile('mkfifo', [graphPath]);
      const readResult = new DashboardCodeGraphReader({ projectRoot }).read().then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error })
      );
      const first = await Promise.race([
        readResult,
        delay(150).then(() => ({ kind: 'timeout' as const }))
      ]);

      try {
        expect(first).toMatchObject({
          kind: 'rejected',
          error: {
            statusCode: 503,
            code: 'DASHBOARD_CODE_GRAPH_UNAVAILABLE'
          }
        });
      } finally {
        if (first.kind === 'timeout') {
          const unblockWriter = writeFile(graphPath, 'unblock').catch(() => undefined);
          await Promise.allSettled([unblockWriter, readResult]);
        }
      }
    }
  );

  it('reports a missing optional artifact without exposing its path', async () => {
    const error = await new DashboardCodeGraphReader({ projectRoot })
      .read()
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      statusCode: 503,
      code: 'DASHBOARD_CODE_GRAPH_UNAVAILABLE',
      message: 'The harness code graph is unavailable'
    });
    expect(JSON.stringify(error)).not.toContain(projectRoot);
  });
});
