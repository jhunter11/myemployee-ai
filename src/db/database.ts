import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import SQLite from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';

import { applyProgrammaticMigrations } from './programmatic-migrations';
import type { ClientDatabase, JarvisDatabase } from './types';

export interface DatabaseOptions {
  projectRoot: string;
  filename: string;
}

export interface DatabaseContext {
  sqlite: SQLite.Database;
  destroy(): Promise<void>;
}

export interface GlobalDatabaseContext extends DatabaseContext {
  db: Kysely<JarvisDatabase>;
}

export interface ClientDatabaseContext extends DatabaseContext {
  db: Kysely<ClientDatabase>;
}

async function openDatabase<T>(
  filename: string,
  schemaFiles: string[]
): Promise<{
  db: Kysely<T>;
  sqlite: SQLite.Database;
  destroy(): Promise<void>;
}> {
  if (filename !== ':memory:') {
    await mkdir(dirname(filename), { recursive: true });
  }

  const schemas = await Promise.all(schemaFiles.map((schemaFile) => readFile(schemaFile, 'utf8')));
  const sqlite = new SQLite(filename);

  try {
    sqlite.pragma('foreign_keys = ON');
    if (filename !== ':memory:') {
      sqlite.pragma('journal_mode = WAL');
    }
    for (const schema of schemas) {
      sqlite.exec(schema);
    }
    applyProgrammaticMigrations(sqlite);
  } catch (error) {
    sqlite.close();
    throw error;
  }

  const db = new Kysely<T>({
    dialect: new SqliteDialect({ database: sqlite })
  });
  let destroyed = false;

  return {
    db,
    sqlite,
    async destroy() {
      if (!destroyed) {
        destroyed = true;
        await db.destroy();
      }
    }
  };
}

export function createDatabase(options: DatabaseOptions): Promise<GlobalDatabaseContext> {
  return openDatabase<JarvisDatabase>(options.filename, [
    join(options.projectRoot, 'memory', 'core', 'schema.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '001_agent_runs.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '002_run_recovery_queue.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '003_model_usage_events.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '004_knowledge_scopes.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '005_priority_queue.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '006_revenue_pipeline.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '007_agent_conversations.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '008_agent_conversation_integrity.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '009_agent_blueprints.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '010_access_control_sleeves.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '011_scoped_lexical_retrieval.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '012_telegram_channel.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '013_command_proposals.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '014_calendar_connections.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '015_delegation_traces.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '016_profile_access_lifecycle_audit.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '017_agency_execution_posture.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '018_verification_freeze.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '019_primary_schema_version.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '020_model_execution_enablement.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '021_provider_rate_limit_circuits.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '022_agent_conversation_turn_claims.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '023_typed_hybrid_memory.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '024_memory_ledger.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '025_memory_experiment_log.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '026_agent_profile_instances.sql'),
    join(options.projectRoot, 'src', 'db', 'migrations', '027_memory_maintenance_outbox.sql')
  ]);
}

export function createClientDatabase(options: DatabaseOptions): Promise<ClientDatabaseContext> {
  return openDatabase<ClientDatabase>(options.filename, [
    join(options.projectRoot, 'memory', 'clients', '_template', 'schema.sql')
  ]);
}
