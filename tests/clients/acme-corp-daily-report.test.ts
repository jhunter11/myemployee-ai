import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import type * as FileSystemPromises from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const directorySyncFault = vi.hoisted(() => ({
  directory: '',
  failAt: 0,
  observed: 0
}));

const reportReadPause = vi.hoisted(() => ({
  path: '',
  observed: 0,
  reached: undefined as (() => void) | undefined,
  wait: undefined as Promise<void> | undefined
}));

const beforeReportOpenSwap = vi.hoisted(() => ({
  path: '',
  replacement: '',
  kind: undefined as 'file' | 'grow' | 'symlink' | undefined
}));

const reportOpenAudit = vi.hoisted(() => ({
  path: '',
  flags: [] as number[]
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystemPromises>();
  const { constants } = await import('node:fs');
  return {
    ...actual,
    async open(
      path: Parameters<typeof actual.open>[0],
      flags: Parameters<typeof actual.open>[1],
      mode?: Parameters<typeof actual.open>[2]
    ) {
      if (
        path === beforeReportOpenSwap.path &&
        typeof flags === 'number' &&
        (flags & constants.O_RDONLY) === constants.O_RDONLY &&
        beforeReportOpenSwap.kind !== undefined
      ) {
        const kind = beforeReportOpenSwap.kind;
        beforeReportOpenSwap.kind = undefined;
        if (kind === 'grow') {
          await actual.appendFile(path, beforeReportOpenSwap.replacement);
        } else if (kind === 'symlink') {
          await actual.rm(path);
          await actual.symlink(beforeReportOpenSwap.replacement, path);
        } else {
          await actual.rm(path);
          await actual.writeFile(path, beforeReportOpenSwap.replacement);
        }
      }
      const handle = await actual.open(path, flags, mode);
      if (path === reportOpenAudit.path && typeof flags === 'number') {
        reportOpenAudit.flags.push(flags);
      }
      if (
        directorySyncFault.failAt > 0 &&
        path === directorySyncFault.directory &&
        flags === constants.O_RDONLY
      ) {
        directorySyncFault.observed += 1;
        if (directorySyncFault.observed === directorySyncFault.failAt) {
          handle.sync = () => Promise.reject(new Error('injected directory sync failure'));
        }
      }
      if (
        path === reportReadPause.path &&
        typeof flags === 'number' &&
        (flags & constants.O_NOFOLLOW) !== 0
      ) {
        const originalClose = handle.close.bind(handle);
        handle.close = async () => {
          reportReadPause.observed += 1;
          if (reportReadPause.observed === 1) {
            reportReadPause.reached?.();
            await reportReadPause.wait;
          }
          await originalClose();
        };
      }
      return handle;
    }
  };
});

import type { WorkerContext } from '../../src/agents/contracts';
import {
  dailyReportWorker,
  recoverDailyReportArtifacts,
  runDailyReport
} from '../../clients/acme_corp/automations/daily-report';

const projectRoot = join(__dirname, '..', '..');
const checkedInCsv = join(projectRoot, 'clients', 'acme_corp', 'data', 'sample-leads.csv');
const CSV_HEADER_FOR_TESTS = 'id,name,email,status';

const expectedQualifiedRecords = [
  { id: 'lead-001', name: 'Avery Stone', email: 'avery.stone@example.test', status: 'qualified' },
  { id: 'lead-003', name: 'Casey Brooks', email: 'casey.brooks@example.test', status: 'qualified' },
  { id: 'lead-005', name: 'Emerson Lane', email: 'emerson.lane@example.test', status: 'qualified' },
  { id: 'lead-008', name: 'Harper Reed', email: 'harper.reed@example.test', status: 'qualified' },
  { id: 'lead-010', name: 'Jordan Ellis', email: 'jordan.ellis@example.test', status: 'qualified' }
];

describe('acme_corp daily-report automation', () => {
  let temporaryRoot: string;
  let clientDirectory: string;

  beforeEach(async () => {
    directorySyncFault.directory = '';
    directorySyncFault.failAt = 0;
    directorySyncFault.observed = 0;
    reportReadPause.path = '';
    reportReadPause.observed = 0;
    reportReadPause.reached = undefined;
    reportReadPause.wait = undefined;
    beforeReportOpenSwap.path = '';
    beforeReportOpenSwap.replacement = '';
    beforeReportOpenSwap.kind = undefined;
    reportOpenAudit.path = '';
    reportOpenAudit.flags = [];
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-daily-report-'));
    clientDirectory = join(temporaryRoot, 'acme_corp');
    await mkdir(join(clientDirectory, 'data'), { recursive: true });
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  function context(runId = 'run-daily-report-001'): WorkerContext {
    return {
      clientId: 'acme_corp',
      automation: 'daily-report',
      runId,
      clientRoot: temporaryRoot,
      clientDirectory,
      memoryDirectory: join(clientDirectory, 'memory'),
      toolPolicy: {
        description: 'Daily report test policy',
        tools_allow: ['read', 'write'],
        tools_deny: [],
        requires_elevated_approval: false
      },
      networkPolicy: { mode: 'none' },
      logger: {
        start: () => undefined,
        log: () => undefined,
        save: () => Promise.resolve(join(temporaryRoot, 'unused-diagram.md'))
      }
    };
  }

  async function installCheckedInCsv(): Promise<void> {
    await writeFile(
      join(clientDirectory, 'data', 'sample-leads.csv'),
      await readFile(checkedInCsv, 'utf8'),
      'utf8'
    );
  }

  it('reads ten leads, returns only qualified records, and atomically writes identical JSON', async () => {
    await installCheckedInCsv();

    const result = await runDailyReport(context());

    expect(dailyReportWorker.id).toBe('acme_daily_report');
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result).toEqual({
      generatedAt: result.generatedAt,
      sourceRows: 10,
      qualifiedCount: 5,
      qualifiedLeads: expectedQualifiedRecords
    });
    const outputDirectory = join(clientDirectory, 'output');
    expect(JSON.parse(await readFile(join(outputDirectory, 'report.json'), 'utf8'))).toEqual(
      result
    );
    expect(await readdir(outputDirectory)).toEqual(['report.json']);
  });

  it('stages worker output until commit and removes an uncommitted artifact on rollback', async () => {
    await installCheckedInCsv();
    const workerContext = context();

    const result = await dailyReportWorker.execute(workerContext);

    await expect(stat(join(clientDirectory, 'output', 'report.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    expect(await readdir(join(clientDirectory, 'output'))).toHaveLength(2);

    await dailyReportWorker.rollback?.(workerContext);

    expect(result).toMatchObject({ sourceRows: 10, qualifiedCount: 5 });
    expect(await readdir(join(clientDirectory, 'output'))).toEqual([]);
  });

  it('restores the previous canonical report when a committed run is rolled back', async () => {
    await installCheckedInCsv();
    const workerContext = context();
    const outputDirectory = join(clientDirectory, 'output');
    const reportPath = join(outputDirectory, 'report.json');
    const previousReport = '{"previous":true}\n';
    await mkdir(outputDirectory);
    await writeFile(reportPath, previousReport, 'utf8');

    const result = await dailyReportWorker.execute(workerContext);
    await dailyReportWorker.commit?.(workerContext, result);
    expect(JSON.parse(await readFile(reportPath, 'utf8'))).toMatchObject({
      sourceRows: 10,
      qualifiedCount: 5
    });

    await dailyReportWorker.rollback?.(workerContext);

    expect(await readFile(reportPath, 'utf8')).toBe(previousReport);
  });

  it('removes a newly committed canonical report when the run is rolled back', async () => {
    await installCheckedInCsv();
    const workerContext = context();

    const result = await dailyReportWorker.execute(workerContext);
    await dailyReportWorker.commit?.(workerContext, result);
    await expect(stat(join(clientDirectory, 'output', 'report.json'))).resolves.toMatchObject({});

    await dailyReportWorker.rollback?.(workerContext);
    await dailyReportWorker.rollback?.(workerContext);

    expect(await readdir(join(clientDirectory, 'output'))).toEqual([]);
  });

  it('rolls back a report renamed before its directory synchronization fails', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-rename-sync-failure');
    const result = await dailyReportWorker.execute(workerContext);
    const outputDirectory = join(clientDirectory, 'output');
    directorySyncFault.directory = await realpath(outputDirectory);
    directorySyncFault.failAt = 3;
    directorySyncFault.observed = 0;

    try {
      await expect(dailyReportWorker.commit(workerContext, result)).rejects.toThrow(
        /injected directory sync failure/i
      );
    } finally {
      directorySyncFault.failAt = 0;
    }
    await dailyReportWorker.rollback(workerContext);

    expect(await readdir(outputDirectory)).toEqual([]);
  });

  it('serializes concurrent publication lifecycles for the same client artifact', async () => {
    await installCheckedInCsv();
    const firstContext = context('run-daily-report-first');
    const secondContext = context('run-daily-report-second');
    const firstResult = await dailyReportWorker.execute(firstContext);
    let secondPrepared = false;
    const secondExecution = dailyReportWorker.execute(secondContext).then((result) => {
      secondPrepared = true;
      return result;
    });

    try {
      const publicationState = await Promise.race([
        secondExecution.then(() => 'prepared' as const),
        delay(75, 'waiting' as const)
      ]);
      expect(publicationState).toBe('waiting');
      expect(secondPrepared).toBe(false);

      await dailyReportWorker.commit?.(firstContext, firstResult);
      await dailyReportWorker.release?.(firstContext);

      const secondResult = await secondExecution;
      expect(secondPrepared).toBe(true);
      await dailyReportWorker.commit?.(secondContext, secondResult);
      await dailyReportWorker.release?.(secondContext);

      expect(await readdir(join(clientDirectory, 'output'))).toEqual(['report.json']);
    } finally {
      await dailyReportWorker.rollback?.(firstContext);
      const secondResult = await secondExecution.catch(() => undefined);
      if (secondResult !== undefined) {
        await dailyReportWorker.rollback?.(secondContext);
      }
    }
  });

  it('coalesces concurrent rollback so a stale rollback cannot delete the next successful report', async () => {
    await installCheckedInCsv();
    const firstContext = context('run-concurrent-rollback-first');
    const secondContext = context('run-concurrent-rollback-second');
    const firstResult = await dailyReportWorker.execute(firstContext);
    await dailyReportWorker.commit(firstContext, firstResult);

    const outputDirectory = join(clientDirectory, 'output');
    const reportPath = join(outputDirectory, 'report.json');
    let markReadReached = (): void => undefined;
    let resumeRead = (): void => undefined;
    const readReached = new Promise<void>((resolveReached) => {
      markReadReached = resolveReached;
    });
    reportReadPause.path = join(await realpath(outputDirectory), 'report.json');
    reportReadPause.reached = markReadReached;
    reportReadPause.wait = new Promise<void>((resolveRead) => {
      resumeRead = resolveRead;
    });

    const secondExecution = dailyReportWorker.execute(secondContext);
    const slowRollback = dailyReportWorker.rollback(firstContext);
    await Promise.race([
      readReached,
      delay(500).then(() => {
        throw new Error('rollback did not reach the paused report read');
      })
    ]);
    const duplicateRollback = dailyReportWorker.rollback(firstContext);

    try {
      const duplicateState = await Promise.race([
        duplicateRollback.then(() => 'released' as const),
        delay(75, 'waiting' as const)
      ]);
      let secondResult;
      if (duplicateState === 'released') {
        secondResult = await Promise.race([
          secondExecution,
          delay(500).then(() => {
            throw new Error('next report did not prepare after duplicate rollback released');
          })
        ]);
        await dailyReportWorker.commit(secondContext, secondResult);
        await dailyReportWorker.release(secondContext);
      }

      resumeRead();
      await Promise.all([slowRollback, duplicateRollback]);
      if (secondResult === undefined) {
        secondResult = await secondExecution;
        await dailyReportWorker.commit(secondContext, secondResult);
        await dailyReportWorker.release(secondContext);
      }

      expect(duplicateState).toBe('waiting');
      expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(secondResult);
      expect(await readdir(outputDirectory)).toEqual(['report.json']);
    } finally {
      resumeRead();
      await slowRollback.catch(() => undefined);
      await duplicateRollback.catch(() => undefined);
      await dailyReportWorker.rollback(firstContext);
      await dailyReportWorker.rollback(secondContext);
    }
  });

  it('keeps rollback behind an in-flight commit for the same prepared report', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-concurrent-commit-rollback');
    const result = await dailyReportWorker.execute(workerContext);
    const outputDirectory = join(clientDirectory, 'output');
    const stageName = (await readdir(outputDirectory)).find((name) => name.endsWith('.pending'));
    expect(stageName).toBeDefined();

    let markReadReached = (): void => undefined;
    let resumeRead = (): void => undefined;
    const readReached = new Promise<void>((resolveReached) => {
      markReadReached = resolveReached;
    });
    reportReadPause.path = join(await realpath(outputDirectory), stageName ?? 'missing.pending');
    reportReadPause.reached = markReadReached;
    reportReadPause.wait = new Promise<void>((resolveRead) => {
      resumeRead = resolveRead;
    });

    const commitOperation = dailyReportWorker.commit(workerContext, result);
    await readReached;
    const rollbackOperation = dailyReportWorker.rollback(workerContext);

    try {
      const rollbackState = await Promise.race([
        rollbackOperation.then(() => 'released' as const),
        delay(75, 'waiting' as const)
      ]);
      resumeRead();
      await commitOperation;
      await rollbackOperation;

      expect(rollbackState).toBe('waiting');
      expect(await readdir(outputDirectory)).toEqual([]);
    } finally {
      resumeRead();
      await commitOperation.catch(() => undefined);
      await rollbackOperation.catch(() => undefined);
      await dailyReportWorker.rollback(workerContext);
    }
  });

  it('recovers a staged transaction after restart without publishing it', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-recover-staged');
    await dailyReportWorker.execute(workerContext);

    const recovered = await recoverDailyReportArtifacts({
      clientRoot: temporaryRoot,
      findRunStatus: () => Promise.resolve('running')
    });

    expect(recovered).toEqual([{ runId: 'run-recover-staged', action: 'rolled_back' }]);
    expect(await readdir(join(clientDirectory, 'output'))).toEqual([]);
    await expect(dailyReportWorker.rollback?.(workerContext)).resolves.toBeUndefined();
  });

  it('restores the prior report when recovery finds an unpublished database run', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-recover-committed');
    const outputDirectory = join(clientDirectory, 'output');
    const reportPath = join(outputDirectory, 'report.json');
    const previousReport = '{"previous":"durable"}\n';
    await mkdir(outputDirectory);
    await writeFile(reportPath, previousReport, 'utf8');
    const result = await dailyReportWorker.execute(workerContext);
    await dailyReportWorker.commit(workerContext, result);

    const recovered = await recoverDailyReportArtifacts({
      clientRoot: temporaryRoot,
      findRunStatus: () => Promise.resolve('running')
    });

    expect(recovered).toEqual([{ runId: 'run-recover-committed', action: 'rolled_back' }]);
    expect(await readFile(reportPath, 'utf8')).toBe(previousReport);
    expect(await readdir(outputDirectory)).toEqual(['report.json']);
  });

  it('keeps the published report when recovery finds a succeeded database run', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-recover-succeeded');
    const outputDirectory = join(clientDirectory, 'output');
    const reportPath = join(outputDirectory, 'report.json');
    const result = await dailyReportWorker.execute(workerContext);
    await dailyReportWorker.commit(workerContext, result);

    const recovered = await recoverDailyReportArtifacts({
      clientRoot: temporaryRoot,
      findRunStatus: () => Promise.resolve('succeeded')
    });

    expect(recovered).toEqual([{ runId: 'run-recover-succeeded', action: 'kept' }]);
    expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(result);
    expect(await readdir(outputDirectory)).toEqual(['report.json']);
  });

  it('preserves evidence and refuses to clobber an unrecognized report during recovery', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-recover-conflict');
    const outputDirectory = join(clientDirectory, 'output');
    const reportPath = join(outputDirectory, 'report.json');
    const result = await dailyReportWorker.execute(workerContext);
    await dailyReportWorker.commit(workerContext, result);
    await writeFile(reportPath, 'externally replaced report\n', 'utf8');

    await expect(
      recoverDailyReportArtifacts({
        clientRoot: temporaryRoot,
        findRunStatus: () => Promise.resolve('running')
      })
    ).rejects.toThrow(/refused to (remove|replace) an unrecognized report/i);

    expect(await readFile(reportPath, 'utf8')).toBe('externally replaced report\n');
    expect(await readdir(outputDirectory)).toContain(
      '.report.run-recover-conflict.transaction.json'
    );
    await expect(dailyReportWorker.execute(context('run-after-recovery-conflict'))).rejects.toThrow(
      /unresolved transaction.*recovery/i
    );
  });

  it('treats absent recovery roots, clients, and output directories as clean state', async () => {
    const missingRoot = join(temporaryRoot, 'missing-clients');
    await expect(
      recoverDailyReportArtifacts({
        clientRoot: missingRoot,
        findRunStatus: () => Promise.resolve(undefined)
      })
    ).resolves.toEqual([]);

    await mkdir(missingRoot);
    await expect(
      recoverDailyReportArtifacts({
        clientRoot: missingRoot,
        findRunStatus: () => Promise.resolve(undefined)
      })
    ).resolves.toEqual([]);

    await mkdir(join(missingRoot, 'acme_corp'));
    await expect(
      recoverDailyReportArtifacts({
        clientRoot: missingRoot,
        findRunStatus: () => Promise.resolve(undefined)
      })
    ).resolves.toEqual([]);
  });

  it('removes recognized orphan transaction files while preserving unrelated output', async () => {
    const outputDirectory = join(clientDirectory, 'output');
    await mkdir(outputDirectory);
    const orphan = `.report.run-orphan.${'a'.repeat(32)}.pending`;
    await writeFile(join(outputDirectory, orphan), 'orphan\n');
    await writeFile(join(outputDirectory, 'keep.txt'), 'keep\n');

    await expect(
      recoverDailyReportArtifacts({
        clientRoot: temporaryRoot,
        findRunStatus: () => Promise.resolve(undefined)
      })
    ).resolves.toEqual([]);

    expect(await readdir(outputDirectory)).toEqual(['keep.txt']);
  });

  it('recovers a staged journal even when the candidate was never durably created', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-recover-missing-stage');
    await dailyReportWorker.execute(workerContext);
    const outputDirectory = join(clientDirectory, 'output');
    const stageName = (await readdir(outputDirectory)).find((name) => name.endsWith('.pending'));
    expect(stageName).toBeDefined();
    await rm(join(outputDirectory, stageName ?? 'missing'));

    await expect(
      recoverDailyReportArtifacts({
        clientRoot: temporaryRoot,
        findRunStatus: () => Promise.resolve('running')
      })
    ).resolves.toEqual([{ runId: 'run-recover-missing-stage', action: 'rolled_back' }]);
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  it('rejects a modified staged candidate before publication', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-corrupt-stage');
    const result = await dailyReportWorker.execute(workerContext);
    const outputDirectory = join(clientDirectory, 'output');
    const stageName = (await readdir(outputDirectory)).find((name) => name.endsWith('.pending'));
    expect(stageName).toBeDefined();
    await writeFile(join(outputDirectory, stageName ?? 'missing'), 'modified candidate\n');

    await expect(dailyReportWorker.commit(workerContext, result)).rejects.toThrow(
      /staged daily report.*journal/i
    );
    await dailyReportWorker.rollback(workerContext);
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  it('finishes rollback when an unpublished candidate report is already absent', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-missing-canonical');
    const result = await dailyReportWorker.execute(workerContext);
    await dailyReportWorker.commit(workerContext, result);
    const outputDirectory = join(clientDirectory, 'output');
    await rm(join(outputDirectory, 'report.json'));

    await dailyReportWorker.rollback(workerContext);
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  it('recognizes an already-restored prior report during idempotent recovery', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-already-restored');
    const outputDirectory = join(clientDirectory, 'output');
    const reportPath = join(outputDirectory, 'report.json');
    const previousReport = '{"previous":"already restored"}\n';
    await mkdir(outputDirectory);
    await writeFile(reportPath, previousReport);
    const result = await dailyReportWorker.execute(workerContext);
    await dailyReportWorker.commit(workerContext, result);
    await writeFile(reportPath, previousReport);

    await expect(
      recoverDailyReportArtifacts({
        clientRoot: temporaryRoot,
        findRunStatus: () => Promise.resolve('failed')
      })
    ).resolves.toEqual([{ runId: 'run-already-restored', action: 'rolled_back' }]);
    expect(await readFile(reportPath, 'utf8')).toBe(previousReport);
    expect(await readdir(outputDirectory)).toEqual(['report.json']);
  });

  it('preserves a journal when its rollback backup no longer matches', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-corrupt-backup');
    const outputDirectory = join(clientDirectory, 'output');
    await mkdir(outputDirectory);
    await writeFile(join(outputDirectory, 'report.json'), '{"previous":true}\n');
    const result = await dailyReportWorker.execute(workerContext);
    await dailyReportWorker.commit(workerContext, result);
    const backupName = (await readdir(outputDirectory)).find((name) => name.endsWith('.backup'));
    expect(backupName).toBeDefined();
    await writeFile(join(outputDirectory, backupName ?? 'missing'), 'corrupt backup\n');

    await expect(dailyReportWorker.rollback(workerContext)).rejects.toThrow(
      /backup does not match/i
    );
    expect(await readdir(outputDirectory)).toContain('.report.run-corrupt-backup.transaction.json');
  });

  it('rejects inconsistent journal metadata and cleans it through normal rollback', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-invalid-journal');
    await dailyReportWorker.execute(workerContext);
    const journalPath = join(
      clientDirectory,
      'output',
      '.report.run-invalid-journal.transaction.json'
    );
    const rawJournal: unknown = JSON.parse(await readFile(journalPath, 'utf8'));
    const journal = rawJournal as Record<string, unknown>;
    journal.hadPrevious = true;
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`);

    await expect(
      recoverDailyReportArtifacts({
        clientRoot: temporaryRoot,
        findRunStatus: () => Promise.resolve('running')
      })
    ).rejects.toThrow(/transaction journal is invalid/i);
    await dailyReportWorker.rollback(workerContext);
  });

  it('rejects a succeeded database state for a merely staged transaction', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-incomplete-success');
    await dailyReportWorker.execute(workerContext);

    await expect(
      recoverDailyReportArtifacts({
        clientRoot: temporaryRoot,
        findRunStatus: () => Promise.resolve('succeeded')
      })
    ).rejects.toThrow(/succeeded.*incomplete artifact transaction/i);
  });

  it('rejects a transaction journal path that is not a regular file', async () => {
    const outputDirectory = join(clientDirectory, 'output');
    await mkdir(outputDirectory);
    await mkdir(join(outputDirectory, '.report.run-directory-journal.transaction.json'));

    await expect(
      recoverDailyReportArtifacts({
        clientRoot: temporaryRoot,
        findRunStatus: () => Promise.resolve('running')
      })
    ).rejects.toThrow(/journal must be a regular file/i);
  });

  it('treats rollback and release without prepared state as idempotent', async () => {
    const workerContext = context('run-without-prepared-state');
    await expect(dailyReportWorker.rollback(workerContext)).resolves.toBeUndefined();
    await expect(dailyReportWorker.release(workerContext)).resolves.toBeUndefined();
  });

  it('rejects a succeeded run whose canonical report no longer matches', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-success-hash-mismatch');
    const outputDirectory = join(clientDirectory, 'output');
    const result = await dailyReportWorker.execute(workerContext);
    await dailyReportWorker.commit(workerContext, result);
    await writeFile(join(outputDirectory, 'report.json'), 'wrong successful report\n');

    await expect(
      recoverDailyReportArtifacts({
        clientRoot: temporaryRoot,
        findRunStatus: () => Promise.resolve('succeeded')
      })
    ).rejects.toThrow(/succeeded daily report.*journal/i);
    expect(await readdir(outputDirectory)).toContain(
      '.report.run-success-hash-mismatch.transaction.json'
    );
  });

  it('rejects an invalid artifact leaf encoded in an otherwise valid journal', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-invalid-artifact-leaf');
    await dailyReportWorker.execute(workerContext);
    const journalPath = join(
      clientDirectory,
      'output',
      '.report.run-invalid-artifact-leaf.transaction.json'
    );
    const rawJournal: unknown = JSON.parse(await readFile(journalPath, 'utf8'));
    const journal = rawJournal as Record<string, unknown>;
    journal.stageName = 'invalid.pending';
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`);

    await expect(
      recoverDailyReportArtifacts({
        clientRoot: temporaryRoot,
        findRunStatus: () => Promise.resolve('running')
      })
    ).rejects.toThrow(/invalid pending filename/i);
    await dailyReportWorker.rollback(workerContext);
  });

  it('rejects a journal whose filename identifies a different run', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-journal-name-a');
    await dailyReportWorker.execute(workerContext);
    const outputDirectory = join(clientDirectory, 'output');
    await rename(
      join(outputDirectory, '.report.run-journal-name-a.transaction.json'),
      join(outputDirectory, '.report.run-journal-name-b.transaction.json')
    );

    await expect(
      recoverDailyReportArtifacts({
        clientRoot: temporaryRoot,
        findRunStatus: () => Promise.resolve('running')
      })
    ).rejects.toThrow(/journal filename does not match/i);
    await dailyReportWorker.rollback(workerContext);
  });

  it('rejects an oversized transaction journal before parsing it', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-oversized-journal');
    await dailyReportWorker.execute(workerContext);
    const journalPath = join(
      clientDirectory,
      'output',
      '.report.run-oversized-journal.transaction.json'
    );
    await writeFile(journalPath, 'x'.repeat(17_000));

    await expect(
      recoverDailyReportArtifacts({
        clientRoot: temporaryRoot,
        findRunStatus: () => Promise.resolve('running')
      })
    ).rejects.toThrow(/transaction journal is invalid/i);
    await dailyReportWorker.rollback(workerContext);
  });

  it('rejects a symlink disguised as an orphan transaction file', async () => {
    const outputDirectory = join(clientDirectory, 'output');
    await mkdir(outputDirectory);
    await symlink(
      checkedInCsv,
      join(outputDirectory, `.report.run-orphan-link.${'b'.repeat(32)}.backup`)
    );

    await expect(
      recoverDailyReportArtifacts({
        clientRoot: temporaryRoot,
        findRunStatus: () => Promise.resolve(undefined)
      })
    ).rejects.toThrow(/orphan transaction path.*regular file/i);
  });

  it('recovers a durable staged journal with no in-memory process state', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-disk-only-recovery');
    await dailyReportWorker.execute(workerContext);
    const outputDirectory = join(clientDirectory, 'output');
    const journalPath = join(outputDirectory, '.report.run-disk-only-recovery.transaction.json');
    const journalContent = await readFile(journalPath);
    const rawJournal: unknown = JSON.parse(journalContent.toString('utf8'));
    const stageName = (rawJournal as { stageName: string }).stageName;
    const stageContent = await readFile(join(outputDirectory, stageName));
    await dailyReportWorker.release(workerContext);
    await writeFile(journalPath, journalContent);
    await writeFile(join(outputDirectory, stageName), stageContent);

    await expect(
      recoverDailyReportArtifacts({
        clientRoot: temporaryRoot,
        findRunStatus: () => Promise.resolve('running')
      })
    ).resolves.toEqual([{ runId: 'run-disk-only-recovery', action: 'rolled_back' }]);
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  it('rejects duplicate preparation and commit without a prepared artifact', async () => {
    await installCheckedInCsv();
    const workerContext = context();
    await dailyReportWorker.execute(workerContext);

    await expect(dailyReportWorker.execute(workerContext)).rejects.toThrow(
      /already has a prepared artifact/i
    );
    await dailyReportWorker.rollback?.(workerContext);
    await expect(dailyReportWorker.commit?.(workerContext, {})).rejects.toThrow(
      /no prepared artifact/i
    );
  });

  it('rejects a client directory outside the trusted client root', async () => {
    await installCheckedInCsv();
    const workerContext = context();
    workerContext.clientRoot = join(temporaryRoot, 'trusted-clients');
    await mkdir(workerContext.clientRoot);

    await expect(runDailyReport(workerContext)).rejects.toThrow(/trusted client root/i);
  });

  it('rejects the wrong client and a non-directory trusted root', async () => {
    await installCheckedInCsv();
    const wrongClient = context();
    wrongClient.clientId = 'other_client';
    await expect(runDailyReport(wrongClient)).rejects.toThrow(/restricted to acme_corp/i);

    const rootFile = join(temporaryRoot, 'client-root-file');
    await writeFile(rootFile, 'not a directory\n');
    const invalidRoot = context();
    invalidRoot.clientRoot = rootFile;
    await expect(runDailyReport(invalidRoot)).rejects.toThrow(
      /trusted client root.*real directory/i
    );
  });

  it('rejects a symlinked CSV instead of following it', async () => {
    await symlink(checkedInCsv, join(clientDirectory, 'data', 'sample-leads.csv'));

    await expect(runDailyReport(context())).rejects.toThrow(/regular file.*symlink/i);
    await expect(stat(join(clientDirectory, 'output', 'report.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('rejects a symlinked data directory instead of escaping the tenant tree', async () => {
    const outsideData = join(temporaryRoot, 'outside-data');
    await mkdir(outsideData);
    await writeFile(
      join(outsideData, 'sample-leads.csv'),
      await readFile(checkedInCsv, 'utf8'),
      'utf8'
    );
    await rm(join(clientDirectory, 'data'), { recursive: true });
    await symlink(outsideData, join(clientDirectory, 'data'));

    await expect(runDailyReport(context())).rejects.toThrow(/data directory.*symlink/i);
    await expect(stat(join(clientDirectory, 'output', 'report.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('rejects a non-regular CSV', async () => {
    await mkdir(join(clientDirectory, 'data', 'sample-leads.csv'));

    await expect(runDailyReport(context())).rejects.toThrow(/regular file/i);
    await expect(stat(join(clientDirectory, 'output', 'report.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('rejects a wrong header and a wrong number of otherwise valid rows', async () => {
    const csvPath = join(clientDirectory, 'data', 'sample-leads.csv');
    await writeFile(csvPath, 'lead_id,name,email,status\n', 'utf8');
    await expect(runDailyReport(context())).rejects.toThrow(/malformed csv header/i);

    await writeFile(csvPath, `${CSV_HEADER_FOR_TESTS}\n`, 'utf8');
    await expect(runDailyReport(context())).rejects.toThrow(/expected exactly 10 lead rows/i);
  });

  it('rejects an invalid output path before publishing', async () => {
    await installCheckedInCsv();
    await writeFile(join(clientDirectory, 'output'), 'not a directory\n');

    await expect(runDailyReport(context())).rejects.toThrow(/output directory.*real directory/i);
  });

  it('opens the prior report through a no-follow descriptor before capturing its rollback backup', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-prior-report-descriptor');
    const outputDirectory = join(clientDirectory, 'output');
    const reportPath = join(outputDirectory, 'report.json');
    await mkdir(outputDirectory);
    await writeFile(reportPath, '{"previous":true}\n');
    const result = await dailyReportWorker.execute(workerContext);
    reportOpenAudit.path = join(await realpath(outputDirectory), 'report.json');

    await dailyReportWorker.commit(workerContext, result);
    await dailyReportWorker.release(workerContext);

    expect(reportOpenAudit.flags.some((flags) => (flags & constants.O_NOFOLLOW) !== 0)).toBe(true);
  });

  it('rejects a prior report swapped to a symlink between path inspection and descriptor open', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-prior-report-symlink-race');
    const outputDirectory = join(clientDirectory, 'output');
    const reportPath = join(outputDirectory, 'report.json');
    await mkdir(outputDirectory);
    await writeFile(reportPath, '{"previous":true}\n');
    const result = await dailyReportWorker.execute(workerContext);
    beforeReportOpenSwap.path = join(await realpath(outputDirectory), 'report.json');
    beforeReportOpenSwap.replacement = checkedInCsv;
    beforeReportOpenSwap.kind = 'symlink';

    await expect(dailyReportWorker.commit(workerContext, result)).rejects.toThrow(/non-symlink/i);
    await dailyReportWorker.rollback(workerContext);
  });

  it('rejects a prior report grown past the bound before descriptor capture', async () => {
    await installCheckedInCsv();
    const workerContext = context('run-prior-report-size-race');
    const outputDirectory = join(clientDirectory, 'output');
    const reportPath = join(outputDirectory, 'report.json');
    await mkdir(outputDirectory);
    await writeFile(reportPath, '{"previous":true}\n');
    const result = await dailyReportWorker.execute(workerContext);
    beforeReportOpenSwap.path = join(await realpath(outputDirectory), 'report.json');
    beforeReportOpenSwap.replacement = 'x'.repeat(270_000);
    beforeReportOpenSwap.kind = 'grow';

    await expect(dailyReportWorker.commit(workerContext, result)).rejects.toThrow(
      /rollback size limit/i
    );
    await dailyReportWorker.rollback(workerContext);
  });

  it.each([
    ['symlink', async (reportPath: string) => symlink(checkedInCsv, reportPath), /non-symlink/],
    ['directory', async (reportPath: string) => mkdir(reportPath), /regular file/],
    [
      'oversized file',
      async (reportPath: string) => writeFile(reportPath, 'x'.repeat(270_000)),
      /rollback size limit/
    ]
  ])('rejects an existing canonical report that is a %s', async (_label, install, error) => {
    await installCheckedInCsv();
    const workerContext = context();
    const outputDirectory = join(clientDirectory, 'output');
    await mkdir(outputDirectory);
    await install(join(outputDirectory, 'report.json'));
    const result = await dailyReportWorker.execute(workerContext);

    await expect(dailyReportWorker.commit?.(workerContext, result)).rejects.toThrow(error);
    await dailyReportWorker.rollback?.(workerContext);
  });

  it('rejects malformed CSV rows without writing a report', async () => {
    await writeFile(
      join(clientDirectory, 'data', 'sample-leads.csv'),
      [
        'id,name,email,status',
        'lead-001,Avery Stone,avery.stone@example.test,qualified',
        'lead-002,Broken Row,missing-status'
      ].join('\n'),
      'utf8'
    );

    await expect(runDailyReport(context())).rejects.toThrow(/malformed/i);
    await expect(stat(join(clientDirectory, 'output', 'report.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('rejects an oversized CSV before loading it into memory', async () => {
    await writeFile(
      join(clientDirectory, 'data', 'sample-leads.csv'),
      `id,name,email,status\n${'x'.repeat(70_000)}`,
      'utf8'
    );

    await expect(runDailyReport(context())).rejects.toThrow(/size limit/i);
    await expect(stat(join(clientDirectory, 'output', 'report.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('rejects duplicate lead IDs without writing a report', async () => {
    await writeFile(
      join(clientDirectory, 'data', 'sample-leads.csv'),
      [
        'id,name,email,status',
        'lead-001,Avery Stone,avery.stone@example.test,qualified',
        'lead-001,Blair Woods,blair.woods@example.test,new',
        'lead-003,Casey Brooks,casey.brooks@example.test,qualified',
        'lead-004,Drew Parker,drew.parker@example.test,contacted',
        'lead-005,Emerson Lane,emerson.lane@example.test,qualified',
        'lead-006,Finley Quinn,finley.quinn@example.test,disqualified',
        'lead-007,Gray Monroe,gray.monroe@example.test,new',
        'lead-008,Harper Reed,harper.reed@example.test,qualified',
        'lead-009,Indigo Hayes,indigo.hayes@example.test,contacted',
        'lead-010,Jordan Ellis,jordan.ellis@example.test,qualified'
      ].join('\n'),
      'utf8'
    );

    await expect(runDailyReport(context())).rejects.toThrow(/duplicate lead id/i);
    await expect(stat(join(clientDirectory, 'output', 'report.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });
});
