import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import SQLite from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ModelExecutionEnablementService,
  SqliteModelExecutionEnablementRepository
} from '../../src/economics/model-execution-enablement';
import {
  runModelEnablementCli,
  type ModelEnablementCliDeps
} from '../../src/models/model-enablement-cli';

const MIGRATION = readFileSync(
  join(process.cwd(), 'src', 'db', 'migrations', '020_model_execution_enablement.sql'),
  'utf8'
);

function inMemoryDeps(): { deps: ModelEnablementCliDeps; close: () => void } {
  const sqlite = new SQLite(':memory:');
  sqlite.exec(MIGRATION);
  const service = new ModelExecutionEnablementService({
    repository: new SqliteModelExecutionEnablementRepository(sqlite)
  });
  return {
    deps: {
      async openService() {
        await service.initialize();
        return { service, destroy: () => Promise.resolve() };
      }
    },
    close: () => sqlite.close()
  };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (m: string) => out.push(m), stderr: (m: string) => err.push(m) }
  };
}

let closer: (() => void) | undefined;
afterEach(() => {
  closer?.();
  closer = undefined;
});

function deps() {
  const built = inMemoryDeps();
  closer = built.close;
  return built.deps;
}

describe('model enablement CLI', () => {
  it('reports the disabled bootstrap record by default', async () => {
    const { out, io } = capture();
    const code = await runModelEnablementCli(['status'], io, deps());
    expect(code).toBe(0);
    const record = JSON.parse(out[0] ?? '{}') as { enabled: boolean; version: number };
    expect(record.enabled).toBe(false);
    expect(record.version).toBe(1);
  });

  it('enables a specific tier, surface, and provider with an approver and bumps the version', async () => {
    const shared = deps();
    const first = capture();
    const enableCode = await runModelEnablementCli(
      [
        'enable',
        '--approver',
        'jackhunter',
        '--reason',
        'local runtime proof',
        '--tiers',
        '1',
        '--surfaces',
        'automation',
        '--providers',
        'ollama'
      ],
      first.io,
      shared
    );
    expect(enableCode).toBe(0);
    const enabled = JSON.parse(first.out[0] ?? '{}') as {
      enabled: boolean;
      version: number;
      approver: string;
      allowedTiers: number[];
      allowedProviders: string[];
      allowedSurfaces: string[];
    };
    expect(enabled.enabled).toBe(true);
    expect(enabled.version).toBe(2);
    expect(enabled.approver).toBe('jackhunter');
    expect(enabled.allowedTiers).toEqual([1]);
    expect(enabled.allowedProviders).toEqual(['ollama']);
    expect(enabled.allowedSurfaces).toEqual(['automation']);
  });

  it('disables an enabled record and clears the allow-lists', async () => {
    const shared = deps();
    await runModelEnablementCli(
      [
        'enable',
        '--approver',
        'jackhunter',
        '--reason',
        'enable for disable test',
        '--tiers',
        '1',
        '--surfaces',
        'automation',
        '--providers',
        'ollama'
      ],
      capture().io,
      shared
    );
    const off = capture();
    const code = await runModelEnablementCli(
      ['disable', '--updated-by', 'jackhunter', '--reason', 'done proving'],
      off.io,
      shared
    );
    expect(code).toBe(0);
    const record = JSON.parse(off.out[0] ?? '{}') as {
      enabled: boolean;
      version: number;
      allowedProviders: string[];
    };
    expect(record.enabled).toBe(false);
    expect(record.version).toBe(3);
    expect(record.allowedProviders).toEqual([]);
  });

  it('rejects an unknown subcommand', async () => {
    const { err, io } = capture();
    const code = await runModelEnablementCli(['frobnicate'], io, deps());
    expect(code).toBe(1);
    expect((JSON.parse(err[0] ?? '{}') as { error: { code: string } }).error.code).toBe(
      'UNKNOWN_SUBCOMMAND'
    );
  });

  it('rejects an invalid tier and a missing approver', async () => {
    const badTier = capture();
    expect(
      await runModelEnablementCli(
        [
          'enable',
          '--approver',
          'a1c',
          '--reason',
          'r',
          '--tiers',
          '9',
          '--surfaces',
          'automation',
          '--providers',
          'ollama'
        ],
        badTier.io,
        deps()
      )
    ).toBe(1);
    expect((JSON.parse(badTier.err[0] ?? '{}') as { error: { code: string } }).error.code).toBe(
      'INVALID_TIER'
    );

    const noApprover = capture();
    expect(
      await runModelEnablementCli(
        [
          'enable',
          '--reason',
          'r',
          '--tiers',
          '1',
          '--surfaces',
          'automation',
          '--providers',
          'ollama'
        ],
        noApprover.io,
        deps()
      )
    ).toBe(1);
    expect((JSON.parse(noApprover.err[0] ?? '{}') as { error: { code: string } }).error.code).toBe(
      'MISSING_APPROVER'
    );
  });
});
