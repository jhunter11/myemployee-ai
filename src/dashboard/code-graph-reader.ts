import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { AppError } from '../utils/errors';

const MAX_GRAPH_BYTES = 2 * 1024 * 1024;
const MAX_GRAPH_NODES = 2_500;
const MAX_GRAPH_LINKS = 10_000;
const MAX_GIT_METADATA_BYTES = 1024 * 1024;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/iu;
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SOURCE_LOCATION_PATTERN = /^L([1-9]\d{0,6})$/u;
const SOURCE_PATH_PATTERN = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u;
const GIT_REF_PATTERN = /^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]{1,255}$/u;

const CODE_GRAPH_RELATIONS = [
  'calls',
  'contains',
  'implements',
  'imports',
  'imports_from',
  'inherits',
  'method',
  'references'
] as const;

const SafeLabelSchema = z.string().trim().min(1).max(160).refine(hasNoControlCharacters);
const NodeIdSchema = z.string().regex(NODE_ID_PATTERN);
const SourcePathSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(SOURCE_PATH_PATTERN)
  .refine(isSafeRelativePath);
const SourceLocationSchema = z.string().regex(SOURCE_LOCATION_PATTERN);

const RawGraphifyNodeSchema = z.strictObject({
  label: SafeLabelSchema,
  file_type: z.literal('code'),
  source_file: SourcePathSchema,
  source_location: SourceLocationSchema,
  _origin: z.literal('ast'),
  id: NodeIdSchema,
  community: z.number().int().min(0).max(1_000_000),
  norm_label: z.string().min(1).max(160)
});

const RawGraphifyLinkSchema = z.strictObject({
  relation: z.enum(CODE_GRAPH_RELATIONS),
  confidence: z.enum(['EXTRACTED', 'INFERRED']),
  source_file: SourcePathSchema,
  source_location: SourceLocationSchema,
  weight: z.number().finite().min(0).max(1_000_000),
  source: NodeIdSchema,
  target: NodeIdSchema,
  confidence_score: z.number().finite().min(0).max(1),
  context: z.string().max(2_000).optional()
});

const RawGraphifySchema = z.strictObject({
  directed: z.literal(false),
  multigraph: z.literal(false),
  graph: z.strictObject({}),
  nodes: z.array(RawGraphifyNodeSchema).max(MAX_GRAPH_NODES),
  links: z.array(RawGraphifyLinkSchema).max(MAX_GRAPH_LINKS),
  hyperedges: z.array(z.never()).max(0),
  built_at_commit: z.string().regex(COMMIT_PATTERN)
});

type CodeGraphRelation = (typeof CODE_GRAPH_RELATIONS)[number];

export interface DashboardCodeGraphNode {
  id: string;
  title: string;
  type: 'code';
  path: string;
  line: number;
  community: number;
}

export interface DashboardCodeGraphEdge {
  from: string;
  to: string;
  relation: CodeGraphRelation;
}

export interface DashboardCodeGraphSnapshot {
  schemaVersion: 1;
  source: 'graphify';
  scope: 'harness';
  indexedAt: string;
  builtAtCommit: string;
  currentCommit: string | null;
  revisionStatus: 'current' | 'stale' | 'unknown';
  totalNodeCount: number;
  totalEdgeCount: number;
  omittedNonStructuralEdgeCount: number;
  nodes: DashboardCodeGraphNode[];
  edges: DashboardCodeGraphEdge[];
}

export interface DashboardCodeGraphReaderOptions {
  projectRoot: string;
}

interface BoundedFile {
  content: Buffer;
  modifiedAt: string;
}

function hasNoControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function unavailable(): AppError {
  return new AppError(
    503,
    'DASHBOARD_CODE_GRAPH_UNAVAILABLE',
    'The harness code graph is unavailable'
  );
}

function isSafeRelativePath(value: string): boolean {
  if (isAbsolute(value) || value.includes('\\') || posix.normalize(value) !== value) {
    return false;
  }
  const segments = value.split('/');
  return segments.every(
    (segment) =>
      segment.length > 0 && segment !== '.' && segment !== '..' && !segment.startsWith('~')
  );
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === '' ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot))
  );
}

async function readBoundedRegularFile(filename: string, maxBytes: number): Promise<BoundedFile> {
  const pathMetadata = await lstat(filename);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() || pathMetadata.size > maxBytes) {
    throw new Error('Unsafe or oversized file');
  }

  const handle = await open(
    filename,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size > maxBytes ||
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino
    ) {
      throw new Error('Unsafe or oversized file');
    }

    const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, metadata.size + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const afterRead = await handle.stat();
    if (
      bytesRead > maxBytes ||
      bytesRead !== metadata.size ||
      afterRead.size !== metadata.size ||
      afterRead.mtimeMs !== metadata.mtimeMs
    ) {
      throw new Error('File changed or exceeded its bound while being read');
    }
    return {
      content: buffer.subarray(0, bytesRead),
      modifiedAt: metadata.mtime.toISOString()
    };
  } finally {
    await handle.close();
  }
}

async function isOrdinaryDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

async function hasSafeDirectoryPath(root: string, relativeDirectory: string): Promise<boolean> {
  let current = root;
  for (const component of relativeDirectory.split('/').filter(Boolean)) {
    current = join(current, component);
    if (!(await isOrdinaryDirectory(current))) {
      return false;
    }
  }
  return true;
}

function parseCommit(content: Buffer): string | null {
  const value = content.toString('utf8').trim();
  return COMMIT_PATTERN.test(value) ? value.toLowerCase() : null;
}

function isSafeGitRef(ref: string): boolean {
  if (!GIT_REF_PATTERN.test(ref) || !isSafeRelativePath(ref)) {
    return false;
  }
  return ref
    .split('/')
    .every(
      (component) =>
        component.length > 0 &&
        !component.startsWith('.') &&
        !component.endsWith('.') &&
        !component.endsWith('.lock') &&
        !component.includes('..')
    );
}

async function readLooseGitRef(gitRoot: string, ref: string): Promise<string | null> {
  const parent = posix.dirname(ref);
  if (!(await hasSafeDirectoryPath(gitRoot, parent))) {
    return null;
  }
  const filename = resolve(gitRoot, ...ref.split('/'));
  if (!isWithin(gitRoot, filename)) {
    return null;
  }
  try {
    return parseCommit((await readBoundedRegularFile(filename, 4_096)).content);
  } catch {
    return null;
  }
}

async function readPackedGitRef(gitRoot: string, ref: string): Promise<string | null> {
  try {
    const packed = await readBoundedRegularFile(
      join(gitRoot, 'packed-refs'),
      MAX_GIT_METADATA_BYTES
    );
    for (const rawLine of packed.content.toString('utf8').split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('#') || line.startsWith('^')) {
        continue;
      }
      const match = /^([a-f0-9]{40}) ([^\s]+)$/iu.exec(line);
      if (match?.[1] !== undefined && match[2] === ref) {
        return match[1].toLowerCase();
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function readCurrentCommit(projectRoot: string): Promise<string | null> {
  const gitRoot = join(projectRoot, '.git');
  if (!(await isOrdinaryDirectory(gitRoot))) {
    return null;
  }
  try {
    const head = await readBoundedRegularFile(join(gitRoot, 'HEAD'), 4_096);
    const headValue = head.content.toString('utf8').trim();
    if (COMMIT_PATTERN.test(headValue)) {
      return headValue.toLowerCase();
    }
    if (!headValue.startsWith('ref: ')) {
      return null;
    }
    const ref = headValue.slice('ref: '.length);
    if (!isSafeGitRef(ref)) {
      return null;
    }
    return (await readLooseGitRef(gitRoot, ref)) ?? (await readPackedGitRef(gitRoot, ref));
  } catch {
    return null;
  }
}

function sourceLine(location: string): number {
  const match = SOURCE_LOCATION_PATTERN.exec(location);
  if (match?.[1] === undefined) {
    throw new Error('Invalid source location');
  }
  return Number.parseInt(match[1], 10);
}

function assertGraphIntegrity(graph: z.infer<typeof RawGraphifySchema>): void {
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) {
      throw new Error('Duplicate graph node');
    }
    nodeIds.add(node.id);
  }

  const adjacency = new Set<string>();
  for (const link of graph.links) {
    if (!nodeIds.has(link.source) || !nodeIds.has(link.target)) {
      throw new Error('Dangling graph link');
    }
    const key = `${link.source}\0${link.relation}\0${link.target}`;
    if (adjacency.has(key)) {
      throw new Error('Duplicate graph link');
    }
    adjacency.add(key);
  }
}

export class DashboardCodeGraphReader {
  private readonly projectRoot: string;

  constructor(options: DashboardCodeGraphReaderOptions) {
    this.projectRoot = resolve(options.projectRoot);
  }

  async read(): Promise<DashboardCodeGraphSnapshot> {
    try {
      return await this.readValidated();
    } catch {
      throw unavailable();
    }
  }

  private async readValidated(): Promise<DashboardCodeGraphSnapshot> {
    const projectRoot = await realpath(this.projectRoot);
    const graphDirectory = join(projectRoot, 'graphify-out');
    if (!(await isOrdinaryDirectory(graphDirectory))) {
      throw new Error('Unsafe graph directory');
    }

    const graphPath = join(graphDirectory, 'graph.json');
    if (!isWithin(projectRoot, graphPath)) {
      throw new Error('Unsafe graph path');
    }
    const graphFile = await readBoundedRegularFile(graphPath, MAX_GRAPH_BYTES);
    const graph = RawGraphifySchema.parse(
      JSON.parse(graphFile.content.toString('utf8')) as unknown
    );
    assertGraphIntegrity(graph);

    const currentCommit = await readCurrentCommit(projectRoot);
    const revisionStatus =
      currentCommit === null
        ? 'unknown'
        : currentCommit === graph.built_at_commit.toLowerCase()
          ? 'current'
          : 'stale';
    const extractedLinks = graph.links.filter((link) => link.confidence === 'EXTRACTED');

    return {
      schemaVersion: 1,
      source: 'graphify',
      scope: 'harness',
      indexedAt: graphFile.modifiedAt,
      builtAtCommit: graph.built_at_commit.toLowerCase(),
      currentCommit,
      revisionStatus,
      totalNodeCount: graph.nodes.length,
      totalEdgeCount: graph.links.length,
      omittedNonStructuralEdgeCount: graph.links.length - extractedLinks.length,
      nodes: graph.nodes.map((node) => ({
        id: node.id,
        title: node.label,
        type: 'code',
        path: `src/${node.source_file}`,
        line: sourceLine(node.source_location),
        community: node.community
      })),
      edges: extractedLinks.map((link) => ({
        from: link.source,
        to: link.target,
        relation: link.relation
      }))
    };
  }
}
