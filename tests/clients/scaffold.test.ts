import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import SQLite from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClientScaffolder } from '../../src/clients/scaffold';
import { PolicyService } from '../../src/config/policies';
import { ClientConfigSchema } from '../../src/config/schemas';

const projectRoot = join(__dirname, '..', '..');
const now = '2026-07-18T12:00:00.000Z';

describe('ClientScaffolder', () => {
  let temporaryRoot: string;
  let clientRoot: string;
  let workspaceRoot: string;
  let scaffolder: ClientScaffolder;
  let policies: PolicyService;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-scaffold-test-'));
    clientRoot = join(temporaryRoot, 'clients');
    workspaceRoot = join(temporaryRoot, 'workspaces');
    scaffolder = new ClientScaffolder({
      projectRoot,
      clientRoot,
      workspaceRoot,
      idFactory: () => 'stage-1'
    });
    policies = await PolicyService.load({ projectRoot });
  });

  async function createVersionedProjectRoot(): Promise<string> {
    const versionedProjectRoot = join(temporaryRoot, 'versioned-project');
    const templateDirectory = join(versionedProjectRoot, 'memory', 'clients', '_template');
    await mkdir(templateDirectory, { recursive: true });
    for (const filename of ['schema.sql', 'client_sops.md']) {
      await writeFile(
        join(templateDirectory, filename),
        await readFile(join(projectRoot, 'memory', 'clients', '_template', filename))
      );
    }
    return versionedProjectRoot;
  }

  function input() {
    return {
      client: {
        id: 'acme_corp' as const,
        name: 'Acme Corporation',
        profile: 'data_processing' as const
      },
      createdAt: now,
      toolPolicy: policies.resolveToolPolicy('data_processing'),
      networkPolicy: policies.resolveNetworkPolicy('acme_corp')
    };
  }

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('creates an isolated client tree, config, agent stub, policies, and SQLite memory', async () => {
    const result = await scaffolder.scaffold({
      client: { id: 'acme_corp', name: 'Acme Corporation', profile: 'data_processing' },
      createdAt: now,
      toolPolicy: policies.resolveToolPolicy('data_processing'),
      networkPolicy: policies.resolveNetworkPolicy('acme_corp')
    });

    const clientDirectory = join(clientRoot, 'acme_corp');
    const config = ClientConfigSchema.parse(
      JSON.parse(await readFile(join(clientDirectory, 'client-config.json'), 'utf8')) as unknown
    );
    const stub = JSON.parse(
      await readFile(join(clientDirectory, 'agent-config-stub.json'), 'utf8')
    ) as Array<{
      id: string;
      sandbox: { scope: string; binds?: string[] };
      tools: { allow: string[] };
    }>;
    const resolvedPolicies = JSON.parse(
      await readFile(join(clientDirectory, 'resolved-policies.json'), 'utf8')
    ) as { network: { mode: string }; tools: { tools_allow: string[] } };

    expect(result.config).toEqual(config);
    expect(config).toMatchObject({
      id: 'acme_corp',
      profile: 'data_processing',
      clientDirectory,
      workspacePath: join(workspaceRoot, 'acme_corp')
    });
    await expect(stat(join(clientDirectory, 'automations'))).resolves.toMatchObject({});
    await expect(stat(join(clientDirectory, 'data'))).resolves.toMatchObject({});
    await expect(stat(join(clientDirectory, 'output'))).resolves.toMatchObject({});
    expect(await readFile(join(clientDirectory, 'data', 'sample-leads.csv'), 'utf8')).toBe(
      await readFile(join(projectRoot, 'clients', 'acme_corp', 'data', 'sample-leads.csv'), 'utf8')
    );
    expect(await readFile(join(clientDirectory, 'memory', 'schema.sql'), 'utf8')).toBe(
      await readFile(join(projectRoot, 'memory', 'clients', '_template', 'schema.sql'), 'utf8')
    );
    expect(stub.map((agent) => agent.id)).toEqual(['acme_corp_supervisor', 'acme_corp_worker']);
    expect(stub[0]?.sandbox).toMatchObject({ scope: 'agent' });
    expect(stub[0]?.sandbox.binds?.[0]).toContain(':ro');
    expect(stub[0]?.tools.allow).toEqual(['read', 'write', 'exec']);
    expect(resolvedPolicies).toMatchObject({
      network: { mode: 'none' },
      tools: { tools_allow: ['read', 'write', 'exec'] }
    });

    const clientDatabase = new SQLite(join(clientDirectory, 'memory', 'client.sqlite'), {
      readonly: true
    });
    const tables = clientDatabase
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    clientDatabase.close();
    expect(tables).toEqual(
      expect.arrayContaining(['task_history', 'crm_leads', 'agent_scratchpad'])
    );
  });

  it('rejects a file occupying the validated client directory', async () => {
    await mkdir(clientRoot);
    await writeFile(join(clientRoot, 'acme_corp'), 'not a client directory\n');

    await expect(scaffolder.scaffold(input())).rejects.toMatchObject({
      statusCode: 409,
      code: 'CLIENT_PATH_INVALID'
    });
  });

  it('rolls back directories created for a new client', async () => {
    const result = await scaffolder.scaffold({
      client: { id: 'acme_corp', name: 'Acme Corporation', profile: 'data_processing' },
      createdAt: now,
      toolPolicy: policies.resolveToolPolicy('data_processing'),
      networkPolicy: policies.resolveNetworkPolicy('acme_corp')
    });

    await result.rollback();

    await expect(stat(join(clientRoot, 'acme_corp'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(workspaceRoot, 'acme_corp'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(result.rollback()).resolves.toBeUndefined();
  });

  it('preserves automation code in an existing checked-in client directory', async () => {
    const automationDirectory = join(clientRoot, 'acme_corp', 'automations');
    const automationFile = join(automationDirectory, 'daily-report.ts');
    await mkdir(automationDirectory, { recursive: true });
    await writeFile(automationFile, 'export const sentinel = true;\n');

    await scaffolder.scaffold({
      client: { id: 'acme_corp', name: 'Acme Corporation', profile: 'data_processing' },
      createdAt: now,
      toolPolicy: policies.resolveToolPolicy('data_processing'),
      networkPolicy: policies.resolveNetworkPolicy('acme_corp')
    });

    expect(await readFile(automationFile, 'utf8')).toBe('export const sentinel = true;\n');
  });

  it('does not overwrite existing tenant data with a versioned asset', async () => {
    const dataDirectory = join(clientRoot, 'acme_corp', 'data');
    const tenantCsv = join(dataDirectory, 'sample-leads.csv');
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(tenantCsv, 'tenant-owned data\n');

    const result = await scaffolder.scaffold(input());
    expect(await readFile(tenantCsv, 'utf8')).toBe('tenant-owned data\n');

    await result.rollback();
    expect(await readFile(tenantCsv, 'utf8')).toBe('tenant-owned data\n');
  });

  it('does not clobber tenant data created during versioned asset publication', async () => {
    const clientDirectory = join(clientRoot, 'acme_corp');
    const dataDirectory = join(clientDirectory, 'data');
    const tenantCsv = join(dataDirectory, 'sample-leads.csv');
    await mkdir(dataDirectory, { recursive: true });
    let injectedTenantWrite = false;
    const racingScaffolder = new ClientScaffolder({
      projectRoot,
      clientRoot,
      workspaceRoot,
      idFactory: () => {
        if (!injectedTenantWrite) {
          injectedTenantWrite = true;
          writeFileSync(tenantCsv, 'tenant won the race\n', { flag: 'wx' });
        }
        return 'race-stage';
      }
    });

    const result = await racingScaffolder.scaffold(input());
    expect(await readFile(tenantCsv, 'utf8')).toBe('tenant won the race\n');

    await result.rollback();
    expect(await readFile(tenantCsv, 'utf8')).toBe('tenant won the race\n');
  });

  it('removes newly provisioned data assets on rollback while preserving tenant data', async () => {
    const dataDirectory = join(clientRoot, 'acme_corp', 'data');
    const tenantFile = join(dataDirectory, 'tenant-owned.csv');
    const versionedFile = join(dataDirectory, 'sample-leads.csv');
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(tenantFile, 'keep me\n');

    const result = await scaffolder.scaffold(input());
    await expect(stat(versionedFile)).resolves.toMatchObject({});

    await result.rollback();

    await expect(stat(versionedFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(tenantFile, 'utf8')).toBe('keep me\n');
  });

  it('rejects symlinked versioned data assets without touching their targets', async () => {
    const versionedProjectRoot = await createVersionedProjectRoot();
    const sourceData = join(versionedProjectRoot, 'clients', 'acme_corp', 'data');
    const outsideFile = join(temporaryRoot, 'outside.csv');
    await mkdir(sourceData, { recursive: true });
    await writeFile(outsideFile, 'outside stays private\n');
    await symlink(outsideFile, join(sourceData, 'sample-leads.csv'));
    const isolatedClientRoot = join(temporaryRoot, 'isolated-clients');
    const isolatedScaffolder = new ClientScaffolder({
      projectRoot: versionedProjectRoot,
      clientRoot: isolatedClientRoot,
      workspaceRoot: join(temporaryRoot, 'isolated-workspaces'),
      idFactory: () => 'asset-stage'
    });

    await expect(isolatedScaffolder.scaffold(input())).rejects.toMatchObject({
      statusCode: 409,
      code: 'CLIENT_PATH_INVALID'
    });

    expect(await readFile(outsideFile, 'utf8')).toBe('outside stays private\n');
    await expect(stat(join(isolatedClientRoot, 'acme_corp'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('allows a project with no versioned client data assets', async () => {
    const versionedProjectRoot = await createVersionedProjectRoot();
    const isolatedClientRoot = join(temporaryRoot, 'no-assets-clients');
    const isolatedScaffolder = new ClientScaffolder({
      projectRoot: versionedProjectRoot,
      clientRoot: isolatedClientRoot,
      workspaceRoot: join(temporaryRoot, 'no-assets-workspaces')
    });

    const result = await isolatedScaffolder.scaffold(input());
    expect(await readdir(join(isolatedClientRoot, 'acme_corp', 'data'))).toEqual([]);
    await result.rollback();
  });

  it('rejects an unsafely named versioned data asset', async () => {
    const versionedProjectRoot = await createVersionedProjectRoot();
    const sourceData = join(versionedProjectRoot, 'clients', 'acme_corp', 'data');
    await mkdir(sourceData, { recursive: true });
    await writeFile(join(sourceData, '.hidden-seed'), 'hidden\n');
    const isolatedScaffolder = new ClientScaffolder({
      projectRoot: versionedProjectRoot,
      clientRoot: join(temporaryRoot, 'unsafe-name-clients'),
      workspaceRoot: join(temporaryRoot, 'unsafe-name-workspaces')
    });

    await expect(isolatedScaffolder.scaffold(input())).rejects.toMatchObject({
      statusCode: 409,
      code: 'CLIENT_PATH_INVALID'
    });
  });

  it('copies a safely nested versioned data directory', async () => {
    const versionedProjectRoot = await createVersionedProjectRoot();
    const sourceData = join(versionedProjectRoot, 'clients', 'acme_corp', 'data', 'nested');
    await mkdir(sourceData, { recursive: true });
    await writeFile(join(sourceData, 'seed.csv'), 'id,status\nlead-1,qualified\n');
    const isolatedClientRoot = join(temporaryRoot, 'nested-assets-clients');
    const isolatedScaffolder = new ClientScaffolder({
      projectRoot: versionedProjectRoot,
      clientRoot: isolatedClientRoot,
      workspaceRoot: join(temporaryRoot, 'nested-assets-workspaces')
    });

    const result = await isolatedScaffolder.scaffold(input());
    expect(
      await readFile(join(isolatedClientRoot, 'acme_corp', 'data', 'nested', 'seed.csv'), 'utf8')
    ).toBe('id,status\nlead-1,qualified\n');
    await result.rollback();
  });

  it('rejects versioned data deeper than the bounded recursion limit', async () => {
    const versionedProjectRoot = await createVersionedProjectRoot();
    let sourceData = join(versionedProjectRoot, 'clients', 'acme_corp', 'data');
    for (let depth = 0; depth < 10; depth += 1) {
      sourceData = join(sourceData, `level-${depth}`);
    }
    await mkdir(sourceData, { recursive: true });
    await writeFile(join(sourceData, 'seed.txt'), 'too deep\n');
    const isolatedScaffolder = new ClientScaffolder({
      projectRoot: versionedProjectRoot,
      clientRoot: join(temporaryRoot, 'deep-assets-clients'),
      workspaceRoot: join(temporaryRoot, 'deep-assets-workspaces')
    });

    await expect(isolatedScaffolder.scaffold(input())).rejects.toMatchObject({
      statusCode: 409,
      code: 'CLIENT_ASSET_LIMIT_EXCEEDED'
    });
  });

  it('rejects a versioned asset larger than the bounded file-read limit', async () => {
    const versionedProjectRoot = await createVersionedProjectRoot();
    const sourceData = join(versionedProjectRoot, 'clients', 'acme_corp', 'data');
    await mkdir(sourceData, { recursive: true });
    await writeFile(join(sourceData, 'oversized.bin'), Buffer.alloc(5 * 1024 * 1024 + 1));
    const isolatedClientRoot = join(temporaryRoot, 'bounded-file-clients');
    const isolatedScaffolder = new ClientScaffolder({
      projectRoot: versionedProjectRoot,
      clientRoot: isolatedClientRoot,
      workspaceRoot: join(temporaryRoot, 'bounded-file-workspaces')
    });

    await expect(isolatedScaffolder.scaffold(input())).rejects.toMatchObject({
      statusCode: 409,
      code: 'CLIENT_ASSET_LIMIT_EXCEEDED'
    });
    await expect(stat(join(isolatedClientRoot, 'acme_corp'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('stops incremental directory iteration at the versioned asset entry limit', async () => {
    const versionedProjectRoot = await createVersionedProjectRoot();
    const sourceData = join(versionedProjectRoot, 'clients', 'acme_corp', 'data');
    await mkdir(sourceData, { recursive: true });
    for (let index = 0; index < 257; index += 1) {
      await writeFile(join(sourceData, `asset-${index.toString().padStart(3, '0')}.txt`), 'x');
    }
    const isolatedClientRoot = join(temporaryRoot, 'bounded-entry-clients');
    const isolatedScaffolder = new ClientScaffolder({
      projectRoot: versionedProjectRoot,
      clientRoot: isolatedClientRoot,
      workspaceRoot: join(temporaryRoot, 'bounded-entry-workspaces')
    });

    await expect(isolatedScaffolder.scaffold(input())).rejects.toMatchObject({
      statusCode: 409,
      code: 'CLIENT_ASSET_LIMIT_EXCEEDED'
    });
    await expect(stat(join(isolatedClientRoot, 'acme_corp'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('does not recursively copy data when the versioned source is the scaffold destination', async () => {
    const versionedProjectRoot = await createVersionedProjectRoot();
    const sourceData = join(versionedProjectRoot, 'clients', 'acme_corp', 'data');
    const sourceFile = join(sourceData, 'seed.csv');
    await mkdir(sourceData, { recursive: true });
    await writeFile(sourceFile, 'id,status\nlead-001,qualified\n');
    const sameRootScaffolder = new ClientScaffolder({
      projectRoot: versionedProjectRoot,
      clientRoot: join(versionedProjectRoot, 'clients'),
      workspaceRoot: join(temporaryRoot, 'same-root-workspaces'),
      idFactory: () => 'same-root-stage'
    });

    const result = await sameRootScaffolder.scaffold(input());

    expect(await readFile(sourceFile, 'utf8')).toBe('id,status\nlead-001,qualified\n');
    await expect(stat(join(sourceData, 'data'))).rejects.toMatchObject({ code: 'ENOENT' });
    await result.rollback();
    expect(await readFile(sourceFile, 'utf8')).toBe('id,status\nlead-001,qualified\n');
  });

  it('preserves files in a preexisting workspace', async () => {
    const workspaceDirectory = join(workspaceRoot, 'acme_corp');
    const workspaceFile = join(workspaceDirectory, 'tenant-owned.md');
    await mkdir(workspaceDirectory, { recursive: true });
    await writeFile(workspaceFile, '# Keep me\n');

    const result = await scaffolder.scaffold({
      client: { id: 'acme_corp', name: 'Acme Corporation', profile: 'data_processing' },
      createdAt: now,
      toolPolicy: policies.resolveToolPolicy('data_processing'),
      networkPolicy: policies.resolveNetworkPolicy('acme_corp')
    });

    await result.rollback();

    expect(await readFile(workspaceFile, 'utf8')).toBe('# Keep me\n');
  });

  it('atomically replaces stale grants and restores the originals on rollback', async () => {
    const clientDirectory = join(clientRoot, 'acme_corp');
    const staleStub = '[{"tools":{"allow":["dangerous_tool"]}}]\n';
    const stalePolicies =
      '{"tools":{"tools_allow":["dangerous_tool"]},"network":{"mode":"allowlist"}}\n';
    await mkdir(clientDirectory, { recursive: true });
    await writeFile(join(clientDirectory, 'agent-config-stub.json'), staleStub);
    await writeFile(join(clientDirectory, 'resolved-policies.json'), stalePolicies);

    const result = await scaffolder.scaffold({
      client: { id: 'acme_corp', name: 'Acme Corporation', profile: 'data_processing' },
      createdAt: now,
      toolPolicy: policies.resolveToolPolicy('data_processing'),
      networkPolicy: policies.resolveNetworkPolicy('acme_corp')
    });

    const stub = await readFile(join(clientDirectory, 'agent-config-stub.json'), 'utf8');
    const resolvedPolicies = await readFile(
      join(clientDirectory, 'resolved-policies.json'),
      'utf8'
    );
    expect(stub).not.toContain('dangerous_tool');
    expect(resolvedPolicies).not.toContain('dangerous_tool');
    expect(JSON.parse(stub)).toMatchObject([
      { tools: { allow: ['read', 'write', 'exec'] } },
      { tools: { allow: ['read', 'write'] } }
    ]);

    await result.rollback();

    expect(await readFile(join(clientDirectory, 'agent-config-stub.json'), 'utf8')).toBe(staleStub);
    expect(await readFile(join(clientDirectory, 'resolved-policies.json'), 'utf8')).toBe(
      stalePolicies
    );
  });

  it('is idempotent and a second rollback leaves the first scaffold intact', async () => {
    const input = {
      client: {
        id: 'acme_corp' as const,
        name: 'Acme Corporation',
        profile: 'data_processing' as const
      },
      createdAt: now,
      toolPolicy: policies.resolveToolPolicy('data_processing'),
      networkPolicy: policies.resolveNetworkPolicy('acme_corp')
    };
    await scaffolder.scaffold(input);
    const second = await scaffolder.scaffold(input);

    await second.rollback();

    const config = ClientConfigSchema.parse(
      JSON.parse(
        await readFile(join(clientRoot, 'acme_corp', 'client-config.json'), 'utf8')
      ) as unknown
    );
    expect(config.id).toBe('acme_corp');
    await expect(
      stat(join(clientRoot, 'acme_corp', 'memory', 'client.sqlite'))
    ).resolves.toBeDefined();
  });

  it.each([
    ['memory directory', 'memory'],
    ['client database', join('memory', 'client.sqlite')],
    ['notes directory', join('memory', 'notes')]
  ])(
    'rejects a nested symlink at the %s boundary without touching its target',
    async (_label, relativePath) => {
      const clientDirectory = join(clientRoot, 'acme_corp');
      const externalDirectory = join(temporaryRoot, 'outside');
      const externalSentinel = join(externalDirectory, 'sentinel.txt');
      await mkdir(externalDirectory, { recursive: true });
      await writeFile(externalSentinel, 'outside remains unchanged\n');
      await mkdir(join(clientDirectory, 'memory'), { recursive: true });
      if (relativePath === 'memory') {
        await rm(join(clientDirectory, 'memory'), { recursive: true });
      }
      const linkPath = join(clientDirectory, relativePath);
      await mkdir(join(linkPath, '..'), { recursive: true });
      await symlink(externalDirectory, linkPath);

      await expect(
        scaffolder.scaffold({
          client: { id: 'acme_corp', name: 'Acme Corporation', profile: 'data_processing' },
          createdAt: now,
          toolPolicy: policies.resolveToolPolicy('data_processing'),
          networkPolicy: policies.resolveNetworkPolicy('acme_corp')
        })
      ).rejects.toMatchObject({ statusCode: 409, code: 'CLIENT_PATH_INVALID' });

      expect(await readFile(externalSentinel, 'utf8')).toBe('outside remains unchanged\n');
      await expect(stat(join(externalDirectory, 'client.sqlite'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
    }
  );

  it('rejects a symlink nested below an automation directory', async () => {
    const automationDirectory = join(clientRoot, 'acme_corp', 'automations');
    const externalDirectory = join(temporaryRoot, 'outside-automation');
    await mkdir(automationDirectory, { recursive: true });
    await mkdir(externalDirectory);
    await symlink(externalDirectory, join(automationDirectory, 'escape'));

    await expect(
      scaffolder.scaffold({
        client: { id: 'acme_corp', name: 'Acme Corporation', profile: 'data_processing' },
        createdAt: now,
        toolPolicy: policies.resolveToolPolicy('data_processing'),
        networkPolicy: policies.resolveNetworkPolicy('acme_corp')
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'CLIENT_PATH_INVALID' });
  });

  it('validates every existing config field before opening its SQLite file', async () => {
    const clientDirectory = join(clientRoot, 'acme_corp');
    const databaseFile = join(clientDirectory, 'memory', 'client.sqlite');
    const invalidDatabase = 'this must not be opened as sqlite';
    await mkdir(join(clientDirectory, 'memory'), { recursive: true });
    await writeFile(databaseFile, invalidDatabase);
    await writeFile(
      join(clientDirectory, 'client-config.json'),
      `${JSON.stringify(
        {
          id: 'acme_corp',
          name: 'Wrong Corporation',
          profile: 'data_processing',
          status: 'active',
          createdAt: now,
          workspacePath: join(workspaceRoot, 'acme_corp'),
          clientDirectory,
          databasePath: databaseFile
        },
        null,
        2
      )}\n`
    );

    await expect(
      scaffolder.scaffold({
        client: { id: 'acme_corp', name: 'Acme Corporation', profile: 'data_processing' },
        createdAt: now,
        toolPolicy: policies.resolveToolPolicy('data_processing'),
        networkPolicy: policies.resolveNetworkPolicy('acme_corp')
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'CLIENT_CONFIG_MISMATCH' });

    expect(await readFile(databaseFile, 'utf8')).toBe(invalidDatabase);
  });

  it('rejects a file where the notes directory belongs and rolls back all new paths', async () => {
    const clientDirectory = join(clientRoot, 'acme_corp');
    await mkdir(join(clientDirectory, 'memory'), { recursive: true });
    await writeFile(join(clientDirectory, 'memory', 'notes'), 'not a directory\n');

    await expect(
      scaffolder.scaffold({
        client: { id: 'acme_corp', name: 'Acme Corporation', profile: 'data_processing' },
        createdAt: now,
        toolPolicy: policies.resolveToolPolicy('data_processing'),
        networkPolicy: policies.resolveNetworkPolicy('acme_corp')
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'CLIENT_PATH_INVALID' });

    expect(await readFile(join(clientDirectory, 'memory', 'notes'), 'utf8')).toBe(
      'not a directory\n'
    );
    await expect(stat(join(clientDirectory, 'agent-config-stub.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('rejects unsafe client ids before writing outside the client root', async () => {
    await expect(
      scaffolder.scaffold({
        client: { id: '../escape', name: 'Escape', profile: 'data_processing' },
        createdAt: now,
        toolPolicy: policies.resolveToolPolicy('data_processing'),
        networkPolicy: policies.resolveNetworkPolicy('escape')
      })
    ).rejects.toBeDefined();
    await expect(stat(join(temporaryRoot, 'escape'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
