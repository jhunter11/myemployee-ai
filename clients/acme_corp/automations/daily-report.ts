import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import type { TransactionalWorker, WorkerContext } from '../../../src/agents/contracts';
import { ClientIdSchema, RunIdSchema } from '../../../src/config/schemas';

const WORKER_ID = 'acme_daily_report';
const SOURCE_ROW_COUNT = 10;
const CSV_HEADER = 'id,name,email,status';
const MAX_CSV_BYTES = 64 * 1024;
const MAX_REPORT_BYTES = 256 * 1024;
const MAX_JOURNAL_BYTES = 16 * 1024;
const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const LEAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const EMAIL_PATTERN = /^[^\s,@]+@[^\s,@]+\.[^\s,@]+$/;
const VALID_STATUSES = new Set(['new', 'contacted', 'qualified', 'disqualified']);

export type DailyReportLead = {
  id: string;
  name: string;
  email: string;
  status: string;
};

export type DailyReport = {
  generatedAt: string;
  sourceRows: number;
  qualifiedCount: number;
  qualifiedLeads: DailyReportLead[];
};

interface DirectoryBoundary {
  path: string;
  canonicalPath: string;
  dev: number;
  ino: number;
}

interface TenantBoundaries {
  root: DirectoryBoundary;
  client: DirectoryBoundary;
  data: DirectoryBoundary;
}

interface PreparedReport {
  runId: string;
  boundaries: DirectoryBoundary[];
  stagePath: string;
  backupPath: string;
  journalPath: string;
  reportPath: string;
  committed: boolean;
  hadPrevious: boolean;
  candidateSha256: string;
  candidateBytes: number;
  previousSha256: string | null;
  previousBytes: number | null;
  state: ArtifactJournal['state'];
  commitOperation?: Promise<void>;
  finalization?: Promise<void>;
  releaseArtifact: () => void;
}

const ArtifactJournalSchema = z
  .strictObject({
    version: z.literal(1),
    runId: RunIdSchema,
    stageName: z.string().min(1).max(255),
    backupName: z.string().min(1).max(255),
    hadPrevious: z.boolean(),
    candidateSha256: z.string().regex(/^[a-f0-9]{64}$/),
    candidateBytes: z.number().int().nonnegative().max(MAX_REPORT_BYTES),
    previousSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    previousBytes: z.number().int().nonnegative().max(MAX_REPORT_BYTES).nullable(),
    state: z.enum(['staged', 'committing', 'committed'])
  })
  .superRefine((journal, context) => {
    const hasPreviousMetadata = journal.previousSha256 !== null && journal.previousBytes !== null;
    if (journal.hadPrevious !== hasPreviousMetadata) {
      context.addIssue({
        code: 'custom',
        message: 'Previous report metadata must match hadPrevious'
      });
    }
  });

type ArtifactJournal = z.infer<typeof ArtifactJournalSchema>;

export type DailyReportRecoveryAction = {
  runId: string;
  action: 'kept' | 'rolled_back';
};

export interface DailyReportRecoveryOptions {
  clientRoot: string;
  findRunStatus(runId: string): Promise<'pending' | 'running' | 'succeeded' | 'failed' | undefined>;
  markRunInterrupted?(runId: string): Promise<void>;
}

const preparedReports = new Map<string, PreparedReport>();

interface ArtifactQueue {
  tail: Promise<void>;
  depth: number;
}

const artifactQueues = new Map<string, ArtifactQueue>();

async function acquireArtifactLease(artifactPath: string): Promise<() => void> {
  const queue = artifactQueues.get(artifactPath) ?? {
    tail: Promise.resolve(),
    depth: 0
  };
  const previous = queue.tail;
  let unlock = (): void => undefined;
  const gate = new Promise<void>((resolveGate) => {
    unlock = resolveGate;
  });
  queue.tail = previous.then(() => gate);
  queue.depth += 1;
  artifactQueues.set(artifactPath, queue);
  await previous;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    queue.depth -= 1;
    unlock();
    if (queue.depth === 0 && artifactQueues.get(artifactPath) === queue) {
      artifactQueues.delete(artifactPath);
    }
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function artifactNonce(): string {
  return randomUUID().replaceAll('-', '');
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function expectedJournalName(runId: string): string {
  return `.report.${runId}.transaction.json`;
}

function assertArtifactLeaf(filename: string, runId: string, suffix: 'pending' | 'backup'): void {
  const pattern = new RegExp(`^\\.report\\.${runId}\\.[a-f0-9]{32}\\.${suffix}$`);
  if (basename(filename) !== filename || !pattern.test(filename)) {
    throw new Error(`Daily report transaction has an invalid ${suffix} filename`);
  }
}

function journalFor(prepared: PreparedReport, state = prepared.state): ArtifactJournal {
  return ArtifactJournalSchema.parse({
    version: 1,
    runId: prepared.runId,
    stageName: basename(prepared.stagePath),
    backupName: basename(prepared.backupPath),
    hadPrevious: prepared.hadPrevious,
    candidateSha256: prepared.candidateSha256,
    candidateBytes: prepared.candidateBytes,
    previousSha256: prepared.previousSha256,
    previousBytes: prepared.previousBytes,
    state
  });
}

function serializeJournal(journal: ArtifactJournal): Buffer {
  return Buffer.from(`${JSON.stringify(journal, null, 2)}\n`);
}

function sameIdentity(left: Stats, right: DirectoryBoundary): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function captureRealDirectory(directory: string, label: string): Promise<DirectoryBoundary> {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory and not a symlink`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  return {
    path: directory,
    canonicalPath: await realpath(directory),
    dev: metadata.dev,
    ino: metadata.ino
  };
}

async function assertDirectoryUnchanged(boundary: DirectoryBoundary, label: string): Promise<void> {
  const current = await lstat(boundary.path);
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameIdentity(current, boundary) ||
    (await realpath(boundary.path)) !== boundary.canonicalPath
  ) {
    throw new Error(`${label} changed during daily report execution`);
  }
}

async function assertBoundariesUnchanged(boundaries: DirectoryBoundary[]): Promise<void> {
  for (const boundary of boundaries) {
    await assertDirectoryUnchanged(boundary, 'Tenant directory boundary');
  }
}

async function resolveTenantBoundaries(context: WorkerContext): Promise<TenantBoundaries> {
  const clientId = ClientIdSchema.parse(context.clientId);
  if (clientId !== 'acme_corp') {
    throw new Error('Daily report worker is restricted to acme_corp');
  }

  const clientRoot = await captureRealDirectory(
    context.clientRoot,
    'Daily report trusted client root'
  );
  const client = await captureRealDirectory(
    context.clientDirectory,
    'Daily report client directory'
  );
  const expectedClientPath = resolve(context.clientRoot, clientId);
  const expectedCanonicalClientPath = join(clientRoot.canonicalPath, clientId);
  if (
    resolve(context.clientDirectory) !== expectedClientPath ||
    client.canonicalPath !== expectedCanonicalClientPath
  ) {
    throw new Error('Daily report client directory is outside the trusted client root');
  }

  const data = await captureRealDirectory(
    join(context.clientDirectory, 'data'),
    'Daily report data directory'
  );
  if (data.canonicalPath !== join(client.canonicalPath, 'data')) {
    throw new Error('Daily report data directory is outside the trusted client root');
  }
  return { root: clientRoot, client, data };
}

async function readRegularCsv(
  sourcePath: string,
  boundaries: DirectoryBoundary[]
): Promise<string> {
  const metadata = await lstat(sourcePath);
  if (metadata.isSymbolicLink()) {
    throw new Error('Daily report CSV must be a regular file and not a symlink');
  }
  if (!metadata.isFile()) {
    throw new Error('Daily report CSV must be a regular file');
  }

  let handle;
  try {
    handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ELOOP') {
      throw new Error('Daily report CSV must be a regular file and not a symlink', {
        cause: error
      });
    }
    throw error;
  }

  try {
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino
    ) {
      throw new Error('Daily report CSV changed while it was opened');
    }
    if (openedMetadata.size > MAX_CSV_BYTES) {
      throw new Error(`Daily report CSV exceeds the ${MAX_CSV_BYTES}-byte size limit`);
    }
    await assertBoundariesUnchanged(boundaries);

    const buffer = Buffer.alloc(MAX_CSV_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_CSV_BYTES) {
      throw new Error(`Daily report CSV exceeds the ${MAX_CSV_BYTES}-byte size limit`);
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

function parseLead(line: string, lineNumber: number): DailyReportLead {
  const columns = line.split(',').map((value) => value.trim());
  if (columns.length !== 4 || columns.some((value) => value.length === 0)) {
    throw new Error(`Malformed CSV row ${lineNumber}`);
  }

  const [id, name, email, status] = columns;
  if (
    id === undefined ||
    name === undefined ||
    email === undefined ||
    status === undefined ||
    !LEAD_ID_PATTERN.test(id) ||
    name.length > MAX_NAME_LENGTH ||
    email.length > MAX_EMAIL_LENGTH ||
    !EMAIL_PATTERN.test(email) ||
    !VALID_STATUSES.has(status)
  ) {
    throw new Error(`Malformed CSV row ${lineNumber}`);
  }
  return { id, name, email, status };
}

function parseCsv(contents: string): DailyReportLead[] {
  const lines = contents.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== CSV_HEADER) {
    throw new Error(`Malformed CSV header; expected ${CSV_HEADER}`);
  }

  const leads: DailyReportLead[] = [];
  const seenIds = new Set<string>();
  for (let index = 1; index < lines.length; index += 1) {
    const lead = parseLead(lines[index] ?? '', index + 1);
    if (seenIds.has(lead.id)) {
      throw new Error(`Duplicate lead ID: ${lead.id}`);
    }
    seenIds.add(lead.id);
    leads.push(lead);
  }
  if (leads.length !== SOURCE_ROW_COUNT) {
    throw new Error(`Malformed CSV: expected exactly ${SOURCE_ROW_COUNT} lead rows`);
  }
  return leads;
}

async function resolveOutputBoundary(client: DirectoryBoundary): Promise<DirectoryBoundary> {
  const outputDirectory = join(client.path, 'output');
  try {
    await lstat(outputDirectory);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    await mkdir(outputDirectory);
    await syncDirectory(client.canonicalPath);
  }

  const output = await captureRealDirectory(outputDirectory, 'Daily report output directory');
  if (output.canonicalPath !== join(client.canonicalPath, 'output')) {
    throw new Error('Daily report output directory is outside the trusted client root');
  }
  return output;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) {
      throw new Error('Daily report durability boundary must be a directory');
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertNoUnresolvedJournal(output: DirectoryBoundary): Promise<void> {
  const journalPattern = /^\.report\.[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.transaction\.json$/;
  const entries = await readdir(output.canonicalPath, { withFileTypes: true });
  if (entries.some((entry) => journalPattern.test(entry.name))) {
    throw new Error('Daily report has an unresolved transaction that requires recovery');
  }
}

async function writeExclusive(
  filename: string,
  content: Buffer,
  boundaries: DirectoryBoundary[]
): Promise<void> {
  await assertBoundariesUnchanged(boundaries);
  const handle = await open(
    filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await assertBoundariesUnchanged(boundaries);
    await handle.writeFile(content);
    await handle.sync();
    await assertBoundariesUnchanged(boundaries);
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(filename));
}

async function replaceFileAtomically(
  filename: string,
  content: Buffer,
  boundaries: DirectoryBoundary[]
): Promise<void> {
  const temporaryPath = `${filename}.${artifactNonce()}.replace`;
  try {
    await writeExclusive(temporaryPath, content, boundaries);
    await assertBoundariesUnchanged(boundaries);
    await rename(temporaryPath, filename);
    await syncDirectory(dirname(filename));
    await assertBoundariesUnchanged(boundaries);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function readTransactionFile(
  filename: string,
  boundaries: DirectoryBoundary[],
  maximumBytes: number,
  label: string
): Promise<Buffer> {
  const metadata = await lstat(filename);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a non-symlink regular file`);
  }

  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ELOOP') {
      throw new Error(`${label} must be a non-symlink regular file`, { cause: error });
    }
    throw error;
  }

  try {
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino
    ) {
      throw new Error(`${label} changed while it was opened`);
    }
    if (openedMetadata.size > maximumBytes) {
      throw new Error(`${label} exceeds its size limit`);
    }
    await assertBoundariesUnchanged(boundaries);
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) {
      throw new Error(`${label} exceeds its size limit`);
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function readTransactionFileIfPresent(
  filename: string,
  boundaries: DirectoryBoundary[],
  maximumBytes: number,
  label: string
): Promise<Buffer | undefined> {
  try {
    return await readTransactionFile(filename, boundaries, maximumBytes, label);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function matchesFingerprint(
  content: Buffer,
  expectedBytes: number,
  expectedSha256: string
): boolean {
  return content.byteLength === expectedBytes && sha256(content) === expectedSha256;
}

async function persistJournal(
  prepared: PreparedReport,
  state: ArtifactJournal['state']
): Promise<void> {
  await replaceFileAtomically(
    prepared.journalPath,
    serializeJournal(journalFor(prepared, state)),
    prepared.boundaries
  );
  prepared.state = state;
}

async function cleanupPreparedFiles(prepared: PreparedReport): Promise<void> {
  await assertBoundariesUnchanged(prepared.boundaries);
  await rm(prepared.journalPath, { force: true });
  await rm(prepared.stagePath, { force: true });
  await rm(prepared.backupPath, { force: true });
  await syncDirectory(dirname(prepared.reportPath));
  await assertBoundariesUnchanged(prepared.boundaries);
}

async function readPreviousReport(
  reportPath: string,
  boundaries: DirectoryBoundary[]
): Promise<Buffer | undefined> {
  let metadata: Stats;
  try {
    metadata = await lstat(reportPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('Existing daily report must be a non-symlink regular file');
  }

  let handle;
  try {
    handle = await open(reportPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ELOOP') {
      throw new Error('Existing daily report must be a non-symlink regular file', {
        cause: error
      });
    }
    throw error;
  }

  try {
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino
    ) {
      throw new Error('Existing daily report changed while it was opened');
    }
    if (openedMetadata.size > MAX_REPORT_BYTES) {
      throw new Error('Existing daily report exceeds the rollback size limit');
    }
    await assertBoundariesUnchanged(boundaries);

    const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_REPORT_BYTES) {
      throw new Error('Existing daily report exceeds the rollback size limit');
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function stageDailyReport(
  context: WorkerContext,
  report: DailyReport,
  tenant: TenantBoundaries
): Promise<void> {
  const runId = RunIdSchema.parse(context.runId);
  if (preparedReports.has(runId)) {
    throw new Error(`Daily report run ${runId} already has a prepared artifact`);
  }

  const output = await resolveOutputBoundary(tenant.client);
  const boundaries = [tenant.root, tenant.client, output];
  const reportPath = join(output.canonicalPath, 'report.json');
  const stagePath = join(output.canonicalPath, `.report.${runId}.${artifactNonce()}.pending`);
  const backupPath = join(output.canonicalPath, `.report.${runId}.${artifactNonce()}.backup`);
  const journalPath = join(output.canonicalPath, expectedJournalName(runId));
  const content = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const releaseArtifact = await acquireArtifactLease(reportPath);
  const prepared: PreparedReport = {
    runId,
    boundaries,
    stagePath,
    backupPath,
    journalPath,
    reportPath,
    committed: false,
    hadPrevious: false,
    candidateSha256: sha256(content),
    candidateBytes: content.byteLength,
    previousSha256: null,
    previousBytes: null,
    state: 'staged',
    releaseArtifact
  };

  try {
    await assertNoUnresolvedJournal(output);
    await writeExclusive(journalPath, serializeJournal(journalFor(prepared)), boundaries);
    await writeExclusive(stagePath, content, boundaries);
    preparedReports.set(runId, prepared);
  } catch (error) {
    await rm(journalPath, { force: true }).catch(() => undefined);
    await rm(stagePath, { force: true }).catch(() => undefined);
    await rm(backupPath, { force: true }).catch(() => undefined);
    releaseArtifact();
    throw error;
  }
}

async function prepareDailyReport(context: WorkerContext): Promise<DailyReport> {
  const tenant = await resolveTenantBoundaries(context);
  const sourcePath = join(tenant.data.canonicalPath, 'sample-leads.csv');
  context.logger.log(WORKER_ID, 'Filesystem', 'read data/sample-leads.csv');
  const leads = parseCsv(
    await readRegularCsv(sourcePath, [tenant.root, tenant.client, tenant.data])
  );
  const qualifiedLeads = leads.filter((lead) => lead.status === 'qualified');
  const report: DailyReport = {
    generatedAt: new Date().toISOString(),
    sourceRows: leads.length,
    qualifiedCount: qualifiedLeads.length,
    qualifiedLeads
  };

  await stageDailyReport(context, report, tenant);
  context.logger.log('Filesystem', WORKER_ID, 'staged output/report.json');
  return report;
}

async function commitPreparedReport(
  context: WorkerContext,
  prepared: PreparedReport
): Promise<void> {
  await assertBoundariesUnchanged(prepared.boundaries);
  const stagedReport = await readTransactionFile(
    prepared.stagePath,
    prepared.boundaries,
    MAX_REPORT_BYTES,
    'Staged daily report'
  );
  if (!matchesFingerprint(stagedReport, prepared.candidateBytes, prepared.candidateSha256)) {
    throw new Error('Staged daily report does not match its transaction journal');
  }
  const previousReport = await readPreviousReport(prepared.reportPath, prepared.boundaries);
  if (previousReport !== undefined) {
    await writeExclusive(prepared.backupPath, previousReport, prepared.boundaries);
    prepared.hadPrevious = true;
    prepared.previousSha256 = sha256(previousReport);
    prepared.previousBytes = previousReport.byteLength;
  }
  await persistJournal(prepared, 'committing');
  await rename(prepared.stagePath, prepared.reportPath);
  prepared.committed = true;
  await syncDirectory(dirname(prepared.reportPath));
  await assertBoundariesUnchanged(prepared.boundaries);
  await persistJournal(prepared, 'committed');
  context.logger.log('Filesystem', WORKER_ID, 'committed output/report.json');
}

function commitDailyReport(context: WorkerContext): Promise<void> {
  const runId = RunIdSchema.parse(context.runId);
  const prepared = preparedReports.get(runId);
  if (prepared === undefined) {
    return Promise.reject(new Error(`Daily report run ${runId} has no prepared artifact`));
  }
  if (prepared.finalization !== undefined) {
    return Promise.reject(new Error(`Daily report run ${runId} is already being finalized`));
  }
  prepared.commitOperation ??= commitPreparedReport(context, prepared);
  return prepared.commitOperation;
}

async function restorePreviousReport(prepared: PreparedReport): Promise<void> {
  const currentReport = await readTransactionFileIfPresent(
    prepared.reportPath,
    prepared.boundaries,
    MAX_REPORT_BYTES,
    'Current daily report during rollback'
  );
  if (!prepared.hadPrevious) {
    if (currentReport === undefined) return;
    if (!matchesFingerprint(currentReport, prepared.candidateBytes, prepared.candidateSha256)) {
      throw new Error('Daily report rollback refused to remove an unrecognized report');
    }
    await rm(prepared.reportPath, { force: true });
    await syncDirectory(dirname(prepared.reportPath));
    return;
  }
  if (prepared.previousBytes === null || prepared.previousSha256 === null) {
    throw new Error('Daily report rollback is missing prior-report metadata');
  }
  const previousReport = await readTransactionFile(
    prepared.backupPath,
    prepared.boundaries,
    MAX_REPORT_BYTES,
    'Daily report rollback backup'
  );
  if (!matchesFingerprint(previousReport, prepared.previousBytes, prepared.previousSha256)) {
    throw new Error('Daily report rollback backup does not match its journal');
  }
  if (
    currentReport !== undefined &&
    matchesFingerprint(currentReport, prepared.previousBytes, prepared.previousSha256)
  ) {
    return;
  }
  if (
    currentReport !== undefined &&
    !matchesFingerprint(currentReport, prepared.candidateBytes, prepared.candidateSha256)
  ) {
    throw new Error('Daily report rollback refused to replace an unrecognized report');
  }
  await replaceFileAtomically(prepared.reportPath, previousReport, prepared.boundaries);
}

async function rollbackPreparedReport(prepared: PreparedReport): Promise<void> {
  try {
    await prepared.commitOperation?.catch(() => undefined);
    await assertBoundariesUnchanged(prepared.boundaries);
    if (prepared.committed) {
      await restorePreviousReport(prepared);
    } else {
      await rm(prepared.stagePath, { force: true });
    }
    await cleanupPreparedFiles(prepared);
  } finally {
    preparedReports.delete(prepared.runId);
    prepared.releaseArtifact();
  }
}

function rollbackDailyReport(context: WorkerContext): Promise<void> {
  const runId = RunIdSchema.parse(context.runId);
  const prepared = preparedReports.get(runId);
  if (prepared === undefined) return Promise.resolve();
  prepared.finalization ??= rollbackPreparedReport(prepared);
  return prepared.finalization;
}

async function releasePreparedReport(prepared: PreparedReport): Promise<void> {
  try {
    await prepared.commitOperation;
    await cleanupPreparedFiles(prepared);
  } finally {
    preparedReports.delete(prepared.runId);
    prepared.releaseArtifact();
  }
}

function releaseDailyReport(context: WorkerContext): Promise<void> {
  const runId = RunIdSchema.parse(context.runId);
  const prepared = preparedReports.get(runId);
  if (prepared === undefined) return Promise.resolve();
  prepared.finalization ??= releasePreparedReport(prepared);
  return prepared.finalization;
}

async function captureDirectoryIfPresent(
  directory: string,
  label: string
): Promise<DirectoryBoundary | undefined> {
  try {
    return await captureRealDirectory(directory, label);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function resolveRecoveryOutput(
  clientRootPath: string
): Promise<DirectoryBoundary[] | undefined> {
  const rootPath = resolve(clientRootPath);
  const root = await captureDirectoryIfPresent(rootPath, 'Daily report recovery client root');
  if (root === undefined) return undefined;
  const client = await captureDirectoryIfPresent(
    join(rootPath, 'acme_corp'),
    'Daily report recovery client directory'
  );
  if (client === undefined) return undefined;
  if (client.canonicalPath !== join(root.canonicalPath, 'acme_corp')) {
    throw new Error('Daily report recovery client directory is outside the trusted root');
  }
  const output = await captureDirectoryIfPresent(
    join(client.path, 'output'),
    'Daily report recovery output directory'
  );
  if (output === undefined) return undefined;
  if (output.canonicalPath !== join(client.canonicalPath, 'output')) {
    throw new Error('Daily report recovery output directory is outside the trusted root');
  }
  return [root, client, output];
}

async function parseJournal(
  journalPath: string,
  boundaries: DirectoryBoundary[]
): Promise<ArtifactJournal> {
  let parsed: ArtifactJournal;
  try {
    parsed = ArtifactJournalSchema.parse(
      JSON.parse(
        (
          await readTransactionFile(
            journalPath,
            boundaries,
            MAX_JOURNAL_BYTES,
            'Daily report transaction journal'
          )
        ).toString('utf8')
      ) as unknown
    );
  } catch (error) {
    throw new Error('Daily report transaction journal is invalid', { cause: error });
  }
  if (basename(journalPath) !== expectedJournalName(parsed.runId)) {
    throw new Error('Daily report transaction journal filename does not match its run');
  }
  assertArtifactLeaf(parsed.stageName, parsed.runId, 'pending');
  assertArtifactLeaf(parsed.backupName, parsed.runId, 'backup');
  return parsed;
}

async function removeOrphanTransactionFiles(
  output: DirectoryBoundary,
  boundaries: DirectoryBoundary[]
): Promise<void> {
  const orphanPattern =
    /^\.report\.[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.[a-f0-9]{32}\.(pending|backup)$/;
  const entries = await readdir(output.canonicalPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!orphanPattern.test(entry.name)) continue;
    const orphanPath = join(output.canonicalPath, entry.name);
    const metadata = await lstat(orphanPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('Daily report orphan transaction path must be a regular file');
    }
    await assertBoundariesUnchanged(boundaries);
    await rm(orphanPath);
    await syncDirectory(output.canonicalPath);
  }
}

export async function recoverDailyReportArtifacts(
  options: DailyReportRecoveryOptions
): Promise<DailyReportRecoveryAction[]> {
  const boundaries = await resolveRecoveryOutput(options.clientRoot);
  if (boundaries === undefined) return [];
  const output = boundaries.at(-1);
  if (output === undefined) return [];
  const journalPattern = /^\.report\.[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.transaction\.json$/;
  const entries = (await readdir(output.canonicalPath, { withFileTypes: true }))
    .filter((entry) => journalPattern.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const recovered: DailyReportRecoveryAction[] = [];

  for (const entry of entries) {
    const journalPath = join(output.canonicalPath, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('Daily report transaction journal must be a regular file');
    }
    const journal = await parseJournal(journalPath, boundaries);
    const reportPath = join(output.canonicalPath, 'report.json');
    const inMemory = preparedReports.get(journal.runId);
    if (inMemory !== undefined) {
      preparedReports.delete(journal.runId);
      inMemory.releaseArtifact();
    }
    const releaseArtifact = await acquireArtifactLease(reportPath);
    const prepared: PreparedReport = {
      runId: journal.runId,
      boundaries,
      stagePath: join(output.canonicalPath, journal.stageName),
      backupPath: join(output.canonicalPath, journal.backupName),
      journalPath,
      reportPath,
      committed: journal.state !== 'staged',
      hadPrevious: journal.hadPrevious,
      candidateSha256: journal.candidateSha256,
      candidateBytes: journal.candidateBytes,
      previousSha256: journal.previousSha256,
      previousBytes: journal.previousBytes,
      state: journal.state,
      releaseArtifact
    };

    try {
      const status = await options.findRunStatus(journal.runId);
      if (status === 'succeeded') {
        if (journal.state !== 'committed') {
          throw new Error('Succeeded daily report run has an incomplete artifact transaction');
        }
        const currentReport = await readTransactionFile(
          reportPath,
          boundaries,
          MAX_REPORT_BYTES,
          'Recovered daily report'
        );
        if (!matchesFingerprint(currentReport, journal.candidateBytes, journal.candidateSha256)) {
          throw new Error('Succeeded daily report does not match its transaction journal');
        }
        await cleanupPreparedFiles(prepared);
        recovered.push({ runId: journal.runId, action: 'kept' });
      } else {
        if (journal.state === 'staged') {
          const stagedReport = await readTransactionFileIfPresent(
            prepared.stagePath,
            boundaries,
            MAX_REPORT_BYTES,
            'Recovered staged daily report'
          );
          if (
            stagedReport !== undefined &&
            !matchesFingerprint(stagedReport, journal.candidateBytes, journal.candidateSha256)
          ) {
            throw new Error('Staged daily report does not match its transaction journal');
          }
        } else {
          await restorePreviousReport(prepared);
        }
        await options.markRunInterrupted?.(journal.runId);
        await cleanupPreparedFiles(prepared);
        recovered.push({ runId: journal.runId, action: 'rolled_back' });
      }
    } finally {
      releaseArtifact();
    }
  }

  await removeOrphanTransactionFiles(output, boundaries);
  return recovered;
}

export async function runDailyReport(context: WorkerContext): Promise<DailyReport> {
  try {
    const report = await prepareDailyReport(context);
    await commitDailyReport(context);
    await releaseDailyReport(context);
    return report;
  } catch (error) {
    await rollbackDailyReport(context).catch(() => undefined);
    throw error;
  }
}

export const dailyReportWorker: TransactionalWorker = {
  id: WORKER_ID,
  execute: prepareDailyReport,
  commit: commitDailyReport,
  rollback: rollbackDailyReport,
  release: releaseDailyReport
};
