import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import { startServer, type StartedServer } from '../../src/gateway/server';
import { ProviderRateLimitCircuit } from '../../src/models/provider-rate-limit-circuit';
import type { ProviderRecoveryRecord } from '../../src/models/provider-recovery-scheduler';

const projectRoot = join(__dirname, '..', '..');

function timeoutAfter(milliseconds: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error('Provider recovery did not reconcile')),
      milliseconds
    ).unref();
  });
}

describe('gateway provider recovery lifecycle', () => {
  let temporaryRoot: string;
  let started: StartedServer | undefined;
  let database: GlobalDatabaseContext | undefined;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-provider-recovery-test-'));
    started = undefined;
    database = undefined;
  });

  afterEach(async () => {
    if (started === undefined) {
      await database?.destroy();
    } else {
      await started.stop();
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('reconciles a durable due circuit immediately after the gateway binds', async () => {
    const detectedAt = Date.now() - 60 * 60 * 1_000 - 1;
    let publishDue: ((record: ProviderRecoveryRecord) => void) | undefined;
    const due = new Promise<ProviderRecoveryRecord>((resolve) => {
      publishDue = resolve;
    });

    started = await startServer({
      projectRoot,
      databaseFile: join(temporaryRoot, 'jarvis.sqlite'),
      clientRoot: join(temporaryRoot, 'clients'),
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot: join(temporaryRoot, 'memory', 'graph'),
      databaseFactory: async (options) => {
        const database = await createDatabase(options);
        new ProviderRateLimitCircuit(database.sqlite).open('claude', {
          detectedAt,
          resetAt: null
        });
        return database;
      },
      monitoring: false,
      automationCycling: false,
      providerRecovery: {
        onDue: (record) => publishDue?.(record)
      },
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });

    await expect(Promise.race([due, timeoutAfter(2_000)])).resolves.toEqual({
      provider: 'claude',
      notBefore: detectedAt + 60 * 60 * 1_000
    });
  });

  it('reschedules to a circuit opened after startup through the shared durable instance', async () => {
    const databaseFile = join(temporaryRoot, 'jarvis.sqlite');
    database = await createDatabase({ projectRoot, filename: databaseFile });
    const providerRateLimits = new ProviderRateLimitCircuit(database.sqlite);
    const published: ProviderRecoveryRecord[] = [];
    let publishFirst: ((record: ProviderRecoveryRecord) => void) | undefined;
    let publishSecond: ((record: ProviderRecoveryRecord) => void) | undefined;
    const firstDue = new Promise<ProviderRecoveryRecord>((resolve) => {
      publishFirst = resolve;
    });
    const secondDue = new Promise<ProviderRecoveryRecord>((resolve) => {
      publishSecond = resolve;
    });

    started = await startServer({
      projectRoot,
      databaseFile,
      clientRoot: join(temporaryRoot, 'clients'),
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot: join(temporaryRoot, 'memory', 'graph'),
      databaseFactory: () => Promise.resolve(database as GlobalDatabaseContext),
      monitoring: false,
      automationCycling: false,
      providerRecovery: {
        rateLimitCircuit: providerRateLimits,
        onDue: (record) => {
          published.push(record);
          if (published.length === 1) publishFirst?.(record);
          if (published.length === 2) publishSecond?.(record);
        }
      },
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });

    const openedAt = Date.now();
    const detectedAt = openedAt - 10 * 60 * 1_000;
    const resetAt = openedAt - 5 * 60 * 1_000 + 200;
    const expectedNotBefore = resetAt + 5 * 60 * 1_000;
    providerRateLimits.open('codex', { detectedAt, resetAt });

    await expect(Promise.race([firstDue, timeoutAfter(2_000)])).resolves.toEqual({
      provider: 'codex',
      notBefore: expectedNotBefore
    });

    expect(providerRateLimits.claim('codex', 200)).toMatchObject({
      allowed: true,
      halfOpen: true
    });
    const claim = database.sqlite
      .prepare(
        `SELECT claim_expires_at
           FROM provider_rate_limit_circuits
          WHERE provider = ?`
      )
      .get('codex') as { claim_expires_at: number };

    await expect(Promise.race([secondDue, timeoutAfter(2_000)])).resolves.toEqual({
      provider: 'codex',
      notBefore: claim.claim_expires_at
    });
  });
});
