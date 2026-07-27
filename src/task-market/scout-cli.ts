import { basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';

import { ScoutCycle } from './scout-cycle';
import type { ScoutCycleResult } from './scout-cycle';
import { createProductionScoutLiveSignals } from './scout-live-signals';
import { TaskmarketScout } from './taskmarket-scout';

const MAX_CLI_OUTPUT_BYTES = 64 * 1_024;

interface RunnableScoutCycle {
  run: () => Promise<ScoutCycleResult>;
}

export interface ScoutCliDependencies {
  cycle: RunnableScoutCycle;
  writeLine: (line: string) => void;
}

function fixedProjectRoot(): string {
  if (
    basename(__dirname) === 'task-market' &&
    basename(dirname(__dirname)) === 'src' &&
    basename(dirname(dirname(__dirname))) === 'dist'
  ) {
    return resolve(__dirname, '..', '..', '..');
  }
  if (basename(__dirname) === 'task-market' && basename(dirname(__dirname)) === 'src') {
    return resolve(__dirname, '..', '..');
  }
  if (basename(__dirname) === 'dist-task-market') {
    return resolve(__dirname, '..');
  }
  throw new Error('Scout CLI location is not recognized');
}

function productionDependencies(): ScoutCliDependencies {
  const clock = (): Date => new Date();
  const projectRoot = fixedProjectRoot();
  const signals = createProductionScoutLiveSignals({
    projectRoot,
    databaseFile:
      process.platform === 'darwin'
        ? resolve(homedir(), 'Library', 'Application Support', 'Jarvis', 'state', 'jarvis.sqlite')
        : resolve(projectRoot, 'data', 'jarvis.sqlite'),
    environment: process.env,
    clock
  });
  const scout = new TaskmarketScout({
    fetch: globalThis.fetch,
    clock
  });
  return {
    cycle: new ScoutCycle({ signals, scout, clock }),
    writeLine: (line) => void process.stdout.write(`${line}\n`)
  };
}

function fixedCliError(): string {
  return JSON.stringify({
    schemaVersion: 1,
    status: 'operational_error',
    errorCode: 'CLI_INTERNAL_ERROR'
  });
}

export async function runScoutCli(dependencies?: ScoutCliDependencies): Promise<number> {
  const writeLine = (line: string): void => {
    if (dependencies === undefined) {
      void process.stdout.write(`${line}\n`);
    } else {
      dependencies.writeLine(line);
    }
  };
  try {
    const activeDependencies = dependencies ?? productionDependencies();
    const result = await activeDependencies.cycle.run();
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_CLI_OUTPUT_BYTES) {
      writeLine(fixedCliError());
      return 1;
    }
    writeLine(serialized);
    return result.status === 'operational_error' ? 1 : 0;
  } catch {
    writeLine(fixedCliError());
    return 1;
  }
}

if (require.main === module) {
  void runScoutCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
