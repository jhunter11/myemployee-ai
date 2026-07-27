import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { z } from 'zod';

import { minimalCliEnvironment } from './cli-runtime';

export const SubscriptionProviderSchema = z.enum(['claude', 'openai']);
export const SubscriptionProviderIdSchema = SubscriptionProviderSchema;
export type SubscriptionProviderId = z.infer<typeof SubscriptionProviderSchema>;

export const SubscriptionConnectionStateSchema = z.enum([
  'connected',
  'disconnected',
  'unavailable',
  'check_failed'
]);
export type SubscriptionConnectionState = z.infer<typeof SubscriptionConnectionStateSchema>;

export const SubscriptionRuntimeDetailSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((detail) => !detail.includes('\n') && !detail.includes('\r'));
export type SubscriptionRuntimeDetail = z.infer<typeof SubscriptionRuntimeDetailSchema>;

export const SubscriptionRuntimeStatusSchema = z
  .object({
    provider: SubscriptionProviderSchema,
    connectionState: SubscriptionConnectionStateSchema,
    loginAvailable: z.boolean(),
    loginInProgress: z.boolean(),
    detail: SubscriptionRuntimeDetailSchema
  })
  .strict();
export type SubscriptionRuntimeStatus = z.infer<typeof SubscriptionRuntimeStatusSchema>;

export const SubscriptionLoginOutcomeSchema = z.enum([
  'started',
  'already_in_progress',
  'unavailable'
]);
export type SubscriptionLoginOutcome = z.infer<typeof SubscriptionLoginOutcomeSchema>;

export const SubscriptionLoginResultSchema = z
  .object({
    provider: SubscriptionProviderSchema,
    outcome: SubscriptionLoginOutcomeSchema,
    detail: SubscriptionRuntimeDetailSchema
  })
  .strict();
export type SubscriptionLoginResult = z.infer<typeof SubscriptionLoginResultSchema>;

export interface StatusCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export interface StatusCommandInvocation {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type StatusCommandRunner = (
  command: string,
  args: readonly string[],
  invocation: StatusCommandInvocation
) => Promise<StatusCommandResult>;

export interface LoginLaunchInvocation {
  env: NodeJS.ProcessEnv;
}

/**
 * A deliberately tiny process handle. Callers can observe only that a login
 * attempt ended; they cannot read output, argv, credentials, or process ids.
 */
export interface LoginAttemptHandle {
  onExit(listener: () => void): void;
  terminate(): void;
  settled(): Promise<void>;
}

export type LoginLauncher = (
  command: string,
  args: readonly string[],
  invocation: LoginLaunchInvocation
) => Promise<LoginAttemptHandle>;

export type ExecutableProbe = (path: string) => Promise<boolean>;

export interface SubscriptionExecutableResolverDeps {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  isExecutable?: ExecutableProbe;
}

export interface SubscriptionRuntimeDeps extends SubscriptionExecutableResolverDeps {
  runStatus?: StatusCommandRunner;
  launchLogin?: LoginLauncher;
  now?: () => number;
}

export interface SubscriptionRuntimePort {
  status(provider: SubscriptionProviderId): Promise<SubscriptionRuntimeStatus>;
  snapshot(): Promise<SubscriptionRuntimeStatus[]>;
  startLogin(provider: SubscriptionProviderId): Promise<SubscriptionLoginResult>;
  stop?(): Promise<void>;
}

const STATUS_TIMEOUT_MS = 5_000;
const LOGIN_ATTEMPT_TTL_MS = 180_000;
const LOGIN_TERMINATE_GRACE_MS = 1_000;
const LOGIN_SHUTDOWN_DRAIN_MS = 5_000;
const MAX_STATUS_OUTPUT_BYTES = 16_384;
const OPENAI_CHATGPT_STATUS = 'Logged in using ChatGPT';
const SUBSCRIPTION_CLI_ENVIRONMENT_KEYS = ['USER'] as const;

const ClaudeStatusViewSchema = z
  .object({
    loggedIn: z.boolean(),
    authMethod: z.string().max(64).optional()
  })
  .strict();

interface LoginReservation {
  token: symbol;
  expiresAt: number;
  expirationTimer: NodeJS.Timeout;
  handle?: LoginAttemptHandle;
  terminating: boolean;
}

interface ProviderCommand {
  executableEnvKey: 'JARVIS_CLAUDE_CLI' | 'JARVIS_CODEX_CLI';
  statusArgs: readonly string[];
  loginArgs: readonly string[];
}

const PROVIDER_COMMANDS: Record<SubscriptionProviderId, ProviderCommand> = {
  claude: {
    executableEnvKey: 'JARVIS_CLAUDE_CLI',
    statusArgs: ['auth', 'status', '--json'],
    loginArgs: ['auth', 'login', '--claudeai']
  },
  openai: {
    executableEnvKey: 'JARVIS_CODEX_CLI',
    statusArgs: ['login', 'status'],
    loginArgs: ['login']
  }
};

const DETAILS: Record<
  SubscriptionProviderId,
  Record<
    SubscriptionConnectionState | 'login_started' | 'login_in_progress' | 'login_failed',
    SubscriptionRuntimeDetail
  >
> = {
  claude: {
    connected: 'Claude subscription connected.',
    disconnected: 'Claude subscription login required.',
    unavailable: 'Claude subscription login is unavailable on this host.',
    check_failed: 'Claude subscription status could not be verified.',
    login_started: 'Claude subscription login started.',
    login_in_progress: 'Claude subscription login is already in progress.',
    login_failed: 'Claude subscription login could not be started.'
  },
  openai: {
    connected: 'OpenAI subscription connected.',
    disconnected: 'OpenAI subscription login required.',
    unavailable: 'OpenAI subscription login is unavailable on this host.',
    check_failed: 'OpenAI subscription status could not be verified.',
    login_started: 'OpenAI subscription login started.',
    login_in_progress: 'OpenAI subscription login is already in progress.',
    login_failed: 'OpenAI subscription login could not be started.'
  }
};

function appendBounded(current: Buffer, chunk: Buffer): Buffer {
  if (current.byteLength >= MAX_STATUS_OUTPUT_BYTES) return current;
  const remaining = MAX_STATUS_OUTPUT_BYTES - current.byteLength;
  return Buffer.concat([current, chunk.subarray(0, remaining)]);
}

/**
 * Runs only a caller-supplied absolute executable and captures at most 16 KiB
 * from each output stream. The service never returns this raw output.
 */
export const defaultStatusCommandRunner: StatusCommandRunner = (command, args, invocation) =>
  new Promise<StatusCommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: invocation.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, invocation.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        code,
        timedOut
      });
    });
  });

/**
 * Starts the provider-owned browser login without a shell and with every stdio
 * stream ignored. No output or process identifier crosses this boundary.
 */
export const defaultLoginLauncher: LoginLauncher = (command, args, invocation) =>
  new Promise<LoginAttemptHandle>((resolve, reject) => {
    const child = spawn(command, [...args], {
      detached: true,
      env: invocation.env,
      shell: false,
      stdio: 'ignore'
    });
    const exitListeners = new Set<() => void>();
    let exited = false;
    let spawned = false;
    let terminationTimer: NodeJS.Timeout | undefined;
    let settle: (() => void) | undefined;
    const settled = new Promise<void>((resolveSettled) => {
      settle = resolveSettled;
    });

    const notifyExit = (): void => {
      if (exited) return;
      exited = true;
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      for (const listener of exitListeners) listener();
      exitListeners.clear();
      settle?.();
    };

    child.once('error', (error) => {
      notifyExit();
      if (!spawned) reject(error);
    });
    child.once('exit', notifyExit);
    child.once('spawn', () => {
      spawned = true;
      child.unref();
      resolve({
        onExit(listener) {
          if (exited) {
            queueMicrotask(listener);
            return;
          }
          exitListeners.add(listener);
        },
        terminate() {
          if (exited || terminationTimer !== undefined) return;
          child.kill('SIGTERM');
          terminationTimer = setTimeout(() => {
            if (!exited) child.kill('SIGKILL');
          }, LOGIN_TERMINATE_GRACE_MS);
          terminationTimer.unref();
        },
        settled() {
          return settled;
        }
      });
    });
  });

export const defaultExecutableProbe: ExecutableProbe = async (path) => {
  if (!isAbsolute(path) || path.includes('\0')) return false;
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

function validAbsoluteCandidate(value: string | undefined): value is string {
  return value !== undefined && isAbsolute(value) && !value.includes('\0');
}

function fixedExecutableCandidates(
  provider: SubscriptionProviderId,
  home: string
): readonly string[] {
  if (provider === 'claude') {
    return [
      join(home, '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude'
    ];
  }
  return [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex'
  ];
}

/**
 * Resolves a server-owned provider executable for runtime composition. The
 * provider id is strict, configured paths come only from trusted process
 * environment, and every candidate must be an absolute executable file.
 *
 * This helper is intentionally not part of the dashboard-facing port.
 */
export async function resolveSubscriptionExecutable(
  providerInput: SubscriptionProviderId,
  deps: SubscriptionExecutableResolverDeps = {}
): Promise<string | undefined> {
  const provider = SubscriptionProviderSchema.parse(providerInput);
  const environment = deps.env ?? process.env;
  const home = (deps.homedir ?? osHomedir)();
  const executableProbe = deps.isExecutable ?? defaultExecutableProbe;
  const command = PROVIDER_COMMANDS[provider];
  const configured = environment[command.executableEnvKey];
  const candidates = [
    ...(validAbsoluteCandidate(configured) ? [configured] : []),
    ...fixedExecutableCandidates(provider, home)
  ];

  for (const candidate of new Set(candidates)) {
    if (!validAbsoluteCandidate(candidate)) continue;
    try {
      if (await executableProbe(candidate)) return candidate;
    } catch {
      // A failed executable probe is equivalent to an unavailable candidate.
    }
  }
  return undefined;
}

function statusFromState(
  provider: SubscriptionProviderId,
  connectionState: SubscriptionConnectionState,
  loginAvailable: boolean,
  loginInProgress: boolean
): SubscriptionRuntimeStatus {
  return SubscriptionRuntimeStatusSchema.parse({
    provider,
    connectionState,
    loginAvailable,
    loginInProgress,
    detail: DETAILS[provider][connectionState]
  });
}

function subscriptionCliEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return minimalCliEnvironment(source, SUBSCRIPTION_CLI_ENVIRONMENT_KEYS);
}

function loginResult(
  provider: SubscriptionProviderId,
  outcome: SubscriptionLoginOutcome,
  detailOverride?: SubscriptionRuntimeDetail
): SubscriptionLoginResult {
  const detail =
    detailOverride ??
    (outcome === 'started'
      ? DETAILS[provider].login_started
      : outcome === 'already_in_progress'
        ? DETAILS[provider].login_in_progress
        : DETAILS[provider].unavailable);
  return SubscriptionLoginResultSchema.parse({ provider, outcome, detail });
}

/**
 * Verifies and brokers provider-subscription login without ever handling a
 * browser-supplied path or argument. Public provider id is the only input; all
 * commands and executable candidates remain server-owned constants.
 */
export class SubscriptionRuntimeService implements SubscriptionRuntimePort {
  private readonly env: NodeJS.ProcessEnv;
  private readonly homedir: () => string;
  private readonly isExecutable: ExecutableProbe;
  private readonly runStatus: StatusCommandRunner;
  private readonly launchLogin: LoginLauncher;
  private readonly now: () => number;
  private readonly loginReservations = new Map<SubscriptionProviderId, LoginReservation>();
  private stopped = false;
  private stopPromise: Promise<void> | undefined;

  constructor(deps: SubscriptionRuntimeDeps = {}) {
    this.env = deps.env ?? process.env;
    this.homedir = deps.homedir ?? osHomedir;
    this.isExecutable = deps.isExecutable ?? defaultExecutableProbe;
    this.runStatus = deps.runStatus ?? defaultStatusCommandRunner;
    this.launchLogin = deps.launchLogin ?? defaultLoginLauncher;
    this.now = deps.now ?? Date.now;
  }

  async status(providerInput: SubscriptionProviderId): Promise<SubscriptionRuntimeStatus> {
    const provider = SubscriptionProviderSchema.parse(providerInput);
    const loginInProgress = this.hasActiveLogin(provider);
    const executable = await this.resolveExecutable(provider);
    if (executable === undefined) {
      return statusFromState(provider, 'unavailable', false, loginInProgress);
    }

    let result: StatusCommandResult;
    try {
      result = await this.runStatus(executable, PROVIDER_COMMANDS[provider].statusArgs, {
        env: subscriptionCliEnvironment(this.env),
        timeoutMs: STATUS_TIMEOUT_MS
      });
    } catch {
      return statusFromState(provider, 'check_failed', true, loginInProgress);
    }
    if (result.timedOut || result.code !== 0) {
      return statusFromState(provider, 'check_failed', true, loginInProgress);
    }

    const connected =
      provider === 'claude'
        ? this.isClaudeSubscription(result.stdout)
        : this.isOpenAiSubscription(result.stdout, result.stderr);
    if (connected === undefined) {
      return statusFromState(provider, 'check_failed', true, loginInProgress);
    }
    return statusFromState(
      provider,
      connected ? 'connected' : 'disconnected',
      true,
      loginInProgress
    );
  }

  snapshot(): Promise<SubscriptionRuntimeStatus[]> {
    return Promise.all([this.status('claude'), this.status('openai')]);
  }

  async startLogin(providerInput: SubscriptionProviderId): Promise<SubscriptionLoginResult> {
    const provider = SubscriptionProviderSchema.parse(providerInput);
    if (this.stopped) {
      return loginResult(provider, 'unavailable', DETAILS[provider].login_failed);
    }
    if (this.hasActiveLogin(provider)) {
      return loginResult(provider, 'already_in_progress');
    }

    const token = Symbol(provider);
    const reservation: LoginReservation = {
      token,
      expiresAt: this.now() + LOGIN_ATTEMPT_TTL_MS,
      expirationTimer: setTimeout(() => {
        this.expireReservation(provider, token);
      }, LOGIN_ATTEMPT_TTL_MS),
      terminating: false
    };
    reservation.expirationTimer.unref();
    this.loginReservations.set(provider, reservation);

    const executable = await this.resolveExecutable(provider);
    if (executable === undefined) {
      this.releaseReservation(provider, reservation.token);
      return loginResult(provider, 'unavailable');
    }

    let handle: LoginAttemptHandle;
    try {
      handle = await this.launchLogin(executable, PROVIDER_COMMANDS[provider].loginArgs, {
        env: subscriptionCliEnvironment(this.env)
      });
    } catch {
      this.releaseReservation(provider, reservation.token);
      return loginResult(provider, 'unavailable', DETAILS[provider].login_failed);
    }

    const activeReservation = this.loginReservations.get(provider);
    if (activeReservation?.token !== reservation.token || this.stopped) {
      handle.terminate();
      await this.boundedHandleDrain(handle);
      return loginResult(provider, 'unavailable', DETAILS[provider].login_failed);
    }
    activeReservation.handle = handle;
    handle.onExit(() => {
      this.releaseReservation(provider, reservation.token);
    });
    if (activeReservation.terminating || this.now() >= activeReservation.expiresAt) {
      this.expireReservation(provider, reservation.token);
    }
    return loginResult(provider, 'started');
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = (async () => {
      const reservations = [...this.loginReservations.entries()];
      const drains: Promise<void>[] = [];
      for (const [provider, reservation] of reservations) {
        clearTimeout(reservation.expirationTimer);
        reservation.terminating = true;
        if (reservation.handle !== undefined) {
          reservation.handle.terminate();
          drains.push(this.boundedHandleDrain(reservation.handle));
        }
        this.releaseReservation(provider, reservation.token);
      }
      await Promise.all(drains);
    })();
    return this.stopPromise;
  }

  private hasActiveLogin(provider: SubscriptionProviderId): boolean {
    const reservation = this.loginReservations.get(provider);
    if (reservation === undefined) return false;
    if (this.now() >= reservation.expiresAt) {
      this.expireReservation(provider, reservation.token);
    }
    return true;
  }

  private expireReservation(provider: SubscriptionProviderId, token: symbol): void {
    const reservation = this.loginReservations.get(provider);
    if (reservation?.token !== token || reservation.terminating) return;
    reservation.terminating = true;
    reservation.handle?.terminate();
  }

  private releaseReservation(provider: SubscriptionProviderId, token: symbol): void {
    const reservation = this.loginReservations.get(provider);
    if (reservation?.token === token) {
      clearTimeout(reservation.expirationTimer);
      this.loginReservations.delete(provider);
    }
  }

  private async boundedHandleDrain(handle: LoginAttemptHandle): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        handle.settled(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, LOGIN_SHUTDOWN_DRAIN_MS);
        })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async resolveExecutable(provider: SubscriptionProviderId): Promise<string | undefined> {
    return resolveSubscriptionExecutable(provider, {
      env: this.env,
      homedir: this.homedir,
      isExecutable: this.isExecutable
    });
  }

  /**
   * Returns undefined only when the output cannot be safely interpreted.
   * Any well-formed non-subscription state is a clean disconnected result.
   */
  private isClaudeSubscription(stdout: string): boolean | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(stdout) as unknown;
    } catch {
      return undefined;
    }
    if (typeof raw !== 'object' || raw === null) return undefined;
    const record = raw as Record<string, unknown>;
    const parsed = ClaudeStatusViewSchema.safeParse({
      loggedIn: record.loggedIn,
      ...(record.authMethod === undefined ? {} : { authMethod: record.authMethod })
    });
    if (!parsed.success) return undefined;
    return parsed.data.loggedIn && parsed.data.authMethod === 'claude.ai';
  }

  private isOpenAiSubscription(stdout: string, stderr: string): boolean {
    const outputs = [stdout.trim(), stderr.trim()].filter((value) => value.length > 0);
    return outputs.length === 1 && outputs[0] === OPENAI_CHATGPT_STATUS;
  }
}
