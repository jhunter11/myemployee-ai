import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import {
  PMQS_COMMAND_ID,
  PMQS_SCRIPT_PATH,
  parseOfflineComputeProfile,
  type OfflineComputeProfile,
  type OfflineComputeReason,
  type OfflineComputeResult,
  type OfflineComputeStatus,
  type StreamDigest
} from './contracts';
import { copyVerifiedSourceArchive } from './source-archive';
import { AppError } from '../utils/errors';

const DEFAULT_SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const DEFAULT_PYTHON = '/usr/bin/python3';
const NETWORK_GUARD_EXIT = 93;

const FIXED_PYTHON_PROGRAM = [
  'import errno, os, runpy, socket, sys',
  'safe_environment = {key: os.environ[key] for key in ("HOME", "LANG", "LC_ALL", "PATH", "PYTHONHASHSEED", "TMPDIR")}',
  'os.environ.clear()',
  'os.environ.update(safe_environment)',
  'try:',
  '    probe = socket.socket()',
  '    probe.bind(("127.0.0.1", 0))',
  'except OSError as error:',
  '    if error.errno not in (errno.EPERM, errno.EACCES):',
  '        raise',
  'else:',
  '    probe.close()',
  `    raise SystemExit(${NETWORK_GUARD_EXIT})`,
  'sys.path.insert(0, "src")',
  `runpy.run_path(${JSON.stringify(PMQS_SCRIPT_PATH)}, run_name="__main__")`,
  ''
].join('\n');

const MACOS_SANDBOX_PROFILE = `(version 1)
(allow default)
(deny network*)
(deny file-read*
  (subpath "/Users")
  (subpath "/Volumes")
  (subpath "/private/tmp")
  (subpath (param "TEMP_ROOT")))
(allow file-read* (subpath (param "RUN_ROOT")))
(deny file-write*
  (subpath "/Users")
  (subpath "/Volumes")
  (subpath "/private/tmp")
  (subpath (param "TEMP_ROOT")))
(allow file-write*
  (subpath (param "HOME_ROOT"))
  (subpath (param "RUN_TMP")))`;

interface RunnerOptions {
  archiveRoot: string;
  profile: OfflineComputeProfile;
  temporaryRoot?: string;
  platform?: NodeJS.Platform;
}

interface CapturedProcess {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  termination: 'timeout' | 'output_limit' | null;
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

async function requireExecutable(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o111) === 0) {
      throw new Error('not executable');
    }
  } catch {
    throw new AppError(
      503,
      'OFFLINE_NETWORK_ISOLATION_UNAVAILABLE',
      'OS-enforced no-network execution is unavailable'
    );
  }
}

function digestStream(content: Buffer): StreamDigest {
  return {
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex')
  };
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === 'ESRCH') return;
    if (code !== 'EPERM') throw error;

    // macOS can report EPERM when the detached process exits between the
    // group lookup and signal delivery. Fall back to the child itself so a
    // bounded run still terminates instead of surfacing an infrastructure
    // error. A vanished child is already in the desired state.
    try {
      process.kill(pid, 'SIGKILL');
    } catch (fallbackError) {
      const fallbackCode =
        typeof fallbackError === 'object' && fallbackError !== null && 'code' in fallbackError
          ? (fallbackError as { code?: unknown }).code
          : undefined;
      if (fallbackCode !== 'ESRCH') throw fallbackError;
    }
  }
}

function runBoundedProcess(options: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<CapturedProcess> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdoutParts: Buffer[] = [];
    const stderrParts: Buffer[] = [];
    let capturedBytes = 0;
    let termination: CapturedProcess['termination'] = null;
    let spawnError: Error | undefined;

    const terminate = (reason: NonNullable<CapturedProcess['termination']>) => {
      if (termination !== null) return;
      termination = reason;
      try {
        killProcessGroup(child.pid);
      } catch (error) {
        rejectPromise(error instanceof Error ? error : new Error('Process group kill failed'));
      }
    };

    const capture = (parts: Buffer[], chunk: Buffer) => {
      if (termination !== null) return;
      const remaining = Math.max(0, options.maxOutputBytes - capturedBytes);
      if (remaining > 0) {
        const accepted = chunk.subarray(0, remaining);
        parts.push(accepted);
        capturedBytes += accepted.length;
      }
      if (chunk.length > remaining || capturedBytes >= options.maxOutputBytes) {
        terminate('output_limit');
      }
    };

    child.stdout.on('data', (chunk: Buffer) => capture(stdoutParts, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderrParts, chunk));
    child.once('error', (error) => {
      spawnError = error;
    });

    const timeout = setTimeout(() => terminate('timeout'), options.timeoutMs);
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      if (spawnError !== undefined) {
        rejectPromise(spawnError);
        return;
      }
      resolvePromise({
        stdout: Buffer.concat(stdoutParts),
        stderr: Buffer.concat(stderrParts),
        exitCode,
        signal,
        termination
      });
    });
  });
}

function parseVerdict(stdout: Buffer): 'PASS' | 'FAIL' | null {
  const matches = [...stdout.toString('utf8').matchAll(/^verdict\s*:\s*(PASS|FAIL)\s*$/gmu)];
  if (matches.length !== 1) return null;
  return matches[0]?.[1] === 'PASS' ? 'PASS' : 'FAIL';
}

function classify(processResult: CapturedProcess): {
  status: OfflineComputeStatus;
  reason: OfflineComputeReason;
  verdict: 'PASS' | 'FAIL' | null;
  exitCode: number | null;
} {
  if (processResult.termination === 'timeout') {
    return { status: 'timeout', reason: 'TIMEOUT', verdict: null, exitCode: null };
  }
  if (processResult.termination === 'output_limit') {
    return { status: 'output_limit', reason: 'OUTPUT_LIMIT', verdict: null, exitCode: null };
  }
  if (processResult.exitCode === NETWORK_GUARD_EXIT) {
    return {
      status: 'failed',
      reason: 'NETWORK_GUARD_FAILED',
      verdict: null,
      exitCode: processResult.exitCode
    };
  }
  if (processResult.exitCode !== 0) {
    return {
      status: 'failed',
      reason: 'COMMAND_FAILED',
      verdict: null,
      exitCode: processResult.exitCode
    };
  }
  const verdict = parseVerdict(processResult.stdout);
  if (verdict === null) {
    return { status: 'failed', reason: 'VERDICT_INVALID', verdict: null, exitCode: 0 };
  }
  return { status: 'succeeded', reason: null, verdict, exitCode: 0 };
}

export class OfflineComputeRunner {
  private readonly profile: OfflineComputeProfile;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: RunnerOptions) {
    this.profile = parseOfflineComputeProfile(options.profile);
    this.platform = options.platform ?? process.platform;
  }

  async run(): Promise<OfflineComputeResult> {
    if (this.platform !== 'darwin') {
      throw new AppError(
        503,
        'OFFLINE_NETWORK_ISOLATION_UNAVAILABLE',
        'OS-enforced no-network execution is unavailable'
      );
    }
    await Promise.all([requireExecutable(DEFAULT_SANDBOX_EXEC), requireExecutable(DEFAULT_PYTHON)]);

    const archiveRoot = await realpath(resolve(this.options.archiveRoot));
    const sourceRoot = await realpath(join(archiveRoot, this.profile.source.directory));
    if (!isWithin(archiveRoot, sourceRoot)) {
      throw new AppError(422, 'OFFLINE_SOURCE_INVALID', 'Pinned offline source archive is invalid');
    }

    const temporaryRoot = await realpath(resolve(this.options.temporaryRoot ?? tmpdir()));
    const executionRoot = await mkdtemp(join(temporaryRoot, 'jarvis-offline-compute-'));
    const executionSource = join(executionRoot, 'source');

    try {
      await copyVerifiedSourceArchive({
        sourceRoot,
        destinationRoot: executionSource,
        source: this.profile.source
      });
      await Promise.all([
        mkdir(join(executionRoot, 'home'), { mode: 0o700 }),
        mkdir(join(executionRoot, 'tmp'), { mode: 0o700 })
      ]);

      const processResult = await runBoundedProcess({
        executable: DEFAULT_SANDBOX_EXEC,
        args: [
          '-D',
          `RUN_ROOT=${executionRoot}`,
          '-D',
          `TEMP_ROOT=${temporaryRoot}`,
          '-D',
          `HOME_ROOT=${join(executionRoot, 'home')}`,
          '-D',
          `RUN_TMP=${join(executionRoot, 'tmp')}`,
          '-p',
          MACOS_SANDBOX_PROFILE,
          DEFAULT_PYTHON,
          '-I',
          '-B',
          '-c',
          FIXED_PYTHON_PROGRAM
        ],
        cwd: executionSource,
        env: {
          HOME: join(executionRoot, 'home'),
          LANG: 'C',
          LC_ALL: 'C',
          PATH: '/usr/bin:/bin',
          PYTHONHASHSEED: '0',
          TMPDIR: join(executionRoot, 'tmp')
        },
        timeoutMs: this.profile.timeoutMs,
        maxOutputBytes: this.profile.maxOutputBytes
      });
      const outcome = classify(processResult);
      return {
        profile: 'offline_compute',
        commandId: PMQS_COMMAND_ID,
        source: {
          repository: this.profile.source.repository,
          commit: this.profile.source.commit,
          tree: this.profile.source.tree,
          digest: this.profile.source.digest
        },
        status: outcome.status,
        reason: outcome.reason,
        verdict: outcome.verdict,
        stdout: digestStream(processResult.stdout),
        stderr: digestStream(processResult.stderr),
        exitCode: outcome.exitCode,
        signal: processResult.signal
      };
    } finally {
      await rm(executionRoot, { recursive: true, force: true });
    }
  }
}
