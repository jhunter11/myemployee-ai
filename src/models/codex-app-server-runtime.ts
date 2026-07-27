import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import { minimalCliEnvironment } from './cli-runtime';
import type { ModelMessage } from './contracts';

const BUNDLED_CODEX_COMMAND = '/Applications/ChatGPT.app/Contents/Resources/codex';
const DEFAULT_MAX_OUTPUT_BYTES = 4_000_000;
const MAX_AGENT_TEXT_LENGTH = 1_048_576;
const PROCESS_SHUTDOWN_GRACE_MS = 1_000;
const CONTINUATION_INPUT = 'Provide the next assistant response.';
const FIXED_DEVELOPER_INSTRUCTIONS =
  'Return assistant text only. Do not request or invoke tools, approvals, external resources, or side effects.';

const CONFIG_OVERRIDES = [
  'web_search="disabled"',
  'tools.experimental_request_user_input.enabled=false',
  'skills.include_instructions=false',
  'skills.bundled.enabled=false',
  'project_doc_max_bytes=0',
  'project_doc_fallback_filenames=[]',
  'include_apps_instructions=false',
  'include_collaboration_mode_instructions=false',
  'include_environment_context=false',
  'include_permissions_instructions=false',
  'analytics.enabled=false',
  'mcp_servers={}'
] as const;

const DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'shell_snapshot',
  'multi_agent',
  'multi_agent_v2',
  'apps',
  'plugins',
  'hooks',
  'image_generation',
  'in_app_browser',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'tool_suggest',
  'standalone_web_search',
  'request_permissions_tool',
  'default_mode_request_user_input',
  'deferred_executor',
  'goals',
  'memories',
  'artifact',
  'code_mode',
  'code_mode_host',
  'code_mode_only',
  'workspace_dependencies',
  'auth_elicitation',
  'tool_call_mcp_elicitation',
  'skill_search',
  'remote_plugin',
  'plugin_sharing',
  'skill_mcp_dependency_install',
  'guardian_approval',
  'enable_mcp_apps',
  'network_proxy'
] as const;

export type CodexAppServerFailureKind =
  'auth' | 'rate_limited' | 'timeout' | 'unavailable' | 'protocol' | 'runtime';

const FAILURE_MESSAGES: Record<CodexAppServerFailureKind, string> = {
  auth: 'Codex subscription authentication failed',
  rate_limited: 'Codex subscription is rate limited',
  timeout: 'Codex app-server timed out',
  unavailable: 'Codex app-server is unavailable',
  protocol: 'Codex app-server protocol rejected',
  runtime: 'Codex app-server turn failed'
};

/** A deliberately content-free runtime error safe to map into ProviderError. */
export class CodexAppServerFailure extends Error {
  constructor(readonly kind: CodexAppServerFailureKind) {
    super(FAILURE_MESSAGES[kind]);
    this.name = 'CodexAppServerFailure';
  }
}

export interface CodexAppServerRequest {
  command: string;
  sourceAuthPath: string;
  sourceEnv: NodeJS.ProcessEnv;
  model: string;
  system: string;
  messages: ModelMessage[];
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface CodexAppServerResult {
  text: string;
  tokensIn: number | null;
  tokensOut: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

export type CodexAppServerRunner = (
  request: CodexAppServerRequest
) => Promise<CodexAppServerResult>;

export interface CodexAppServerMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export interface CodexAppServerChildProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface CodexAppServerSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: readonly ['pipe', 'pipe', 'pipe'];
}

export type CodexAppServerSpawn = (
  command: string,
  args: readonly string[],
  options: CodexAppServerSpawnOptions
) => CodexAppServerChildProcess;

export interface CodexRuntimeHome {
  root: string;
  home: string;
  codexHome: string;
  cwd: string;
  cleanup(): Promise<void>;
}

export type CodexRuntimeHomeLifecycle = (sourceAuthPath: string) => Promise<CodexRuntimeHome>;

export interface CodexAppServerRuntimeDependencies {
  spawnImpl?: CodexAppServerSpawn;
  homeLifecycle?: CodexRuntimeHomeLifecycle;
  maxOutputBytes?: number;
  tempDirectory?: () => string;
}

/**
 * Prefer the binary bundled with the ChatGPT desktop app on macOS. Other hosts,
 * and macOS hosts without that bundle, resolve `codex` through PATH.
 */
export function resolveDefaultCodexCommand(
  platform: NodeJS.Platform = process.platform,
  pathExists: (path: string) => boolean = existsSync
): string {
  return platform === 'darwin' && pathExists(BUNDLED_CODEX_COMMAND)
    ? BUNDLED_CODEX_COMMAND
    : 'codex';
}

/**
 * Copies only the subscription auth file into a single-use private runtime.
 * User config, skills, AGENTS.md files, plugins, MCP configuration, and history
 * are intentionally not copied.
 */
export async function createSecureCodexRuntimeHome(
  sourceAuthPath: string,
  tempDirectory: string = tmpdir()
): Promise<CodexRuntimeHome> {
  let authBytes: Buffer;
  try {
    authBytes = await readFile(sourceAuthPath);
  } catch {
    throw new CodexAppServerFailure('auth');
  }
  if (authBytes.length === 0) {
    authBytes.fill(0);
    throw new CodexAppServerFailure('auth');
  }

  let root: string | undefined;
  try {
    root = await mkdtemp(join(tempDirectory, 'jarvis-codex-runtime-'));
    const home = join(root, 'home');
    const codexHome = join(root, 'codex');
    const cwd = join(root, 'work');
    await chmod(root, 0o700);
    await Promise.all([
      mkdir(home, { mode: 0o700 }),
      mkdir(codexHome, { mode: 0o700 }),
      mkdir(cwd, { mode: 0o700 })
    ]);
    await Promise.all([chmod(home, 0o700), chmod(codexHome, 0o700), chmod(cwd, 0o700)]);
    const isolatedAuthPath = join(codexHome, 'auth.json');
    await writeFile(isolatedAuthPath, authBytes, { flag: 'wx', mode: 0o600 });
    await chmod(isolatedAuthPath, 0o600);

    let cleaned = false;
    return {
      root,
      home,
      codexHome,
      cwd,
      cleanup: async () => {
        if (cleaned) return;
        await rm(root as string, { force: true, recursive: true });
        cleaned = true;
      }
    };
  } catch (error) {
    if (root !== undefined) {
      await rm(root, { force: true, recursive: true }).catch(() => undefined);
    }
    if (error instanceof CodexAppServerFailure) throw error;
    throw new CodexAppServerFailure('runtime');
  } finally {
    authBytes.fill(0);
  }
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: CodexAppServerSpawnOptions
): CodexAppServerChildProcess {
  return nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

export function codexAppServerArguments(): string[] {
  const args = ['app-server', '--stdio', '--strict-config'];
  for (const override of CONFIG_OVERRIDES) {
    args.push('-c', override);
  }
  for (const feature of DISABLED_FEATURES) {
    args.push('--disable', feature);
  }
  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function property(record: unknown, key: string): unknown {
  return isRecord(record) ? record[key] : undefined;
}

function jsonRpcId(message: CodexAppServerMessage): string | number | undefined {
  return typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined;
}

function failureKindFromCodexError(value: unknown): CodexAppServerFailureKind {
  const info = isRecord(value) && 'codexErrorInfo' in value ? value.codexErrorInfo : value;
  if (info === 'unauthorized') return 'auth';
  if (info === 'usageLimitExceeded' || info === 'sessionBudgetExceeded') {
    return 'rate_limited';
  }
  if (info === 'serverOverloaded' || info === 'internalServerError') return 'runtime';
  if (isRecord(info)) {
    const connection =
      property(info, 'httpConnectionFailed') ??
      property(info, 'responseStreamConnectionFailed') ??
      property(info, 'responseStreamDisconnected') ??
      property(info, 'responseTooManyFailedAttempts');
    const status = asCount(property(connection, 'httpStatusCode'));
    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'rate_limited';
    return 'unavailable';
  }
  return 'runtime';
}

function serializeHistoryItem(message: ModelMessage): Record<string, unknown> {
  return {
    type: 'message',
    role: message.role,
    content: [
      {
        type: message.role === 'assistant' ? 'output_text' : 'input_text',
        text: message.content
      }
    ]
  };
}

function splitConversation(messages: ModelMessage[]): {
  history: ModelMessage[];
  input: string;
} {
  const last = messages.at(-1);
  if (last?.role === 'user') {
    return { history: messages.slice(0, -1), input: last.content };
  }
  return { history: [...messages], input: CONTINUATION_INPUT };
}

function validItemType(item: unknown): item is Record<string, unknown> {
  if (!isRecord(item)) return false;
  return item.type === 'userMessage' || item.type === 'reasoning' || item.type === 'agentMessage';
}

function notificationIdsMatch(
  params: unknown,
  threadId: string | undefined,
  turnId?: string
): boolean {
  if (!isRecord(params)) return false;
  if (threadId !== undefined && params.threadId !== threadId) return false;
  if (turnId !== undefined && params.turnId !== turnId) return false;
  return true;
}

interface CompletedAgentMessage {
  text: string;
  phase: string | undefined;
}

interface TokenCounts {
  tokensIn: number | null;
  tokensOut: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

function runProtocol(
  request: CodexAppServerRequest,
  runtimeHome: CodexRuntimeHome,
  spawnImpl: CodexAppServerSpawn,
  maxOutputBytes: number
): Promise<CodexAppServerResult> {
  const environment = {
    ...minimalCliEnvironment(request.sourceEnv),
    HOME: runtimeHome.home,
    CODEX_HOME: runtimeHome.codexHome
  };

  let child: CodexAppServerChildProcess;
  try {
    child = spawnImpl(request.command, codexAppServerArguments(), {
      cwd: runtimeHome.cwd,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch {
    return Promise.reject(new CodexAppServerFailure('unavailable'));
  }

  return new Promise<CodexAppServerResult>((resolve, reject) => {
    type Stage = 'initialize' | 'thread' | 'inject' | 'turn' | 'running' | 'terminal';
    let stage: Stage = 'initialize';
    let threadId: string | undefined;
    let turnId: string | undefined;
    let outputBytes = 0;
    let stdoutBuffer = '';
    let terminalResult: CodexAppServerResult | undefined;
    let terminalFailure: CodexAppServerFailure | undefined;
    let settled = false;
    let processExitTimer: NodeJS.Timeout | undefined;
    const completedAgentMessages: CompletedAgentMessage[] = [];
    let tokenCounts: TokenCounts = {
      tokensIn: null,
      tokensOut: null,
      cacheReadTokens: null,
      cacheWriteTokens: null
    };
    const decoder = new StringDecoder('utf8');
    const conversation = splitConversation(request.messages);

    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(requestTimer);
      if (processExitTimer !== undefined) clearTimeout(processExitTimer);
      if (terminalFailure !== undefined) {
        reject(terminalFailure);
      } else if (terminalResult !== undefined) {
        resolve(terminalResult);
      } else {
        reject(new CodexAppServerFailure(stage === 'initialize' ? 'unavailable' : 'protocol'));
      }
    };

    const fail = (kind: CodexAppServerFailureKind) => {
      if (terminalFailure !== undefined || terminalResult !== undefined) return;
      terminalFailure = new CodexAppServerFailure(kind);
      try {
        if (!child.kill('SIGKILL')) {
          settle();
          return;
        }
        if (!settled) {
          processExitTimer = setTimeout(settle, PROCESS_SHUTDOWN_GRACE_MS);
        }
      } catch {
        settle();
      }
    };

    const send = (message: CodexAppServerMessage) => {
      if (terminalFailure !== undefined || terminalResult !== undefined) return;
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) fail('runtime');
        });
      } catch {
        fail('runtime');
      }
    };

    const sendTurnStart = () => {
      stage = 'turn';
      send({
        id: 4,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: conversation.input }],
          environments: [],
          runtimeWorkspaceRoots: [],
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', networkAccess: false }
        }
      });
    };

    const handleResponse = (message: CodexAppServerMessage) => {
      if (message.error !== undefined) {
        fail(failureKindFromCodexError(property(message.error, 'data')));
        return;
      }
      const id = jsonRpcId(message);
      if (stage === 'initialize' && id === 1 && isRecord(message.result)) {
        stage = 'thread';
        send({ method: 'initialized', params: {} });
        send({
          id: 2,
          method: 'thread/start',
          params: {
            serviceName: 'jarvis',
            model: request.model,
            cwd: runtimeHome.cwd,
            approvalPolicy: 'never',
            sandbox: 'read-only',
            baseInstructions: request.system,
            developerInstructions: `${FIXED_DEVELOPER_INSTRUCTIONS} Keep the response within ${request.maxOutputTokens} output tokens.`,
            personality: 'none',
            ephemeral: true,
            environments: [],
            runtimeWorkspaceRoots: [],
            dynamicTools: [],
            selectedCapabilityRoots: []
          }
        });
        return;
      }
      if (stage === 'thread' && id === 2 && isRecord(message.result)) {
        const instructionSources = message.result.instructionSources;
        const responseThreadId = asNonemptyString(property(message.result.thread, 'id'));
        const sandbox = message.result.sandbox;
        if (
          !Array.isArray(instructionSources) ||
          instructionSources.length !== 0 ||
          responseThreadId === undefined ||
          message.result.approvalPolicy !== 'never' ||
          message.result.model !== request.model ||
          !isRecord(sandbox) ||
          sandbox.type !== 'readOnly' ||
          sandbox.networkAccess !== false
        ) {
          fail('protocol');
          return;
        }
        threadId = responseThreadId;
        stage = 'inject';
        send({
          id: 3,
          method: 'thread/inject_items',
          params: {
            threadId,
            items: conversation.history.map(serializeHistoryItem)
          }
        });
        return;
      }
      if (stage === 'inject' && id === 3 && isRecord(message.result)) {
        sendTurnStart();
        return;
      }
      if (stage === 'turn' && id === 4 && isRecord(message.result)) {
        const turn = message.result.turn;
        const responseTurnId = asNonemptyString(property(turn, 'id'));
        if (responseTurnId === undefined || property(turn, 'status') !== 'inProgress') {
          fail('protocol');
          return;
        }
        turnId = responseTurnId;
        stage = 'running';
        return;
      }
      fail('protocol');
    };

    const handleItemNotification = (params: unknown, completed: boolean) => {
      if (!notificationIdsMatch(params, threadId, turnId)) {
        fail('protocol');
        return;
      }
      const item = property(params, 'item');
      if (!validItemType(item)) {
        fail('protocol');
        return;
      }
      if (completed && item.type === 'agentMessage') {
        const text = asNonemptyString(item.text);
        if (text === undefined || text.length > MAX_AGENT_TEXT_LENGTH) {
          fail('protocol');
          return;
        }
        completedAgentMessages.push({
          text,
          phase: typeof item.phase === 'string' ? item.phase : undefined
        });
      }
    };

    const handleTurnCompleted = (params: unknown) => {
      if (!isRecord(params) || params.threadId !== threadId || !isRecord(params.turn)) {
        fail('protocol');
        return;
      }
      const turn = params.turn;
      if (turn.id !== turnId) {
        fail('protocol');
        return;
      }
      if (turn.status === 'failed') {
        fail(failureKindFromCodexError(property(turn.error, 'codexErrorInfo')));
        return;
      }
      if (turn.status !== 'completed' || !Array.isArray(turn.items)) {
        fail('runtime');
        return;
      }
      if (!turn.items.every(validItemType)) {
        fail('protocol');
        return;
      }
      let selected = completedAgentMessages.at(-1);
      for (let index = completedAgentMessages.length - 1; index >= 0; index -= 1) {
        const candidate = completedAgentMessages[index];
        if (candidate?.phase === 'final_answer') {
          selected = candidate;
          break;
        }
      }
      if (
        selected === undefined ||
        selected.text.length === 0 ||
        selected.text.length > MAX_AGENT_TEXT_LENGTH ||
        (tokenCounts.tokensOut !== null && tokenCounts.tokensOut > request.maxOutputTokens)
      ) {
        fail('protocol');
        return;
      }
      terminalResult = { text: selected.text, ...tokenCounts };
      stage = 'terminal';
      clearTimeout(requestTimer);
      processExitTimer = setTimeout(() => {
        try {
          if (!child.kill('SIGKILL')) {
            settle();
            return;
          }
          processExitTimer = setTimeout(settle, PROCESS_SHUTDOWN_GRACE_MS);
        } catch {
          settle();
        }
      }, PROCESS_SHUTDOWN_GRACE_MS);
      try {
        child.stdin.end();
      } catch {
        terminalResult = undefined;
        fail('runtime');
      }
    };

    const handleNotification = (message: CodexAppServerMessage) => {
      const method = message.method;
      if (method === 'thread/started') return;
      if (method === 'thread/status/changed') {
        if (
          threadId !== undefined &&
          isRecord(message.params) &&
          message.params.threadId !== threadId
        ) {
          fail('protocol');
        }
        return;
      }
      if (method === 'turn/started') {
        const notificationTurnId = asNonemptyString(
          property(property(message.params, 'turn'), 'id')
        );
        if (!notificationIdsMatch(message.params, threadId) || notificationTurnId !== turnId) {
          fail('protocol');
        }
        return;
      }
      if (method === 'item/started') {
        handleItemNotification(message.params, false);
        return;
      }
      if (method === 'item/completed') {
        handleItemNotification(message.params, true);
        return;
      }
      if (
        method === 'item/agentMessage/delta' ||
        method === 'item/reasoning/summaryPartAdded' ||
        method === 'item/reasoning/summaryTextDelta' ||
        method === 'item/reasoning/textDelta'
      ) {
        if (!notificationIdsMatch(message.params, threadId, turnId)) fail('protocol');
        return;
      }
      if (method === 'thread/tokenUsage/updated') {
        if (!notificationIdsMatch(message.params, threadId, turnId)) {
          fail('protocol');
          return;
        }
        const last = property(property(message.params, 'tokenUsage'), 'last');
        if (!isRecord(last)) {
          fail('protocol');
          return;
        }
        tokenCounts = {
          tokensIn: asCount(last.inputTokens),
          tokensOut: asCount(last.outputTokens),
          cacheReadTokens: asCount(last.cachedInputTokens),
          cacheWriteTokens: asCount(last.cacheWriteInputTokens)
        };
        return;
      }
      if (method === 'turn/completed') {
        handleTurnCompleted(message.params);
        return;
      }
      if (method === 'error') {
        fail(
          failureKindFromCodexError(property(property(message.params, 'error'), 'codexErrorInfo'))
        );
        return;
      }
      fail('protocol');
    };

    const handleLine = (line: string) => {
      if (terminalFailure !== undefined || terminalResult !== undefined || line.length === 0)
        return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail('protocol');
        return;
      }
      if (!isRecord(parsed)) {
        fail('protocol');
        return;
      }
      const message = parsed as CodexAppServerMessage;
      if (message.method !== undefined && jsonRpcId(message) !== undefined) {
        // Every server-initiated request (tools, approvals, token refresh, or
        // attestation) is forbidden on this text-only boundary.
        fail('protocol');
        return;
      }
      if (jsonRpcId(message) !== undefined) {
        handleResponse(message);
        return;
      }
      if (typeof message.method === 'string') {
        handleNotification(message);
        return;
      }
      fail('protocol');
    };

    const countOutput = (chunk: Buffer): boolean => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        fail('protocol');
        return false;
      }
      return true;
    };

    child.stdout.on('data', (rawChunk: Buffer | string) => {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      if (!countOutput(chunk)) return;
      stdoutBuffer += decoder.write(chunk);
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        handleLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
      }
    });
    child.stdout.on('end', () => {
      stdoutBuffer += decoder.end();
      if (
        stdoutBuffer.length > 0 &&
        terminalFailure === undefined &&
        terminalResult === undefined
      ) {
        handleLine(stdoutBuffer.endsWith('\r') ? stdoutBuffer.slice(0, -1) : stdoutBuffer);
      }
      stdoutBuffer = '';
    });
    child.stderr.on('data', (rawChunk: Buffer | string) => {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      countOutput(chunk);
    });
    child.stdin.on('error', () => fail('runtime'));
    child.on('error', () => fail('unavailable'));
    child.on('close', () => settle());

    // Declared here so the request clock starts only once every handler is bound.
    const requestTimer = setTimeout(() => fail('timeout'), request.timeoutMs);
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'jarvis', title: 'Jarvis', version: '0.1.0' },
        capabilities: { experimentalApi: true }
      }
    });
  });
}

export function createCodexAppServerRunner(
  dependencies: CodexAppServerRuntimeDependencies = {}
): CodexAppServerRunner {
  const spawnImpl = dependencies.spawnImpl ?? defaultSpawn;
  const maxOutputBytes =
    dependencies.maxOutputBytes !== undefined &&
    Number.isSafeInteger(dependencies.maxOutputBytes) &&
    dependencies.maxOutputBytes > 0
      ? dependencies.maxOutputBytes
      : DEFAULT_MAX_OUTPUT_BYTES;
  const homeLifecycle =
    dependencies.homeLifecycle ??
    ((sourceAuthPath: string) =>
      createSecureCodexRuntimeHome(sourceAuthPath, (dependencies.tempDirectory ?? tmpdir)()));

  return async (request) => {
    let runtimeHome: CodexRuntimeHome;
    try {
      runtimeHome = await homeLifecycle(request.sourceAuthPath);
    } catch (error) {
      if (error instanceof CodexAppServerFailure) throw error;
      throw new CodexAppServerFailure('runtime');
    }

    let result: CodexAppServerResult | undefined;
    let failure: CodexAppServerFailure | undefined;
    try {
      result = await runProtocol(request, runtimeHome, spawnImpl, maxOutputBytes);
    } catch (error) {
      failure =
        error instanceof CodexAppServerFailure ? error : new CodexAppServerFailure('unavailable');
    }

    try {
      await runtimeHome.cleanup();
    } catch {
      throw new CodexAppServerFailure('runtime');
    }
    if (failure !== undefined) throw failure;
    if (result === undefined) throw new CodexAppServerFailure('runtime');
    return result;
  };
}

export const defaultCodexAppServerRunner = createCodexAppServerRunner();
