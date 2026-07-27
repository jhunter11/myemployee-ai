import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadPinnedPmqsProfile } from '../../src/offline-compute/profile';

const projectRoot = join(__dirname, '..', '..');

describe('loadPinnedPmqsProfile', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('loads immutable repository, commit, tree, and content provenance', async () => {
    const profile = await loadPinnedPmqsProfile(projectRoot);

    expect(profile).toMatchObject({
      id: 'offline_compute',
      commandId: 'pmqs-fixture-backtest-v1',
      network: 'none',
      source: {
        repository: 'jhunter11/pmqs',
        commit: '6fbd6d4fe0b9b17c18d5560fb1507a6cd66ac6d4',
        tree: '8cf4d1fd58e29c44fc537d19739c1135ed76987e',
        digest: '4316095c1fc9d67d07e10249e87021feba070ffa7951fce489457835cd7c76bb'
      }
    });
    expect(profile.source.files).toHaveLength(37);
    expect(profile.source.files.map((file) => file.path)).toContain(
      'examples/run_fixture_backtest.py'
    );
  });

  it('rejects a symlinked profile rather than reading through it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-offline-profile-'));
    temporaryRoots.push(root);
    const configDirectory = join(root, 'config', 'execution-profiles');
    await mkdir(configDirectory, { recursive: true });
    const outside = join(root, 'outside.json');
    await writeFile(outside, '{}');
    await symlink(outside, join(configDirectory, 'pmqs-fixture-backtest.json'));

    await expect(loadPinnedPmqsProfile(root)).rejects.toMatchObject({
      code: 'INVALID_OFFLINE_COMPUTE_PROFILE'
    });
  });

  it('returns one safe error for malformed profile JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-offline-profile-'));
    temporaryRoots.push(root);
    const configDirectory = join(root, 'config', 'execution-profiles');
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, 'pmqs-fixture-backtest.json'), '{not json');

    await expect(loadPinnedPmqsProfile(root)).rejects.toMatchObject({
      statusCode: 500,
      code: 'INVALID_OFFLINE_COMPUTE_PROFILE',
      message: 'Offline compute profile is invalid'
    });
  });
});
