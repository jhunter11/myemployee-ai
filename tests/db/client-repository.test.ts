import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import { ClientRepository } from '../../src/db/client-repository';

const projectRoot = join(__dirname, '..', '..');

describe('ClientRepository', () => {
  let temporaryRoot: string;
  let context: GlobalDatabaseContext;
  let repository: ClientRepository;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-client-repository-'));
    context = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    repository = new ClientRepository(context.db);
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('creates and reads a client using domain field names', async () => {
    const created = await repository.create({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing',
      status: 'active',
      createdAt: '2026-07-18T12:00:00.000Z'
    });

    expect(created).toEqual({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing',
      status: 'active',
      createdAt: '2026-07-18T12:00:00.000Z'
    });
    await expect(repository.findById('acme_corp')).resolves.toEqual(created);
  });

  it('lists clients by creation time and then id', async () => {
    await repository.create({
      id: 'zenith_labs',
      name: 'Zenith Labs',
      profile: 'email_only',
      status: 'active',
      createdAt: '2026-07-18T13:00:00.000Z'
    });
    await repository.create({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing',
      status: 'active',
      createdAt: '2026-07-18T12:00:00.000Z'
    });

    await expect(repository.list()).resolves.toEqual([
      expect.objectContaining({ id: 'acme_corp' }),
      expect.objectContaining({ id: 'zenith_labs' })
    ]);
  });

  it('returns undefined for a missing client', async () => {
    await expect(repository.findById('missing_client')).resolves.toBeUndefined();
  });

  it('updates client status and returns undefined when the client is missing', async () => {
    await repository.create({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing',
      status: 'active',
      createdAt: '2026-07-18T12:00:00.000Z'
    });

    await expect(repository.updateStatus('acme_corp', 'suspended')).resolves.toMatchObject({
      id: 'acme_corp',
      status: 'suspended'
    });
    await expect(repository.updateStatus('missing_client', 'suspended')).resolves.toBeUndefined();
  });

  it('deletes an existing client and reports missing deletes', async () => {
    await repository.create({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing',
      status: 'active',
      createdAt: '2026-07-18T12:00:00.000Z'
    });

    await expect(repository.delete('acme_corp')).resolves.toBe(true);
    await expect(repository.delete('acme_corp')).resolves.toBe(false);
    await expect(repository.findById('acme_corp')).resolves.toBeUndefined();
  });
});
