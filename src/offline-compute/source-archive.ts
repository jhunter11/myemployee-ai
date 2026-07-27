import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { OfflineComputeProfile, SourceFileRecord } from './contracts';
import { digestSourceFileRecords } from './contracts';
import { AppError } from '../utils/errors';

const invalidSource = () =>
  new AppError(422, 'OFFLINE_SOURCE_INVALID', 'Pinned offline source archive is invalid');

interface EnumeratedTree {
  directories: string[];
  files: SourceFileRecord[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function expectedDirectories(files: readonly SourceFileRecord[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    let parent = dirname(file.path);
    while (parent !== '.') {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  return [...directories].sort(compareText);
}

async function enumerateTree(root: string): Promise<EnumeratedTree> {
  const directories: string[] = [];
  const files: SourceFileRecord[] = [];

  async function visit(directory: string, relativeDirectory: string, depth: number): Promise<void> {
    if (depth > 8) throw invalidSource();
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const relativePath =
        relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw invalidSource();
      if (metadata.isDirectory()) {
        directories.push(relativePath);
        await visit(path, relativePath, depth + 1);
        continue;
      }
      if (!metadata.isFile() || files.length >= 256 || metadata.size > 1_000_000) {
        throw invalidSource();
      }
      files.push({ path: relativePath, bytes: metadata.size, sha256: '' });
    }
  }

  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw invalidSource();
  await visit(root, '', 0);
  return {
    directories: directories.sort(compareText),
    files: files.sort((left, right) => compareText(left.path, right.path))
  };
}

async function readVerifiedFile(sourceRoot: string, expected: SourceFileRecord): Promise<Buffer> {
  let handle;
  try {
    handle = await open(
      join(sourceRoot, ...expected.path.split('/')),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    const before = await handle.stat();
    if (!before.isFile() || before.size !== expected.bytes) throw invalidSource();
    const content = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      content.length !== expected.bytes ||
      createHash('sha256').update(content).digest('hex') !== expected.sha256
    ) {
      throw invalidSource();
    }
    return content;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidSource();
  } finally {
    await handle?.close();
  }
}

async function writeExclusive(destination: string, content: Buffer): Promise<void> {
  let handle;
  try {
    handle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o400
    );
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidSource();
  } finally {
    await handle?.close();
  }
}

export async function copyVerifiedSourceArchive(options: {
  sourceRoot: string;
  destinationRoot: string;
  source: OfflineComputeProfile['source'];
}): Promise<void> {
  const expectedFiles = options.source.files;
  let tree: EnumeratedTree;
  try {
    tree = await enumerateTree(options.sourceRoot);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidSource();
  }

  const actualPaths = tree.files.map((file) => file.path);
  const expectedPaths = expectedFiles.map((file) => file.path);
  if (
    JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths) ||
    JSON.stringify(tree.directories) !== JSON.stringify(expectedDirectories(expectedFiles)) ||
    digestSourceFileRecords(expectedFiles) !== options.source.digest
  ) {
    throw invalidSource();
  }

  try {
    const directories = expectedDirectories(expectedFiles);
    await mkdir(options.destinationRoot, { mode: 0o700 });
    for (const directory of directories) {
      await mkdir(join(options.destinationRoot, ...directory.split('/')), { mode: 0o700 });
    }
    for (const expected of expectedFiles) {
      const content = await readVerifiedFile(options.sourceRoot, expected);
      await writeExclusive(join(options.destinationRoot, ...expected.path.split('/')), content);
    }
  } catch (error) {
    await rm(options.destinationRoot, { recursive: true, force: true });
    if (error instanceof AppError) throw error;
    throw invalidSource();
  }
}
