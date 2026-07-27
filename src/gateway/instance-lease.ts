import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import SQLite from 'better-sqlite3';

import { AppError } from '../utils/errors';

export interface GatewayInstanceLease {
  lockPath: string | null;
  release(): Promise<void>;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isSqliteBusy(error: unknown): boolean {
  return isNodeError(error) && error.code?.startsWith('SQLITE_BUSY') === true;
}

function normalizeLeaseError(error: unknown, operation: string): Error {
  return error instanceof Error
    ? error
    : new Error(`${operation} failed with a non-Error value`, { cause: error });
}

async function ensureRegularLockDatabase(lockPath: string): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      const metadata = await lstat(lockPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error('Gateway instance lock database must be a non-symlink regular file');
      }
      await chmod(lockPath, 0o600);
      return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }

    let handle;
    try {
      handle = await open(
        lockPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      await handle.sync();
      return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    } finally {
      await handle?.close();
    }
  }
}

async function canonicalizePrimaryDatabase(databaseFile: string): Promise<string> {
  const resolvedDatabase = resolve(databaseFile);
  await mkdir(dirname(resolvedDatabase), { recursive: true });
  const canonicalDatabase = join(
    await realpath(dirname(resolvedDatabase)),
    basename(resolvedDatabase)
  );

  for (;;) {
    let handle;
    try {
      handle = await open(
        canonicalDatabase,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      await handle.sync();
      return canonicalDatabase;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    } finally {
      await handle?.close();
    }

    const metadata = await lstat(canonicalDatabase);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
      throw new Error('Gateway database must be a non-symlink, singly linked regular file');
    }
    return canonicalDatabase;
  }
}

function noOpLease(): GatewayInstanceLease {
  let releasePromise: Promise<void> | undefined;
  return {
    lockPath: null,
    release() {
      releasePromise ??= Promise.resolve();
      return releasePromise;
    }
  };
}

function activeLease(lockPath: string, database: SQLite.Database): GatewayInstanceLease {
  let releasePromise: Promise<void> | undefined;
  return {
    lockPath,
    release() {
      releasePromise ??= (() => {
        const errors: Error[] = [];
        try {
          database.exec('ROLLBACK');
        } catch (error) {
          errors.push(normalizeLeaseError(error, 'Gateway lease rollback'));
        }
        try {
          database.close();
        } catch (error) {
          errors.push(normalizeLeaseError(error, 'Gateway lease database close'));
        }
        const firstError = errors[0];
        if (errors.length === 1 && firstError !== undefined) return Promise.reject(firstError);
        if (errors.length > 1) {
          return Promise.reject(
            new AggregateError(errors, 'Gateway instance lease release failed')
          );
        }
        return Promise.resolve();
      })();
      return releasePromise;
    }
  };
}

export async function acquireGatewayInstanceLease(
  databaseFile: string
): Promise<GatewayInstanceLease> {
  if (databaseFile === ':memory:') return noOpLease();

  let canonicalDatabase: string;
  try {
    canonicalDatabase = await canonicalizePrimaryDatabase(databaseFile);
  } catch (error) {
    throw new AppError(
      500,
      'GATEWAY_INSTANCE_LOCK_INVALID',
      'Gateway database path is invalid for instance locking',
      error
    );
  }
  const lockPath = `${canonicalDatabase}.gateway.lock`;
  try {
    await ensureRegularLockDatabase(lockPath);
  } catch (error) {
    throw new AppError(
      500,
      'GATEWAY_INSTANCE_LOCK_INVALID',
      'Gateway instance lock database is invalid',
      error
    );
  }

  let database: SQLite.Database | undefined;
  try {
    database = new SQLite(lockPath, { timeout: 0 });
    database.exec('BEGIN EXCLUSIVE');
    return activeLease(lockPath, database);
  } catch (error) {
    let cause: unknown = error;
    try {
      database?.close();
    } catch (closeError) {
      cause = new AggregateError([error, closeError], 'Gateway lock acquisition cleanup failed');
    }
    if (isSqliteBusy(error)) {
      throw new AppError(
        409,
        'GATEWAY_INSTANCE_ACTIVE',
        'Another Jarvis gateway instance owns this database',
        cause
      );
    }
    throw new AppError(
      500,
      'GATEWAY_INSTANCE_LOCK_INVALID',
      'Gateway instance lock database is invalid',
      cause
    );
  }
}
