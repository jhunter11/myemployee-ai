import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import SQLite from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = join(__dirname, '..', '..');
const migrationPath = join(
  projectRoot,
  'src',
  'db',
  'migrations',
  '019_primary_schema_version.sql'
);

describe('primary schema version migration', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  async function filename(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-primary-schema-migration-'));
    temporaryRoots.push(root);
    return join(root, 'jarvis.sqlite');
  }

  it('installs both marker guards and writes the version last in one transaction', async () => {
    const database = new SQLite(await filename());
    const migration = await readFile(migrationPath, 'utf8');

    database.exec(migration);

    expect(
      database
        .prepare(
          `SELECT schema_version AS schemaVersion
           FROM jarvis_primary_schema
           WHERE singleton_id = 'primary'`
        )
        .get()
    ).toEqual({ schemaVersion: 19 });
    expect(
      database
        .prepare(
          `SELECT name
           FROM sqlite_schema
           WHERE type = 'trigger' AND tbl_name = 'jarvis_primary_schema'
           ORDER BY name`
        )
        .all()
    ).toEqual([
      { name: 'jarvis_primary_schema_monotonic_update' },
      { name: 'jarvis_primary_schema_no_delete' }
    ]);
    database.close();
  });

  it('cannot leave a certified marker or partial guards when installation fails', async () => {
    const path = await filename();
    const migration = await readFile(migrationPath, 'utf8');
    const malformed = new SQLite(path);
    malformed.exec(`
      CREATE TABLE jarvis_primary_schema (
        singleton_id TEXT PRIMARY KEY
      );
    `);

    expect(() => malformed.exec(migration)).toThrow();
    malformed.close();

    const reopened = new SQLite(path);
    expect(
      reopened
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sqlite_schema
           WHERE type = 'trigger' AND tbl_name = 'jarvis_primary_schema'`
        )
        .get()
    ).toEqual({ count: 0 });
    expect(reopened.prepare(`SELECT COUNT(*) AS count FROM jarvis_primary_schema`).get()).toEqual({
      count: 0
    });
    reopened.close();
  });
});
