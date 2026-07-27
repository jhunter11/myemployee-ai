import { homedir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';

import { seedWorkIndex } from './work-index-seed';

const MAX_OUTPUT_BYTES = 4_096;
const SAFE_ERROR = {
  error: {
    code: 'WORK_INDEX_SEED_FAILED',
    message: 'Work index seeding failed validation or application'
  }
} as const;

export interface WorkIndexSeedCliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

interface ParsedArguments {
  apply: boolean;
  projectRoot: string;
  manifestPath: string;
  databaseFile: string;
}

function defaultDatabaseFile(projectRoot: string): string {
  return process.platform === 'darwin'
    ? resolve(homedir(), 'Library', 'Application Support', 'Jarvis', 'state', 'jarvis.sqlite')
    : resolve(projectRoot, 'data', 'jarvis.sqlite');
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const projectRoot = resolve(__dirname, '..', '..');
  let apply = false;
  let manifestPath = 'docs/work-index.json';
  let databaseFile = defaultDatabaseFile(projectRoot);
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      if (seen.has(argument)) throw new Error('Duplicate apply flag');
      seen.add(argument);
      apply = true;
      continue;
    }
    if (argument === '--manifest') {
      if (seen.has(argument)) throw new Error('Duplicate manifest flag');
      seen.add(argument);
      const value = argv[index + 1];
      if (value === undefined) throw new Error('Manifest flag requires a value');
      manifestPath = value;
      index += 1;
      continue;
    }
    if (argument === '--database') {
      if (seen.has(argument)) throw new Error('Duplicate database flag');
      seen.add(argument);
      const value = argv[index + 1];
      if (value === undefined) throw new Error('Database flag requires a value');
      databaseFile = value;
      index += 1;
      continue;
    }
    throw new Error('Unrecognized argument');
  }

  return { apply, projectRoot, manifestPath, databaseFile };
}

export async function runWorkIndexSeedCli(
  argv: readonly string[] = process.argv.slice(2),
  io: WorkIndexSeedCliIo = {
    stdout: (message) => process.stdout.write(`${message}\n`),
    stderr: (message) => process.stderr.write(`${message}\n`)
  }
): Promise<number> {
  try {
    const options = parseArguments(argv);
    const result = await seedWorkIndex(options);
    const output = JSON.stringify(result);
    if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) {
      throw new Error('Seed output exceeded its redacted size boundary');
    }
    io.stdout(output);
    return 0;
  } catch {
    io.stderr(JSON.stringify(SAFE_ERROR));
    return 1;
  }
}

if (require.main === module) {
  void runWorkIndexSeedCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
