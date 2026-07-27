import { randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  ClientConfigSchema,
  ClientIdSchema,
  type ClientConfig,
  type CreateClientRequest,
  type NetworkPolicy,
  type ToolPolicy
} from '../config/schemas';
import { createClientDatabase } from '../db/database';
import { AppError } from '../utils/errors';

export interface ClientScaffolderOptions {
  projectRoot: string;
  clientRoot: string;
  workspaceRoot: string;
  idFactory?: () => string;
}

export interface ScaffoldClientInput {
  client: CreateClientRequest;
  createdAt: string;
  toolPolicy: ToolPolicy;
  networkPolicy: NetworkPolicy;
}

export interface ScaffoldResult {
  config: ClientConfig;
  rollback(): Promise<void>;
}

type PathType = 'directory' | 'file' | 'symlink' | 'other' | undefined;
type RollbackAction = () => Promise<void>;

interface AssetCopyBudget {
  entries: number;
  bytes: number;
}

const MAX_ASSET_DEPTH = 8;
const MAX_ASSET_ENTRIES = 256;
const MAX_ASSET_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ASSET_TOTAL_BYTES = 20 * 1024 * 1024;
const SAFE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

async function getPathType(filename: string): Promise<PathType> {
  try {
    const value = await lstat(filename);
    if (value.isSymbolicLink()) return 'symlink';
    if (value.isDirectory()) return 'directory';
    if (value.isFile()) return 'file';
    return 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function invalidClientPath(filename: string, expectation: string): AppError {
  return new AppError(409, 'CLIENT_PATH_INVALID', `Expected ${expectation} at ${filename}`);
}

function assetLimitExceeded(message: string): AppError {
  return new AppError(409, 'CLIENT_ASSET_LIMIT_EXCEEDED', message);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const childPath = relative(parent, candidate);
  return (
    childPath === '' ||
    (childPath !== '..' && !childPath.startsWith(`..${sep}`) && !isAbsolute(childPath))
  );
}

async function readRegularAssetFile(filename: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw invalidClientPath(filename, 'a regular versioned data file');
    }
    throw error;
  }

  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw invalidClientPath(filename, 'a regular versioned data file');
    }
    if (metadata.size > MAX_ASSET_FILE_BYTES) {
      throw assetLimitExceeded(`Versioned data file exceeds ${MAX_ASSET_FILE_BYTES} bytes`);
    }
    const content = Buffer.alloc(MAX_ASSET_FILE_BYTES + 1);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_ASSET_FILE_BYTES) {
      throw assetLimitExceeded(`Versioned data file exceeds ${MAX_ASSET_FILE_BYTES} bytes`);
    }
    return content.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function assertSafeTree(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filename = join(directory, entry.name);
    const type = await getPathType(filename);
    if (type === 'symlink' || type === 'other') {
      throw invalidClientPath(filename, 'a regular file or directory');
    }
    if (type === 'directory') {
      await assertSafeTree(filename);
    }
  }
}

async function assertPathType(
  filename: string,
  expected: Exclude<PathType, 'symlink' | 'other' | undefined>
): Promise<void> {
  const type = await getPathType(filename);
  if (type !== undefined && type !== expected) {
    throw invalidClientPath(filename, expected);
  }
}

async function ensureRootDirectory(filename: string): Promise<void> {
  const type = await getPathType(filename);
  if (type === undefined) {
    await mkdir(filename, { recursive: true });
    return;
  }
  if (type !== 'directory') {
    throw invalidClientPath(filename, 'directory');
  }
}

async function createDirectoryIfMissing(
  filename: string,
  rollbackActions: RollbackAction[]
): Promise<void> {
  const type = await getPathType(filename);
  if (type === undefined) {
    await mkdir(filename);
    rollbackActions.push(() => rm(filename, { recursive: true, force: true }));
    return;
  }
  if (type !== 'directory') {
    throw invalidClientPath(filename, 'directory');
  }
}

async function rollback(actions: RollbackAction[]): Promise<void> {
  const errors: unknown[] = [];
  for (const action of [...actions].reverse()) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  actions.length = 0;
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Client scaffold rollback failed');
  }
}

function configsMatch(existing: ClientConfig, expected: ClientConfig): boolean {
  return (
    existing.id === expected.id &&
    existing.name === expected.name &&
    existing.profile === expected.profile &&
    existing.status === expected.status &&
    existing.createdAt === expected.createdAt &&
    existing.workspacePath === expected.workspacePath &&
    existing.clientDirectory === expected.clientDirectory &&
    existing.databasePath === expected.databasePath
  );
}

export class ClientScaffolder {
  private readonly idFactory: () => string;

  constructor(private readonly options: ClientScaffolderOptions) {
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async scaffold(input: ScaffoldClientInput): Promise<ScaffoldResult> {
    const id = ClientIdSchema.parse(input.client.id);
    await ensureRootDirectory(this.options.clientRoot);
    await ensureRootDirectory(this.options.workspaceRoot);

    const clientDirectory = join(this.options.clientRoot, id);
    const workspacePath = join(this.options.workspaceRoot, id);
    const existingType = await getPathType(clientDirectory);
    if (existingType !== undefined && existingType !== 'directory') {
      throw invalidClientPath(clientDirectory, 'directory');
    }

    const config = ClientConfigSchema.parse({
      ...input.client,
      status: 'active',
      createdAt: input.createdAt,
      workspacePath,
      clientDirectory,
      databasePath: join(clientDirectory, 'memory', 'client.sqlite')
    });

    if (existingType === 'directory') {
      await this.preflightExistingClient(clientDirectory, config);
    }
    await this.preflightWorkspace(workspacePath);

    const clientRollback: RollbackAction[] = [];
    const workspaceRollback: RollbackAction[] = [];
    let destination = clientDirectory;
    const createdClientRoot = existingType === undefined;
    if (createdClientRoot) {
      destination = join(this.options.clientRoot, `.${id}.${this.idFactory()}.staging`);
      await mkdir(destination);
    }

    try {
      await this.populateClientDirectory(destination, config, input, clientRollback);
      await createDirectoryIfMissing(workspacePath, workspaceRollback);
      if (createdClientRoot) {
        await rename(destination, clientDirectory);
      }

      let rolledBack = false;
      return {
        config,
        rollback: async () => {
          if (rolledBack) return;
          rolledBack = true;
          if (createdClientRoot) {
            await rm(clientDirectory, { recursive: true, force: true });
          } else {
            await rollback(clientRollback);
          }
          await rollback(workspaceRollback);
        }
      };
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        if (createdClientRoot) {
          await rm(destination, { recursive: true, force: true });
        } else {
          await rollback(clientRollback);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      try {
        await rollback(workspaceRollback);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], 'Client scaffold and rollback failed');
      }
      throw error;
    }
  }

  private async preflightExistingClient(
    clientDirectory: string,
    expectedConfig: ClientConfig
  ): Promise<void> {
    await assertSafeTree(clientDirectory);

    const directoryPaths = ['automations', 'data', 'memory', join('memory', 'notes'), 'output'];
    const filePaths = [
      'client-config.json',
      'agent-config-stub.json',
      'resolved-policies.json',
      join('memory', 'schema.sql'),
      join('memory', 'client_sops.md'),
      join('memory', 'client.sqlite')
    ];
    await Promise.all(
      directoryPaths.map((relativePath) =>
        assertPathType(join(clientDirectory, relativePath), 'directory')
      )
    );
    await Promise.all(
      filePaths.map((relativePath) => assertPathType(join(clientDirectory, relativePath), 'file'))
    );

    const configFile = join(clientDirectory, 'client-config.json');
    if ((await getPathType(configFile)) !== 'file') return;

    let existingConfig: ClientConfig;
    try {
      existingConfig = ClientConfigSchema.parse(
        JSON.parse(await readFile(configFile, 'utf8')) as unknown
      );
    } catch {
      throw new AppError(
        409,
        'CLIENT_CONFIG_MISMATCH',
        `Existing config for ${expectedConfig.id} is invalid`
      );
    }
    if (!configsMatch(existingConfig, expectedConfig)) {
      throw new AppError(
        409,
        'CLIENT_CONFIG_MISMATCH',
        `Existing config for ${expectedConfig.id} differs`
      );
    }
  }

  private async preflightWorkspace(workspacePath: string): Promise<void> {
    const type = await getPathType(workspacePath);
    if (type === undefined) return;
    if (type !== 'directory') {
      throw invalidClientPath(workspacePath, 'directory');
    }
    await assertSafeTree(workspacePath);
  }

  private async populateClientDirectory(
    destination: string,
    config: ClientConfig,
    input: ScaffoldClientInput,
    rollbackActions: RollbackAction[]
  ): Promise<void> {
    const directories = ['automations', 'data', 'memory', join('memory', 'notes'), 'output'];
    for (const directory of directories) {
      await createDirectoryIfMissing(join(destination, directory), rollbackActions);
    }

    await this.provisionVersionedDataAssets(config.id, destination, rollbackActions);

    await this.writeManagedFile(
      join(destination, 'memory', 'schema.sql'),
      await readFile(
        join(this.options.projectRoot, 'memory', 'clients', '_template', 'schema.sql')
      ),
      rollbackActions,
      false
    );
    await this.writeManagedFile(
      join(destination, 'memory', 'client_sops.md'),
      await readFile(
        join(this.options.projectRoot, 'memory', 'clients', '_template', 'client_sops.md')
      ),
      rollbackActions,
      false
    );

    await this.writeManagedFile(
      join(destination, 'client-config.json'),
      Buffer.from(`${JSON.stringify(config, null, 2)}\n`),
      rollbackActions,
      false
    );

    await this.initializeDatabase(join(destination, 'memory', 'client.sqlite'), rollbackActions);

    const workspacePath = join(this.options.workspaceRoot, input.client.id);
    const stub = [
      {
        id: `${input.client.id}_supervisor`,
        name: `Supervisor - ${input.client.id}`,
        workspace: workspacePath,
        sandbox: {
          mode: 'all',
          scope: 'agent',
          workspaceAccess: 'rw',
          binds: [`${join(this.options.projectRoot, 'skills')}:${join(workspacePath, 'skills')}:ro`]
        },
        tools: { allow: input.toolPolicy.tools_allow, deny: input.toolPolicy.tools_deny }
      },
      {
        id: `${input.client.id}_worker`,
        name: `Generic Worker - ${input.client.id}`,
        workspace: workspacePath,
        sandbox: { mode: 'all', scope: 'agent', workspaceAccess: 'rw' },
        tools: {
          allow: input.toolPolicy.tools_allow.filter(
            (tool) => !['exec', 'process', 'apply_patch'].includes(tool)
          ),
          deny: input.toolPolicy.tools_deny
        }
      }
    ];
    await this.writeManagedFile(
      join(destination, 'agent-config-stub.json'),
      Buffer.from(`${JSON.stringify(stub, null, 2)}\n`),
      rollbackActions,
      true
    );
    await this.writeManagedFile(
      join(destination, 'resolved-policies.json'),
      Buffer.from(
        `${JSON.stringify({ tools: input.toolPolicy, network: input.networkPolicy }, null, 2)}\n`
      ),
      rollbackActions,
      true
    );
  }

  private async provisionVersionedDataAssets(
    clientId: string,
    destination: string,
    rollbackActions: RollbackAction[]
  ): Promise<void> {
    const sourceSegments = ['clients', clientId, 'data'];
    let sourceDirectory = resolve(this.options.projectRoot);
    for (const segment of sourceSegments) {
      sourceDirectory = join(sourceDirectory, segment);
      const type = await getPathType(sourceDirectory);
      if (type === undefined) return;
      if (type !== 'directory') {
        throw invalidClientPath(sourceDirectory, 'a regular versioned data directory');
      }
    }

    const destinationDirectory = resolve(destination, 'data');
    if (
      sourceDirectory !== destinationDirectory &&
      (pathIsWithin(sourceDirectory, destinationDirectory) ||
        pathIsWithin(destinationDirectory, sourceDirectory))
    ) {
      throw invalidClientPath(destinationDirectory, 'a non-overlapping client data directory');
    }

    await this.copyVersionedDataDirectory(
      sourceDirectory,
      destinationDirectory,
      rollbackActions,
      { entries: 0, bytes: 0 },
      0
    );
  }

  private async copyVersionedDataDirectory(
    sourceDirectory: string,
    destinationDirectory: string,
    rollbackActions: RollbackAction[],
    budget: AssetCopyBudget,
    depth: number
  ): Promise<void> {
    if (depth > MAX_ASSET_DEPTH) {
      throw assetLimitExceeded(`Versioned data exceeds maximum depth ${MAX_ASSET_DEPTH}`);
    }
    if ((await getPathType(sourceDirectory)) !== 'directory') {
      throw invalidClientPath(sourceDirectory, 'a regular versioned data directory');
    }
    if ((await getPathType(destinationDirectory)) !== 'directory') {
      throw invalidClientPath(destinationDirectory, 'a regular client data directory');
    }

    const entries: Dirent[] = [];
    const directory = await opendir(sourceDirectory);
    for await (const entry of directory) {
      if (!SAFE_ASSET_NAME.test(entry.name)) {
        throw invalidClientPath(join(sourceDirectory, entry.name), 'a safely named data asset');
      }
      budget.entries += 1;
      if (budget.entries > MAX_ASSET_ENTRIES) {
        throw assetLimitExceeded(`Versioned data exceeds ${MAX_ASSET_ENTRIES} entries`);
      }
      entries.push(entry);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const sourcePath = join(sourceDirectory, entry.name);
      const destinationPath = join(destinationDirectory, entry.name);
      const sourceType = await getPathType(sourcePath);
      if (sourceType === 'directory') {
        await createDirectoryIfMissing(destinationPath, rollbackActions);
        await this.copyVersionedDataDirectory(
          sourcePath,
          destinationPath,
          rollbackActions,
          budget,
          depth + 1
        );
        continue;
      }
      if (sourceType !== 'file') {
        throw invalidClientPath(sourcePath, 'a regular versioned data file or directory');
      }

      const content = await readRegularAssetFile(sourcePath);
      budget.bytes += content.byteLength;
      if (budget.bytes > MAX_ASSET_TOTAL_BYTES) {
        throw assetLimitExceeded(`Versioned data exceeds ${MAX_ASSET_TOTAL_BYTES} total bytes`);
      }
      await this.writeManagedFile(destinationPath, content, rollbackActions, false);
    }
  }

  private async initializeDatabase(
    databaseFile: string,
    rollbackActions: RollbackAction[]
  ): Promise<void> {
    const type = await getPathType(databaseFile);
    if (type === 'file') return;
    if (type !== undefined) {
      throw invalidClientPath(databaseFile, 'file');
    }

    const temporaryFile = this.temporaryFilename(databaseFile, 'sqlite');
    rollbackActions.push(() => rm(databaseFile, { force: true }));
    try {
      const database = await createClientDatabase({
        projectRoot: this.options.projectRoot,
        filename: temporaryFile
      });
      database.sqlite.pragma('wal_checkpoint(TRUNCATE)');
      await database.destroy();
      await rename(temporaryFile, databaseFile);
      if ((await getPathType(databaseFile)) !== 'file') {
        throw new AppError(
          500,
          'CLIENT_FILE_VERIFY_FAILED',
          `Failed to verify managed database ${databaseFile}`
        );
      }
    } finally {
      await Promise.all([
        rm(temporaryFile, { force: true }),
        rm(`${temporaryFile}-shm`, { force: true }),
        rm(`${temporaryFile}-wal`, { force: true })
      ]);
    }
  }

  private async writeManagedFile(
    filename: string,
    content: Buffer,
    rollbackActions: RollbackAction[],
    replaceExisting: boolean
  ): Promise<void> {
    const type = await getPathType(filename);
    if (type !== undefined && type !== 'file') {
      throw invalidClientPath(filename, 'file');
    }

    const previous = type === 'file' ? await readFile(filename) : undefined;
    if (previous?.equals(content)) return;
    if (previous !== undefined && !replaceExisting) return;

    if (previous === undefined) {
      const created = await this.atomicCreate(filename, content);
      if (created) {
        rollbackActions.push(() => this.removeManagedFileIfUnchanged(filename, content));
        return;
      }
      if (!replaceExisting) return;

      const racedType = await getPathType(filename);
      if (racedType !== 'file') {
        throw invalidClientPath(filename, 'file');
      }
      const racedContent = await readFile(filename);
      if (racedContent.equals(content)) return;
      rollbackActions.push(() => this.atomicWrite(filename, racedContent));
      await this.atomicWrite(filename, content);
      return;
    }

    rollbackActions.push(() => this.atomicWrite(filename, previous));
    await this.atomicWrite(filename, content);
  }

  private async atomicCreate(filename: string, content: Buffer): Promise<boolean> {
    const temporaryFile = this.temporaryFilename(filename, 'create');
    try {
      await writeFile(temporaryFile, content, { flag: 'wx' });
      try {
        await link(temporaryFile, filename);
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') return false;
        throw error;
      }
      const verified = await readFile(filename);
      if (!verified.equals(content)) {
        throw new AppError(
          500,
          'CLIENT_FILE_VERIFY_FAILED',
          `Failed to verify managed file ${filename}`
        );
      }
      return true;
    } finally {
      await rm(temporaryFile, { force: true });
    }
  }

  private async removeManagedFileIfUnchanged(filename: string, content: Buffer): Promise<void> {
    const type = await getPathType(filename);
    if (type === undefined) return;
    if (type !== 'file') {
      throw invalidClientPath(filename, 'file');
    }
    if ((await readFile(filename)).equals(content)) {
      await rm(filename);
    }
  }

  private async atomicWrite(filename: string, content: Buffer): Promise<void> {
    const temporaryFile = this.temporaryFilename(filename, 'write');
    try {
      await writeFile(temporaryFile, content, { flag: 'wx' });
      await rename(temporaryFile, filename);
      const verified = await readFile(filename);
      if (!verified.equals(content)) {
        throw new AppError(
          500,
          'CLIENT_FILE_VERIFY_FAILED',
          `Failed to verify managed file ${filename}`
        );
      }
    } finally {
      await rm(temporaryFile, { force: true });
    }
  }

  private temporaryFilename(filename: string, purpose: string): string {
    return join(dirname(filename), `.${basename(filename)}.${this.idFactory()}.${purpose}.tmp`);
  }
}
