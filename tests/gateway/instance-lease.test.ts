import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireGatewayInstanceLease } from '../../src/gateway/instance-lease';

function waitForOutput(child: ChildProcess, expected: string): Promise<void> {
  return new Promise<void>((resolveOutput, rejectOutput) => {
    let output = '';
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      if (output.includes(expected)) {
        cleanup();
        resolveOutput();
      }
    };
    const onExit = (): void => {
      cleanup();
      rejectOutput(new Error(`Lease child exited before emitting ${expected}`));
    };
    const cleanup = (): void => {
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
}

describe('Gateway instance lease', () => {
  let temporaryRoot: string;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-instance-lease-'));
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('uses a kernel-backed lock, excludes a live owner, and supports idempotent release', async () => {
    const databaseFile = join(temporaryRoot, 'jarvis.sqlite');
    const first = await acquireGatewayInstanceLease(databaseFile);
    const lockPath = join(
      await realpath(dirname(databaseFile)),
      `${basename(databaseFile)}.gateway.lock`
    );
    expect(first.lockPath).toBe(lockPath);
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);

    await expect(acquireGatewayInstanceLease(databaseFile)).rejects.toMatchObject({
      statusCode: 409,
      code: 'GATEWAY_INSTANCE_ACTIVE'
    });

    const firstRelease = first.release();
    expect(first.release()).toBe(firstRelease);
    await firstRelease;
    await expect(stat(lockPath)).resolves.toMatchObject({});

    const second = await acquireGatewayInstanceLease(databaseFile);
    await second.release();
  });

  it('allows exactly one concurrent contender to acquire a new lease', async () => {
    const databaseFile = join(temporaryRoot, 'contended.sqlite');
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, () => acquireGatewayInstanceLease(databaseFile))
    );
    const acquired = results.filter(
      (
        result
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof acquireGatewayInstanceLease>>
      > => result.status === 'fulfilled'
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );

    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(39);
    for (const result of rejected) {
      expect(result.reason).toMatchObject({
        statusCode: 409,
        code: 'GATEWAY_INSTANCE_ACTIVE'
      });
    }
    await acquired[0]?.value.release();
  });

  it('reacquires automatically after the owning process is killed', async () => {
    const databaseFile = join(temporaryRoot, 'crash-recovery.sqlite');
    const lockPath = `${resolve(databaseFile)}.gateway.lock`;
    const child = spawn(
      process.execPath,
      [
        '-e',
        [
          'const SQLite = require("better-sqlite3");',
          'const database = new SQLite(process.argv[1], { timeout: 0 });',
          'database.exec("BEGIN EXCLUSIVE");',
          'process.stdout.write("locked\\n");',
          'setInterval(() => undefined, 1000);'
        ].join(' '),
        lockPath
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    children.push(child);
    await waitForOutput(child, 'locked\n');
    await expect(acquireGatewayInstanceLease(databaseFile)).rejects.toMatchObject({
      code: 'GATEWAY_INSTANCE_ACTIVE'
    });

    child.kill('SIGKILL');
    await once(child, 'exit');
    children.splice(children.indexOf(child), 1);

    const recovered = await acquireGatewayInstanceLease(databaseFile);
    await recovered.release();
  });

  it('fails closed on malformed, directory, and symlink lock paths', async () => {
    const malformedDatabase = join(temporaryRoot, 'malformed.sqlite');
    const malformedLock = `${resolve(malformedDatabase)}.gateway.lock`;
    await writeFile(malformedLock, 'not a sqlite database\n');
    await expect(acquireGatewayInstanceLease(malformedDatabase)).rejects.toMatchObject({
      code: 'GATEWAY_INSTANCE_LOCK_INVALID'
    });
    expect(await readFile(malformedLock, 'utf8')).toBe('not a sqlite database\n');

    const directoryDatabase = join(temporaryRoot, 'directory.sqlite');
    await mkdir(`${resolve(directoryDatabase)}.gateway.lock`);
    await expect(acquireGatewayInstanceLease(directoryDatabase)).rejects.toMatchObject({
      code: 'GATEWAY_INSTANCE_LOCK_INVALID'
    });

    const symlinkDatabase = join(temporaryRoot, 'symlink.sqlite');
    const outside = join(temporaryRoot, 'outside-lock.sqlite');
    await writeFile(outside, 'outside\n');
    await symlink(outside, `${resolve(symlinkDatabase)}.gateway.lock`);
    await expect(acquireGatewayInstanceLease(symlinkDatabase)).rejects.toMatchObject({
      code: 'GATEWAY_INSTANCE_LOCK_INVALID'
    });
    expect(await readFile(outside, 'utf8')).toBe('outside\n');
  });

  it('canonicalizes parent aliases and rejects a symlinked primary database', async () => {
    const realDirectory = join(temporaryRoot, 'real-database-directory');
    const aliasDirectory = join(temporaryRoot, 'database-directory-alias');
    await mkdir(realDirectory);
    await symlink(realDirectory, aliasDirectory);
    const realDatabase = join(realDirectory, 'jarvis.sqlite');
    const parentAliasDatabase = join(aliasDirectory, 'jarvis.sqlite');

    const lease = await acquireGatewayInstanceLease(realDatabase);
    await expect(acquireGatewayInstanceLease(parentAliasDatabase)).rejects.toMatchObject({
      code: 'GATEWAY_INSTANCE_ACTIVE'
    });
    await lease.release();

    const primaryDatabase = join(realDirectory, 'primary.sqlite');
    const primaryAlias = join(realDirectory, 'primary-alias.sqlite');
    await writeFile(primaryDatabase, '');
    await symlink(primaryDatabase, primaryAlias);
    await expect(acquireGatewayInstanceLease(primaryAlias)).rejects.toMatchObject({
      code: 'GATEWAY_INSTANCE_LOCK_INVALID'
    });
  });

  it('uses a no-op lease for isolated in-memory databases', async () => {
    const lease = await acquireGatewayInstanceLease(':memory:');
    expect(lease.lockPath).toBeNull();
    await expect(lease.release()).resolves.toBeUndefined();
  });
});
