import { describe, expect, it, vi } from 'vitest';

import {
  defaultExecutableProbe,
  defaultLoginLauncher,
  defaultStatusCommandRunner,
  resolveSubscriptionExecutable,
  SubscriptionLoginResultSchema,
  SubscriptionProviderSchema,
  SubscriptionRuntimeService,
  SubscriptionRuntimeStatusSchema,
  type LoginAttemptHandle,
  type LoginLauncher,
  type StatusCommandRunner,
  type SubscriptionRuntimeDeps
} from '../../src/models/subscription-runtime';

const SECRET = 'secret-value-that-must-never-leak';
const CLAUDE_PATH = '/Users/operator/.local/bin/claude';
const CODEX_PATH = '/Applications/ChatGPT.app/Contents/Resources/codex';

interface FakeLoginHandle extends LoginAttemptHandle {
  exit(): void;
  readonly terminateCalls: number;
}

function loginHandle(): FakeLoginHandle {
  let exitListener: (() => void) | undefined;
  let terminateCalls = 0;
  let settle: (() => void) | undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    onExit(listener) {
      exitListener = listener;
    },
    terminate() {
      terminateCalls += 1;
    },
    settled() {
      return settled;
    },
    exit() {
      exitListener?.();
      settle?.();
    },
    get terminateCalls() {
      return terminateCalls;
    }
  };
}

function deps(
  overrides: Partial<SubscriptionRuntimeDeps> = {}
): Required<
  Pick<
    SubscriptionRuntimeDeps,
    'env' | 'homedir' | 'isExecutable' | 'runStatus' | 'launchLogin' | 'now'
  >
> {
  return {
    env: {
      HOME: '/Users/operator',
      USER: 'operator',
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://127.0.0.1:8080',
      ANTHROPIC_API_KEY: SECRET,
      OPENAI_API_KEY: SECRET,
      DATABASE_URL: SECRET
    },
    homedir: () => '/Users/operator',
    isExecutable: (path) => Promise.resolve(path === CLAUDE_PATH || path === CODEX_PATH),
    runStatus: () => Promise.resolve({ stdout: '', stderr: '', code: 0, timedOut: false }),
    launchLogin: () => Promise.resolve(loginHandle()),
    now: () => Date.parse('2026-07-23T18:00:00.000Z'),
    ...overrides
  };
}

describe('subscription runtime schemas', () => {
  it('accepts only the two public subscription provider ids', () => {
    expect(SubscriptionProviderSchema.parse('claude')).toBe('claude');
    expect(SubscriptionProviderSchema.parse('openai')).toBe('openai');
    expect(() => SubscriptionProviderSchema.parse('codex')).toThrow();
    expect(() => SubscriptionProviderSchema.parse('gemini')).toThrow();
  });

  it('rejects extra or unbounded public status and login-result fields', () => {
    expect(() =>
      SubscriptionRuntimeStatusSchema.parse({
        provider: 'claude',
        connectionState: 'connected',
        loginAvailable: true,
        loginInProgress: false,
        detail: 'Claude subscription connected.',
        rawOutput: SECRET
      })
    ).toThrow();

    expect(() =>
      SubscriptionLoginResultSchema.parse({
        provider: 'openai',
        outcome: 'started',
        detail: 'OpenAI subscription login started.',
        executable: CODEX_PATH
      })
    ).toThrow();
  });
});

describe('default subscription process boundaries', () => {
  it('runs a bounded status command and never supplies stdin', async () => {
    const result = await defaultStatusCommandRunner(
      process.execPath,
      [
        '-e',
        'process.stdout.write("x".repeat(16384)); setTimeout(() => { process.stdout.write("overflow"); process.stderr.write("bounded-error"); }, 10)'
      ],
      { env: { PATH: process.env.PATH }, timeoutMs: 5_000 }
    );

    expect(result).toMatchObject({ code: 0, timedOut: false, stderr: 'bounded-error' });
    expect(Buffer.byteLength(result.stdout)).toBe(16_384);
  });

  it('kills a status command that exceeds its short timeout', async () => {
    const result = await defaultStatusCommandRunner(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60000)'],
      { env: { PATH: process.env.PATH }, timeoutMs: 50 }
    );

    expect(result.timedOut).toBe(true);
  });

  it('rejects an unlaunchable status command', async () => {
    await expect(
      defaultStatusCommandRunner('/definitely/not/a/status-binary', [], {
        env: {},
        timeoutMs: 50
      })
    ).rejects.toBeInstanceOf(Error);
  });

  it('launches with ignored stdio and reports only process exit', async () => {
    const handle = await defaultLoginLauncher(
      process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 20)'],
      { env: { PATH: process.env.PATH } }
    );

    await expect(
      new Promise<void>((resolve) => {
        handle.onExit(resolve);
      })
    ).resolves.toBeUndefined();
  });

  it('terminates and settles a bounded long-running login process', async () => {
    const handle = await defaultLoginLauncher(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60000)'],
      { env: { PATH: process.env.PATH } }
    );

    handle.terminate();

    await expect(handle.settled()).resolves.toBeUndefined();
  });

  it('notifies a listener registered after the detached login process exited', async () => {
    const handle = await defaultLoginLauncher(process.execPath, ['-e', 'process.exit(0)'], {
      env: { PATH: process.env.PATH }
    });
    await new Promise<void>((resolve) => {
      handle.onExit(resolve);
    });

    await expect(
      new Promise<void>((resolve) => {
        handle.onExit(resolve);
      })
    ).resolves.toBeUndefined();
  });

  it('rejects an unlaunchable login command', async () => {
    await expect(
      defaultLoginLauncher('/definitely/not/a/login-binary', [], { env: {} })
    ).rejects.toBeInstanceOf(Error);
  });

  it('validates that a discovered executable is absolute, executable, and a file', async () => {
    await expect(defaultExecutableProbe(process.execPath)).resolves.toBe(true);
    await expect(defaultExecutableProbe('./relative-command')).resolves.toBe(false);
    await expect(defaultExecutableProbe('/tmp')).resolves.toBe(false);
    await expect(defaultExecutableProbe('/definitely/not/an/executable')).resolves.toBe(false);
    await expect(defaultExecutableProbe('/tmp/invalid\0path')).resolves.toBe(false);
  });
});

describe('resolveSubscriptionExecutable', () => {
  it('uses only trusted absolute candidates and skips failed probes', async () => {
    const probes: string[] = [];
    await expect(
      resolveSubscriptionExecutable('claude', {
        env: { JARVIS_CLAUDE_CLI: '/configured/claude' },
        homedir: () => '/Users/operator',
        isExecutable: (path) => {
          probes.push(path);
          if (path === '/configured/claude') {
            return Promise.reject(new Error(`probe failure: ${SECRET}`));
          }
          return Promise.resolve(path === CLAUDE_PATH);
        }
      })
    ).resolves.toBe(CLAUDE_PATH);
    expect(probes).toEqual(['/configured/claude', CLAUDE_PATH]);
  });

  it('rejects invalid provider ids before probing any path', async () => {
    const isExecutable = vi.fn(() => Promise.resolve(true));

    await expect(
      resolveSubscriptionExecutable('codex' as unknown as 'openai', { isExecutable })
    ).rejects.toThrow();
    expect(isExecutable).not.toHaveBeenCalled();
  });

  it('skips a relative candidate derived from an invalid home directory', async () => {
    const probed: string[] = [];

    await expect(
      resolveSubscriptionExecutable('claude', {
        env: {},
        homedir: () => 'relative-home',
        isExecutable: (path) => {
          probed.push(path);
          return Promise.resolve(false);
        }
      })
    ).resolves.toBeUndefined();
    expect(probed).not.toContain('relative-home/.local/bin/claude');
  });
});

describe('SubscriptionRuntimeService status verification', () => {
  it('uses the fixed Claude subscription status command with a minimal environment', async () => {
    const runStatus = vi.fn<StatusCommandRunner>(() =>
      Promise.resolve({
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          email: `operator-${SECRET}@example.test`,
          orgId: SECRET,
          subscriptionType: 'max'
        }),
        stderr: '',
        code: 0,
        timedOut: false
      })
    );
    const service = new SubscriptionRuntimeService(deps({ runStatus }));

    const status = await service.status('claude');

    expect(status).toEqual({
      provider: 'claude',
      connectionState: 'connected',
      loginAvailable: true,
      loginInProgress: false,
      detail: 'Claude subscription connected.'
    });
    expect(runStatus).toHaveBeenCalledWith(CLAUDE_PATH, ['auth', 'status', '--json'], {
      env: {
        HOME: '/Users/operator',
        USER: 'operator',
        PATH: '/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
        HTTPS_PROXY: 'http://127.0.0.1:8080'
      },
      timeoutMs: 5_000
    });
    expect(JSON.stringify(status)).not.toContain(SECRET);
  });

  it.each([
    [{ loggedIn: true, authMethod: 'apiKey' }, 'API-key auth is not a subscription'],
    [{ loggedIn: true, authMethod: 'console' }, 'other Claude auth is not a subscription'],
    [{ loggedIn: false, authMethod: 'claude.ai' }, 'logged-out Claude is disconnected'],
    [{ loggedIn: false }, 'logged-out Claude without an auth method is disconnected']
  ])('does not accept %s as a Claude subscription (%s)', async (payload, description) => {
    const service = new SubscriptionRuntimeService(
      deps({
        runStatus: () =>
          Promise.resolve({
            stdout: JSON.stringify(payload),
            stderr: '',
            code: 0,
            timedOut: false
          })
      })
    );

    expect(description.length).toBeGreaterThan(0);
    await expect(service.status('claude')).resolves.toMatchObject({
      provider: 'claude',
      connectionState: 'disconnected',
      loginAvailable: true,
      detail: 'Claude subscription login required.'
    });
  });

  it('accepts only an exact ChatGPT login as an OpenAI subscription', async () => {
    const runner = vi
      .fn<StatusCommandRunner>()
      .mockResolvedValueOnce({
        stdout: 'Logged in using ChatGPT\n',
        stderr: '',
        code: 0,
        timedOut: false
      })
      .mockResolvedValueOnce({
        stdout: 'Logged in using an API key\n',
        stderr: '',
        code: 0,
        timedOut: false
      })
      .mockResolvedValueOnce({
        stdout: 'Logged in using ChatGPT\n',
        stderr: 'warning: unexpected output',
        code: 0,
        timedOut: false
      });
    const service = new SubscriptionRuntimeService(deps({ runStatus: runner }));

    await expect(service.status('openai')).resolves.toEqual({
      provider: 'openai',
      connectionState: 'connected',
      loginAvailable: true,
      loginInProgress: false,
      detail: 'OpenAI subscription connected.'
    });
    await expect(service.status('openai')).resolves.toMatchObject({
      connectionState: 'disconnected',
      detail: 'OpenAI subscription login required.'
    });
    await expect(service.status('openai')).resolves.toMatchObject({
      connectionState: 'disconnected'
    });
    expect(runner).toHaveBeenCalledWith(CODEX_PATH, ['login', 'status'], {
      env: {
        HOME: '/Users/operator',
        USER: 'operator',
        PATH: '/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
        HTTPS_PROXY: 'http://127.0.0.1:8080'
      },
      timeoutMs: 5_000
    });
  });

  it('accepts the exact OpenAI subscription message from stderr when stdout is empty', async () => {
    const service = new SubscriptionRuntimeService(
      deps({
        runStatus: () =>
          Promise.resolve({
            stdout: '',
            stderr: 'Logged in using ChatGPT\n',
            code: 0,
            timedOut: false
          })
      })
    );

    await expect(service.status('openai')).resolves.toMatchObject({
      connectionState: 'connected'
    });
  });

  it.each([
    [{ stdout: '{not-json', stderr: '', code: 0, timedOut: false }, 'malformed output'],
    [{ stdout: '', stderr: SECRET, code: 1, timedOut: false }, 'nonzero exit'],
    [{ stdout: SECRET, stderr: '', code: null, timedOut: true }, 'timeout']
  ])('fails closed and redacts status command %s (%s)', async (result, description) => {
    const service = new SubscriptionRuntimeService(
      deps({ runStatus: () => Promise.resolve(result) })
    );

    const status = await service.status('claude');

    expect(description.length).toBeGreaterThan(0);
    expect(status).toMatchObject({
      connectionState: 'check_failed',
      detail: 'Claude subscription status could not be verified.'
    });
    expect(JSON.stringify(status)).not.toContain(SECRET);
  });

  it('fails closed and redacts a thrown status-runner error', async () => {
    const service = new SubscriptionRuntimeService(
      deps({
        runStatus: () => Promise.reject(new Error(`command failed: ${SECRET}`))
      })
    );

    const status = await service.status('openai');

    expect(status).toMatchObject({
      connectionState: 'check_failed',
      detail: 'OpenAI subscription status could not be verified.'
    });
    expect(JSON.stringify(status)).not.toContain(SECRET);
  });

  it('fails closed for well-formed but structurally invalid Claude output', async () => {
    const service = new SubscriptionRuntimeService(
      deps({
        runStatus: () =>
          Promise.resolve({
            stdout: JSON.stringify({ loggedIn: SECRET, authMethod: 'claude.ai' }),
            stderr: '',
            code: 0,
            timedOut: false
          })
      })
    );

    await expect(service.status('claude')).resolves.toMatchObject({
      connectionState: 'check_failed'
    });
  });

  it('fails closed for a null Claude status document', async () => {
    const service = new SubscriptionRuntimeService(
      deps({
        runStatus: () =>
          Promise.resolve({
            stdout: 'null',
            stderr: '',
            code: 0,
            timedOut: false
          })
      })
    );

    await expect(service.status('claude')).resolves.toMatchObject({
      connectionState: 'check_failed'
    });
  });

  it('treats an empty successful OpenAI status as disconnected, not connected', async () => {
    const service = new SubscriptionRuntimeService(deps());

    await expect(service.status('openai')).resolves.toMatchObject({
      connectionState: 'disconnected'
    });
  });

  it('ignores a relative trusted-env path and uses the first validated fixed executable', async () => {
    const probed: string[] = [];
    const service = new SubscriptionRuntimeService(
      deps({
        env: {
          JARVIS_CLAUDE_CLI: './browser-supplied-claude',
          HOME: '/Users/operator'
        },
        isExecutable: (path) => {
          probed.push(path);
          return Promise.resolve(path === CLAUDE_PATH);
        },
        runStatus: () =>
          Promise.resolve({
            stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
            stderr: '',
            code: 0,
            timedOut: false
          })
      })
    );

    await expect(service.status('claude')).resolves.toMatchObject({
      connectionState: 'connected'
    });
    expect(probed).not.toContain('./browser-supplied-claude');
    expect(probed[0]).toBe(CLAUDE_PATH);
  });

  it('prefers a validated absolute trusted-env executable', async () => {
    const configuredPath = '/opt/jarvis/bin/claude';
    const runStatus = vi.fn<StatusCommandRunner>(() =>
      Promise.resolve({
        stdout: JSON.stringify({ loggedIn: false, authMethod: 'claude.ai' }),
        stderr: '',
        code: 0,
        timedOut: false
      })
    );
    const service = new SubscriptionRuntimeService(
      deps({
        env: { HOME: '/Users/operator', JARVIS_CLAUDE_CLI: configuredPath },
        isExecutable: (path) => Promise.resolve(path === configuredPath),
        runStatus
      })
    );

    await service.status('claude');

    expect(runStatus).toHaveBeenCalledWith(configuredPath, ['auth', 'status', '--json'], {
      env: { HOME: '/Users/operator' },
      timeoutMs: 5_000
    });
  });

  it('reports unavailable without running a command when no trusted executable validates', async () => {
    const runStatus = vi.fn<StatusCommandRunner>();
    const service = new SubscriptionRuntimeService(
      deps({ isExecutable: () => Promise.resolve(false), runStatus })
    );

    const statuses = await service.snapshot();

    expect(statuses).toEqual([
      {
        provider: 'claude',
        connectionState: 'unavailable',
        loginAvailable: false,
        loginInProgress: false,
        detail: 'Claude subscription login is unavailable on this host.'
      },
      {
        provider: 'openai',
        connectionState: 'unavailable',
        loginAvailable: false,
        loginInProgress: false,
        detail: 'OpenAI subscription login is unavailable on this host.'
      }
    ]);
    expect(runStatus).not.toHaveBeenCalled();
  });
});

describe('SubscriptionRuntimeService login broker', () => {
  it.each([
    ['claude' as const, CLAUDE_PATH, ['auth', 'login', '--claudeai']],
    ['openai' as const, CODEX_PATH, ['login']]
  ])('launches only the fixed %s login command', async (provider, command, args) => {
    const handle = loginHandle();
    const launchLogin = vi.fn<LoginLauncher>(() => Promise.resolve(handle));
    const service = new SubscriptionRuntimeService(deps({ launchLogin }));

    const result = await service.startLogin(provider);

    expect(result).toEqual({
      provider,
      outcome: 'started',
      detail:
        provider === 'claude'
          ? 'Claude subscription login started.'
          : 'OpenAI subscription login started.'
    });
    expect(launchLogin).toHaveBeenCalledWith(command, args, {
      env: {
        HOME: '/Users/operator',
        USER: 'operator',
        PATH: '/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
        HTTPS_PROXY: 'http://127.0.0.1:8080'
      }
    });
    await expect(service.status(provider)).resolves.toMatchObject({
      loginInProgress: true
    });
  });

  it('allows only one concurrent login attempt per provider', async () => {
    let release: ((handle: LoginAttemptHandle) => void) | undefined;
    const launchLogin = vi.fn<LoginLauncher>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const service = new SubscriptionRuntimeService(deps({ launchLogin }));

    const first = service.startLogin('claude');
    await vi.waitFor(() => {
      expect(launchLogin).toHaveBeenCalledTimes(1);
    });
    const second = await service.startLogin('claude');

    expect(second).toEqual({
      provider: 'claude',
      outcome: 'already_in_progress',
      detail: 'Claude subscription login is already in progress.'
    });
    release?.(loginHandle());
    await expect(first).resolves.toMatchObject({ outcome: 'started' });
  });

  it('clears the active attempt on process exit and permits another login', async () => {
    const firstHandle = loginHandle();
    const launchLogin = vi
      .fn<LoginLauncher>()
      .mockResolvedValueOnce(firstHandle)
      .mockResolvedValueOnce(loginHandle());
    const service = new SubscriptionRuntimeService(deps({ launchLogin }));

    await service.startLogin('openai');
    firstHandle.exit();
    await service.startLogin('openai');

    expect(launchLogin).toHaveBeenCalledTimes(2);
  });

  it('terminates an expired attempt and never overlaps a replacement process', async () => {
    vi.useFakeTimers();
    try {
      const firstHandle = loginHandle();
      const launchLogin = vi
        .fn<LoginLauncher>()
        .mockResolvedValueOnce(firstHandle)
        .mockResolvedValueOnce(loginHandle());
      const service = new SubscriptionRuntimeService(deps({ launchLogin, now: () => Date.now() }));

      await service.startLogin('claude');
      await vi.advanceTimersByTimeAsync(180_001);

      expect(firstHandle.terminateCalls).toBe(1);
      await expect(service.startLogin('claude')).resolves.toMatchObject({
        outcome: 'already_in_progress'
      });
      expect(launchLogin).toHaveBeenCalledTimes(1);

      firstHandle.exit();
      await service.startLogin('claude');
      expect(launchLogin).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates and drains every active login during runtime shutdown', async () => {
    const claudeHandle = loginHandle();
    const openAiHandle = loginHandle();
    const launchLogin = vi
      .fn<LoginLauncher>()
      .mockResolvedValueOnce(claudeHandle)
      .mockResolvedValueOnce(openAiHandle);
    const service = new SubscriptionRuntimeService(deps({ launchLogin }));

    await service.startLogin('claude');
    await service.startLogin('openai');
    const stopped = service.stop();

    expect(claudeHandle.terminateCalls).toBe(1);
    expect(openAiHandle.terminateCalls).toBe(1);
    claudeHandle.exit();
    openAiHandle.exit();
    await expect(stopped).resolves.toBeUndefined();
    await expect(service.startLogin('claude')).resolves.toMatchObject({
      outcome: 'unavailable'
    });
  });

  it('does not launch when no executable is available', async () => {
    const launchLogin = vi.fn<LoginLauncher>();
    const service = new SubscriptionRuntimeService(
      deps({ isExecutable: () => Promise.resolve(false), launchLogin })
    );

    await expect(service.startLogin('openai')).resolves.toEqual({
      provider: 'openai',
      outcome: 'unavailable',
      detail: 'OpenAI subscription login is unavailable on this host.'
    });
    expect(launchLogin).not.toHaveBeenCalled();
  });

  it('redacts launcher errors and releases the provider reservation', async () => {
    const launchLogin = vi
      .fn<LoginLauncher>()
      .mockRejectedValueOnce(new Error(`spawn failed: ${SECRET}`))
      .mockResolvedValueOnce(loginHandle());
    const service = new SubscriptionRuntimeService(deps({ launchLogin }));

    const failed = await service.startLogin('claude');
    const retry = await service.startLogin('claude');

    expect(failed).toEqual({
      provider: 'claude',
      outcome: 'unavailable',
      detail: 'Claude subscription login could not be started.'
    });
    expect(JSON.stringify(failed)).not.toContain(SECRET);
    expect(retry.outcome).toBe('started');
    expect(launchLogin).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid browser-supplied provider before process discovery', async () => {
    const isExecutable = vi.fn(() => Promise.resolve(true));
    const launchLogin = vi.fn<LoginLauncher>();
    const service = new SubscriptionRuntimeService(deps({ isExecutable, launchLogin }));

    await expect(service.startLogin('codex' as unknown as 'claude')).rejects.toThrow();
    expect(isExecutable).not.toHaveBeenCalled();
    expect(launchLogin).not.toHaveBeenCalled();
  });
});
