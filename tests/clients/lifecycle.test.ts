import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LifecycleClientService, type ClientRegistryStore } from '../../src/clients/service';
import { ClientScaffolder } from '../../src/clients/scaffold';
import { PolicyService } from '../../src/config/policies';
import type { ClientRecord, NewClientRecord } from '../../src/db/client-repository';
import { ClientRepository } from '../../src/db/client-repository';
import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import { MarkdownGraph } from '../../src/memory/markdown-graph';

const projectRoot = join(__dirname, '..', '..');
const now = '2026-07-18T12:00:00.000Z';

class FailingRegistry implements ClientRegistryStore {
  list(): Promise<ClientRecord[]> {
    return Promise.resolve([]);
  }

  findById(): Promise<ClientRecord | undefined> {
    return Promise.resolve(undefined);
  }

  create(): Promise<ClientRecord> {
    return Promise.reject(new Error('database unavailable'));
  }

  delete(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

class GateFirstCreateRegistry implements ClientRegistryStore {
  readonly firstCreateStarted: Promise<void>;
  private releaseFirstCreate: (() => void) | undefined;
  private signalFirstCreate: (() => void) | undefined;
  private createCount = 0;

  constructor(private readonly delegate: ClientRegistryStore) {
    this.firstCreateStarted = new Promise((resolve) => {
      this.signalFirstCreate = resolve;
    });
  }

  list(): Promise<ClientRecord[]> {
    return this.delegate.list();
  }

  findById(id: string): Promise<ClientRecord | undefined> {
    return this.delegate.findById(id);
  }

  async create(input: NewClientRecord): Promise<ClientRecord> {
    this.createCount += 1;
    if (this.createCount === 1) {
      this.signalFirstCreate?.();
      await new Promise<void>((resolve) => {
        this.releaseFirstCreate = resolve;
      });
    }
    return this.delegate.create(input);
  }

  delete(id: string): Promise<boolean> {
    return this.delegate.delete(id);
  }

  release(): void {
    this.releaseFirstCreate?.();
  }
}

describe('LifecycleClientService', () => {
  let temporaryRoot: string;
  let database: GlobalDatabaseContext;
  let repository: ClientRepository;
  let policies: PolicyService;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-lifecycle-test-'));
    database = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    repository = new ClientRepository(database.db);
    policies = await PolicyService.load({ projectRoot });
  });

  afterEach(async () => {
    await database.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  function createService(registry: ClientRegistryStore = repository): LifecycleClientService {
    return new LifecycleClientService({
      registry,
      scaffolder: new ClientScaffolder({
        projectRoot,
        clientRoot: join(temporaryRoot, 'clients'),
        workspaceRoot: join(temporaryRoot, 'workspaces'),
        idFactory: () => 'stage-1'
      }),
      policies,
      graph: new MarkdownGraph({
        graphRoot: join(temporaryRoot, 'memory', 'graph'),
        now: () => now
      }),
      now: () => now
    });
  }

  it('coordinates policy, filesystem, registry, and Markdown graph creation', async () => {
    const service = createService();

    const client = await service.create({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing'
    });

    expect(client).toMatchObject({ id: 'acme_corp', status: 'active', createdAt: now });
    await expect(repository.findById('acme_corp')).resolves.toEqual(client);
    await expect(
      stat(join(temporaryRoot, 'clients', 'acme_corp', 'memory', 'client.sqlite'))
    ).resolves.toMatchObject({});
    expect(
      await readFile(join(temporaryRoot, 'memory', 'graph', 'clients', 'acme_corp.md'), 'utf8')
    ).toContain('[[clients/index]]');
    expect(
      await readFile(
        join(temporaryRoot, 'clients', 'acme_corp', 'memory', 'notes', 'index.md'),
        'utf8'
      )
    ).toContain('Tenant-private Markdown memory');
  });

  it('rejects unapproved profiles before creating registry or filesystem state', async () => {
    const service = createService();

    await expect(
      service.create({ id: 'acme_corp', name: 'Acme Corporation', profile: 'full_automation' })
    ).rejects.toMatchObject({ code: 'PROFILE_APPROVAL_REQUIRED' });

    await expect(repository.findById('acme_corp')).resolves.toBeUndefined();
    await expect(stat(join(temporaryRoot, 'clients', 'acme_corp'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('removes scaffolded state when database persistence fails', async () => {
    const service = createService(new FailingRegistry());

    await expect(
      service.create({ id: 'acme_corp', name: 'Acme Corporation', profile: 'data_processing' })
    ).rejects.toThrow('database unavailable');

    await expect(stat(join(temporaryRoot, 'clients', 'acme_corp'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await expect(stat(join(temporaryRoot, 'workspaces', 'acme_corp'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('rolls back registry and generated files when graph validation fails', async () => {
    const automationDirectory = join(temporaryRoot, 'clients', 'acme_corp', 'automations');
    const automationFile = join(automationDirectory, 'daily-report.ts');
    await mkdir(automationDirectory, { recursive: true });
    await writeFile(automationFile, 'export const preserved = true;\n');
    const graph = new MarkdownGraph({
      graphRoot: join(temporaryRoot, 'memory', 'graph'),
      now: () => now
    });
    await graph.initialize();
    await writeFile(
      join(temporaryRoot, 'memory', 'graph', 'broken.md'),
      [
        '---',
        'id: "broken"',
        'type: "test"',
        'title: "Broken"',
        `created_at: "${now}"`,
        `updated_at: "${now}"`,
        'tags:',
        '  - "test"',
        '---',
        '',
        '[[missing/node]]',
        ''
      ].join('\n')
    );

    await expect(
      createService().create({
        id: 'acme_corp',
        name: 'Acme Corporation',
        profile: 'data_processing'
      })
    ).rejects.toMatchObject({ code: 'BROKEN_MEMORY_LINK' });

    await expect(repository.findById('acme_corp')).resolves.toBeUndefined();
    expect(await readFile(automationFile, 'utf8')).toBe('export const preserved = true;\n');
    await expect(
      stat(join(temporaryRoot, 'memory', 'graph', 'clients', 'acme_corp.md'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns a conflict without mutating an existing client', async () => {
    const service = createService();
    await service.create({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing'
    });

    await expect(
      service.create({ id: 'acme_corp', name: 'Other Acme', profile: 'email_only' })
    ).rejects.toMatchObject({ code: 'CLIENT_EXISTS' });
    await expect(service.list()).resolves.toHaveLength(1);
  });

  it('serializes concurrent creation of the same client without deleting the winner', async () => {
    const registry = new GateFirstCreateRegistry(repository);
    const service = createService(registry);
    const first = service.create({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing'
    });
    await registry.firstCreateStarted;

    const second = service.create({
      id: 'acme_corp',
      name: 'Other Acme',
      profile: 'data_processing'
    });
    registry.release();

    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: { code: 'CLIENT_EXISTS', statusCode: 409 }
    });
    await expect(repository.findById('acme_corp')).resolves.toMatchObject({
      id: 'acme_corp',
      name: 'Acme Corporation'
    });
    await expect(stat(join(temporaryRoot, 'clients', 'acme_corp'))).resolves.toMatchObject({});
  });
});
