import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OperatorPageSpec } from '../../src/dashboard/contracts';
import { MarkdownGraph } from '../../src/memory/markdown-graph';

const now = '2026-07-18T17:00:00.000Z';

function page(overrides: Partial<OperatorPageSpec> = {}): OperatorPageSpec {
  return {
    version: 1,
    slug: 'client-health',
    title: 'Client Health',
    request: 'Create a client health page for operations',
    widgets: ['health', 'clients'],
    createdAt: now,
    planFingerprint: 'a'.repeat(64),
    ...overrides
  };
}

describe('MarkdownGraph operator pages', () => {
  let temporaryRoot: string;
  let graphRoot: string;
  let graph: MarkdownGraph;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-operator-pages-'));
    graphRoot = join(temporaryRoot, 'memory', 'graph');
    graph = new MarkdownGraph({ graphRoot, now: () => now });
    await graph.initialize();
    await graph.rebuild();
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('publishes a validated Obsidian-compatible page and rebuilds its adjacency', async () => {
    const created = await graph.createOperatorPage(page());

    expect(created).toEqual({ created: true, page: page() });
    await expect(graph.listOperatorPages()).resolves.toEqual([page()]);
    const note = await readFile(join(graphRoot, 'pages', 'client-health.md'), 'utf8');
    expect(note).toContain('id: "pages/client-health"');
    expect(note).toContain('type: "operator-page"');
    expect(note).toContain('dashboard_manifest: {');
    expect(note).toContain('Parent: [[pages/index]]');
    expect(note).not.toContain('<script>');

    const index = await graph.readIndex();
    expect(index.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'pages/index', type: 'index' }),
        expect.objectContaining({ id: 'pages/client-health', type: 'operator-page' })
      ])
    );
    expect(index.edges).toEqual(
      expect.arrayContaining([
        { from: 'index', to: 'pages/index' },
        { from: 'pages/index', to: 'pages/client-health' },
        { from: 'pages/client-health', to: 'pages/index' }
      ])
    );
  });

  it('makes equal retries idempotent and rejects a different plan for the same slug', async () => {
    await graph.createOperatorPage(page());

    await expect(graph.createOperatorPage(page())).resolves.toEqual({
      created: false,
      page: page()
    });
    await expect(
      graph.createOperatorPage(
        page({ request: 'Create a different client health page', planFingerprint: 'b'.repeat(64) })
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'DASHBOARD_PAGE_EXISTS' });
  });

  it('rolls back a new page when graph publication fails after the note and index change', async () => {
    const before = await graph.readIndex();
    const injected = new Error('injected graph rebuild failure');
    const internals = graph as unknown as { rebuildUnlocked(): Promise<unknown> };
    internals.rebuildUnlocked = () => Promise.reject(injected);

    await expect(graph.createOperatorPage(page())).rejects.toBe(injected);
    await expect(
      readFile(join(graphRoot, 'pages', 'client-health.md'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(graph.listOperatorPages()).resolves.toEqual([]);
    await expect(graph.readIndex()).resolves.toEqual(before);
    await expect(readdir(join(graphRoot, '.transactions'))).resolves.toEqual([]);
  });

  it.each(['page-written', 'index-linked'] as const)(
    'recovers a durable %s publication journal on initialization',
    async (crashPoint) => {
      const graphIndexBeforePage = await readFile(join(graphRoot, 'graph.json'), 'utf8');
      const rootIndexBeforePage = await readFile(join(graphRoot, 'index.md'), 'utf8');
      await graph.createOperatorPage(page());

      if (crashPoint === 'page-written') {
        await writeFile(join(graphRoot, 'index.md'), rootIndexBeforePage);
        await rm(join(graphRoot, 'pages', 'index.md'));
      }
      await writeFile(join(graphRoot, 'graph.json'), graphIndexBeforePage);
      const transactionRoot = join(graphRoot, '.transactions');
      await mkdir(transactionRoot, { recursive: true });
      await writeFile(
        join(transactionRoot, 'operator-page-client-health.json'),
        `${JSON.stringify({ version: 1, operation: 'create_operator_page', page: page() })}\n`
      );

      const recovered = new MarkdownGraph({ graphRoot, now: () => now });
      await recovered.initialize();

      await expect(recovered.listOperatorPages()).resolves.toEqual([page()]);
      const index = await recovered.readIndex();
      expect(index.nodes.map((node) => node.id)).toEqual(
        expect.arrayContaining(['pages/index', 'pages/client-health'])
      );
      expect(index.edges).toEqual(
        expect.arrayContaining([
          { from: 'index', to: 'pages/index' },
          { from: 'pages/index', to: 'pages/client-health' }
        ])
      );
      await expect(readdir(transactionRoot)).resolves.toEqual([]);
    }
  );

  it('removes abandoned atomic-write temporaries before scanning publication journals', async () => {
    const transactionRoot = join(graphRoot, '.transactions');
    await mkdir(transactionRoot, { recursive: true });
    await writeFile(join(transactionRoot, '.operator-page-client-health.json.abcd.tmp'), 'partial');

    await graph.initialize();

    await expect(readdir(transactionRoot)).resolves.toEqual([]);
  });

  it.each([
    ['malformed JSON', 'operator-page-client-health.json', '{not-json'],
    [
      'a mismatched filename',
      'operator-page-other-page.json',
      JSON.stringify({ version: 1, operation: 'create_operator_page', page: page() })
    ]
  ])('fails closed on %s in the publication journal', async (_label, filename, content) => {
    const transactionRoot = join(graphRoot, '.transactions');
    await mkdir(transactionRoot, { recursive: true });
    await writeFile(join(transactionRoot, filename), content);

    await expect(graph.initialize()).rejects.toMatchObject({
      statusCode: 500,
      code: 'INVALID_OPERATOR_PAGE_TRANSACTION'
    });
  });

  it('rejects invalid manifests and symlink traversal before publication', async () => {
    await expect(graph.createOperatorPage({ ...page(), slug: '../escape' })).rejects.toBeDefined();

    const outside = join(temporaryRoot, 'outside-pages');
    await mkdir(outside);
    await symlink(outside, join(graphRoot, 'pages'), 'dir');
    await expect(graph.createOperatorPage(page())).rejects.toMatchObject({
      statusCode: 400,
      code: 'UNSAFE_MEMORY_PATH'
    });
  });

  it('fails closed when the generated graph index is malformed', async () => {
    await writeFile(join(graphRoot, 'graph.json'), '{"nodes":"not-an-array"}\n');

    await expect(graph.readIndex()).rejects.toMatchObject({
      statusCode: 500,
      code: 'INVALID_MEMORY_GRAPH_INDEX'
    });
  });
});
