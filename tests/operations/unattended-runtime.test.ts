import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClientScaffolder } from '../../src/clients/scaffold';
import { PolicyService } from '../../src/config/policies';
import { createClientDatabase, createDatabase } from '../../src/db/database';

const execFileAsync = promisify(execFile);
const projectRoot = join(__dirname, '..', '..');
const runtimeScripts = join(projectRoot, 'scripts', 'runtime');
const databaseInputs = [
  'memory/core/schema.sql',
  'memory/clients/_template/schema.sql',
  'src/db/migrations/001_agent_runs.sql',
  'src/db/migrations/002_run_recovery_queue.sql',
  'src/db/migrations/003_model_usage_events.sql',
  'src/db/migrations/004_knowledge_scopes.sql',
  'src/db/migrations/005_priority_queue.sql',
  'src/db/migrations/006_revenue_pipeline.sql',
  'src/db/migrations/007_agent_conversations.sql',
  'src/db/migrations/008_agent_conversation_integrity.sql',
  'src/db/migrations/009_agent_blueprints.sql',
  'src/db/migrations/010_access_control_sleeves.sql',
  'src/db/migrations/011_scoped_lexical_retrieval.sql',
  'src/db/migrations/012_telegram_channel.sql',
  'src/db/migrations/013_command_proposals.sql',
  'src/db/migrations/014_calendar_connections.sql',
  'src/db/migrations/015_delegation_traces.sql',
  'src/db/migrations/016_profile_access_lifecycle_audit.sql',
  'src/db/migrations/017_agency_execution_posture.sql',
  'src/db/migrations/018_verification_freeze.sql',
  'src/db/migrations/019_primary_schema_version.sql',
  'src/db/migrations/020_model_execution_enablement.sql',
  'src/db/migrations/021_provider_rate_limit_circuits.sql',
  'src/db/migrations/022_agent_conversation_turn_claims.sql',
  'src/db/migrations/023_typed_hybrid_memory.sql',
  'src/db/migrations/024_memory_ledger.sql',
  'src/db/migrations/025_memory_experiment_log.sql',
  'src/db/migrations/026_agent_profile_instances.sql',
  'src/db/migrations/027_memory_maintenance_outbox.sql'
] as const;

interface CommandFailure extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
}

async function command(
  executable: string,
  arguments_: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(executable, arguments_, {
    env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
}

async function commandFailure(
  executable: string,
  arguments_: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<CommandFailure> {
  try {
    await command(executable, arguments_, env);
  } catch (error) {
    return error as CommandFailure;
  }
  throw new Error('Expected command to fail');
}

async function makeFakeReleaseSource(root: string): Promise<void> {
  const files: Record<string, string> = {
    'dist/src/gateway/server.js': 'process.exitCode = 0;\n',
    'public/dashboard/index.html': '<!doctype html>\n',
    'config/tool-policies/default.json': `${JSON.stringify({
      profiles: {
        data_processing: {
          description: 'Fixture-only data processing',
          tools_allow: ['read', 'write', 'exec'],
          tools_deny: ['process'],
          exec_scope: 'node',
          requires_elevated_approval: false
        }
      },
      client_assignments: {}
    })}\n`,
    'config/network-policies/default.json': `${JSON.stringify({
      default: { mode: 'none', description: 'Fixture-only no-network policy' }
    })}\n`,
    'clients/acme_corp/data/sample-leads.csv': 'email\n',
    'memory/clients/_template/client_sops.md': '# Client SOPs\n',
    'skills/jarvis-workflows/SKILL.md': '# Jarvis workflows\n',
    'node_modules/runtime-marker/package.json': '{"name":"runtime-marker"}\n',
    'package.json': '{"name":"ai-agency-jarvis","private":true}\n',
    'package-lock.json': '{"name":"ai-agency-jarvis","lockfileVersion":3}\n'
  };

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    await mkdir(join(absolutePath, '..'), { recursive: true });
    await writeFile(absolutePath, contents);
  }

  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  await symlink(
    '../runtime-marker/package.json',
    join(root, 'node_modules', '.bin', 'runtime-marker')
  );

  for (const relativePath of databaseInputs) {
    const target = join(root, relativePath);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, await readFile(join(projectRoot, relativePath), 'utf8'));
  }

  await mkdir(join(root, 'scripts', 'runtime'), { recursive: true });
  for (const filename of [
    'runtime-entrypoint.sh',
    'runtime-watchdog.sh',
    'disk-guard.sh',
    'rotate-logs.sh'
  ]) {
    const source = join(runtimeScripts, filename);
    const target = join(root, 'scripts', 'runtime', filename);
    await writeFile(target, await readFile(source, 'utf8'));
    await chmod(target, 0o755);
  }
}

async function parsePlist(path: string): Promise<Record<string, unknown>> {
  const result = await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path]);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe('unattended macOS runtime packaging', () => {
  let temporaryRoot: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-runtime-test-'));
  });

  afterEach(async () => {
    await command('/bin/chmod', ['-R', 'u+w', temporaryRoot]).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('keeps dry-run side-effect free while reporting the exact immutable release', async () => {
    const sourceRoot = join(temporaryRoot, 'source');
    const installRoot = join(temporaryRoot, 'Jarvis Runtime');
    const launchAgentsDirectory = join(temporaryRoot, 'LaunchAgents');
    await makeFakeReleaseSource(sourceRoot);

    const result = await command(join(runtimeScripts, 'install-launch-agent.sh'), [
      '--dry-run',
      '--source-root',
      sourceRoot,
      '--install-root',
      installRoot,
      '--launch-agents-dir',
      launchAgentsDirectory,
      '--node-bin',
      process.execPath,
      '--release-id',
      'test-release'
    ]);

    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: 'dry-run',
      releaseId: 'test-release',
      releaseRoot: join(installRoot, 'releases', 'test-release'),
      loaded: false,
      host: '127.0.0.1',
      port: 3000,
      initialAgencyPosture: 'paused'
    });
    await expect(stat(installRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(launchAgentsDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires an explicit installer choice to bootstrap active instead of safely paused', async () => {
    const sourceRoot = join(temporaryRoot, 'source');
    await makeFakeReleaseSource(sourceRoot);
    const baseArguments = [
      '--dry-run',
      '--source-root',
      sourceRoot,
      '--install-root',
      join(temporaryRoot, 'Jarvis Runtime'),
      '--launch-agents-dir',
      join(temporaryRoot, 'LaunchAgents'),
      '--node-bin',
      process.execPath,
      '--release-id',
      'posture-release'
    ];

    const active = await command(join(runtimeScripts, 'install-launch-agent.sh'), [
      ...baseArguments,
      '--initial-agency-posture',
      'active'
    ]);
    expect(JSON.parse(active.stdout)).toMatchObject({ initialAgencyPosture: 'active' });

    const invalid = await commandFailure(join(runtimeScripts, 'install-launch-agent.sh'), [
      ...baseArguments,
      '--initial-agency-posture',
      'unknown'
    ]);
    expect(invalid.code).toBe(64);
  });

  it('packages only Telegram allowlist and Keychain handles, never a bot token', async () => {
    const sourceRoot = join(temporaryRoot, 'source');
    const installRoot = join(temporaryRoot, 'Jarvis Runtime');
    const launchAgentsDirectory = join(temporaryRoot, 'LaunchAgents');
    await makeFakeReleaseSource(sourceRoot);

    const result = await command(join(runtimeScripts, 'install-launch-agent.sh'), [
      '--install',
      '--source-root',
      sourceRoot,
      '--install-root',
      installRoot,
      '--launch-agents-dir',
      launchAgentsDirectory,
      '--node-bin',
      process.execPath,
      '--release-id',
      'telegram-release',
      '--telegram-user-id',
      '42',
      '--telegram-chat-id',
      '84',
      '--telegram-keychain-service',
      'com.aiagency.jarvis.telegram',
      '--telegram-keychain-account',
      'bot-token'
    ]);
    const gateway = await parsePlist(
      join(launchAgentsDirectory, 'com.aiagency.jarvis.gateway.plist')
    );

    expect(JSON.parse(result.stdout)).toMatchObject({ telegramConfigured: true });
    expect(gateway).toMatchObject({
      EnvironmentVariables: {
        JARVIS_TELEGRAM_ENABLED: '1',
        JARVIS_TELEGRAM_USER_ID: '42',
        JARVIS_TELEGRAM_CHAT_ID: '84',
        JARVIS_TELEGRAM_KEYCHAIN_SERVICE: 'com.aiagency.jarvis.telegram',
        JARVIS_TELEGRAM_KEYCHAIN_ACCOUNT: 'bot-token',
        JARVIS_AGENCY_INITIAL_POSTURE: 'paused'
      }
    });
    expect(JSON.stringify(gateway)).not.toContain('TELEGRAM_TOKEN');
  });

  it('rejects a partial or group-style Telegram allowlist before installation', async () => {
    const sourceRoot = join(temporaryRoot, 'source');
    await makeFakeReleaseSource(sourceRoot);
    const baseArguments = [
      '--dry-run',
      '--source-root',
      sourceRoot,
      '--install-root',
      join(temporaryRoot, 'Jarvis Runtime'),
      '--launch-agents-dir',
      join(temporaryRoot, 'LaunchAgents'),
      '--node-bin',
      process.execPath,
      '--release-id',
      'telegram-release'
    ];

    const partial = await commandFailure(join(runtimeScripts, 'install-launch-agent.sh'), [
      ...baseArguments,
      '--telegram-user-id',
      '42'
    ]);
    const groupChat = await commandFailure(join(runtimeScripts, 'install-launch-agent.sh'), [
      ...baseArguments,
      '--telegram-user-id',
      '42',
      '--telegram-chat-id',
      '-100123'
    ]);

    expect(partial.code).toBe(64);
    expect(groupChat.code).toBe(64);
  });

  it('installs an immutable release and secure unloaded LaunchAgents', async () => {
    const sourceRoot = join(temporaryRoot, 'source');
    const installRoot = join(temporaryRoot, 'Jarvis Runtime');
    const launchAgentsDirectory = join(temporaryRoot, 'LaunchAgents');
    await makeFakeReleaseSource(sourceRoot);

    const result = await command(join(runtimeScripts, 'install-launch-agent.sh'), [
      '--install',
      '--source-root',
      sourceRoot,
      '--install-root',
      installRoot,
      '--launch-agents-dir',
      launchAgentsDirectory,
      '--node-bin',
      process.execPath,
      '--release-id',
      'test-release'
    ]);
    const releaseRoot = join(installRoot, 'releases', 'test-release');
    const stateRoot = join(installRoot, 'state');
    const logRoot = join(installRoot, 'logs');
    const gatewayPlistPath = join(launchAgentsDirectory, 'com.aiagency.jarvis.gateway.plist');
    const watchdogPlistPath = join(launchAgentsDirectory, 'com.aiagency.jarvis.watchdog.plist');
    const gateway = await parsePlist(gatewayPlistPath);
    const watchdog = await parsePlist(watchdogPlistPath);

    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'install', loaded: false });
    expect((await stat(releaseRoot)).mode & 0o777).toBe(0o555);
    expect((await stat(join(releaseRoot, 'package.json'))).mode & 0o777).toBe(0o444);
    expect(await realpath(join(releaseRoot, 'node_modules', '.bin', 'runtime-marker'))).toBe(
      await realpath(join(releaseRoot, 'node_modules', 'runtime-marker', 'package.json'))
    );
    for (const relativePath of databaseInputs) {
      const installedPath = join(releaseRoot, relativePath);
      expect((await stat(installedPath)).mode & 0o777).toBe(0o444);
      await expect(readFile(installedPath, 'utf8')).resolves.toBe(
        await readFile(join(sourceRoot, relativePath), 'utf8')
      );
    }
    expect((await stat(stateRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(logRoot)).mode & 0o777).toBe(0o700);

    expect(gateway).toMatchObject({
      Label: 'com.aiagency.jarvis.gateway',
      ProgramArguments: [
        '/usr/bin/caffeinate',
        '-s',
        join(releaseRoot, 'scripts', 'runtime', 'runtime-entrypoint.sh'),
        process.execPath,
        join(releaseRoot, 'dist', 'src', 'gateway', 'server.js')
      ],
      KeepAlive: { SuccessfulExit: false },
      ThrottleInterval: 30,
      Umask: 63,
      ProcessType: 'Background',
      EnvironmentVariables: {
        HOST: '127.0.0.1',
        PORT: '3000',
        JARVIS_ROOT: releaseRoot,
        DB_PATH: join(stateRoot, 'jarvis.sqlite'),
        JARVIS_CLIENT_ROOT: join(stateRoot, 'clients'),
        JARVIS_WORKSPACE_ROOT: join(stateRoot, 'workspaces'),
        JARVIS_GRAPH_ROOT: join(stateRoot, 'memory', 'graph'),
        JARVIS_PERSONAL_MEMORY_ROOT: join(stateRoot, 'memory', 'personal'),
        JARVIS_AGENCY_INITIAL_POSTURE: 'paused'
      }
    });
    expect(watchdog).toMatchObject({
      Label: 'com.aiagency.jarvis.watchdog',
      ProgramArguments: [join(releaseRoot, 'scripts', 'runtime', 'runtime-watchdog.sh')],
      StartInterval: 60,
      RunAtLoad: true,
      Umask: 63,
      EnvironmentVariables: {
        JARVIS_HEALTH_BASE_URL: 'http://127.0.0.1:3000',
        JARVIS_STATE_ROOT: stateRoot,
        JARVIS_LOG_ROOT: logRoot
      }
    });
    expect(gateway).not.toHaveProperty('Sockets');
    expect(gateway).not.toHaveProperty('NetworkState');

    const globalDatabase = await createDatabase({ projectRoot: releaseRoot, filename: ':memory:' });
    const clientDatabase = await createClientDatabase({
      projectRoot: releaseRoot,
      filename: ':memory:'
    });
    try {
      const globalTables = globalDatabase.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const clientTables = clientDatabase.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      expect(globalTables.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          'client_registry',
          'agent_runs',
          'revenue_prospects',
          'agency_execution_posture',
          'agency_execution_posture_events'
        ])
      );
      expect(clientTables.map(({ name }) => name)).toEqual(
        expect.arrayContaining(['task_history', 'crm_leads', 'agent_scratchpad'])
      );
    } finally {
      await Promise.all([globalDatabase.destroy(), clientDatabase.destroy()]);
    }
  });

  it('rejects a source missing any required database input before dry-run planning', async () => {
    const sourceRoot = join(temporaryRoot, 'source');
    await makeFakeReleaseSource(sourceRoot);
    await rm(join(sourceRoot, 'src', 'db', 'migrations', '006_revenue_pipeline.sql'));

    const failure = await commandFailure(join(runtimeScripts, 'install-launch-agent.sh'), [
      '--dry-run',
      '--source-root',
      sourceRoot,
      '--install-root',
      join(temporaryRoot, 'Jarvis Runtime'),
      '--launch-agents-dir',
      join(temporaryRoot, 'LaunchAgents'),
      '--node-bin',
      process.execPath,
      '--release-id',
      'test-release'
    ]);

    expect(failure.code).toBe(66);
    expect(failure.stderr).toContain('src/db/migrations/006_revenue_pipeline.sql');
    expect(failure.stdout).toBe('');
  });

  it('rejects release input symlinks that escape their copied subtree before planning', async () => {
    const sourceRoot = join(temporaryRoot, 'source');
    const outsideDependency = join(temporaryRoot, 'mutable-outside-dependency.js');
    await makeFakeReleaseSource(sourceRoot);
    await writeFile(outsideDependency, 'module.exports = "mutable";\n');
    await symlink(
      outsideDependency,
      join(sourceRoot, 'node_modules', 'runtime-marker', 'outside-dependency.js')
    );

    const installRoot = join(temporaryRoot, 'Jarvis Runtime');
    const launchAgentsDirectory = join(temporaryRoot, 'LaunchAgents');
    const failure = await commandFailure(join(runtimeScripts, 'install-launch-agent.sh'), [
      '--dry-run',
      '--source-root',
      sourceRoot,
      '--install-root',
      installRoot,
      '--launch-agents-dir',
      launchAgentsDirectory,
      '--node-bin',
      process.execPath,
      '--release-id',
      'test-release'
    ]);

    expect(failure.code).toBe(66);
    expect(failure.stderr).toContain('release input contains an unsafe symlink');
    await expect(stat(installRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(launchAgentsDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('entrypoint fails closed on wildcard binding before starting Node', async () => {
    const releaseRoot = join(temporaryRoot, 'release');
    const stateRoot = join(temporaryRoot, 'state');
    const serverFile = join(releaseRoot, 'dist', 'src', 'gateway', 'server.js');
    await mkdir(join(serverFile, '..'), { recursive: true });
    await mkdir(join(stateRoot, 'clients'), { recursive: true });
    await mkdir(join(stateRoot, 'workspaces'), { recursive: true });
    await mkdir(join(stateRoot, 'memory', 'graph'), { recursive: true });
    for (const directory of [
      stateRoot,
      join(stateRoot, 'clients'),
      join(stateRoot, 'workspaces'),
      join(stateRoot, 'memory'),
      join(stateRoot, 'memory', 'graph')
    ]) {
      await chmod(directory, 0o700);
    }
    await writeFile(serverFile, '');

    const failure = await commandFailure(
      join(runtimeScripts, 'runtime-entrypoint.sh'),
      ['/usr/bin/true', serverFile],
      {
        ...process.env,
        HOST: '0.0.0.0',
        PORT: '3000',
        JARVIS_ROOT: releaseRoot,
        DB_PATH: join(stateRoot, 'jarvis.sqlite'),
        JARVIS_CLIENT_ROOT: join(stateRoot, 'clients'),
        JARVIS_WORKSPACE_ROOT: join(stateRoot, 'workspaces'),
        JARVIS_GRAPH_ROOT: join(stateRoot, 'memory', 'graph'),
        JARVIS_PERSONAL_MEMORY_ROOT: join(stateRoot, 'memory', 'personal')
      }
    );

    expect(failure.code).toBe(64);
    expect(failure.stderr).toContain('loopback');
  });

  it('entrypoint scrubs ambient secrets before starting the gateway', async () => {
    const runtimeRoot = join(temporaryRoot, 'runtime');
    const releaseRoot = join(runtimeRoot, 'releases', 'test-release');
    const stateRoot = join(runtimeRoot, 'state');
    const serverFile = join(releaseRoot, 'dist', 'src', 'gateway', 'server.js');
    const diskGuard = join(releaseRoot, 'scripts', 'runtime', 'disk-guard.sh');
    const environmentCapture = join(temporaryRoot, 'gateway-environment.txt');
    const fakeNode = join(temporaryRoot, 'node-direct');
    await mkdir(join(serverFile, '..'), { recursive: true });
    await mkdir(join(diskGuard, '..'), { recursive: true });
    await mkdir(join(stateRoot, 'clients'), { recursive: true });
    await mkdir(join(stateRoot, 'workspaces'), { recursive: true });
    await mkdir(join(stateRoot, 'memory', 'graph'), { recursive: true });
    await mkdir(join(stateRoot, 'memory', 'personal'), { recursive: true });
    for (const directory of [
      stateRoot,
      join(stateRoot, 'clients'),
      join(stateRoot, 'workspaces'),
      join(stateRoot, 'memory'),
      join(stateRoot, 'memory', 'graph'),
      join(stateRoot, 'memory', 'personal')
    ]) {
      await chmod(directory, 0o700);
    }
    await writeFile(serverFile, '');
    await writeFile(diskGuard, await readFile(join(runtimeScripts, 'disk-guard.sh'), 'utf8'));
    await chmod(diskGuard, 0o555);
    await writeFile(
      fakeNode,
      `#!/usr/bin/env bash\n/usr/bin/env > ${JSON.stringify(environmentCapture)}\n`
    );
    await chmod(fakeNode, 0o755);

    await command(join(runtimeScripts, 'runtime-entrypoint.sh'), [fakeNode, serverFile], {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '3000',
      JARVIS_ROOT: releaseRoot,
      JARVIS_STATE_ROOT: stateRoot,
      DB_PATH: join(stateRoot, 'jarvis.sqlite'),
      JARVIS_CLIENT_ROOT: join(stateRoot, 'clients'),
      JARVIS_WORKSPACE_ROOT: join(stateRoot, 'workspaces'),
      JARVIS_GRAPH_ROOT: join(stateRoot, 'memory', 'graph'),
      JARVIS_PERSONAL_MEMORY_ROOT: join(stateRoot, 'memory', 'personal'),
      JARVIS_TELEGRAM_ENABLED: '1',
      JARVIS_TELEGRAM_USER_ID: '42',
      JARVIS_TELEGRAM_CHAT_ID: '84',
      JARVIS_TELEGRAM_KEYCHAIN_SERVICE: 'com.aiagency.jarvis.telegram',
      JARVIS_TELEGRAM_KEYCHAIN_ACCOUNT: 'bot-token',
      JARVIS_TELEGRAM_TOKEN: 'must-not-reach-gateway',
      JARVIS_HOSTILE_SECRET: 'must-not-reach-gateway'
    });

    const captured = await readFile(environmentCapture, 'utf8');
    expect(captured).not.toContain('JARVIS_HOSTILE_SECRET');
    expect(captured).not.toContain('must-not-reach-gateway');
    expect(captured).toContain('NODE_ENV=production');
    expect(captured).toContain(`HOME=${process.env.HOME}`);
    expect(captured).toContain('HOST=127.0.0.1');
    expect(captured).toContain(`DB_PATH=${join(stateRoot, 'jarvis.sqlite')}`);
    expect(captured).toContain(
      `JARVIS_PERSONAL_MEMORY_ROOT=${join(stateRoot, 'memory', 'personal')}`
    );
    expect(captured).toContain('JARVIS_TELEGRAM_ENABLED=1');
    expect(captured).toContain('JARVIS_TELEGRAM_USER_ID=42');
    expect(captured).toContain('JARVIS_TELEGRAM_CHAT_ID=84');
    expect(captured).toContain('JARVIS_AGENCY_INITIAL_POSTURE=paused');
    expect(captured).not.toContain('JARVIS_TELEGRAM_TOKEN');
  });

  it('entrypoint rejects writable runtime paths outside the exact private state layout', async () => {
    const runtimeRoot = join(temporaryRoot, 'runtime');
    const releaseRoot = join(runtimeRoot, 'releases', 'test-release');
    const stateRoot = join(runtimeRoot, 'state');
    const externalClients = join(temporaryRoot, 'external-clients');
    const serverFile = join(releaseRoot, 'dist', 'src', 'gateway', 'server.js');
    const diskGuard = join(releaseRoot, 'scripts', 'runtime', 'disk-guard.sh');
    await mkdir(join(serverFile, '..'), { recursive: true });
    await mkdir(join(diskGuard, '..'), { recursive: true });
    await mkdir(externalClients, { recursive: true });
    await mkdir(join(stateRoot, 'clients'), { recursive: true });
    await mkdir(join(stateRoot, 'workspaces'), { recursive: true });
    await mkdir(join(stateRoot, 'memory', 'graph'), { recursive: true });
    await writeFile(serverFile, '');
    await writeFile(diskGuard, await readFile(join(runtimeScripts, 'disk-guard.sh'), 'utf8'));
    await chmod(diskGuard, 0o555);

    const failure = await commandFailure(
      join(runtimeScripts, 'runtime-entrypoint.sh'),
      [process.execPath, serverFile],
      {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: '3000',
        JARVIS_ROOT: releaseRoot,
        JARVIS_STATE_ROOT: stateRoot,
        DB_PATH: join(stateRoot, 'jarvis.sqlite'),
        JARVIS_CLIENT_ROOT: externalClients,
        JARVIS_WORKSPACE_ROOT: join(stateRoot, 'workspaces'),
        JARVIS_GRAPH_ROOT: join(stateRoot, 'memory', 'graph'),
        JARVIS_PERSONAL_MEMORY_ROOT: join(stateRoot, 'memory', 'personal')
      }
    );

    expect(failure.code).toBe(64);
    expect(failure.stderr).toContain('exact private state layout');
  });

  it('entrypoint binds the complete state root to the release install root', async () => {
    const installRoot = join(temporaryRoot, 'Jarvis Runtime');
    const releaseRoot = join(installRoot, 'releases', 'test-release');
    const externalStateRoot = join(temporaryRoot, 'external-state');
    const serverFile = join(releaseRoot, 'dist', 'src', 'gateway', 'server.js');
    const diskGuard = join(releaseRoot, 'scripts', 'runtime', 'disk-guard.sh');
    await mkdir(join(serverFile, '..'), { recursive: true });
    await mkdir(join(diskGuard, '..'), { recursive: true });
    await mkdir(join(externalStateRoot, 'clients'), { recursive: true });
    await mkdir(join(externalStateRoot, 'workspaces'), { recursive: true });
    await mkdir(join(externalStateRoot, 'memory', 'graph'), { recursive: true });
    for (const directory of [
      externalStateRoot,
      join(externalStateRoot, 'clients'),
      join(externalStateRoot, 'workspaces'),
      join(externalStateRoot, 'memory'),
      join(externalStateRoot, 'memory', 'graph')
    ]) {
      await chmod(directory, 0o700);
    }
    await writeFile(serverFile, '');
    await writeFile(diskGuard, await readFile(join(runtimeScripts, 'disk-guard.sh'), 'utf8'));
    await chmod(diskGuard, 0o555);

    const failure = await commandFailure(
      join(runtimeScripts, 'runtime-entrypoint.sh'),
      [process.execPath, serverFile],
      {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: '3000',
        JARVIS_ROOT: releaseRoot,
        JARVIS_STATE_ROOT: externalStateRoot,
        DB_PATH: join(externalStateRoot, 'jarvis.sqlite'),
        JARVIS_CLIENT_ROOT: join(externalStateRoot, 'clients'),
        JARVIS_WORKSPACE_ROOT: join(externalStateRoot, 'workspaces'),
        JARVIS_GRAPH_ROOT: join(externalStateRoot, 'memory', 'graph'),
        JARVIS_PERSONAL_MEMORY_ROOT: join(externalStateRoot, 'memory', 'personal')
      }
    );

    expect(failure.code).toBe(64);
    expect(failure.stderr).toContain('release install root');
  });

  it('watchdog checks loopback liveness/readiness and rotates bounded logs', async () => {
    const stateRoot = join(temporaryRoot, 'state');
    const logRoot = join(temporaryRoot, 'logs');
    await mkdir(stateRoot, { recursive: true });
    await mkdir(logRoot, { recursive: true });
    await writeFile(join(logRoot, 'gateway.stdout.log'), '0123456789abcdef');
    const server: Server = createServer((request, response) => {
      if (request.url === '/livez' || request.url === '/readyz') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"status":"ready"}');
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing test port');

    try {
      const result = await command(join(runtimeScripts, 'runtime-watchdog.sh'), [], {
        ...process.env,
        JARVIS_HEALTH_BASE_URL: `http://127.0.0.1:${address.port}`,
        JARVIS_STATE_ROOT: stateRoot,
        JARVIS_LOG_ROOT: logRoot,
        JARVIS_LOG_MAX_BYTES: '10',
        JARVIS_LOG_KEEP: '2'
      });

      expect(JSON.parse(result.stdout)).toMatchObject({
        status: 'ready',
        livez: 'ok',
        readyz: 'ok'
      });
      expect(await readFile(join(logRoot, 'gateway.stdout.log'), 'utf8')).toBe('');
      expect(await readFile(join(logRoot, 'gateway.stdout.log.1'), 'utf8')).toBe(
        '0123456789abcdef'
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      );
    }
  });

  it('disk guard returns a distinct critical hold code with bounded JSON', async () => {
    const failure = await commandFailure(join(runtimeScripts, 'disk-guard.sh'), [
      '--path',
      temporaryRoot,
      '--warn-percent',
      '100',
      '--critical-percent',
      '99'
    ]);

    expect(failure.code).toBe(10);
    expect(JSON.parse(failure.stdout ?? '{}')).toMatchObject({
      status: 'critical',
      action: 'hold_new_work'
    });
    expect((failure.stdout ?? '').length).toBeLessThan(512);
  });

  it('reports an unloaded package as NO_GO without changing launchd or remote access', async () => {
    const sourceRoot = join(temporaryRoot, 'source');
    const installRoot = join(temporaryRoot, 'Jarvis Runtime');
    const launchAgentsDirectory = join(temporaryRoot, 'LaunchAgents');
    await makeFakeReleaseSource(sourceRoot);
    await command(join(runtimeScripts, 'install-launch-agent.sh'), [
      '--install',
      '--source-root',
      sourceRoot,
      '--install-root',
      installRoot,
      '--launch-agents-dir',
      launchAgentsDirectory,
      '--node-bin',
      process.execPath,
      '--release-id',
      'test-release',
      '--port',
      '49151'
    ]);

    const failure = await commandFailure(join(runtimeScripts, 'runtime-audit.sh'), [
      '--install-root',
      installRoot,
      '--launch-agents-dir',
      launchAgentsDirectory,
      '--port',
      '49151'
    ]);
    const report = JSON.parse(failure.stdout ?? '{}') as Record<string, unknown>;

    expect(failure.code).toBe(10);
    expect(report).toMatchObject({
      status: 'NO_GO',
      checks: {
        plists: 'pass',
        loopbackConfig: 'pass',
        immutableRelease: 'pass',
        secureState: 'pass',
        gatewayLoaded: 'fail',
        caffeinateSupervisor: 'fail',
        loopbackListener: 'fail',
        readiness: 'fail'
      },
      remoteAccess: 'not_configured_by_runtime'
    });
    expect(failure.stderr).toBe('');
  });

  it('fails the runtime audit when the plist redirects tenant state outside the install root', async () => {
    const sourceRoot = join(temporaryRoot, 'source');
    const installRoot = join(temporaryRoot, 'Jarvis Runtime');
    const launchAgentsDirectory = join(temporaryRoot, 'LaunchAgents');
    const externalClients = join(temporaryRoot, 'external-clients');
    await makeFakeReleaseSource(sourceRoot);
    await mkdir(externalClients);
    await command(join(runtimeScripts, 'install-launch-agent.sh'), [
      '--install',
      '--source-root',
      sourceRoot,
      '--install-root',
      installRoot,
      '--launch-agents-dir',
      launchAgentsDirectory,
      '--node-bin',
      process.execPath,
      '--release-id',
      'test-release',
      '--port',
      '49152'
    ]);
    const gatewayPlist = join(launchAgentsDirectory, 'com.aiagency.jarvis.gateway.plist');
    await command('/usr/bin/plutil', [
      '-replace',
      'EnvironmentVariables.JARVIS_CLIENT_ROOT',
      '-string',
      externalClients,
      gatewayPlist
    ]);

    const failure = await commandFailure(join(runtimeScripts, 'runtime-audit.sh'), [
      '--install-root',
      installRoot,
      '--launch-agents-dir',
      launchAgentsDirectory,
      '--port',
      '49152'
    ]);
    const report = JSON.parse(failure.stdout ?? '{}') as {
      checks?: { loopbackConfig?: string; secureState?: string };
    };

    expect(failure.code).toBe(10);
    expect(report.checks).toMatchObject({ loopbackConfig: 'fail', secureState: 'fail' });
  });

  it('fails the runtime audit when any tenant state subtree is group-readable', async () => {
    const sourceRoot = join(temporaryRoot, 'source');
    const installRoot = join(temporaryRoot, 'Jarvis Runtime');
    const launchAgentsDirectory = join(temporaryRoot, 'LaunchAgents');
    await makeFakeReleaseSource(sourceRoot);
    await command(join(runtimeScripts, 'install-launch-agent.sh'), [
      '--install',
      '--source-root',
      sourceRoot,
      '--install-root',
      installRoot,
      '--launch-agents-dir',
      launchAgentsDirectory,
      '--node-bin',
      process.execPath,
      '--release-id',
      'test-release',
      '--port',
      '49153'
    ]);
    await chmod(join(installRoot, 'state', 'clients'), 0o750);

    const failure = await commandFailure(join(runtimeScripts, 'runtime-audit.sh'), [
      '--install-root',
      installRoot,
      '--launch-agents-dir',
      launchAgentsDirectory,
      '--port',
      '49153'
    ]);
    const report = JSON.parse(failure.stdout ?? '{}') as {
      checks?: { secureState?: string };
    };

    expect(failure.code).toBe(10);
    expect(report.checks?.secureState).toBe('fail');
  });

  it('fails the runtime audit when an immutable-release symlink is redirected outside', async () => {
    const sourceRoot = join(temporaryRoot, 'source');
    const installRoot = join(temporaryRoot, 'Jarvis Runtime');
    const launchAgentsDirectory = join(temporaryRoot, 'LaunchAgents');
    const outsideDependency = join(temporaryRoot, 'mutable-outside-dependency.js');
    await makeFakeReleaseSource(sourceRoot);
    await writeFile(outsideDependency, 'module.exports = "mutable";\n');
    await command(join(runtimeScripts, 'install-launch-agent.sh'), [
      '--install',
      '--source-root',
      sourceRoot,
      '--install-root',
      installRoot,
      '--launch-agents-dir',
      launchAgentsDirectory,
      '--node-bin',
      process.execPath,
      '--release-id',
      'test-release',
      '--port',
      '49154'
    ]);
    const releaseRoot = join(installRoot, 'releases', 'test-release');
    const binaryDirectory = join(releaseRoot, 'node_modules', '.bin');
    const installedLink = join(binaryDirectory, 'runtime-marker');
    await chmod(binaryDirectory, 0o755);
    await rm(installedLink);
    await symlink(outsideDependency, installedLink);
    await chmod(binaryDirectory, 0o555);

    const failure = await commandFailure(join(runtimeScripts, 'runtime-audit.sh'), [
      '--install-root',
      installRoot,
      '--launch-agents-dir',
      launchAgentsDirectory,
      '--port',
      '49154'
    ]);
    const report = JSON.parse(failure.stdout ?? '{}') as {
      checks?: { immutableRelease?: string };
    };

    expect(failure.code).toBe(10);
    expect(report.checks?.immutableRelease).toBe('fail');
  });

  it('rejects a non-exact listener even when exact loopback also listens on the port', async () => {
    const exactLoopback = createServer((_request, response) => {
      response.writeHead(503).end();
    });
    const alternateAddress = createServer((_request, response) => {
      response.writeHead(503).end();
    });
    await new Promise<void>((resolve, reject) => {
      exactLoopback.once('error', reject);
      exactLoopback.listen(0, '127.0.0.1', resolve);
    });
    const address = exactLoopback.address();
    if (address === null || typeof address === 'string') throw new Error('missing test port');

    const auditListener = async (): Promise<string | undefined> => {
      const failure = await commandFailure(join(runtimeScripts, 'runtime-audit.sh'), [
        '--install-root',
        join(temporaryRoot, 'Jarvis Runtime'),
        '--launch-agents-dir',
        join(temporaryRoot, 'LaunchAgents'),
        '--port',
        String(address.port)
      ]);
      const report = JSON.parse(failure.stdout ?? '{}') as {
        checks?: { loopbackListener?: string };
      };
      expect(failure.code).toBe(10);
      return report.checks?.loopbackListener;
    };

    expect(await auditListener()).toBe('pass');
    await new Promise<void>((resolve, reject) => {
      alternateAddress.once('error', reject);
      alternateAddress.listen(address.port, '::1', resolve);
    });

    try {
      expect(await auditListener()).toBe('fail');
    } finally {
      await Promise.all(
        [alternateAddress, exactLoopback].map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error === undefined ? resolve() : reject(error)))
            )
        )
      );
    }
  });

  it('documents an explicit activation and recoverable rollback with remote access held at NO_GO', async () => {
    const runbook = await readFile(
      join(projectRoot, 'docs', 'operations', 'unattended-runtime.md'),
      'utf8'
    );

    expect(runbook).toContain('Remote access decision: **NO-GO**');
    expect(runbook).toContain('./scripts/remote-access-audit.sh');
    expect(runbook).toContain('--dry-run');
    expect(runbook).toContain('--install');
    expect(runbook).toContain('launchctl bootstrap');
    expect(runbook).toContain('launchctl bootout');
    expect(runbook).toContain('does not guarantee lid-closed operation');
    expect(runbook).not.toMatch(/kickstart[^\n]*(screensharing|RemoteManagement|VNC)/i);
  });

  it('packages immutable onboarding inputs without pre-seeding mutable tenant state', async () => {
    const sourceRoot = join(temporaryRoot, 'source');
    const installRoot = join(temporaryRoot, 'Jarvis Runtime');
    const launchAgentsDirectory = join(temporaryRoot, 'LaunchAgents');
    await makeFakeReleaseSource(sourceRoot);

    await command(join(runtimeScripts, 'install-launch-agent.sh'), [
      '--install',
      '--source-root',
      sourceRoot,
      '--install-root',
      installRoot,
      '--launch-agents-dir',
      launchAgentsDirectory,
      '--node-bin',
      process.execPath,
      '--release-id',
      'onboarding-release'
    ]);

    const releaseRoot = join(installRoot, 'releases', 'onboarding-release');
    const stateRoot = join(installRoot, 'state');
    await expect(readdir(join(stateRoot, 'clients'))).resolves.toEqual([]);
    await expect(
      readFile(join(releaseRoot, 'memory', 'clients', '_template', 'client_sops.md'), 'utf8')
    ).resolves.toBe('# Client SOPs\n');
    await expect(
      readFile(join(releaseRoot, 'clients', 'acme_corp', 'data', 'sample-leads.csv'), 'utf8')
    ).resolves.toBe('email\n');
    await expect(
      readFile(join(releaseRoot, 'skills', 'jarvis-workflows', 'SKILL.md'), 'utf8')
    ).resolves.toBe('# Jarvis workflows\n');

    const policies = await PolicyService.load({ projectRoot: releaseRoot });
    const scaffold = await new ClientScaffolder({
      projectRoot: releaseRoot,
      clientRoot: join(stateRoot, 'clients'),
      workspaceRoot: join(stateRoot, 'workspaces'),
      idFactory: () => 'fixture'
    }).scaffold({
      client: { id: 'acme_corp', name: 'ACME Corp Synthetic Proof', profile: 'data_processing' },
      createdAt: '2026-07-19T12:00:00.000Z',
      toolPolicy: policies.resolveToolPolicy('data_processing'),
      networkPolicy: policies.resolveNetworkPolicy('acme_corp')
    });

    await expect(
      readFile(join(scaffold.config.clientDirectory, 'data', 'sample-leads.csv'), 'utf8')
    ).resolves.toBe('email\n');
    await expect(
      readFile(join(scaffold.config.clientDirectory, 'memory', 'client_sops.md'), 'utf8')
    ).resolves.toBe('# Client SOPs\n');
  });
});
