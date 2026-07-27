import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve as resolvePath } from 'node:path';

import SQLite from 'better-sqlite3';
import ts from 'typescript';

import { buildAnchorIndex, type AnchorIndex, type CodeAnchor } from './anchors';

/**
 * A rebuildable structural index of the repository: files, content anchors, and import edges.
 *
 * This deliberately does NOT go through ScopedGraphifyRuntime. Graphify's contract is
 * tenant-isolated client knowledge partitioned as `graphify/<kind>/<subject>`; repository
 * structure is not tenant data, and mixing it in would weaken the partition invariant that
 * makes Graphify worth having. Traversal here is plain SQLite recursive CTEs.
 */

const INDEXABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.md', '.json']);
const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-task-market',
  'coverage',
  'graphify-out',
  'workspaces',
  '.venv'
]);
const MAX_FILE_BYTES = 1_048_576;

export type CodeNodeKind = 'file' | 'anchor';
export type CodeEdgeKind = 'imports' | 'anchors';

export interface CodeNode {
  id: string;
  kind: CodeNodeKind;
  path: string;
  name: string | null;
  line: number | null;
  digest: string;
  parentId: string | null;
}

export interface CodeEdge {
  srcId: string;
  dstId: string;
  kind: CodeEdgeKind;
}

export interface CodeIndexBuild {
  generatedAt: string;
  nodes: CodeNode[];
  edges: CodeEdge[];
  anchorIndex: AnchorIndex;
  fileCount: number;
  anchorCount: number;
  importEdgeCount: number;
  unresolvedImportCount: number;
}

export function fileNodeId(repoRelativePath: string): string {
  return `file:${repoRelativePath}`;
}

export function anchorNodeId(anchorId: string): string {
  return `anchor:${anchorId}`;
}

async function walk(root: string, current: string, collected: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.github') {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
    }
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await walk(root, absolute, collected);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!INDEXABLE_EXTENSIONS.has(extname(entry.name))) continue;
    collected.push(relative(root, absolute));
  }
}

export async function collectIndexableFiles(root: string): Promise<string[]> {
  const collected: string[] = [];
  await walk(root, root, collected);
  return collected.sort();
}

/**
 * Uses the TypeScript pre-processor rather than a hand-rolled regex so that type-only imports,
 * re-exports, and dynamic import() calls are all reported consistently.
 */
export function extractImportSpecifiers(path: string, contents: string): string[] {
  const extension = extname(path);
  if (!['.ts', '.tsx', '.js', '.mjs', '.cjs'].includes(extension)) return [];
  const preprocessed = ts.preProcessFile(contents, true, true);
  return preprocessed.importedFiles.map((imported) => imported.fileName);
}

function resolveRelativeImport(
  fromPath: string,
  specifier: string,
  knownFiles: ReadonlySet<string>
): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = join(dirname(fromPath), specifier).replace(/\\/g, '/');
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}/index.ts`,
    `${base}/index.js`
  ];
  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

export async function buildCodeIndex(
  root: string,
  now: () => Date = () => new Date()
): Promise<CodeIndexBuild> {
  const absoluteRoot = resolvePath(root);
  const paths = await collectIndexableFiles(absoluteRoot);
  const knownFiles = new Set(paths);

  const loaded: Array<{ path: string; contents: string; digest: string }> = [];
  for (const path of paths) {
    const absolute = join(absoluteRoot, path);
    const stats = await stat(absolute);
    if (stats.size > MAX_FILE_BYTES) continue;
    const contents = await readFile(absolute, 'utf8');
    loaded.push({
      path,
      contents,
      digest: createHash('sha256').update(contents, 'utf8').digest('hex')
    });
  }

  const anchorIndex = buildAnchorIndex(loaded.map(({ path, contents }) => ({ path, contents })));

  const nodes: CodeNode[] = loaded.map((file) => ({
    id: fileNodeId(file.path),
    kind: 'file',
    path: file.path,
    name: null,
    line: null,
    digest: file.digest,
    parentId: null
  }));

  const edges: CodeEdge[] = [];
  let anchorCount = 0;
  for (const occurrences of anchorIndex.anchors.values()) {
    // Ambiguous anchors are recorded so the enforcement test can fail loudly, but only the
    // first occurrence becomes a node so the index stays a function of resolvable evidence.
    const anchor: CodeAnchor | undefined = occurrences[0];
    if (anchor === undefined) continue;
    anchorCount += 1;
    nodes.push({
      id: anchorNodeId(anchor.id),
      kind: 'anchor',
      path: anchor.path,
      name: anchor.id,
      line: anchor.line,
      digest: anchor.digest,
      parentId: fileNodeId(anchor.path)
    });
    edges.push({
      srcId: fileNodeId(anchor.path),
      dstId: anchorNodeId(anchor.id),
      kind: 'anchors'
    });
  }

  let unresolvedImportCount = 0;
  let importEdgeCount = 0;
  for (const file of loaded) {
    for (const specifier of extractImportSpecifiers(file.path, file.contents)) {
      const target = resolveRelativeImport(file.path, specifier, knownFiles);
      if (target === null) {
        unresolvedImportCount += 1;
        continue;
      }
      edges.push({ srcId: fileNodeId(file.path), dstId: fileNodeId(target), kind: 'imports' });
      importEdgeCount += 1;
    }
  }

  return {
    generatedAt: now().toISOString(),
    nodes,
    edges,
    anchorIndex,
    fileCount: loaded.length,
    anchorCount,
    importEdgeCount,
    unresolvedImportCount
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS code_nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('file','anchor')),
  path TEXT NOT NULL,
  name TEXT,
  line INTEGER,
  digest TEXT NOT NULL,
  parent_id TEXT REFERENCES code_nodes(id)
);
CREATE TABLE IF NOT EXISTS code_edges (
  src_id TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('imports','anchors')),
  PRIMARY KEY (src_id, dst_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_code_edges_dst ON code_edges (dst_id, kind);
CREATE INDEX IF NOT EXISTS idx_code_nodes_path ON code_nodes (path);
CREATE TABLE IF NOT EXISTS code_index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function persistCodeIndex(databaseFile: string, build: CodeIndexBuild): void {
  const database = new SQLite(databaseFile);
  try {
    database.pragma('journal_mode = WAL');
    database.exec(SCHEMA);
    const write = database.transaction(() => {
      database.prepare('DELETE FROM code_edges').run();
      database.prepare('DELETE FROM code_nodes').run();
      const insertNode = database.prepare(
        'INSERT INTO code_nodes (id, kind, path, name, line, digest, parent_id) VALUES (?,?,?,?,?,?,?)'
      );
      // Files first: anchor nodes carry a parent_id foreign key into them.
      for (const node of build.nodes.filter((candidate) => candidate.kind === 'file')) {
        insertNode.run(node.id, node.kind, node.path, node.name, node.line, node.digest, null);
      }
      for (const node of build.nodes.filter((candidate) => candidate.kind === 'anchor')) {
        insertNode.run(
          node.id,
          node.kind,
          node.path,
          node.name,
          node.line,
          node.digest,
          node.parentId
        );
      }
      const insertEdge = database.prepare(
        'INSERT OR IGNORE INTO code_edges (src_id, dst_id, kind) VALUES (?,?,?)'
      );
      for (const edge of build.edges) insertEdge.run(edge.srcId, edge.dstId, edge.kind);
      const insertMeta = database.prepare(
        'INSERT INTO code_index_meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      );
      insertMeta.run('generatedAt', build.generatedAt);
      insertMeta.run('fileCount', String(build.fileCount));
      insertMeta.run('anchorCount', String(build.anchorCount));
      insertMeta.run('importEdgeCount', String(build.importEdgeCount));
    });
    write();
  } finally {
    database.close();
  }
}

/**
 * Everything that transitively imports `path`, i.e. the blast radius of changing it. Depth is
 * bounded so a cycle cannot produce an unbounded walk.
 */
export function queryBlastRadius(
  databaseFile: string,
  path: string,
  maxDepth = 4
): Array<{ path: string; depth: number }> {
  const database = new SQLite(databaseFile, { readonly: true });
  try {
    return database
      .prepare(
        `WITH RECURSIVE blast(id, depth) AS (
           SELECT ?, 0
           UNION
           SELECT e.src_id, b.depth + 1
             FROM code_edges e
             JOIN blast b ON e.dst_id = b.id
            WHERE e.kind = 'imports' AND b.depth < ?
         )
         SELECT n.path AS path, MIN(b.depth) AS depth
           FROM blast b JOIN code_nodes n ON n.id = b.id
          WHERE b.depth > 0
          GROUP BY n.path
          ORDER BY depth, path`
      )
      .all(fileNodeId(path), maxDepth) as Array<{ path: string; depth: number }>;
  } finally {
    database.close();
  }
}

export function queryAnchor(
  databaseFile: string,
  anchorId: string
): { path: string; line: number; digest: string } | null {
  const database = new SQLite(databaseFile, { readonly: true });
  try {
    const row = database
      .prepare('SELECT path, line, digest FROM code_nodes WHERE id = ? AND kind = ?')
      .get(anchorNodeId(anchorId), 'anchor') as
      { path: string; line: number; digest: string } | undefined;
    return row ?? null;
  } finally {
    database.close();
  }
}
