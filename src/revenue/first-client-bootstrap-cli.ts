import { join, resolve } from 'node:path';
import process from 'node:process';

import { bootstrapFirstClientRevenue } from './first-client-bootstrap';

const MAX_OUTPUT_BYTES = 4_096;
const SAFE_ERROR = {
  error: {
    code: 'FIRST_CLIENT_BOOTSTRAP_FAILED',
    message: 'Local first-client bootstrap failed validation or application'
  }
} as const;

export interface FirstClientBootstrapCliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

interface ParsedArguments {
  apply: boolean;
  projectRoot: string;
  packPath: string;
  databaseFile: string;
}

export async function runFirstClientBootstrapCli(
  argv: readonly string[] = process.argv.slice(2),
  io: FirstClientBootstrapCliIo = {
    stdout: (message) => process.stdout.write(`${message}\n`),
    stderr: (message) => process.stderr.write(`${message}\n`)
  }
): Promise<number> {
  try {
    const options = parseArguments(argv);
    const result = await bootstrapFirstClientRevenue(options);
    const output = JSON.stringify(result);
    if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) {
      throw new Error('Bootstrap output exceeded its redacted size boundary');
    }
    io.stdout(output);
    return 0;
  } catch {
    io.stderr(JSON.stringify(SAFE_ERROR));
    return 1;
  }
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  let apply = false;
  let projectRoot: string | undefined;
  let packPath: string | undefined;
  let databaseFile: string | undefined;
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      if (seen.has(argument)) throw new Error('Duplicate apply flag');
      seen.add(argument);
      apply = true;
      continue;
    }
    if (argument !== '--project-root' && argument !== '--pack' && argument !== '--database') {
      throw new Error('Unsupported first-client bootstrap argument');
    }
    if (seen.has(argument)) throw new Error('Duplicate path argument');
    seen.add(argument);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('Path argument requires a direct value');
    }
    index += 1;
    if (argument === '--project-root') projectRoot = value;
    if (argument === '--pack') packPath = value;
    if (argument === '--database') databaseFile = value;
  }

  const root = projectRoot ?? resolve(process.cwd());
  return {
    apply,
    projectRoot: root,
    packPath: packPath ?? join(root, 'docs', 'revenue', 'first-client-pack.json'),
    databaseFile: databaseFile ?? join(root, 'data', 'jarvis.sqlite')
  };
}

if (require.main === module) {
  void runFirstClientBootstrapCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
