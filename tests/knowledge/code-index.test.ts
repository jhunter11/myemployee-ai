import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  anchorNodeId,
  buildCodeIndex,
  collectIndexableFiles,
  extractImportSpecifiers,
  fileNodeId,
  persistCodeIndex,
  queryAnchor,
  queryBlastRadius
} from '../../src/knowledge/code-index';

const PROJECT_ROOT = resolve(__dirname, '..', '..');
const temporaryDirectories: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-code-index-'));
  temporaryDirectories.push(directory);
  return join(directory, 'code-index.sqlite');
}

afterAll(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('extractImportSpecifiers', () => {
  it('reports static, type-only, and dynamic imports', () => {
    const specifiers = extractImportSpecifiers(
      'src/x.ts',
      [
        "import { a } from './alpha';",
        "import type { B } from './beta';",
        "const c = await import('./gamma');"
      ].join('\n')
    );

    expect(specifiers).toEqual(expect.arrayContaining(['./alpha', './beta', './gamma']));
  });

  it('returns nothing for non-source files', () => {
    expect(extractImportSpecifiers('docs/x.md', "import { a } from './alpha';")).toEqual([]);
  });
});

describe('collectIndexableFiles', () => {
  it('excludes node_modules and build output', async () => {
    const paths = await collectIndexableFiles(PROJECT_ROOT);

    expect(paths.some((path) => path.startsWith('node_modules'))).toBe(false);
    expect(paths.some((path) => path.startsWith('dist'))).toBe(false);
    expect(paths).toContain('src/knowledge/code-index.ts');
  });
});

describe('buildCodeIndex', () => {
  it('indexes this repository with resolvable import edges', async () => {
    const build = await buildCodeIndex(PROJECT_ROOT, () => new Date('2026-07-21T00:00:00.000Z'));

    expect(build.fileCount).toBeGreaterThan(100);
    expect(build.importEdgeCount).toBeGreaterThan(50);
    expect(build.nodes.some((node) => node.id === fileNodeId('src/knowledge/anchors.ts'))).toBe(
      true
    );
  });

  it('links a file to the anchors it declares', async () => {
    const build = await buildCodeIndex(PROJECT_ROOT);
    const anchorNodes = build.nodes.filter((node) => node.kind === 'anchor');

    for (const node of anchorNodes) {
      expect(node.parentId).toBe(fileNodeId(node.path));
      expect(
        build.edges.some(
          (edge) => edge.kind === 'anchors' && edge.dstId === anchorNodeId(node.name ?? '')
        )
      ).toBe(true);
    }
  });
});

describe('recursive traversal', () => {
  it('finds transitive importers and bounds depth', async () => {
    const databaseFile = await temporaryDatabase();
    const build = await buildCodeIndex(PROJECT_ROOT);
    persistCodeIndex(databaseFile, build);

    // code-index.ts imports anchors.ts, and the CLI imports code-index.ts, so the CLI must
    // appear in the blast radius of anchors.ts at depth two.
    const affected = queryBlastRadius(databaseFile, 'src/knowledge/anchors.ts');
    const paths = affected.map((entry) => entry.path);

    expect(paths).toContain('src/knowledge/code-index.ts');
    expect(paths).toContain('src/knowledge/code-index-cli.ts');
    expect(affected.every((entry) => entry.depth >= 1 && entry.depth <= 4)).toBe(true);
  });

  it('respects an explicit depth bound', async () => {
    const databaseFile = await temporaryDatabase();
    persistCodeIndex(databaseFile, await buildCodeIndex(PROJECT_ROOT));

    const shallow = queryBlastRadius(databaseFile, 'src/knowledge/anchors.ts', 1);

    expect(shallow.every((entry) => entry.depth === 1)).toBe(true);
    expect(shallow.map((entry) => entry.path)).toContain('src/knowledge/code-index.ts');
  });

  it('returns an empty radius for a file nothing imports', async () => {
    const databaseFile = await temporaryDatabase();
    persistCodeIndex(databaseFile, await buildCodeIndex(PROJECT_ROOT));

    expect(queryBlastRadius(databaseFile, 'docs/anchors.md')).toEqual([]);
  });
});

describe('queryAnchor', () => {
  it('returns null for an anchor that does not exist', async () => {
    const databaseFile = await temporaryDatabase();
    persistCodeIndex(databaseFile, await buildCodeIndex(PROJECT_ROOT));

    expect(queryAnchor(databaseFile, 'tm.nonexistent.anchor')).toBeNull();
  });
});
