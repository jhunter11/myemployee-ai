import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

import { buildCodeIndex, persistCodeIndex, queryBlastRadius } from './code-index';
import { duplicateAnchorIds } from './anchors';

const MAX_OUTPUT_BYTES = 16_384;
const SAFE_ERROR = {
  error: { code: 'CODE_INDEX_FAILED', message: 'Code index build or query failed' }
} as const;

export interface CodeIndexCliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

interface ParsedArguments {
  command: 'build' | 'blast';
  projectRoot: string;
  databaseFile: string;
  target: string | null;
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const projectRoot = resolve(__dirname, '..', '..');
  let command: 'build' | 'blast' = 'build';
  let databaseFile = resolve(projectRoot, 'data', 'code-index.sqlite');
  let target: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === 'build' || argument === 'blast') {
      command = argument;
      continue;
    }
    if (argument === '--database') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('Database flag requires a value');
      databaseFile = resolve(value);
      index += 1;
      continue;
    }
    if (argument === '--path') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('Path flag requires a value');
      target = value;
      index += 1;
      continue;
    }
    throw new Error('Unrecognized argument');
  }

  if (command === 'blast' && target === null) {
    throw new Error('blast requires --path');
  }
  return { command, projectRoot, databaseFile, target };
}

export async function runCodeIndexCli(
  argv: readonly string[] = process.argv.slice(2),
  io: CodeIndexCliIo = {
    stdout: (message) => process.stdout.write(`${message}\n`),
    stderr: (message) => process.stderr.write(`${message}\n`)
  }
): Promise<number> {
  try {
    const options = parseArguments(argv);

    if (options.command === 'blast') {
      const affected = queryBlastRadius(options.databaseFile, options.target ?? '');
      const output = JSON.stringify({
        schemaVersion: 1,
        path: options.target,
        affectedCount: affected.length,
        affected: affected.slice(0, 100)
      });
      io.stdout(output.slice(0, MAX_OUTPUT_BYTES));
      return 0;
    }

    await mkdir(dirname(options.databaseFile), { recursive: true });
    const build = await buildCodeIndex(options.projectRoot);
    persistCodeIndex(options.databaseFile, build);

    const duplicates = duplicateAnchorIds(build.anchorIndex);
    const output = JSON.stringify({
      schemaVersion: 1,
      status: duplicates.length === 0 && build.anchorIndex.issues.length === 0 ? 'ok' : 'warn',
      generatedAt: build.generatedAt,
      fileCount: build.fileCount,
      anchorCount: build.anchorCount,
      importEdgeCount: build.importEdgeCount,
      unresolvedImportCount: build.unresolvedImportCount,
      duplicateAnchorIds: duplicates.slice(0, 20),
      anchorIssues: build.anchorIndex.issues.slice(0, 20)
    });
    io.stdout(output.slice(0, MAX_OUTPUT_BYTES));
    return 0;
  } catch {
    io.stderr(JSON.stringify(SAFE_ERROR));
    return 1;
  }
}

if (require.main === module) {
  void runCodeIndexCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
