import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import SQLite from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ModelExecutionEnablementService,
  SqliteModelExecutionEnablementRepository
} from '../../src/economics/model-execution-enablement';

const projectRoot = join(__dirname, '..', '..');

async function migrate(sqlite: SQLite.Database): Promise<void> {
  sqlite.exec(
    await readFile(
      join(projectRoot, 'src/db/migrations/020_model_execution_enablement.sql'),
      'utf8'
    )
  );
}

describe('durable model-execution enablement record', () => {
  let sqlite: SQLite.Database;
  let service: ModelExecutionEnablementService;

  beforeEach(async () => {
    sqlite = new SQLite(':memory:');
    await migrate(sqlite);
    service = new ModelExecutionEnablementService({
      repository: new SqliteModelExecutionEnablementRepository(sqlite),
      now: () => '2026-07-23T18:00:00.000Z'
    });
  });

  it('bootstraps disabled by default and is idempotent', async () => {
    const first = await service.initialize();
    expect(first).toMatchObject({
      enabled: false,
      version: 1,
      approver: null,
      approvedAt: null,
      allowedTiers: [],
      allowedSurfaces: [],
      allowedProviders: []
    });
    const second = await service.initialize();
    expect(second.version).toBe(1);
    expect(await service.snapshot()).toEqual({ enabled: false, allowedTiers: [], version: 1 });
  });

  it('enables execution for the operator with a version-checked, audited transition', async () => {
    await service.initialize();
    const enabled = await service.enable({
      approver: 'principal:web_operator',
      reason: 'operator_flipped_switch_on',
      allowedTiers: [3, 1, 1, 2],
      allowedSurfaces: ['telegram', 'web', 'telegram'],
      allowedProviders: ['ollama', 'claude'],
      expectedVersion: 1
    });
    expect(enabled).toMatchObject({
      enabled: true,
      version: 2,
      approver: 'principal:web_operator',
      approvedAt: '2026-07-23T18:00:00.000Z',
      allowedTiers: [1, 2, 3],
      allowedSurfaces: ['telegram', 'web'],
      allowedProviders: ['claude', 'ollama']
    });
    expect(await service.snapshot()).toEqual({
      enabled: true,
      allowedTiers: [1, 2, 3],
      version: 2
    });
    const events = sqlite
      .prepare(
        'SELECT to_enabled, resulting_version, approver FROM model_execution_enablement_events ORDER BY sequence'
      )
      .all() as Array<{ to_enabled: number; resulting_version: number; approver: string | null }>;
    expect(events).toEqual([
      { to_enabled: 0, resulting_version: 1, approver: null },
      { to_enabled: 1, resulting_version: 2, approver: 'principal:web_operator' }
    ]);
  });

  it('re-enables from an already-enabled state, recording the prior enabled flag in the event', async () => {
    await service.initialize();
    await service.enable({
      approver: 'principal:web_operator',
      reason: 'first_on',
      allowedTiers: [1],
      allowedSurfaces: ['web'],
      allowedProviders: ['ollama'],
      expectedVersion: 1
    });
    const reEnabled = await service.enable({
      approver: 'principal:web_operator',
      reason: 'widen_tiers',
      allowedTiers: [1, 2, 3],
      allowedSurfaces: ['web', 'telegram'],
      allowedProviders: ['claude', 'ollama'],
      expectedVersion: 2
    });
    expect(reEnabled).toMatchObject({ enabled: true, version: 3, allowedTiers: [1, 2, 3] });
    const lastEvent = sqlite
      .prepare(
        'SELECT from_enabled, to_enabled FROM model_execution_enablement_events ORDER BY sequence DESC LIMIT 1'
      )
      .get() as { from_enabled: number; to_enabled: number };
    expect(lastEvent).toEqual({ from_enabled: 1, to_enabled: 1 });
  });

  it('rejects an enable against a stale expected version', async () => {
    await service.initialize();
    await service.enable({
      approver: 'principal:web_operator',
      reason: 'first',
      allowedTiers: [1],
      allowedSurfaces: ['web'],
      allowedProviders: ['ollama'],
      expectedVersion: 1
    });
    await expect(
      service.enable({
        approver: 'principal:web_operator',
        reason: 'stale',
        allowedTiers: [2],
        allowedSurfaces: ['web'],
        allowedProviders: ['claude'],
        expectedVersion: 1
      })
    ).rejects.toThrow(/version conflict/i);
  });

  it('disables execution again, clearing approval and emptying the allow-lists', async () => {
    await service.initialize();
    await service.enable({
      approver: 'principal:web_operator',
      reason: 'switch_on',
      allowedTiers: [1, 2],
      allowedSurfaces: ['web'],
      allowedProviders: ['ollama'],
      expectedVersion: 1
    });
    const disabled = await service.disable({
      updatedBy: 'principal:web_operator',
      reason: 'kill_switch',
      expectedVersion: 2
    });
    expect(disabled).toMatchObject({
      enabled: false,
      version: 3,
      approver: null,
      approvedAt: null,
      allowedTiers: [],
      allowedSurfaces: [],
      allowedProviders: []
    });
    expect(await service.snapshot()).toEqual({ enabled: false, allowedTiers: [], version: 3 });
  });

  it('rejects malformed enable input before touching the database', async () => {
    await service.initialize();
    await expect(
      service.enable({
        approver: 'x',
        reason: 'too_short_approver',
        allowedTiers: [1],
        allowedSurfaces: ['web'],
        allowedProviders: ['ollama'],
        expectedVersion: 1
      })
    ).rejects.toThrow();
    await expect(
      service.enable({
        approver: 'principal:web_operator',
        reason: 'bad_tier',
        allowedTiers: [4],
        allowedSurfaces: ['web'],
        allowedProviders: ['ollama'],
        expectedVersion: 1
      })
    ).rejects.toThrow();
    await expect(
      service.enable({
        approver: 'principal:web_operator',
        reason: 'empty_providers',
        allowedTiers: [1],
        allowedSurfaces: ['web'],
        allowedProviders: [],
        expectedVersion: 1
      })
    ).rejects.toThrow();
    // The record is untouched and still disabled.
    expect(await service.snapshot()).toEqual({ enabled: false, allowedTiers: [], version: 1 });
  });

  it('resolves a fail-closed disabled snapshot when the record cannot be read', async () => {
    const brokenService = new ModelExecutionEnablementService({
      repository: {
        initialize() {
          throw new Error('unreachable');
        },
        current() {
          throw new Error('corrupt enablement row');
        }
      } as unknown as SqliteModelExecutionEnablementRepository,
      now: () => '2026-07-23T18:00:00.000Z'
    });
    expect(await brokenService.resolveSnapshot()).toEqual({
      enabled: false,
      allowedTiers: [],
      version: 1
    });
  });
});
