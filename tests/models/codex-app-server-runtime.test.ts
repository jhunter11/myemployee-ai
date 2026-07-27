import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type CodexAppServerChildProcess,
  type CodexAppServerMessage,
  type CodexAppServerRequest,
  type CodexAppServerSpawn,
  createCodexAppServerRunner,
  resolveDefaultCodexCommand
} from '../../src/models/codex-app-server-runtime';

const temporarySources: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporarySources.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

async function createSourceAuthFile(contents = '{"tokens":{"access_token":"private-token"}}') {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-codex-source-auth-test-'));
  temporarySources.push(root);
  const directory = join(root, '.codex');
  const path = join(directory, 'auth.json');
  await mkdir(directory, { mode: 0o700 });
  await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 });
  return { path, contents };
}

class ScriptedCodexProcess extends EventEmitter implements CodexAppServerChildProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly received: CodexAppServerMessage[] = [];
  killed = false;
  private closed = false;
  private inputBuffer = '';

  constructor(
    private readonly script: (message: CodexAppServerMessage, child: ScriptedCodexProcess) => void
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, done) => {
        this.inputBuffer += chunk.toString();
        const lines = this.inputBuffer.split('\n');
        this.inputBuffer = lines.pop() ?? '';
        try {
          for (const line of lines) {
            if (line.length === 0) continue;
            const message = JSON.parse(line) as CodexAppServerMessage;
            this.received.push(message);
            this.script(message, this);
          }
          done();
        } catch (error) {
          done(error as Error);
        }
      },
      final: (done) => {
        done();
        queueMicrotask(() => this.close(0, null));
      }
    });
  }

  respond(message: unknown): void {
    // A killed or exited app-server emits nothing further.
    if (this.closed) return;
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  writeRawStdout(value: string): void {
    this.stdout.write(value);
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('close', code, signal));
  }

  kill(signal: NodeJS.Signals = 'SIGKILL'): boolean {
    this.killed = true;
    this.close(null, signal);
    return true;
  }
}

/** A child that reports the signal was not delivered. */
class UnkillableCodexProcess extends ScriptedCodexProcess {
  override kill(): boolean {
    this.killed = true;
    return false;
  }
}

/** A child whose signal delivery itself throws. */
class UnsignallableCodexProcess extends ScriptedCodexProcess {
  override kill(): boolean {
    this.killed = true;
    throw new Error('private kill failure');
  }
}

interface SpawnCapture {
  command: string;
  args: readonly string[];
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: readonly ['pipe', 'pipe', 'pipe'];
  };
  child: ScriptedCodexProcess;
}

function scriptedSpawn(
  script: (message: CodexAppServerMessage, child: ScriptedCodexProcess) => void,
  capture?: (capture: SpawnCapture) => void
): CodexAppServerSpawn {
  return (command, args, options) => {
    const child = new ScriptedCodexProcess(script);
    capture?.({ command, args, options, child });
    return child;
  };
}

const agentItem = {
  id: 'agent-1',
  type: 'agentMessage',
  phase: 'final_answer',
  text: 'All systems nominal.'
};
const userItem = {
  id: 'user-1',
  type: 'userMessage',
  content: [{ type: 'text', text: 'status?' }]
};
const reasoningItem = {
  id: 'reasoning-1',
  type: 'reasoning',
  summary: [],
  content: []
};

function respondWithSuccessfulTurn(
  message: CodexAppServerMessage,
  child: ScriptedCodexProcess
): void {
  if (message.method === 'initialize') {
    child.respond({
      id: message.id,
      result: {
        codexHome: '/isolated/codex',
        platformFamily: 'unix',
        platformOs: 'macos',
        userAgent: 'codex-test'
      }
    });
    return;
  }
  if (message.method === 'thread/start') {
    child.respond({
      method: 'thread/started',
      params: { thread: { id: 'thread-1' } }
    });
    child.respond({
      id: message.id,
      result: {
        thread: { id: 'thread-1' },
        instructionSources: [],
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        cwd: '/isolated/work',
        model: 'gpt-5.6-sol',
        modelProvider: 'openai',
        sandbox: { type: 'readOnly', networkAccess: false },
        runtimeWorkspaceRoots: []
      }
    });
    return;
  }
  if (message.method === 'thread/inject_items') {
    child.respond({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'turn/start') {
    child.respond({
      id: message.id,
      result: { turn: { id: 'turn-1', items: [], status: 'inProgress' } }
    });
    child.respond({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', items: [], status: 'inProgress' } }
    });
    child.respond({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 1,
        item: userItem
      }
    });
    child.respond({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 2,
        item: userItem
      }
    });
    child.respond({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 3,
        item: reasoningItem
      }
    });
    child.respond({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 4,
        item: reasoningItem
      }
    });
    child.respond({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 5,
        item: agentItem
      }
    });
    child.respond({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'agent-1',
        delta: 'All systems nominal.'
      }
    });
    child.respond({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 6,
        item: agentItem
      }
    });
    child.respond({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          last: {
            inputTokens: 1200,
            cachedInputTokens: 400,
            cacheWriteInputTokens: 32,
            outputTokens: 8,
            reasoningOutputTokens: 2,
            totalTokens: 1208
          },
          total: {
            inputTokens: 1200,
            cachedInputTokens: 400,
            cacheWriteInputTokens: 32,
            outputTokens: 8,
            reasoningOutputTokens: 2,
            totalTokens: 1208
          }
        }
      }
    });
    child.respond({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: [userItem, reasoningItem, agentItem]
        }
      }
    });
  }
}

/**
 * Drives the handshake through an accepted `turn/start` and then hands the
 * running turn to the test, so each case scripts only the behavior it asserts.
 */
function scriptTurn(
  onTurnRunning: (child: ScriptedCodexProcess) => void
): (message: CodexAppServerMessage, child: ScriptedCodexProcess) => void {
  return (message, child) => {
    if (message.method === 'initialize') {
      child.respond({
        id: message.id,
        result: {
          codexHome: '/isolated/codex',
          platformFamily: 'unix',
          platformOs: 'macos',
          userAgent: 'codex-test'
        }
      });
      return;
    }
    if (message.method === 'thread/start') {
      child.respond({
        id: message.id,
        result: {
          thread: { id: 'thread-1' },
          instructionSources: [],
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          cwd: '/isolated/work',
          model: 'gpt-5.6-sol',
          modelProvider: 'openai',
          sandbox: { type: 'readOnly', networkAccess: false }
        }
      });
      return;
    }
    if (message.method === 'thread/inject_items') {
      child.respond({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'turn/start') {
      child.respond({
        id: message.id,
        result: { turn: { id: 'turn-1', items: [], status: 'inProgress' } }
      });
      onTurnRunning(child);
    }
  };
}

function completeTurnWith(child: ScriptedCodexProcess, items: readonly unknown[]): void {
  for (const item of items) {
    child.respond({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 1, item }
    });
  }
  child.respond({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items } }
  });
}

function runtimeRequest(sourceAuthPath: string): CodexAppServerRequest {
  return {
    command: '/Applications/ChatGPT.app/Contents/Resources/codex',
    sourceAuthPath,
    sourceEnv: {
      HOME: '/Users/operator',
      PATH: '/usr/bin:/bin',
      TMPDIR: '/tmp/operator',
      LANG: 'en_US.UTF-8',
      OPENAI_API_KEY: 'metered-api-key',
      DATABASE_URL: 'private-database',
      CODEX_HOME: '/Users/operator/.codex'
    },
    model: 'gpt-5.6-sol',
    system: 'You are Jarvis.',
    messages: [
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'status?' }
    ],
    maxOutputTokens: 256,
    timeoutMs: 5_000
  };
}

describe('Codex app-server runtime', () => {
  it('uses isolated credentials, an allowlisted environment, fixed deny config, and JSONL stdio', async () => {
    const source = await createSourceAuthFile();
    let capture: SpawnCapture | undefined;
    let copiedAuth: string | undefined;
    let runtimeRoot: string | undefined;
    let homeMode: number | undefined;
    let codexHomeMode: number | undefined;
    let authMode: number | undefined;
    let workMode: number | undefined;

    const runner = createCodexAppServerRunner({
      spawnImpl: scriptedSpawn(respondWithSuccessfulTurn, (spawnCapture) => {
        capture = spawnCapture;
        const home = spawnCapture.options.env.HOME as string;
        const codexHome = spawnCapture.options.env.CODEX_HOME as string;
        const authPath = join(codexHome, 'auth.json');
        runtimeRoot = dirname(home);
        copiedAuth = readFileSync(authPath, 'utf8');
        homeMode = statSync(home).mode & 0o777;
        codexHomeMode = statSync(codexHome).mode & 0o777;
        authMode = statSync(authPath).mode & 0o777;
        workMode = statSync(spawnCapture.options.cwd).mode & 0o777;
      })
    });

    const result = await runner(runtimeRequest(source.path));

    expect(result).toEqual({
      text: 'All systems nominal.',
      tokensIn: 1200,
      tokensOut: 8,
      cacheReadTokens: 400,
      cacheWriteTokens: 32
    });
    expect(copiedAuth).toBe(source.contents);
    if (process.platform !== 'win32') {
      expect(homeMode).toBe(0o700);
      expect(codexHomeMode).toBe(0o700);
      expect(workMode).toBe(0o700);
      expect(authMode).toBe(0o600);
    }
    expect(capture?.command).toBe('/Applications/ChatGPT.app/Contents/Resources/codex');
    expect(capture?.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(Object.keys(capture?.options.env ?? {}).sort()).toEqual([
      'CODEX_HOME',
      'HOME',
      'LANG',
      'PATH',
      'TMPDIR'
    ]);
    expect(capture?.options.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(capture?.options.env).not.toHaveProperty('DATABASE_URL');
    expect(capture?.args).toContain('app-server');
    expect(capture?.args).toContain('--stdio');
    expect(capture?.args).toContain('--strict-config');
    for (const feature of [
      'shell_tool',
      'unified_exec',
      'multi_agent',
      'apps',
      'plugins',
      'hooks',
      'image_generation',
      'browser_use',
      'computer_use',
      'tool_suggest',
      'workspace_dependencies'
    ]) {
      const index = capture?.args.findIndex(
        (value, valueIndex) => value === '--disable' && capture?.args[valueIndex + 1] === feature
      );
      expect(index, `expected ${feature} to be disabled`).toBeGreaterThanOrEqual(0);
    }
    for (const override of [
      'web_search="disabled"',
      'tools.experimental_request_user_input.enabled=false',
      'skills.include_instructions=false',
      'skills.bundled.enabled=false',
      'project_doc_max_bytes=0',
      'project_doc_fallback_filenames=[]',
      'mcp_servers={}'
    ]) {
      expect(capture?.args).toContain(override);
    }
    expect(capture?.args.join(' ')).not.toContain(source.contents);
    expect(capture?.args.join(' ')).not.toContain('You are Jarvis.');
    expect(capture?.args.join(' ')).not.toContain('status?');

    const initialize = capture?.child.received.find((message) => message.method === 'initialize');
    expect(initialize).toMatchObject({
      id: 1,
      params: {
        clientInfo: { name: 'jarvis', title: 'Jarvis', version: '0.1.0' },
        capabilities: { experimentalApi: true }
      }
    });
    expect(
      capture?.child.received.find((message) => message.method === 'initialized')
    ).toMatchObject({ params: {} });

    const threadStart = capture?.child.received.find(
      (message) => message.method === 'thread/start'
    );
    expect(threadStart?.params).toMatchObject({
      model: 'gpt-5.6-sol',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      baseInstructions: 'You are Jarvis.',
      personality: 'none',
      ephemeral: true,
      environments: [],
      runtimeWorkspaceRoots: [],
      dynamicTools: [],
      selectedCapabilityRoots: []
    });
    expect(threadStart?.params).toHaveProperty('cwd', capture?.options.cwd);

    const injected = capture?.child.received.find(
      (message) => message.method === 'thread/inject_items'
    );
    expect(injected?.params).toEqual({
      threadId: 'thread-1',
      items: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Earlier question' }]
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Earlier answer' }]
        }
      ]
    });

    const turnStart = capture?.child.received.find((message) => message.method === 'turn/start');
    expect(turnStart?.params).toEqual({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'status?' }],
      environments: [],
      runtimeWorkspaceRoots: [],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false }
    });
    expect(runtimeRoot).toBeDefined();
    await expect(access(runtimeRoot as string)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses a fixed continuation input when the supplied history ends with an assistant message', async () => {
    const source = await createSourceAuthFile();
    let capture: SpawnCapture | undefined;
    const runner = createCodexAppServerRunner({
      spawnImpl: scriptedSpawn(respondWithSuccessfulTurn, (value) => {
        capture = value;
      })
    });
    const request = runtimeRequest(source.path);
    request.messages = [
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Partial answer' }
    ];

    await runner(request);

    const injected = capture?.child.received.find(
      (message) => message.method === 'thread/inject_items'
    );
    expect(injected?.params).toMatchObject({
      items: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Question' }]
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Partial answer' }]
        }
      ]
    });
    expect(
      capture?.child.received.find((message) => message.method === 'turn/start')?.params
    ).toMatchObject({
      input: [{ type: 'text', text: 'Provide the next assistant response.' }]
    });
  });

  it('fails closed and cleans up when instruction sources are not empty', async () => {
    const source = await createSourceAuthFile();
    let runtimeRoot: string | undefined;
    const runner = createCodexAppServerRunner({
      spawnImpl: scriptedSpawn(
        (message, child) => {
          if (message.method === 'initialize') {
            child.respond({
              id: message.id,
              result: {
                codexHome: '/isolated/codex',
                platformFamily: 'unix',
                platformOs: 'macos',
                userAgent: 'codex-test'
              }
            });
          } else if (message.method === 'thread/start') {
            child.respond({
              id: message.id,
              result: {
                thread: { id: 'thread-1' },
                instructionSources: ['/private/AGENTS.md']
              }
            });
          }
        },
        ({ options }) => {
          runtimeRoot = dirname(options.cwd);
        }
      )
    });

    const error = await runner(runtimeRequest(source.path)).then(
      () => undefined,
      (reason: unknown) => reason
    );

    expect(error).toMatchObject({ kind: 'protocol' });
    expect((error as Error).message).not.toContain('/private/AGENTS.md');
    expect(runtimeRoot).toBeDefined();
    await expect(access(runtimeRoot as string)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    {
      label: 'server approval request',
      forbidden: {
        id: 99,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1' }
      }
    },
    {
      label: 'tool item event',
      forbidden: {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          startedAtMs: 1,
          item: { id: 'command-1', type: 'commandExecution' }
        }
      }
    },
    {
      label: 'unknown non-agent notification',
      forbidden: {
        method: 'turn/diff/updated',
        params: { threadId: 'thread-1', turnId: 'turn-1', diff: 'private diff' }
      }
    }
  ])('fails closed on a $label', async ({ forbidden }) => {
    const source = await createSourceAuthFile();
    let childProcess: ScriptedCodexProcess | undefined;
    const runner = createCodexAppServerRunner({
      spawnImpl: scriptedSpawn(
        (message, child) => {
          if (message.method === 'initialize') {
            child.respond({
              id: message.id,
              result: {
                codexHome: '/isolated/codex',
                platformFamily: 'unix',
                platformOs: 'macos',
                userAgent: 'codex-test'
              }
            });
          } else if (message.method === 'thread/start') {
            child.respond({
              id: message.id,
              result: {
                thread: { id: 'thread-1' },
                instructionSources: [],
                approvalPolicy: 'never',
                approvalsReviewer: 'user',
                cwd: '/isolated/work',
                model: 'gpt-5.6-sol',
                modelProvider: 'openai',
                sandbox: { type: 'readOnly', networkAccess: false }
              }
            });
          } else if (message.method === 'thread/inject_items') {
            child.respond({ id: message.id, result: {} });
          } else if (message.method === 'turn/start') {
            child.respond({
              id: message.id,
              result: { turn: { id: 'turn-1', items: [], status: 'inProgress' } }
            });
            child.respond(forbidden);
          }
        },
        ({ child }) => {
          childProcess = child;
        }
      )
    });

    const error = await runner(runtimeRequest(source.path)).then(
      () => undefined,
      (reason: unknown) => reason
    );

    expect(error).toMatchObject({ kind: 'protocol' });
    expect((error as Error).message).not.toContain('private diff');
    expect(childProcess?.killed).toBe(true);
  });

  it.each([
    ['unauthorized', 'auth'],
    ['usageLimitExceeded', 'rate_limited'],
    ['sessionBudgetExceeded', 'rate_limited'],
    ['serverOverloaded', 'runtime'],
    ['internalServerError', 'runtime'],
    ['somethingUnrecognized', 'runtime']
  ] as const)('maps a failed turn with %s without retaining its content', async (info, kind) => {
    const source = await createSourceAuthFile();
    const runner = createCodexAppServerRunner({
      spawnImpl: scriptedSpawn((message, child) => {
        if (message.method === 'initialize') {
          child.respond({
            id: message.id,
            result: {
              codexHome: '/isolated/codex',
              platformFamily: 'unix',
              platformOs: 'macos',
              userAgent: 'codex-test'
            }
          });
        } else if (message.method === 'thread/start') {
          child.respond({
            id: message.id,
            result: {
              thread: { id: 'thread-1' },
              instructionSources: [],
              approvalPolicy: 'never',
              approvalsReviewer: 'user',
              cwd: '/isolated/work',
              model: 'gpt-5.6-sol',
              modelProvider: 'openai',
              sandbox: { type: 'readOnly', networkAccess: false }
            }
          });
        } else if (message.method === 'thread/inject_items') {
          child.respond({ id: message.id, result: {} });
        } else if (message.method === 'turn/start') {
          child.respond({
            id: message.id,
            result: { turn: { id: 'turn-1', items: [], status: 'inProgress' } }
          });
          child.respond({
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: {
                id: 'turn-1',
                status: 'failed',
                items: [],
                error: {
                  message: 'private upstream failure body',
                  codexErrorInfo: info
                }
              }
            }
          });
        }
      })
    });

    const error = await runner(runtimeRequest(source.path)).then(
      () => undefined,
      (reason: unknown) => reason
    );

    expect(error).toMatchObject({ kind });
    expect((error as Error).message).not.toContain('private upstream failure body');
  });

  it.each([
    ['httpConnectionFailed', 401, 'auth'],
    ['responseStreamConnectionFailed', 403, 'auth'],
    ['responseStreamDisconnected', 429, 'rate_limited'],
    ['responseTooManyFailedAttempts', 503, 'unavailable'],
    ['httpConnectionFailed', undefined, 'unavailable']
  ] as const)(
    'maps a failed turn reporting %s with status %s to %s',
    async (connection, httpStatusCode, kind) => {
      const source = await createSourceAuthFile();
      const runner = createCodexAppServerRunner({
        spawnImpl: scriptedSpawn(
          scriptTurn((child) => {
            child.respond({
              method: 'turn/completed',
              params: {
                threadId: 'thread-1',
                turn: {
                  id: 'turn-1',
                  status: 'failed',
                  items: [],
                  error: {
                    message: 'private upstream failure body',
                    codexErrorInfo: {
                      [connection]: httpStatusCode === undefined ? {} : { httpStatusCode }
                    }
                  }
                }
              }
            });
          })
        )
      });

      const error = await runner(runtimeRequest(source.path)).then(
        () => undefined,
        (reason: unknown) => reason
      );

      expect(error).toMatchObject({ kind });
      expect((error as Error).message).not.toContain('private upstream failure body');
    }
  );

  it.each([
    ['cancelled', []],
    ['completed', 'not-an-array']
  ] as const)('refuses a turn ending with status %s and unusable items', async (status, items) => {
    const source = await createSourceAuthFile();
    const runner = createCodexAppServerRunner({
      spawnImpl: scriptedSpawn(
        scriptTurn((child) => {
          child.respond({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status, items } }
          });
        })
      )
    });

    await expect(runner(runtimeRequest(source.path))).rejects.toMatchObject({ kind: 'runtime' });
  });

  it('refuses a completed turn whose agent message never arrived', async () => {
    const source = await createSourceAuthFile();
    const runner = createCodexAppServerRunner({
      spawnImpl: scriptedSpawn(
        scriptTurn((child) => {
          child.respond({
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: { id: 'turn-1', status: 'completed', items: [userItem, reasoningItem] }
            }
          });
        })
      )
    });

    await expect(runner(runtimeRequest(source.path))).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('refuses a completed turn carrying an unknown item type', async () => {
    const source = await createSourceAuthFile();
    const runner = createCodexAppServerRunner({
      spawnImpl: scriptedSpawn(
        scriptTurn((child) => {
          child.respond({
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: {
                id: 'turn-1',
                status: 'completed',
                items: [agentItem, { id: 'tool-1', type: 'commandExecution' }]
              }
            }
          });
        })
      )
    });

    await expect(runner(runtimeRequest(source.path))).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('refuses an agent message beyond the durable text bound', async () => {
    const source = await createSourceAuthFile();
    const oversized = {
      id: 'agent-1',
      type: 'agentMessage',
      phase: 'final_answer',
      text: 'x'.repeat(1_048_577)
    };
    const runner = createCodexAppServerRunner({
      maxOutputBytes: 8_000_000,
      spawnImpl: scriptedSpawn(
        scriptTurn((child) => {
          completeTurnWith(child, [oversized]);
        })
      )
    });

    await expect(runner(runtimeRequest(source.path))).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('refuses a turn that reports more output tokens than the request allowed', async () => {
    const source = await createSourceAuthFile();
    const runner = createCodexAppServerRunner({
      spawnImpl: scriptedSpawn(
        scriptTurn((child) => {
          child.respond({
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              completedAtMs: 1,
              item: agentItem
            }
          });
          child.respond({
            method: 'thread/tokenUsage/updated',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              tokenUsage: {
                last: {
                  inputTokens: 10,
                  cachedInputTokens: 0,
                  cacheWriteInputTokens: 0,
                  outputTokens: 4_096,
                  reasoningOutputTokens: 0,
                  totalTokens: 4_106
                }
              }
            }
          });
          child.respond({
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: { id: 'turn-1', status: 'completed', items: [agentItem] }
            }
          });
        })
      )
    });

    await expect(runner(runtimeRequest(source.path))).rejects.toMatchObject({ kind: 'protocol' });
  });

  it.each([
    ['thread', { threadId: 'other-thread', turnId: 'turn-1' }],
    ['turn', { threadId: 'thread-1', turnId: 'other-turn' }]
  ] as const)('refuses an item notification bound to a different %s', async (_label, ids) => {
    const source = await createSourceAuthFile();
    const runner = createCodexAppServerRunner({
      spawnImpl: scriptedSpawn(
        scriptTurn((child) => {
          child.respond({
            method: 'item/completed',
            params: { ...ids, completedAtMs: 1, item: agentItem }
          });
        })
      )
    });

    await expect(runner(runtimeRequest(source.path))).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('answers with the final_answer message even when a later message follows', async () => {
    const source = await createSourceAuthFile();
    const runner = createCodexAppServerRunner({
      spawnImpl: scriptedSpawn(
        scriptTurn((child) => {
          completeTurnWith(child, [
            { id: 'agent-1', type: 'agentMessage', phase: 'final_answer', text: 'The answer.' },
            { id: 'agent-2', type: 'agentMessage', phase: 'summary', text: 'A trailing note.' }
          ]);
        })
      )
    });

    await expect(runner(runtimeRequest(source.path))).resolves.toMatchObject({
      text: 'The answer.'
    });
  });

  it('answers with the last message when no phase is marked final', async () => {
    const source = await createSourceAuthFile();
    const runner = createCodexAppServerRunner({
      spawnImpl: scriptedSpawn(
        scriptTurn((child) => {
          completeTurnWith(child, [
            { id: 'agent-1', type: 'agentMessage', text: 'An earlier draft.' },
            { id: 'agent-2', type: 'agentMessage', text: 'The last word.' }
          ]);
        })
      )
    });

    await expect(runner(runtimeRequest(source.path))).resolves.toMatchObject({
      text: 'The last word.'
    });
  });

  it('refuses a turn whose app-server exits before any terminal message', async () => {
    const source = await createSourceAuthFile();
    const runner = createCodexAppServerRunner({
      spawnImpl: scriptedSpawn(
        scriptTurn((child) => {
          child.close(0, null);
        })
      )
    });

    await expect(runner(runtimeRequest(source.path))).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('refuses a thread status notification bound to a different thread', async () => {
    const source = await createSourceAuthFile();
    const runner = createCodexAppServerRunner({
      spawnImpl: scriptedSpawn(
        scriptTurn((child) => {
          child.respond({
            method: 'thread/status/changed',
            params: { threadId: 'other-thread', status: 'idle' }
          });
        })
      )
    });

    await expect(runner(runtimeRequest(source.path))).rejects.toMatchObject({ kind: 'protocol' });
  });

  it.each([
    ['refuses to die', UnkillableCodexProcess],
    ['cannot be signalled', UnsignallableCodexProcess]
  ] as const)('still reports the original failure when the child %s', async (_label, Process) => {
    const source = await createSourceAuthFile();
    const runner = createCodexAppServerRunner({
      spawnImpl: () =>
        new Process(
          scriptTurn((child) => {
            child.respond({
              method: 'turn/completed',
              params: {
                threadId: 'thread-1',
                turn: {
                  id: 'turn-1',
                  status: 'failed',
                  items: [],
                  error: { message: 'private body', codexErrorInfo: 'unauthorized' }
                }
              }
            });
          })
        )
    });

    const error = await runner(runtimeRequest(source.path)).then(
      () => undefined,
      (reason: unknown) => reason
    );

    expect(error).toMatchObject({ kind: 'auth' });
    expect((error as Error).message).not.toContain('private body');
  });

  it('bounds protocol output and never includes it in the error', async () => {
    const source = await createSourceAuthFile();
    const privateOutput = 'private-protocol-output'.repeat(20);
    const runner = createCodexAppServerRunner({
      maxOutputBytes: 128,
      spawnImpl: scriptedSpawn((_message, child) => {
        child.writeRawStdout(privateOutput);
      })
    });

    const error = await runner(runtimeRequest(source.path)).then(
      () => undefined,
      (reason: unknown) => reason
    );

    expect(error).toMatchObject({ kind: 'protocol' });
    expect((error as Error).message).not.toContain('private-protocol-output');
  });

  it('kills the child on timeout and reports a sanitized timeout', async () => {
    const source = await createSourceAuthFile();
    let childProcess: ScriptedCodexProcess | undefined;
    const runner = createCodexAppServerRunner({
      spawnImpl: scriptedSpawn(
        () => undefined,
        ({ child }) => {
          childProcess = child;
        }
      )
    });
    const request = runtimeRequest(source.path);
    request.timeoutMs = 25;

    await expect(runner(request)).rejects.toMatchObject({ kind: 'timeout' });
    expect(childProcess?.killed).toBe(true);
  });

  it('maps an unreadable source auth file to auth without spawning', async () => {
    let spawnCalls = 0;
    const runner = createCodexAppServerRunner({
      spawnImpl: () => {
        spawnCalls += 1;
        throw new Error('must not spawn');
      }
    });

    await expect(
      runner(runtimeRequest('/definitely/missing/.codex/auth.json'))
    ).rejects.toMatchObject({
      kind: 'auth'
    });
    expect(spawnCalls).toBe(0);
  });

  it('removes the isolated runtime when spawning the app-server fails', async () => {
    const source = await createSourceAuthFile();
    let runtimeRoot: string | undefined;
    const runner = createCodexAppServerRunner({
      spawnImpl: (...spawnArguments) => {
        const options = spawnArguments[2];
        runtimeRoot = dirname(options.cwd);
        throw new Error('spawn failure with private content');
      }
    });

    const error = await runner(runtimeRequest(source.path)).then(
      () => undefined,
      (reason: unknown) => reason
    );

    expect(error).toMatchObject({ kind: 'unavailable' });
    expect((error as Error).message).not.toContain('private content');
    expect(runtimeRoot).toBeDefined();
    await expect(access(runtimeRoot as string)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when runtime-home cleanup fails after a successful turn', async () => {
    const runner = createCodexAppServerRunner({
      homeLifecycle: () =>
        Promise.resolve({
          root: '/isolated/root',
          home: '/isolated/root/home',
          codexHome: '/isolated/root/codex',
          cwd: '/isolated/root/work',
          cleanup: () => Promise.reject(new Error('private cleanup failure'))
        }),
      spawnImpl: scriptedSpawn(respondWithSuccessfulTurn)
    });

    const error = await runner(runtimeRequest('/unused/auth.json')).then(
      () => undefined,
      (reason: unknown) => reason
    );

    expect(error).toMatchObject({ kind: 'runtime' });
    expect((error as Error).message).not.toContain('private cleanup failure');
  });
});

describe('resolveDefaultCodexCommand', () => {
  it('prefers the ChatGPT-bundled binary on macOS when present', () => {
    expect(resolveDefaultCodexCommand('darwin', () => true)).toBe(
      '/Applications/ChatGPT.app/Contents/Resources/codex'
    );
  });

  it('falls back to the PATH command off macOS or when the bundle is absent', () => {
    expect(resolveDefaultCodexCommand('darwin', () => false)).toBe('codex');
    expect(resolveDefaultCodexCommand('linux', existsSync)).toBe('codex');
  });
});
