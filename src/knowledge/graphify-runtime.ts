import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { z } from 'zod';

import { AppError } from '../utils/errors';
import {
  KnowledgeGraphPartitionSchema,
  KnowledgeScopeRecordSchema,
  type KnowledgeAdapterQuery,
  type KnowledgeGraphPartition,
  type KnowledgeScopeRecord,
  type ScopedKnowledgeAdapter,
  type ScopedKnowledgeAdapterResolver
} from './contracts';

const sha256Pattern = /^[a-f0-9]{64}$/u;
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const graphifyVersionOutputPattern = /^graphify (\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u;
const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu');

const DEFAULT_QUERY_TIMEOUT_MS = 5_000;
const DEFAULT_INDEX_TIMEOUT_MS = 120_000;
const DEFAULT_QUERY_OUTPUT_BYTES = 24_576;
const DEFAULT_INDEX_OUTPUT_BYTES = 131_072;
const DEFAULT_GRAPH_BYTES = 64 * 1024 * 1024;
const DEFAULT_GRAPH_ITEMS = 250_000;
const DEFAULT_CORPUS_ENTRIES = 50_000;
const DEFAULT_EXCERPT_CHARACTERS = 1_500;
const DEFAULT_QUERY_TOKEN_BUDGET = 1_000;
const MAX_CORPUS_DEPTH = 32;
const MAX_EXECUTABLE_BYTES = 8 * 1024 * 1024;
const AUDIT_OUTPUT_BYTES = 4_096;

export interface GraphifyProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface GraphifyProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  termination: 'timeout' | 'output_limit' | null;
}

export interface GraphifyProcessRunner {
  run(request: GraphifyProcessRequest): Promise<GraphifyProcessResult>;
}

export interface GraphifyRuntimeAudit {
  runtime: 'graphify';
  version: string;
  executableSha256: string;
  checkedAt: string;
  queryLogging: 'disabled';
}

export interface GraphifyIndexAudit {
  graphPartition: KnowledgeGraphPartition;
  graphifyVersion: string;
  graphSha256: string;
  nodes: number;
  edges: number;
  indexedAt: string;
}

export type GraphifyScopeBinding =
  | {
      scope: KnowledgeScopeRecord;
      corpusRoot: string;
    }
  | {
      scope: KnowledgeScopeRecord;
    };

export interface ScopedGraphifyRuntimeOptions {
  executable: string;
  expectedVersion: string;
  expectedExecutableSha256: string;
  storageRoot: string;
  clientRoot: string;
  bindings: readonly GraphifyScopeBinding[];
  runner?: GraphifyProcessRunner;
  now?: () => string;
  queryTimeoutMs?: number;
  indexTimeoutMs?: number;
  maxQueryOutputBytes?: number;
  maxIndexOutputBytes?: number;
  maxGraphBytes?: number;
  maxGraphItems?: number;
  maxCorpusEntries?: number;
  maxExcerptCharacters?: number;
  maxQueryTokenBudget?: number;
}

interface ParsedRuntimeOptions {
  executable: string;
  expectedVersion: string;
  expectedExecutableSha256: string;
  storageRoot: string;
  clientRoot: string;
  queryTimeoutMs: number;
  indexTimeoutMs: number;
  maxQueryOutputBytes: number;
  maxIndexOutputBytes: number;
  maxGraphBytes: number;
  maxGraphItems: number;
  maxCorpusEntries: number;
  maxExcerptCharacters: number;
  maxQueryTokenBudget: number;
}

interface RegisteredBinding {
  scope: KnowledgeScopeRecord;
  configuredCorpusRoot: string | undefined;
  partitionKind: 'harness' | 'project' | 'client';
  partitionKey: string;
}

interface ValidatedGraph {
  content: Buffer;
  sha256: string;
  nodes: number;
  edges: number;
  updatedAt: string;
}

interface ParsedNode {
  rawLabel: string;
  title: string;
  community: number | undefined;
}

interface ParsedEdge {
  left: string;
  relation: string;
  right: string;
}

const AdapterQuerySchema = z.strictObject({
  graphPartition: KnowledgeGraphPartitionSchema,
  text: z.string().trim().min(2).max(1_000),
  projection: z.enum(['metadata', 'content']),
  limit: z.number().int().min(1).max(25)
});

const RuntimeConfigurationSchema = z.strictObject({
  executable: z.string().refine(isAbsolute, 'Graphify executable must be absolute'),
  expectedVersion: z.string().regex(versionPattern),
  expectedExecutableSha256: z.string().regex(sha256Pattern),
  storageRoot: z.string().refine(isAbsolute, 'Graphify storage root must be absolute'),
  clientRoot: z.string().refine(isAbsolute, 'Graphify client root must be absolute'),
  queryTimeoutMs: z.number().int().min(25).max(30_000),
  indexTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(15 * 60_000),
  maxQueryOutputBytes: z.number().int().min(512).max(1_000_000),
  maxIndexOutputBytes: z.number().int().min(1_024).max(4_000_000),
  maxGraphBytes: z
    .number()
    .int()
    .min(1_024)
    .max(512 * 1024 * 1024),
  maxGraphItems: z.number().int().min(1).max(1_000_000),
  maxCorpusEntries: z.number().int().min(1).max(1_000_000),
  maxExcerptCharacters: z.number().int().min(80).max(2_000),
  maxQueryTokenBudget: z.number().int().min(64).max(2_000)
});

const RawBindingSchema = z
  .strictObject({
    scope: KnowledgeScopeRecordSchema,
    corpusRoot: z.string().refine(isAbsolute, 'Graphify corpus root must be absolute').optional()
  })
  .superRefine((binding, context) => {
    if (binding.scope.kind === 'client' && binding.corpusRoot !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['corpusRoot'],
        message: 'Client corpus roots are derived from the registered client scope'
      });
    }
    if (binding.scope.kind !== 'client' && binding.corpusRoot === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['corpusRoot'],
        message: 'Harness and project corpus roots must be operator configured'
      });
    }
  });

function graphifyError(statusCode: number, code: string, message: string): AppError {
  return new AppError(statusCode, code, message);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

function overlaps(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function assertConsistentScope(scope: KnowledgeScopeRecord): void {
  const expectedId = `${scope.kind}:${scope.subjectId}`;
  const expectedRootKey = `knowledge/${scope.kind}/${scope.subjectId}`;
  const expectedPartition = `graphify/${scope.kind}/${scope.subjectId}`;
  const consistentClient =
    scope.kind === 'client'
      ? scope.clientId === scope.subjectId && scope.parentScopeId?.startsWith('project:') === true
      : scope.clientId === null;
  const consistentParent =
    scope.kind === 'harness'
      ? scope.parentScopeId === null
      : scope.kind === 'project'
        ? scope.parentScopeId?.startsWith('harness:') === true
        : true;
  if (
    scope.id !== expectedId ||
    scope.rootKey !== expectedRootKey ||
    scope.graphPartition !== expectedPartition ||
    !consistentClient ||
    !consistentParent
  ) {
    throw graphifyError(
      500,
      'GRAPHIFY_CONFIGURATION_INVALID',
      'Scoped Graphify configuration is invalid'
    );
  }
}

function parseRuntimeOptions(options: ScopedGraphifyRuntimeOptions): ParsedRuntimeOptions {
  return RuntimeConfigurationSchema.parse({
    executable: options.executable,
    expectedVersion: options.expectedVersion,
    expectedExecutableSha256: options.expectedExecutableSha256,
    storageRoot: options.storageRoot,
    clientRoot: options.clientRoot,
    queryTimeoutMs: options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
    indexTimeoutMs: options.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS,
    maxQueryOutputBytes: options.maxQueryOutputBytes ?? DEFAULT_QUERY_OUTPUT_BYTES,
    maxIndexOutputBytes: options.maxIndexOutputBytes ?? DEFAULT_INDEX_OUTPUT_BYTES,
    maxGraphBytes: options.maxGraphBytes ?? DEFAULT_GRAPH_BYTES,
    maxGraphItems: options.maxGraphItems ?? DEFAULT_GRAPH_ITEMS,
    maxCorpusEntries: options.maxCorpusEntries ?? DEFAULT_CORPUS_ENTRIES,
    maxExcerptCharacters: options.maxExcerptCharacters ?? DEFAULT_EXCERPT_CHARACTERS,
    maxQueryTokenBudget: options.maxQueryTokenBudget ?? DEFAULT_QUERY_TOKEN_BUDGET
  });
}

function partitionKey(partition: KnowledgeGraphPartition): string {
  return createHash('sha256').update(partition).digest('hex');
}

function combinedBytes(result: GraphifyProcessResult): number {
  return result.stdout.length + result.stderr.length;
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      (error as { code?: unknown }).code !== 'ESRCH'
    ) {
      throw error;
    }
  }
}

export class NodeGraphifyProcessRunner implements GraphifyProcessRunner {
  run(request: GraphifyProcessRequest): Promise<GraphifyProcessResult> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(request.executable, request.args, {
        cwd: request.cwd,
        env: request.env,
        detached: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const stdoutParts: Buffer[] = [];
      const stderrParts: Buffer[] = [];
      let capturedBytes = 0;
      let termination: GraphifyProcessResult['termination'] = null;
      let spawnError: Error | undefined;

      const terminate = (reason: Exclude<GraphifyProcessResult['termination'], null>) => {
        if (termination !== null) return;
        termination = reason;
        try {
          killProcessGroup(child.pid);
        } catch {
          child.kill('SIGKILL');
        }
      };
      const capture = (parts: Buffer[], rawChunk: Buffer | string) => {
        if (termination !== null) return;
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        const remaining = Math.max(0, request.maxOutputBytes - capturedBytes);
        if (remaining > 0) {
          const accepted = chunk.subarray(0, remaining);
          parts.push(accepted);
          capturedBytes += accepted.length;
        }
        if (chunk.length > remaining) terminate('output_limit');
      };

      child.stdout.on('data', (chunk: Buffer | string) => capture(stdoutParts, chunk));
      child.stderr.on('data', (chunk: Buffer | string) => capture(stderrParts, chunk));
      child.once('error', (error) => {
        spawnError = error;
      });
      const timeout = setTimeout(() => terminate('timeout'), request.timeoutMs);
      child.once('close', (exitCode, signal) => {
        clearTimeout(timeout);
        if (spawnError !== undefined) {
          rejectPromise(spawnError);
          return;
        }
        resolvePromise({
          stdout: Buffer.concat(stdoutParts),
          stderr: Buffer.concat(stderrParts),
          exitCode,
          signal,
          termination
        });
      });
    });
  }
}

async function ensurePrivateDirectory(
  path: string,
  code: string,
  message: string
): Promise<string> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('unsafe directory');
    await chmod(path, 0o700);
    return await realpath(path);
  } catch {
    throw graphifyError(503, code, message);
  }
}

async function requireCanonicalDirectory(path: string): Promise<string> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('unsafe corpus');
    return await realpath(path);
  } catch {
    throw graphifyError(503, 'GRAPHIFY_CORPUS_INVALID', 'Scoped Graphify corpus is unavailable');
  }
}

async function assertSafeCorpusTree(root: string, maxEntries: number): Promise<void> {
  const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  let entries = 0;
  try {
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || current.depth > MAX_CORPUS_DEPTH) throw new Error('depth');
      const directory = await opendir(current.directory);
      for await (const entry of directory) {
        entries += 1;
        if (entries > maxEntries || entry.isSymbolicLink()) throw new Error('unsafe entry');
        const entryPath = join(current.directory, entry.name);
        if (entry.isDirectory()) {
          pending.push({ directory: entryPath, depth: current.depth + 1 });
        } else if (!entry.isFile()) {
          throw new Error('unsupported entry');
        }
      }
    }
  } catch {
    throw graphifyError(503, 'GRAPHIFY_CORPUS_INVALID', 'Scoped Graphify corpus is unavailable');
  }
}

async function validateGraphFile(
  path: string,
  maxGraphBytes: number,
  maxGraphItems: number
): Promise<ValidatedGraph> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maxGraphBytes) {
      throw new Error('unsafe graph');
    }
    const content = await readFile(path);
    if (content.length > maxGraphBytes) throw new Error('oversized graph');
    const raw: unknown = JSON.parse(content.toString('utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      throw new Error('invalid graph');
    const graph = raw as { nodes?: unknown; edges?: unknown; links?: unknown };
    const edges = Array.isArray(graph.edges) ? graph.edges : graph.links;
    if (!Array.isArray(graph.nodes) || !Array.isArray(edges)) throw new Error('invalid graph');
    if (graph.nodes.length > maxGraphItems || edges.length > maxGraphItems) {
      throw new Error('oversized graph');
    }
    return {
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      nodes: graph.nodes.length,
      edges: edges.length,
      updatedAt: metadata.mtime.toISOString()
    };
  } catch (error) {
    if (isMissing(error)) {
      throw graphifyError(
        503,
        'GRAPHIFY_INDEX_UNAVAILABLE',
        'Scoped Graphify index is unavailable'
      );
    }
    if (error instanceof AppError) throw error;
    throw graphifyError(503, 'GRAPHIFY_INDEX_INVALID', 'Scoped Graphify index is invalid');
  }
}

async function assertSafePublishTarget(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('unsafe target');
  } catch (error) {
    if (isMissing(error)) return;
    throw graphifyError(503, 'GRAPHIFY_INDEX_INVALID', 'Scoped Graphify index is invalid');
  }
}

async function atomicPublish(path: string, content: Buffer): Promise<void> {
  const temporaryPath = join(dirname(path), `.graph-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch {
    await rm(temporaryPath, { force: true });
    throw graphifyError(503, 'GRAPHIFY_INDEX_INVALID', 'Scoped Graphify index is invalid');
  }
}

function replaceUnsafeControls(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    result += code <= 9 || (code >= 11 && code <= 31) || code === 127 ? ' ' : character;
  }
  return result;
}

function safeLabel(rawLabel: string): string | undefined {
  const cleaned = replaceUnsafeControls(rawLabel.replace(ansiPattern, ''))
    .replace(/\s+/gu, ' ')
    .trim();
  if (
    cleaned.length === 0 ||
    cleaned.includes('/') ||
    cleaned.includes('\\') ||
    cleaned.startsWith('~') ||
    /^[A-Za-z]:/u.test(cleaned) ||
    /^file:/iu.test(cleaned)
  ) {
    return undefined;
  }
  const allowlisted = cleaned
    .replace(/[^\p{L}\p{N} ._():,#@+\-=<>!?{}'"$%&*]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return allowlisted.length === 0 ? undefined : allowlisted.slice(0, 160);
}

function safeRelation(rawRelation: string): string {
  const normalized = rawRelation
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 32);
  return normalized.length >= 2 ? normalized : 'relates_to';
}

function parseGraphifyOutput(
  output: string,
  partition: KnowledgeGraphPartition,
  projection: 'metadata' | 'content',
  limit: number,
  updatedAt: string,
  maxExcerptCharacters: number
): readonly unknown[] {
  const cleanOutput = replaceUnsafeControls(output.replace(ansiPattern, ''));
  if (cleanOutput.trim() === 'No matching nodes found.') return [];

  const nodes: ParsedNode[] = [];
  const edges: ParsedEdge[] = [];
  for (const rawLine of cleanOutput.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('NODE ')) {
      const detailsAt = line.lastIndexOf(' [src=');
      const communityMatch = / community=(\d*)\]$/u.exec(line);
      if (detailsAt < 5 || communityMatch === null) continue;
      const rawLabel = line.slice(5, detailsAt).trim();
      const title = safeLabel(rawLabel);
      if (title === undefined) continue;
      const rawCommunity = communityMatch[1] ?? '';
      const community = rawCommunity === '' ? undefined : Number.parseInt(rawCommunity, 10);
      nodes.push({
        rawLabel,
        title,
        community:
          community !== undefined && Number.isSafeInteger(community) && community >= 0
            ? community
            : undefined
      });
      continue;
    }
    if (line.startsWith('EDGE ')) {
      const relationAt = line.indexOf(' --', 5);
      const evidenceAt = line.indexOf(' [', relationAt + 3);
      const targetAt = line.indexOf('--> ', evidenceAt + 2);
      if (relationAt < 5 || evidenceAt < relationAt || targetAt < evidenceAt) continue;
      edges.push({
        left: line.slice(5, relationAt).trim(),
        relation: safeRelation(line.slice(relationAt + 3, evidenceAt)),
        right: line.slice(targetAt + 4).trim()
      });
    }
  }
  if (nodes.length === 0) {
    throw graphifyError(
      502,
      'GRAPHIFY_QUERY_OUTPUT_INVALID',
      'Scoped Graphify query output is invalid'
    );
  }

  return nodes.slice(0, limit).map((node, index) => {
    const kind = node.title.endsWith('()')
      ? 'function'
      : /\.[A-Za-z0-9]{1,8}$/u.test(node.title)
        ? 'file'
        : 'symbol';
    const tags = ['graphify'];
    if (node.community !== undefined) tags.push(`community_${node.community}`);
    const metadata = {
      documentId: `graphify_${createHash('sha256')
        .update(`${partition}\0${node.rawLabel}`)
        .digest('hex')
        .slice(0, 32)}`,
      title: node.title,
      kind,
      updatedAt,
      score: Number(Math.max(0, 1 - index / Math.max(nodes.length, 1)).toFixed(4)),
      tags
    };
    if (projection === 'metadata') return metadata;

    const related = edges
      .flatMap((edge) => {
        if (edge.left === node.rawLabel) {
          const target = safeLabel(edge.right);
          return target === undefined
            ? []
            : [`${node.title} ${edge.relation.replaceAll('_', ' ')} ${target}.`];
        }
        if (edge.right === node.rawLabel) {
          const source = safeLabel(edge.left);
          return source === undefined
            ? []
            : [`${source} ${edge.relation.replaceAll('_', ' ')} ${node.title}.`];
        }
        return [];
      })
      .slice(0, 4);
    const excerpt = (
      related.length > 0 ? related.join(' ') : `Graphify traversal matched ${node.title}.`
    ).slice(0, maxExcerptCharacters);
    return { ...metadata, excerpt };
  });
}

export class ScopedGraphifyRuntime implements ScopedKnowledgeAdapterResolver {
  private readonly options: ParsedRuntimeOptions;
  private readonly bindings = new Map<KnowledgeGraphPartition, RegisteredBinding>();
  private readonly adapters = new Map<KnowledgeGraphPartition, ScopedKnowledgeAdapter>();
  private readonly runner: GraphifyProcessRunner;
  private readonly now: () => string;

  constructor(rawOptions: ScopedGraphifyRuntimeOptions) {
    this.options = parseRuntimeOptions(rawOptions);
    this.runner = rawOptions.runner ?? new NodeGraphifyProcessRunner();
    this.now = rawOptions.now ?? (() => new Date().toISOString());

    for (const rawBinding of rawOptions.bindings) {
      const parsed = RawBindingSchema.parse(rawBinding);
      assertConsistentScope(parsed.scope);
      if (this.bindings.has(parsed.scope.graphPartition)) {
        throw graphifyError(
          500,
          'GRAPHIFY_CONFIGURATION_INVALID',
          'Scoped Graphify configuration is invalid'
        );
      }
      const binding: RegisteredBinding = {
        scope: parsed.scope,
        configuredCorpusRoot: parsed.corpusRoot,
        partitionKind: parsed.scope.kind,
        partitionKey: partitionKey(parsed.scope.graphPartition)
      };
      this.bindings.set(parsed.scope.graphPartition, binding);
      this.adapters.set(parsed.scope.graphPartition, {
        isolation: {
          graphPartition: parsed.scope.graphPartition,
          queryLogging: {
            mode: 'disabled',
            control: 'GRAPHIFY_QUERY_LOG_DISABLE=1'
          }
        },
        query: (input) => this.queryBinding(binding, input)
      });
    }
  }

  resolve(rawPartition: KnowledgeGraphPartition): ScopedKnowledgeAdapter | undefined {
    const partition = KnowledgeGraphPartitionSchema.safeParse(rawPartition);
    return partition.success ? this.adapters.get(partition.data) : undefined;
  }

  private async storageDirectory(): Promise<string> {
    return ensurePrivateDirectory(
      this.options.storageRoot,
      'GRAPHIFY_STORAGE_INVALID',
      'Scoped Graphify storage is unavailable'
    );
  }

  private async partitionDirectory(binding: RegisteredBinding): Promise<string> {
    const storage = await this.storageDirectory();
    return ensurePrivateDirectory(
      join(storage, binding.partitionKind, binding.partitionKey),
      'GRAPHIFY_STORAGE_INVALID',
      'Scoped Graphify storage is unavailable'
    );
  }

  private async processEnvironment(
    binding: RegisteredBinding | undefined,
    graphifyOut: string
  ): Promise<Readonly<Record<string, string>>> {
    const storage = await this.storageDirectory();
    const runtimeRoot = await ensurePrivateDirectory(
      binding === undefined
        ? join(storage, 'audit')
        : join(storage, binding.partitionKind, binding.partitionKey, 'runtime'),
      'GRAPHIFY_STORAGE_INVALID',
      'Scoped Graphify storage is unavailable'
    );
    const privateRuntimeDirectory = (name: string) =>
      ensurePrivateDirectory(
        join(runtimeRoot, name),
        'GRAPHIFY_STORAGE_INVALID',
        'Scoped Graphify storage is unavailable'
      );
    const [home, cache, configuration, temporary] = await Promise.all([
      privateRuntimeDirectory('home'),
      privateRuntimeDirectory('cache'),
      privateRuntimeDirectory('config'),
      privateRuntimeDirectory('tmp')
    ]);
    return {
      GRAPHIFY_NO_TIPS: '1',
      GRAPHIFY_OUT: graphifyOut,
      GRAPHIFY_QUERY_LOG_DISABLE: '1',
      HOME: home,
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
      PYTHONHASHSEED: '0',
      TMPDIR: temporary,
      TZ: 'UTC',
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: configuration
    };
  }

  private async auditedExecutable(): Promise<{
    audit: GraphifyRuntimeAudit;
    executablePath: string;
  }> {
    const storage = await this.storageDirectory();
    let executablePath: string;
    let executableSha256: string;
    try {
      const configured = await lstat(this.options.executable);
      if (!configured.isFile() && !configured.isSymbolicLink()) throw new Error('not executable');
      executablePath = await realpath(this.options.executable);
      const executable = await lstat(executablePath);
      if (
        executable.isSymbolicLink() ||
        !executable.isFile() ||
        executable.size > MAX_EXECUTABLE_BYTES ||
        (executable.mode & 0o111) === 0
      ) {
        throw new Error('not executable');
      }
      await access(executablePath, fsConstants.X_OK);
      executableSha256 = createHash('sha256')
        .update(await readFile(executablePath))
        .digest('hex');
    } catch {
      throw graphifyError(
        503,
        'GRAPHIFY_EXECUTABLE_INVALID',
        'Scoped Graphify runtime is unavailable'
      );
    }
    if (executableSha256 !== this.options.expectedExecutableSha256) {
      throw graphifyError(
        503,
        'GRAPHIFY_EXECUTABLE_MISMATCH',
        'Scoped Graphify runtime executable is not approved'
      );
    }

    let result: GraphifyProcessResult;
    try {
      result = await this.runner.run({
        executable: executablePath,
        args: ['--version'],
        cwd: storage,
        env: await this.processEnvironment(undefined, join(storage, 'audit', 'graphify-out')),
        timeoutMs: this.options.queryTimeoutMs,
        maxOutputBytes: AUDIT_OUTPUT_BYTES
      });
    } catch {
      throw graphifyError(
        503,
        'GRAPHIFY_EXECUTABLE_INVALID',
        'Scoped Graphify runtime is unavailable'
      );
    }
    if (
      result.termination !== null ||
      result.exitCode !== 0 ||
      combinedBytes(result) > AUDIT_OUTPUT_BYTES
    ) {
      throw graphifyError(
        503,
        'GRAPHIFY_EXECUTABLE_INVALID',
        'Scoped Graphify runtime is unavailable'
      );
    }
    const versionMatch = graphifyVersionOutputPattern.exec(result.stdout.toString('utf8').trim());
    if (versionMatch === null || versionMatch[1] !== this.options.expectedVersion) {
      throw graphifyError(
        503,
        'GRAPHIFY_VERSION_MISMATCH',
        'Scoped Graphify runtime version is not approved'
      );
    }
    return {
      audit: {
        runtime: 'graphify',
        version: versionMatch[1],
        executableSha256,
        checkedAt: this.now(),
        queryLogging: 'disabled'
      },
      executablePath
    };
  }

  async audit(): Promise<GraphifyRuntimeAudit> {
    return (await this.auditedExecutable()).audit;
  }

  private binding(rawPartition: KnowledgeGraphPartition): RegisteredBinding {
    const partition = KnowledgeGraphPartitionSchema.parse(rawPartition);
    const binding = this.bindings.get(partition);
    if (binding === undefined) {
      throw graphifyError(
        503,
        'GRAPHIFY_SCOPE_UNAVAILABLE',
        'Scoped Graphify partition is unavailable'
      );
    }
    return binding;
  }

  private async canonicalCorpus(binding: RegisteredBinding, inspectTree: boolean): Promise<string> {
    const clientBase = await requireCanonicalDirectory(this.options.clientRoot);
    let corpus: string;
    if (binding.scope.kind === 'client') {
      const expected = join(clientBase, binding.scope.subjectId);
      corpus = await requireCanonicalDirectory(expected);
      if (corpus !== expected || !isWithin(clientBase, corpus)) {
        throw graphifyError(
          503,
          'GRAPHIFY_CORPUS_INVALID',
          'Scoped Graphify corpus is unavailable'
        );
      }
    } else {
      if (binding.configuredCorpusRoot === undefined) {
        throw graphifyError(
          503,
          'GRAPHIFY_CORPUS_INVALID',
          'Scoped Graphify corpus is unavailable'
        );
      }
      corpus = await requireCanonicalDirectory(binding.configuredCorpusRoot);
      if (overlaps(clientBase, corpus)) {
        throw graphifyError(
          503,
          'GRAPHIFY_CORPUS_INVALID',
          'Scoped Graphify corpus is unavailable'
        );
      }
    }
    if (inspectTree) await assertSafeCorpusTree(corpus, this.options.maxCorpusEntries);
    return corpus;
  }

  async index(rawPartition: KnowledgeGraphPartition): Promise<GraphifyIndexAudit> {
    const binding = this.binding(rawPartition);
    const corpus = await this.canonicalCorpus(binding, true);
    const executable = await this.auditedExecutable();
    const partitionRoot = await this.partitionDirectory(binding);
    const stagingRoot = await ensurePrivateDirectory(
      join(partitionRoot, 'staging', randomUUID()),
      'GRAPHIFY_STORAGE_INVALID',
      'Scoped Graphify storage is unavailable'
    );
    try {
      let result: GraphifyProcessResult;
      try {
        result = await this.runner.run({
          executable: executable.executablePath,
          args: ['extract', corpus, '--out', stagingRoot, '--no-cluster', '--max-workers', '1'],
          cwd: partitionRoot,
          env: await this.processEnvironment(binding, join(stagingRoot, 'graphify-out')),
          timeoutMs: this.options.indexTimeoutMs,
          maxOutputBytes: this.options.maxIndexOutputBytes
        });
      } catch {
        throw graphifyError(502, 'GRAPHIFY_INDEX_FAILED', 'Scoped Graphify indexing failed');
      }
      if (
        result.termination !== null ||
        result.exitCode !== 0 ||
        combinedBytes(result) > this.options.maxIndexOutputBytes
      ) {
        throw graphifyError(502, 'GRAPHIFY_INDEX_FAILED', 'Scoped Graphify indexing failed');
      }

      const stagedGraph = await validateGraphFile(
        join(stagingRoot, 'graphify-out', 'graph.json'),
        this.options.maxGraphBytes,
        this.options.maxGraphItems
      );
      const graphDirectory = await ensurePrivateDirectory(
        join(partitionRoot, 'graphify-out'),
        'GRAPHIFY_STORAGE_INVALID',
        'Scoped Graphify storage is unavailable'
      );
      const graphPath = join(graphDirectory, 'graph.json');
      await assertSafePublishTarget(graphPath);
      await atomicPublish(graphPath, stagedGraph.content);
      return {
        graphPartition: binding.scope.graphPartition,
        graphifyVersion: executable.audit.version,
        graphSha256: stagedGraph.sha256,
        nodes: stagedGraph.nodes,
        edges: stagedGraph.edges,
        indexedAt: this.now()
      };
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  private async queryBinding(
    binding: RegisteredBinding,
    rawInput: KnowledgeAdapterQuery
  ): Promise<readonly unknown[]> {
    const input = AdapterQuerySchema.parse(rawInput);
    if (input.graphPartition !== binding.scope.graphPartition) {
      throw graphifyError(
        403,
        'GRAPHIFY_SCOPE_FORBIDDEN',
        'Scoped Graphify partition selection is forbidden'
      );
    }
    await this.canonicalCorpus(binding, false);
    const executable = await this.auditedExecutable();
    const partitionRoot = await this.partitionDirectory(binding);
    const graphPath = join(partitionRoot, 'graphify-out', 'graph.json');
    const graph = await validateGraphFile(
      graphPath,
      this.options.maxGraphBytes,
      this.options.maxGraphItems
    );
    const requestedBudget = input.limit * (input.projection === 'content' ? 128 : 48);
    const tokenBudget = Math.min(this.options.maxQueryTokenBudget, Math.max(64, requestedBudget));
    let result: GraphifyProcessResult;
    try {
      result = await this.runner.run({
        executable: executable.executablePath,
        args: ['query', input.text, '--budget', String(tokenBudget), '--graph', graphPath],
        cwd: partitionRoot,
        env: await this.processEnvironment(binding, join(partitionRoot, 'graphify-out')),
        timeoutMs: this.options.queryTimeoutMs,
        maxOutputBytes: this.options.maxQueryOutputBytes
      });
    } catch {
      throw graphifyError(502, 'GRAPHIFY_QUERY_FAILED', 'Scoped Graphify query failed');
    }
    if (combinedBytes(result) > this.options.maxQueryOutputBytes) {
      throw graphifyError(
        502,
        'GRAPHIFY_QUERY_OUTPUT_INVALID',
        'Scoped Graphify query output is invalid'
      );
    }
    if (result.termination !== null || result.exitCode !== 0) {
      throw graphifyError(502, 'GRAPHIFY_QUERY_FAILED', 'Scoped Graphify query failed');
    }
    return parseGraphifyOutput(
      result.stdout.toString('utf8'),
      input.graphPartition,
      input.projection,
      input.limit,
      graph.updatedAt,
      this.options.maxExcerptCharacters
    );
  }
}
