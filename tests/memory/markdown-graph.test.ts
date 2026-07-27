import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MarkdownGraph } from '../../src/memory/markdown-graph';

const now = '2026-07-18T12:00:00.000Z';

function customNote(frontmatterLines: string[]): string {
  return ['---', ...frontmatterLines, '---', '', '# Custom', ''].join('\n');
}

describe('MarkdownGraph', () => {
  let temporaryRoot: string;
  let graphRoot: string;
  let graph: MarkdownGraph;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-markdown-graph-'));
    graphRoot = join(temporaryRoot, 'memory', 'graph');
    graph = new MarkdownGraph({ graphRoot, now: () => now });
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('creates a navigable base tree and machine-readable adjacency index', async () => {
    await graph.initialize();
    const index = await graph.rebuild();

    expect(await readFile(join(graphRoot, 'index.md'), 'utf8')).toContain('[[agency/jarvis]]');
    expect(await readFile(join(graphRoot, 'index.md'), 'utf8')).toContain('[[clients/index]]');
    expect(index.nodes.map((node) => node.id)).toEqual(['agency/jarvis', 'clients/index', 'index']);
    expect(index.edges).toEqual(
      expect.arrayContaining([
        { from: 'index', to: 'agency/jarvis' },
        { from: 'index', to: 'clients/index' }
      ])
    );
    expect(JSON.parse(await readFile(join(graphRoot, 'graph.json'), 'utf8'))).toEqual(index);
  });

  it('links global client metadata to a tenant-private note index', async () => {
    const clientDirectory = join(temporaryRoot, 'clients', 'acme_corp');
    await graph.initialize();
    await graph.createClientNode({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing',
      createdAt: now,
      clientDirectory
    });
    const index = await graph.rebuild();

    const globalNote = await readFile(join(graphRoot, 'clients', 'acme_corp.md'), 'utf8');
    const privateNote = await readFile(
      join(clientDirectory, 'memory', 'notes', 'index.md'),
      'utf8'
    );
    expect(globalNote).toContain('id: "clients/acme_corp"');
    expect(globalNote).toContain('[[clients/index]]');
    expect(globalNote).not.toContain('lead data');
    expect(privateNote).toContain('Tenant-private Markdown memory');
    expect(privateNote).toContain('acme_corp');
    expect(await readFile(join(graphRoot, 'clients', 'index.md'), 'utf8')).toContain(
      '[[clients/acme_corp]]'
    );
    expect(index.edges).toContainEqual({ from: 'clients/acme_corp', to: 'clients/index' });
    expect(index.edges).toContainEqual({ from: 'clients/index', to: 'clients/acme_corp' });
  });

  it('serializes concurrent client mutations so every registry link is retained', async () => {
    const secondGraph = new MarkdownGraph({ graphRoot, now: () => now });
    const clients = Array.from({ length: 16 }, (_, index) => ({
      id: `client_${index.toString().padStart(2, '0')}`,
      name: `Client ${index}`,
      directory: join(temporaryRoot, 'clients', `client_${index.toString().padStart(2, '0')}`)
    }));

    await Promise.all(
      clients.map((client, index) =>
        (index % 2 === 0 ? graph : secondGraph).createClientNode({
          id: client.id,
          name: client.name,
          profile: 'data_processing',
          createdAt: now,
          clientDirectory: client.directory
        })
      )
    );

    const clientIndex = await readFile(join(graphRoot, 'clients', 'index.md'), 'utf8');
    for (const client of clients) {
      expect(clientIndex).toContain(`- [[clients/${client.id}]]`);
    }
    const index = await graph.rebuild();
    expect(index.nodes.filter((node) => node.type === 'client')).toHaveLength(clients.length);
  });

  it('rejects a symlink in the global graph write path', async () => {
    const outsideDirectory = join(temporaryRoot, 'outside-graph');
    await mkdir(graphRoot, { recursive: true });
    await mkdir(outsideDirectory, { recursive: true });
    await symlink(outsideDirectory, join(graphRoot, 'clients'), 'dir');

    await expect(graph.initialize()).rejects.toMatchObject({
      statusCode: 400,
      code: 'UNSAFE_MEMORY_PATH'
    });
    expect(await readdir(outsideDirectory)).toEqual([]);
  });

  it('rejects symlinked notes while rebuilding the global graph', async () => {
    const outsideNote = join(temporaryRoot, 'outside-note.md');
    await graph.initialize();
    await writeFile(outsideNote, '# Outside\n');
    await symlink(outsideNote, join(graphRoot, 'linked.md'));

    await expect(graph.rebuild()).rejects.toMatchObject({
      statusCode: 400,
      code: 'UNSAFE_MEMORY_PATH'
    });
  });

  it('rejects a symlink in the tenant-private note path before writing through it', async () => {
    const clientDirectory = join(temporaryRoot, 'clients', 'acme_corp');
    const outsideDirectory = join(temporaryRoot, 'outside-client');
    await graph.initialize();
    await mkdir(clientDirectory, { recursive: true });
    await mkdir(outsideDirectory, { recursive: true });
    await symlink(outsideDirectory, join(clientDirectory, 'memory'), 'dir');

    await expect(
      graph.createClientNode({
        id: 'acme_corp',
        name: 'Acme Corporation',
        profile: 'data_processing',
        createdAt: now,
        clientDirectory
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'UNSAFE_MEMORY_PATH' });
    expect(await readdir(outsideDirectory)).toEqual([]);
  });

  it('neutralizes wiki-link syntax supplied through a client name', async () => {
    const clientDirectory = join(temporaryRoot, 'clients', 'acme_corp');
    await graph.createClientNode({
      id: 'acme_corp',
      name: 'Acme [[missing/node|Injected]]',
      profile: 'data_processing',
      createdAt: now,
      clientDirectory
    });

    const index = await graph.rebuild();
    const globalNote = await readFile(join(graphRoot, 'clients', 'acme_corp.md'), 'utf8');
    expect(globalNote).toContain('# Acme &#91;&#91;missing/node|Injected&#93;&#93;');
    expect(globalNote).not.toContain('[[missing/node');
    expect(index.edges).not.toContainEqual({ from: 'clients/acme_corp', to: 'missing/node' });
  });

  it('rejects unsafe client ids before creating a note path', async () => {
    await graph.initialize();

    await expect(
      graph.createClientNode({
        id: '../escape',
        name: 'Escape',
        profile: 'data_processing',
        createdAt: now,
        clientDirectory: join(temporaryRoot, 'clients', 'escape')
      })
    ).rejects.toBeDefined();
    await expect(readFile(join(graphRoot, 'escape.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('fails graph generation when a wiki-link target is missing', async () => {
    await graph.initialize();
    await writeFile(
      join(graphRoot, 'broken.md'),
      [
        '---',
        'id: "broken"',
        'type: "test"',
        'title: "Broken"',
        'created_at: "2026-07-18T12:00:00.000Z"',
        'updated_at: "2026-07-18T12:00:00.000Z"',
        'tags:',
        '  - "test"',
        '---',
        '',
        '[[missing/node]]',
        ''
      ].join('\n')
    );

    await expect(graph.rebuild()).rejects.toMatchObject({
      statusCode: 500,
      code: 'BROKEN_MEMORY_LINK'
    });
  });

  it.each([
    ['created_at', 'created_at: "2026-07-18T12:00:00.000Z"\n'],
    ['updated_at', 'updated_at: "2026-07-18T12:00:00.000Z"\n'],
    ['tags', 'tags:\n  - "test"\n']
  ])('rejects a note missing required %s frontmatter', async (_field, lineToRemove) => {
    await graph.initialize();
    const validNote = [
      '---',
      'id: "custom"',
      'type: "test"',
      'title: "Custom"',
      'created_at: "2026-07-18T12:00:00.000Z"',
      'updated_at: "2026-07-18T12:00:00.000Z"',
      'tags:',
      '  - "test"',
      '---',
      '',
      '# Custom',
      ''
    ].join('\n');
    await writeFile(join(graphRoot, 'custom.md'), validNote.replace(lineToRemove, ''));

    await expect(graph.rebuild()).rejects.toMatchObject({
      statusCode: 500,
      code: 'INVALID_MEMORY_NOTE'
    });
  });

  it('rejects non-list tags frontmatter', async () => {
    await graph.initialize();
    await writeFile(
      join(graphRoot, 'custom.md'),
      [
        '---',
        'id: "custom"',
        'type: "test"',
        'title: "Custom"',
        'created_at: "2026-07-18T12:00:00.000Z"',
        'updated_at: "2026-07-18T12:00:00.000Z"',
        'tags: "test"',
        '---',
        '',
        '# Custom',
        ''
      ].join('\n')
    );

    await expect(graph.rebuild()).rejects.toMatchObject({
      statusCode: 500,
      code: 'INVALID_MEMORY_NOTE'
    });
  });

  it.each([
    ['missing frontmatter', '# Custom\n'],
    [
      'malformed tag item',
      customNote([
        'id: "custom"',
        'type: "test"',
        'title: "Custom"',
        `created_at: ${JSON.stringify(now)}`,
        `updated_at: ${JSON.stringify(now)}`,
        'tags:',
        '  malformed'
      ])
    ],
    [
      'empty tag item',
      customNote([
        'id: "custom"',
        'type: "test"',
        'title: "Custom"',
        `created_at: ${JSON.stringify(now)}`,
        `updated_at: ${JSON.stringify(now)}`,
        'tags:',
        '  - ""'
      ])
    ],
    [
      'duplicate metadata key',
      customNote([
        'id: "custom"',
        'id: "other"',
        'type: "test"',
        'title: "Custom"',
        `created_at: ${JSON.stringify(now)}`,
        `updated_at: ${JSON.stringify(now)}`,
        'tags: ["test"]'
      ])
    ]
  ])('rejects %s', async (_scenario, content) => {
    await graph.initialize();
    await writeFile(join(graphRoot, 'custom.md'), content);

    await expect(graph.rebuild()).rejects.toMatchObject({
      statusCode: 500,
      code: 'INVALID_MEMORY_NOTE'
    });
  });

  it('accepts an inline JSON tag list', async () => {
    await graph.initialize();
    await writeFile(
      join(graphRoot, 'custom.md'),
      customNote([
        'id: "custom"',
        'type: "test"',
        'title: "Custom"',
        `created_at: ${JSON.stringify(now)}`,
        `updated_at: ${JSON.stringify(now)}`,
        'tags: ["test"]'
      ])
    );

    const index = await graph.rebuild();
    expect(index.nodes.map((node) => node.id)).toContain('custom');
  });

  it('rejects duplicate node ids instead of silently merging their identity', async () => {
    await graph.initialize();
    const duplicate = (title: string) =>
      [
        '---',
        'id: "duplicate"',
        'type: "test"',
        `title: ${JSON.stringify(title)}`,
        'created_at: "2026-07-18T12:00:00.000Z"',
        'updated_at: "2026-07-18T12:00:00.000Z"',
        'tags:',
        '  - "test"',
        '---',
        '',
        `# ${title}`,
        ''
      ].join('\n');
    await writeFile(join(graphRoot, 'duplicate-a.md'), duplicate('Duplicate A'));
    await writeFile(join(graphRoot, 'duplicate-b.md'), duplicate('Duplicate B'));

    await expect(graph.rebuild()).rejects.toMatchObject({
      statusCode: 500,
      code: 'DUPLICATE_MEMORY_NODE'
    });
  });

  it('preserves customized base and private notes when initializing again', async () => {
    const clientDirectory = join(temporaryRoot, 'clients', 'acme_corp');
    await graph.initialize();
    const baseIndex = join(graphRoot, 'index.md');
    const customizedBase = `${await readFile(baseIndex, 'utf8')}\nCustom base content\n`;
    await writeFile(baseIndex, customizedBase);
    await graph.initialize();
    expect(await readFile(baseIndex, 'utf8')).toBe(customizedBase);

    const clientInput = {
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing' as const,
      createdAt: now,
      clientDirectory
    };
    await graph.createClientNode(clientInput);
    const privateIndex = join(clientDirectory, 'memory', 'notes', 'index.md');
    const customizedPrivate = `${await readFile(privateIndex, 'utf8')}\nCustom private content\n`;
    await writeFile(privateIndex, customizedPrivate);
    await graph.createClientNode(clientInput);
    expect(await readFile(privateIndex, 'utf8')).toBe(customizedPrivate);
  });

  it('removes a client node and its index link', async () => {
    const clientDirectory = join(temporaryRoot, 'clients', 'acme_corp');
    await mkdir(clientDirectory, { recursive: true });
    await graph.initialize();
    await graph.createClientNode({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing',
      createdAt: now,
      clientDirectory
    });

    await graph.removeClientNode('acme_corp');
    const index = await graph.rebuild();

    expect(index.nodes.map((node) => node.id)).not.toContain('clients/acme_corp');
    expect(await readFile(join(graphRoot, 'clients', 'index.md'), 'utf8')).not.toContain(
      '[[clients/acme_corp]]'
    );
  });
});
