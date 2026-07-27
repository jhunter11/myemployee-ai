import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { parseOfflineComputeProfile, type OfflineComputeProfile } from './contracts';
import { AppError } from '../utils/errors';

const PROFILE_PATH = ['config', 'execution-profiles', 'pmqs-fixture-backtest.json'] as const;
const MAX_PROFILE_BYTES = 256_000;

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

function invalidProfile(): AppError {
  return new AppError(500, 'INVALID_OFFLINE_COMPUTE_PROFILE', 'Offline compute profile is invalid');
}

export async function loadPinnedPmqsProfile(projectRoot: string): Promise<OfflineComputeProfile> {
  let handle;
  try {
    const canonicalRoot = await realpath(resolve(projectRoot));
    const configuredPath = join(canonicalRoot, ...PROFILE_PATH);
    const canonicalPath = await realpath(configuredPath);
    if (!isWithin(canonicalRoot, canonicalPath) || canonicalPath !== configuredPath) {
      throw invalidProfile();
    }
    handle = await open(configuredPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MAX_PROFILE_BYTES) {
      throw invalidProfile();
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw invalidProfile();
    }
    return parseOfflineComputeProfile(JSON.parse(content.toString('utf8')) as unknown);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidProfile();
  } finally {
    await handle?.close();
  }
}
