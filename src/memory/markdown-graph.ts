import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { link, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import {
  AgentRunSchema,
  AutomationIdSchema,
  ClientIdSchema,
  RunIdSchema,
  type AgentRun,
  type ClientProfile
} from '../config/schemas';
import { OperatorPageSpecSchema, type OperatorPageSpec } from '../dashboard/contracts';
import { AppError } from '../utils/errors';

export interface MarkdownGraphOptions {
  graphRoot: string;
  clientRoot?: string;
  now?: () => string;
}

export interface ClientNodeInput {
  id: string;
  name: string;
  profile: ClientProfile;
  createdAt: string;
  clientDirectory: string;
}

export interface RunMemoryInput {
  run: AgentRun;
  clientDirectory: string;
}

export interface GraphNode {
  id: string;
  type: string;
  title: string;
  path: string;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphIndex {
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface NoteMetadata {
  id: string;
  type: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
}

const GraphIndexSchema = z.strictObject({
  generatedAt: z.iso.datetime(),
  nodes: z.array(
    z.strictObject({
      id: z.string().min(1),
      type: z.string().min(1),
      title: z.string().min(1),
      path: z.string().min(1)
    })
  ),
  edges: z.array(
    z.strictObject({
      from: z.string().min(1),
      to: z.string().min(1)
    })
  )
});

const MAX_GRAPH_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_OPERATOR_PAGE_TRANSACTION_BYTES = 64 * 1024;

const OperatorPageTransactionSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal('create_operator_page'),
  page: OperatorPageSpecSchema
});

type OperatorPageTransaction = z.infer<typeof OperatorPageTransactionSchema>;

interface TextFileSnapshot {
  exists: boolean;
  content?: string;
}

const mutationQueues = new Map<string, Promise<void>>();

function serializeMutation<T>(graphRoot: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(graphRoot);
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  mutationQueues.set(key, tail);
  void tail.then(() => {
    if (mutationQueues.get(key) === tail) {
      mutationQueues.delete(key);
    }
  });
  return result;
}

function renderNote(metadata: NoteMetadata, body: string, extraFrontmatter: string[] = []): string {
  const tags = metadata.tags.map((tag) => `  - ${JSON.stringify(tag)}`).join('\n');
  return [
    '---',
    `id: ${JSON.stringify(metadata.id)}`,
    `type: ${JSON.stringify(metadata.type)}`,
    `title: ${JSON.stringify(metadata.title)}`,
    `created_at: ${JSON.stringify(metadata.createdAt)}`,
    `updated_at: ${JSON.stringify(metadata.updatedAt)}`,
    ...extraFrontmatter,
    'tags:',
    tags,
    '---',
    '',
    body.trim(),
    ''
  ].join('\n');
}

function unsafeMemoryPath(path: string): AppError {
  return new AppError(400, 'UNSAFE_MEMORY_PATH', `Memory path cannot traverse a symlink: ${path}`);
}

async function assertNoSymlinkTraversal(root: string, target: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const relativeTarget = relative(resolvedRoot, resolvedTarget);
  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw unsafeMemoryPath(target);
  }

  const components = relativeTarget.length === 0 ? [] : relativeTarget.split(sep);
  let current = resolvedRoot;
  for (const component of [undefined, ...components]) {
    if (component !== undefined) {
      current = join(current, component);
    }
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw unsafeMemoryPath(current);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

async function atomicWrite(root: string, filename: string, content: string): Promise<void> {
  await assertNoSymlinkTraversal(root, filename);
  await mkdir(dirname(filename), { recursive: true });
  await assertNoSymlinkTraversal(root, filename);
  const temporaryFile = join(dirname(filename), `.${basename(filename)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryFile, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryFile, filename);
  } catch (error) {
    await rm(temporaryFile, { force: true });
    throw error;
  }
}

async function atomicWriteIfMissing(
  root: string,
  filename: string,
  content: string
): Promise<void> {
  await assertNoSymlinkTraversal(root, filename);
  await mkdir(dirname(filename), { recursive: true });
  await assertNoSymlinkTraversal(root, filename);
  const temporaryFile = join(dirname(filename), `.${basename(filename)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryFile, content, { encoding: 'utf8', flag: 'wx' });
    try {
      await link(temporaryFile, filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      await assertNoSymlinkTraversal(root, filename);
    }
  } finally {
    await rm(temporaryFile, { force: true });
  }
}

async function collectMarkdownFiles(root: string, current = root): Promise<string[]> {
  await assertNoSymlinkTraversal(root, current);
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const filename = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw unsafeMemoryPath(filename);
    } else if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(root, filename)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(filename);
    }
  }
  return files.sort();
}

function readMetadataField(frontmatter: string, field: string): string {
  const matches = [...frontmatter.matchAll(new RegExp(`^${field}:\\s*(.+)$`, 'gm'))];
  if (matches.length === 0 || matches[0]?.[1] === undefined) {
    throw new AppError(500, 'INVALID_MEMORY_NOTE', `Memory note is missing ${field}`);
  }
  if (matches.length !== 1) {
    throw new AppError(500, 'INVALID_MEMORY_NOTE', `Memory note has duplicate ${field}`);
  }
  try {
    const value = JSON.parse(matches[0][1]) as unknown;
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('Metadata field is not a string');
    }
    return value;
  } catch {
    throw new AppError(500, 'INVALID_MEMORY_NOTE', `Memory note has invalid ${field}`);
  }
}

function readMetadataTags(frontmatter: string): string[] {
  const lines = frontmatter.split('\n');
  const tagLines = lines
    .map((line, index) => ({ line, index, match: /^tags:\s*(.*)$/.exec(line) }))
    .filter(({ match }) => match !== null);
  if (tagLines.length === 0) {
    throw new AppError(500, 'INVALID_MEMORY_NOTE', 'Memory note is missing tags');
  }
  if (tagLines.length !== 1) {
    throw new AppError(500, 'INVALID_MEMORY_NOTE', 'Memory note has duplicate tags');
  }

  const tagLine = tagLines[0];
  if (tagLine === undefined || tagLine.match?.[1] === undefined) {
    throw new AppError(500, 'INVALID_MEMORY_NOTE', 'Memory note has invalid tags');
  }
  const inlineValue = tagLine.match[1].trim();
  let values: unknown[];
  try {
    if (inlineValue.length > 0) {
      const parsed = JSON.parse(inlineValue) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('Tags are not an array');
      }
      values = parsed;
    } else {
      values = [];
      for (const line of lines.slice(tagLine.index + 1)) {
        if (!line.startsWith(' ')) {
          break;
        }
        const item = /^\s+-\s+(.+)$/.exec(line);
        if (item?.[1] === undefined) {
          throw new Error('Tag list item is malformed');
        }
        values.push(JSON.parse(item[1]) as unknown);
      }
    }
    if (!values.every((value) => typeof value === 'string' && value.length > 0)) {
      throw new Error('Tags must be non-empty strings');
    }
    return values as string[];
  } catch {
    throw new AppError(500, 'INVALID_MEMORY_NOTE', 'Memory note has invalid tags');
  }
}

function readMetadataJsonField(frontmatter: string, field: string): unknown {
  const matches = [...frontmatter.matchAll(new RegExp(`^${field}:\\s*(.+)$`, 'gm'))];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new AppError(500, 'INVALID_DASHBOARD_PAGE', `Dashboard page has invalid ${field}`);
  }
  try {
    return JSON.parse(matches[0][1]) as unknown;
  } catch {
    throw new AppError(500, 'INVALID_DASHBOARD_PAGE', `Dashboard page has invalid ${field}`);
  }
}

function neutralizeWikiLinks(value: string): string {
  return value.replaceAll('[', '&#91;').replaceAll(']', '&#93;');
}

function safeInlineText(value: string): string {
  return neutralizeWikiLinks(value).replaceAll('`', "'").replaceAll(/\s+/g, ' ').trim();
}

function safeMarkdownText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('[', '&#91;')
    .replaceAll(']', '&#93;')
    .replaceAll('`', "'")
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function serializeJsonForMarkdown(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

function parseOperatorPage(filename: string, graphRoot: string, content: string): OperatorPageSpec {
  const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(content);
  if (frontmatterMatch?.[1] === undefined) {
    throw new AppError(500, 'INVALID_DASHBOARD_PAGE', 'Dashboard page has no frontmatter');
  }
  try {
    const note = parseNote(filename, graphRoot, content).node;
    const page = OperatorPageSpecSchema.parse(
      readMetadataJsonField(frontmatterMatch[1], 'dashboard_manifest')
    );
    if (
      note.id !== `pages/${page.slug}` ||
      note.type !== 'operator-page' ||
      note.title !== page.title ||
      note.path !== `pages/${page.slug}.md`
    ) {
      throw new Error('Dashboard page metadata does not match its manifest');
    }
    return page;
  } catch (error) {
    if (error instanceof AppError && error.code === 'UNSAFE_MEMORY_PATH') {
      throw error;
    }
    throw new AppError(500, 'INVALID_DASHBOARD_PAGE', 'Dashboard page manifest is invalid');
  }
}

function samePagePlan(left: OperatorPageSpec, right: OperatorPageSpec): boolean {
  return (
    left.version === right.version &&
    left.slug === right.slug &&
    left.title === right.title &&
    left.request === right.request &&
    left.planFingerprint === right.planFingerprint &&
    left.widgets.length === right.widgets.length &&
    left.widgets.every((widget, index) => widget === right.widgets[index])
  );
}

function renderOperatorPage(page: OperatorPageSpec): string {
  return renderNote(
    {
      id: `pages/${page.slug}`,
      type: 'operator-page',
      title: page.title,
      createdAt: page.createdAt,
      updatedAt: page.createdAt,
      tags: ['dashboard', 'operator-page', ...page.widgets]
    },
    [
      `# ${safeMarkdownText(page.title)}`,
      '',
      'Parent: [[pages/index]]',
      '',
      `Request: ${safeMarkdownText(page.request)}`,
      '',
      'Widgets:',
      ...page.widgets.map((widget) => `- \`${widget}\``),
      '',
      `Plan fingerprint: \`${page.planFingerprint}\``
    ].join('\n'),
    [`dashboard_manifest: ${serializeJsonForMarkdown(page)}`]
  );
}

function operatorPageTransactionPath(graphRoot: string, slug: string): string {
  return join(graphRoot, '.transactions', `operator-page-${slug}.json`);
}

async function snapshotTextFile(root: string, filename: string): Promise<TextFileSnapshot> {
  await assertNoSymlinkTraversal(root, filename);
  try {
    return { exists: true, content: await readFile(filename, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false };
    }
    throw error;
  }
}

async function restoreTextFile(
  root: string,
  filename: string,
  snapshot: TextFileSnapshot
): Promise<void> {
  await assertNoSymlinkTraversal(root, filename);
  if (snapshot.exists) {
    if (snapshot.content === undefined) {
      throw new Error(`Snapshot for ${filename} has no content`);
    }
    await atomicWrite(root, filename, snapshot.content);
    return;
  }
  await rm(filename, { force: true });
}

async function readOperatorPageTransaction(
  graphRoot: string,
  filename: string
): Promise<OperatorPageTransaction> {
  await assertNoSymlinkTraversal(graphRoot, filename);
  try {
    const content = await readFile(filename, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_OPERATOR_PAGE_TRANSACTION_BYTES) {
      throw new Error('Operator page transaction exceeds its read bound');
    }
    const transaction = OperatorPageTransactionSchema.parse(JSON.parse(content) as unknown);
    if (basename(filename) !== `operator-page-${transaction.page.slug}.json`) {
      throw new Error('Operator page transaction filename does not match its manifest');
    }
    return transaction;
  } catch (error) {
    if (error instanceof AppError && error.code === 'UNSAFE_MEMORY_PATH') {
      throw error;
    }
    throw new AppError(
      500,
      'INVALID_OPERATOR_PAGE_TRANSACTION',
      'Operator page publication journal is invalid'
    );
  }
}

async function appendWikiLink(root: string, filename: string, link: string): Promise<void> {
  await assertNoSymlinkTraversal(root, filename);
  const content = await readFile(filename, 'utf8');
  if (!content.includes(link)) {
    await atomicWrite(root, filename, `${content.trimEnd()}\n${link}\n`);
  }
}

function parseNote(
  filename: string,
  root: string,
  content: string
): {
  node: GraphNode;
  links: string[];
} {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (match?.[1] === undefined) {
    throw new AppError(500, 'INVALID_MEMORY_NOTE', `Memory note ${filename} has no frontmatter`);
  }
  const frontmatter = match[1];
  readMetadataField(frontmatter, 'created_at');
  readMetadataField(frontmatter, 'updated_at');
  readMetadataTags(frontmatter);
  const noteBody = content.slice(match[0].length);
  const links = [...noteBody.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g)].map((link) =>
    (link[1] ?? '').trim()
  );
  return {
    node: {
      id: readMetadataField(frontmatter, 'id'),
      type: readMetadataField(frontmatter, 'type'),
      title: readMetadataField(frontmatter, 'title'),
      path: relative(root, filename).split(sep).join('/')
    },
    links: [...new Set(links)].sort()
  };
}

export class MarkdownGraph {
  private readonly now: () => string;

  constructor(private readonly options: MarkdownGraphOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  initialize(): Promise<void> {
    return serializeMutation(this.options.graphRoot, () => this.initializeUnlocked());
  }

  private async initializeUnlocked(): Promise<void> {
    const timestamp = this.now();
    await atomicWriteIfMissing(
      this.options.graphRoot,
      join(this.options.graphRoot, 'index.md'),
      renderNote(
        {
          id: 'index',
          type: 'index',
          title: 'Jarvis Memory Graph',
          createdAt: timestamp,
          updatedAt: timestamp,
          tags: ['memory', 'index']
        },
        '# Jarvis Memory Graph\n\n- [[agency/jarvis]]\n- [[clients/index]]'
      )
    );
    await atomicWriteIfMissing(
      this.options.graphRoot,
      join(this.options.graphRoot, 'agency', 'jarvis.md'),
      renderNote(
        {
          id: 'agency/jarvis',
          type: 'agency',
          title: 'Jarvis',
          createdAt: timestamp,
          updatedAt: timestamp,
          tags: ['agency', 'jarvis']
        },
        '# Jarvis\n\nParent: [[index]]'
      )
    );
    await atomicWriteIfMissing(
      this.options.graphRoot,
      join(this.options.graphRoot, 'clients', 'index.md'),
      renderNote(
        {
          id: 'clients/index',
          type: 'index',
          title: 'Client Registry',
          createdAt: timestamp,
          updatedAt: timestamp,
          tags: ['clients', 'index']
        },
        '# Client Registry\n\nParent: [[index]]'
      )
    );
    await this.recoverOperatorPageTransactionsUnlocked();
  }

  createClientNode(input: ClientNodeInput): Promise<void> {
    return serializeMutation(this.options.graphRoot, () => this.createClientNodeUnlocked(input));
  }

  private async createClientNodeUnlocked(input: ClientNodeInput): Promise<void> {
    const id = ClientIdSchema.parse(input.id);
    this.assertClientDirectory(id, input.clientDirectory);
    const clientNode = join(this.options.graphRoot, 'clients', `${id}.md`);
    const clientsIndex = join(this.options.graphRoot, 'clients', 'index.md');
    const privateIndex = join(input.clientDirectory, 'memory', 'notes', 'index.md');
    await Promise.all([
      assertNoSymlinkTraversal(this.options.graphRoot, clientNode),
      assertNoSymlinkTraversal(this.options.graphRoot, clientsIndex),
      assertNoSymlinkTraversal(input.clientDirectory, privateIndex)
    ]);
    await this.initializeUnlocked();
    const safeName = neutralizeWikiLinks(input.name);
    await atomicWrite(
      this.options.graphRoot,
      clientNode,
      renderNote(
        {
          id: `clients/${id}`,
          type: 'client',
          title: safeName,
          createdAt: input.createdAt,
          updatedAt: this.now(),
          tags: ['client', input.profile]
        },
        [
          `# ${safeName}`,
          '',
          'Parent: [[clients/index]]',
          '',
          `Profile: \`${input.profile}\``,
          '',
          `Private memory root: \`clients/${id}/memory/notes/\``
        ].join('\n')
      )
    );

    const link = `- [[clients/${id}]]`;
    await assertNoSymlinkTraversal(this.options.graphRoot, clientsIndex);
    const indexContent = await readFile(clientsIndex, 'utf8');
    if (!indexContent.includes(link)) {
      await atomicWrite(
        this.options.graphRoot,
        clientsIndex,
        `${indexContent.trimEnd()}\n${link}\n`
      );
    }

    await atomicWriteIfMissing(
      input.clientDirectory,
      privateIndex,
      renderNote(
        {
          id: `tenant/${id}/index`,
          type: 'tenant-memory',
          title: `${safeName} Private Memory`,
          createdAt: input.createdAt,
          updatedAt: this.now(),
          tags: ['tenant-private', id]
        },
        [
          `# ${safeName} Private Memory`,
          '',
          'Tenant-private Markdown memory. Do not link client content into the global graph.',
          '',
          `Global metadata node: \`memory/graph/clients/${id}.md\``
        ].join('\n')
      )
    );
  }

  recordRun(input: RunMemoryInput): Promise<void> {
    return serializeMutation(this.options.graphRoot, () => this.recordRunUnlocked(input));
  }

  private async recordRunUnlocked(input: RunMemoryInput): Promise<void> {
    const run = AgentRunSchema.parse(input.run);
    const runId = RunIdSchema.parse(run.id);
    const clientId = ClientIdSchema.parse(run.clientId);
    this.assertClientDirectory(clientId, input.clientDirectory);
    const automation = AutomationIdSchema.parse(run.automation);
    if (!['succeeded', 'failed'].includes(run.status) || run.completedAt === null) {
      throw new AppError(
        400,
        'RUN_NOT_COMPLETED',
        'Only completed runs can be written to Markdown memory'
      );
    }

    const graphIndex = join(this.options.graphRoot, 'index.md');
    const clientNode = join(this.options.graphRoot, 'clients', `${clientId}.md`);
    const automationsIndex = join(this.options.graphRoot, 'automations', 'index.md');
    const automationNode = join(
      this.options.graphRoot,
      'automations',
      clientId,
      `${automation}.md`
    );
    const runsIndex = join(this.options.graphRoot, 'runs', 'index.md');
    const runNode = join(this.options.graphRoot, 'runs', `${runId}.md`);
    const privateIndex = join(input.clientDirectory, 'memory', 'notes', 'index.md');
    const privateRun = join(input.clientDirectory, 'memory', 'notes', 'runs', `${runId}.md`);
    await Promise.all([
      assertNoSymlinkTraversal(this.options.graphRoot, graphIndex),
      assertNoSymlinkTraversal(this.options.graphRoot, clientNode),
      assertNoSymlinkTraversal(this.options.graphRoot, automationsIndex),
      assertNoSymlinkTraversal(this.options.graphRoot, automationNode),
      assertNoSymlinkTraversal(this.options.graphRoot, runsIndex),
      assertNoSymlinkTraversal(this.options.graphRoot, runNode),
      assertNoSymlinkTraversal(input.clientDirectory, privateIndex),
      assertNoSymlinkTraversal(input.clientDirectory, privateRun)
    ]);

    await this.initializeUnlocked();
    try {
      await readFile(clientNode, 'utf8');
    } catch {
      throw new AppError(
        404,
        'MEMORY_CLIENT_NOT_FOUND',
        `Markdown client node ${clientId} was not found`
      );
    }

    const timestamp = this.now();
    await atomicWriteIfMissing(
      this.options.graphRoot,
      automationsIndex,
      renderNote(
        {
          id: 'automations/index',
          type: 'index',
          title: 'Automation Registry',
          createdAt: timestamp,
          updatedAt: timestamp,
          tags: ['automations', 'index']
        },
        '# Automation Registry\n\nParent: [[index]]'
      )
    );
    await appendWikiLink(this.options.graphRoot, graphIndex, '- [[automations/index]]');

    await atomicWriteIfMissing(
      this.options.graphRoot,
      runsIndex,
      renderNote(
        {
          id: 'runs/index',
          type: 'index',
          title: 'Run Registry',
          createdAt: timestamp,
          updatedAt: timestamp,
          tags: ['runs', 'index']
        },
        '# Run Registry\n\nParent: [[index]]'
      )
    );
    await appendWikiLink(this.options.graphRoot, graphIndex, '- [[runs/index]]');

    const automationId = `automations/${clientId}/${automation}`;
    await atomicWriteIfMissing(
      this.options.graphRoot,
      automationNode,
      renderNote(
        {
          id: automationId,
          type: 'automation',
          title: automation,
          createdAt: timestamp,
          updatedAt: timestamp,
          tags: ['automation', clientId]
        },
        [
          `# ${automation}`,
          '',
          'Parent: [[automations/index]]',
          '',
          `Client: [[clients/${clientId}]]`
        ].join('\n')
      )
    );
    await appendWikiLink(this.options.graphRoot, automationsIndex, `- [[${automationId}]]`);

    const worker = safeInlineText(run.workerId ?? 'unassigned');
    await atomicWrite(
      this.options.graphRoot,
      runNode,
      renderNote(
        {
          id: `runs/${runId}`,
          type: 'run',
          title: `Run ${runId}`,
          createdAt: run.startedAt,
          updatedAt: run.completedAt,
          tags: ['run', run.status, clientId, automation]
        },
        [
          `# Run ${runId}`,
          '',
          'Parent: [[runs/index]]',
          '',
          `Client: [[clients/${clientId}]]`,
          '',
          `Automation: [[${automationId}]]`,
          '',
          `Status: \`${run.status}\``,
          '',
          `Worker: \`${worker}\``,
          '',
          `Started: \`${run.startedAt}\``,
          '',
          `Completed: \`${run.completedAt}\``
        ].join('\n')
      )
    );
    await appendWikiLink(this.options.graphRoot, runsIndex, `- [[runs/${runId}]]`);

    await atomicWrite(
      input.clientDirectory,
      privateRun,
      renderNote(
        {
          id: `tenant/${clientId}/runs/${runId}`,
          type: 'tenant-run',
          title: `Run ${runId}`,
          createdAt: run.startedAt,
          updatedAt: run.completedAt,
          tags: ['tenant-private', 'run', run.status]
        },
        [
          `# Run ${runId}`,
          '',
          'Parent: [[index]]',
          '',
          `Automation: \`${automation}\``,
          '',
          `Status: \`${run.status}\``,
          '',
          `Worker: \`${worker}\``
        ].join('\n')
      )
    );
    await appendWikiLink(input.clientDirectory, privateIndex, `- [[runs/${runId}]]`);
  }

  private assertClientDirectory(clientId: string, clientDirectory: string): void {
    const resolvedDirectory = resolve(clientDirectory);
    const expectedDirectory =
      this.options.clientRoot === undefined
        ? undefined
        : resolve(this.options.clientRoot, clientId);
    if (
      basename(resolvedDirectory) !== clientId ||
      (expectedDirectory !== undefined && resolvedDirectory !== expectedDirectory)
    ) {
      throw new AppError(
        400,
        'TENANT_MEMORY_MISMATCH',
        `Private memory directory does not match client ${clientId}`
      );
    }
  }

  removeClientNode(idInput: string): Promise<void> {
    return serializeMutation(this.options.graphRoot, () => this.removeClientNodeUnlocked(idInput));
  }

  private async removeClientNodeUnlocked(idInput: string): Promise<void> {
    const id = ClientIdSchema.parse(idInput);
    const clientNode = join(this.options.graphRoot, 'clients', `${id}.md`);
    const clientsIndex = join(this.options.graphRoot, 'clients', 'index.md');
    await Promise.all([
      assertNoSymlinkTraversal(this.options.graphRoot, clientNode),
      assertNoSymlinkTraversal(this.options.graphRoot, clientsIndex)
    ]);
    await rm(clientNode, { force: true });
    const content = await readFile(clientsIndex, 'utf8');
    const link = `- [[clients/${id}]]`;
    const updated = content
      .split('\n')
      .filter((line) => line.trim() !== link)
      .join('\n');
    await atomicWrite(
      this.options.graphRoot,
      clientsIndex,
      updated.endsWith('\n') ? updated : `${updated}\n`
    );
  }

  createOperatorPage(
    input: OperatorPageSpec
  ): Promise<{ created: boolean; page: OperatorPageSpec }> {
    return serializeMutation(this.options.graphRoot, () => this.createOperatorPageUnlocked(input));
  }

  private async createOperatorPageUnlocked(
    input: OperatorPageSpec
  ): Promise<{ created: boolean; page: OperatorPageSpec }> {
    const page = OperatorPageSpecSchema.parse(input);
    const graphIndex = join(this.options.graphRoot, 'index.md');
    const pagesIndex = join(this.options.graphRoot, 'pages', 'index.md');
    const pageNote = join(this.options.graphRoot, 'pages', `${page.slug}.md`);
    const generatedIndex = join(this.options.graphRoot, 'graph.json');
    const transactionFile = operatorPageTransactionPath(this.options.graphRoot, page.slug);
    await Promise.all([
      assertNoSymlinkTraversal(this.options.graphRoot, graphIndex),
      assertNoSymlinkTraversal(this.options.graphRoot, pagesIndex),
      assertNoSymlinkTraversal(this.options.graphRoot, pageNote),
      assertNoSymlinkTraversal(this.options.graphRoot, generatedIndex),
      assertNoSymlinkTraversal(this.options.graphRoot, transactionFile)
    ]);
    await this.initializeUnlocked();
    const content = renderOperatorPage(page);
    let existingPage: OperatorPageSpec | undefined;
    try {
      const existingContent = await readFile(pageNote, 'utf8');
      existingPage = parseOperatorPage(pageNote, this.options.graphRoot, existingContent);
      if (!samePagePlan(existingPage, page)) {
        throw new AppError(
          409,
          'DASHBOARD_PAGE_EXISTS',
          `Dashboard page ${page.slug} already exists with a different plan`
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    const transaction: OperatorPageTransaction = {
      version: 1,
      operation: 'create_operator_page',
      page
    };
    if (existingPage !== undefined) {
      await atomicWrite(
        this.options.graphRoot,
        transactionFile,
        `${JSON.stringify(transaction)}\n`
      );
      const repairedPage = await this.ensureOperatorPagePublishedUnlocked(page, content);
      await rm(transactionFile);
      return { created: false, page: repairedPage };
    }

    const [graphIndexSnapshot, pagesIndexSnapshot, generatedIndexSnapshot] = await Promise.all([
      snapshotTextFile(this.options.graphRoot, graphIndex),
      snapshotTextFile(this.options.graphRoot, pagesIndex),
      snapshotTextFile(this.options.graphRoot, generatedIndex)
    ]);
    await atomicWrite(this.options.graphRoot, transactionFile, `${JSON.stringify(transaction)}\n`);

    let publishedPage: OperatorPageSpec;
    try {
      publishedPage = await this.ensureOperatorPagePublishedUnlocked(page, content);
    } catch (error) {
      const rollbackErrors = await this.rollbackOperatorPagePublicationUnlocked({
        page,
        content,
        pageNote,
        graphIndex,
        pagesIndex,
        generatedIndex,
        transactionFile,
        graphIndexSnapshot,
        pagesIndexSnapshot,
        generatedIndexSnapshot
      });
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Dashboard page ${page.slug} publication and rollback failed`
        );
      }
      throw error;
    }

    await rm(transactionFile);
    return { created: true, page: publishedPage };
  }

  private async ensureOperatorPagePublishedUnlocked(
    page: OperatorPageSpec,
    content = renderOperatorPage(page)
  ): Promise<OperatorPageSpec> {
    const graphIndex = join(this.options.graphRoot, 'index.md');
    const pagesIndex = join(this.options.graphRoot, 'pages', 'index.md');
    const pageNote = join(this.options.graphRoot, 'pages', `${page.slug}.md`);
    await atomicWriteIfMissing(
      this.options.graphRoot,
      pagesIndex,
      renderNote(
        {
          id: 'pages/index',
          type: 'index',
          title: 'Operator Pages',
          createdAt: page.createdAt,
          updatedAt: page.createdAt,
          tags: ['dashboard', 'pages', 'index']
        },
        '# Operator Pages\n\nParent: [[index]]'
      )
    );
    await appendWikiLink(this.options.graphRoot, graphIndex, '- [[pages/index]]');
    await atomicWriteIfMissing(this.options.graphRoot, pageNote, content);
    const publishedPage = parseOperatorPage(
      pageNote,
      this.options.graphRoot,
      await readFile(pageNote, 'utf8')
    );
    if (!samePagePlan(publishedPage, page)) {
      throw new AppError(
        409,
        'DASHBOARD_PAGE_EXISTS',
        `Dashboard page ${page.slug} already exists with a different plan`
      );
    }
    await appendWikiLink(this.options.graphRoot, pagesIndex, `- [[pages/${page.slug}]]`);
    await this.rebuildUnlocked();
    return publishedPage;
  }

  private async rollbackOperatorPagePublicationUnlocked(input: {
    page: OperatorPageSpec;
    content: string;
    pageNote: string;
    graphIndex: string;
    pagesIndex: string;
    generatedIndex: string;
    transactionFile: string;
    graphIndexSnapshot: TextFileSnapshot;
    pagesIndexSnapshot: TextFileSnapshot;
    generatedIndexSnapshot: TextFileSnapshot;
  }): Promise<unknown[]> {
    const errors: unknown[] = [];
    try {
      const current = await readFile(input.pageNote, 'utf8');
      if (current !== input.content) {
        throw new Error(`Dashboard page ${input.page.slug} changed during rollback`);
      }
      await rm(input.pageNote);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        errors.push(error);
      }
    }
    for (const [filename, snapshot] of [
      [input.graphIndex, input.graphIndexSnapshot],
      [input.pagesIndex, input.pagesIndexSnapshot],
      [input.generatedIndex, input.generatedIndexSnapshot]
    ] as const) {
      try {
        await restoreTextFile(this.options.graphRoot, filename, snapshot);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 0) {
      try {
        await rm(input.transactionFile, { force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private async recoverOperatorPageTransactionsUnlocked(): Promise<void> {
    const transactionRoot = join(this.options.graphRoot, '.transactions');
    await assertNoSymlinkTraversal(this.options.graphRoot, transactionRoot);
    let entries: Dirent[];
    try {
      entries = await readdir(transactionRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const filename = join(transactionRoot, entry.name);
      if (entry.isSymbolicLink()) {
        throw unsafeMemoryPath(filename);
      }
      if (entry.isFile() && entry.name.startsWith('.') && entry.name.endsWith('.tmp')) {
        await rm(filename);
        continue;
      }
      if (!entry.isFile() || !/^operator-page-[a-z][a-z0-9-]{2,47}\.json$/.test(entry.name)) {
        throw new AppError(
          500,
          'INVALID_OPERATOR_PAGE_TRANSACTION',
          'Operator page transaction directory contains an unsupported entry'
        );
      }
      const transaction = await readOperatorPageTransaction(this.options.graphRoot, filename);
      await this.ensureOperatorPagePublishedUnlocked(transaction.page);
      await rm(filename);
    }
  }

  listOperatorPages(): Promise<OperatorPageSpec[]> {
    return serializeMutation(this.options.graphRoot, () => this.listOperatorPagesUnlocked());
  }

  private async listOperatorPagesUnlocked(): Promise<OperatorPageSpec[]> {
    const pagesRoot = join(this.options.graphRoot, 'pages');
    await assertNoSymlinkTraversal(this.options.graphRoot, pagesRoot);
    let entries: Dirent[];
    try {
      entries = await readdir(pagesRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const pages: OperatorPageSpec[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === 'index.md') {
        continue;
      }
      const filename = join(pagesRoot, entry.name);
      if (entry.isSymbolicLink()) {
        throw unsafeMemoryPath(filename);
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        throw new AppError(
          500,
          'INVALID_DASHBOARD_PAGE',
          'Dashboard pages directory contains an unsupported entry'
        );
      }
      pages.push(
        parseOperatorPage(filename, this.options.graphRoot, await readFile(filename, 'utf8'))
      );
    }
    return pages.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.slug.localeCompare(right.slug)
    );
  }

  readIndex(): Promise<GraphIndex> {
    return serializeMutation(this.options.graphRoot, () => this.readIndexUnlocked());
  }

  private async readIndexUnlocked(): Promise<GraphIndex> {
    const filename = join(this.options.graphRoot, 'graph.json');
    await assertNoSymlinkTraversal(this.options.graphRoot, filename);
    try {
      const content = await readFile(filename, 'utf8');
      if (Buffer.byteLength(content, 'utf8') > MAX_GRAPH_INDEX_BYTES) {
        throw new Error('Memory graph index exceeds its read bound');
      }
      const index = GraphIndexSchema.parse(JSON.parse(content) as unknown);
      const nodeIds = new Set(index.nodes.map((node) => node.id));
      if (
        nodeIds.size !== index.nodes.length ||
        index.edges.some((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))
      ) {
        throw new Error('Memory graph index adjacency is invalid');
      }
      return index;
    } catch (error) {
      if (error instanceof AppError && error.code === 'UNSAFE_MEMORY_PATH') {
        throw error;
      }
      throw new AppError(
        500,
        'INVALID_MEMORY_GRAPH_INDEX',
        'Generated Markdown graph index is invalid'
      );
    }
  }

  rebuild(): Promise<GraphIndex> {
    return serializeMutation(this.options.graphRoot, () => this.rebuildUnlocked());
  }

  private async rebuildUnlocked(): Promise<GraphIndex> {
    await assertNoSymlinkTraversal(this.options.graphRoot, this.options.graphRoot);
    const files = await collectMarkdownFiles(this.options.graphRoot);
    const parsed = await Promise.all(
      files.map(async (filename) =>
        parseNote(filename, this.options.graphRoot, await readFile(filename, 'utf8'))
      )
    );
    const nodeIds = new Set<string>();
    for (const { node } of parsed) {
      if (nodeIds.has(node.id)) {
        throw new AppError(
          500,
          'DUPLICATE_MEMORY_NODE',
          `Memory graph contains duplicate node id ${node.id}`
        );
      }
      nodeIds.add(node.id);
    }
    const edges: GraphEdge[] = [];
    for (const note of parsed) {
      for (const target of note.links) {
        if (!nodeIds.has(target)) {
          throw new AppError(
            500,
            'BROKEN_MEMORY_LINK',
            `Memory note ${note.node.id} links to missing node ${target}`
          );
        }
        edges.push({ from: note.node.id, to: target });
      }
    }
    const index: GraphIndex = {
      generatedAt: this.now(),
      nodes: parsed.map(({ node }) => node).sort((left, right) => left.id.localeCompare(right.id)),
      edges: edges.sort((left, right) =>
        `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`)
      )
    };
    await atomicWrite(
      this.options.graphRoot,
      join(this.options.graphRoot, 'graph.json'),
      `${JSON.stringify(index, null, 2)}\n`
    );
    return index;
  }
}
