import { chmod, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ModelGenerationRequest,
  type ModelGenerationResult,
  type ModelProvider,
  type ModelTierRoute,
  type ProviderAvailability,
  ProviderError
} from './contracts';
import {
  type CliResult,
  type CliRunner,
  type CredentialProbe,
  defaultCliRunner,
  minimalCliEnvironment,
  secretsPlaneProbe
} from './cli-runtime';

export interface ClaudeProviderOptions {
  models?: Partial<Record<ModelTierRoute, string>>;
  runner?: CliRunner;
  credentialProbe?: CredentialProbe;
  command?: string;
  /** Sandbox working directory; the CLI is denied every filesystem/exec tool anyway. */
  cwd?: string;
  /** Source environment; reduced to an allow-list before the CLI is launched. */
  env?: NodeJS.ProcessEnv;
  /** Injectable secure-file lifecycle for deterministic tests. */
  systemPromptFileLifecycle?: ClaudeSystemPromptFileLifecycle;
}

export interface ClaudeSystemPromptFile {
  path: string;
  cleanup(): Promise<void>;
}

export type ClaudeSystemPromptFileLifecycle = (
  systemPrompt: string
) => Promise<ClaudeSystemPromptFile>;

/**
 * Writes one system prompt into a private, single-use directory. The file path,
 * never the prompt bytes, is safe to pass as a process argument.
 */
export async function createSecureClaudeSystemPromptFile(
  systemPrompt: string
): Promise<ClaudeSystemPromptFile> {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-claude-system-'));
  const path = join(directory, 'system-prompt.txt');

  try {
    await chmod(directory, 0o700);
    await writeFile(path, systemPrompt, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    await chmod(path, 0o600);
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    await rmdir(directory).catch(() => undefined);
    throw error;
  }

  let cleaned = false;
  return {
    path,
    cleanup: async () => {
      if (cleaned) return;
      await rm(path, { force: true });
      await rmdir(directory);
      cleaned = true;
    }
  };
}

// Claude Code accepts model aliases the CLI resolves to current concrete ids.
const DEFAULT_MODELS: Record<ModelTierRoute, string> = {
  local: 'haiku',
  economy: 'sonnet',
  frontier: 'opus'
};

interface ClaudeResultEnvelope {
  result?: unknown;
  is_error?: unknown;
  api_error_status?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

/**
 * A logged-out/revoked headless CLI reports its failure only in the result text
 * (no HTTP status). Detect those phrasings so the error degrades as `auth`
 * rather than a retriable `runtime` error. Matches on stable, non-localized
 * fragments the CLI emits for missing/rejected credentials.
 */
function looksLikeAuthFailure(result: unknown): boolean {
  if (typeof result !== 'string') return false;
  const text = result.toLowerCase();
  return (
    text.includes('not logged in') ||
    text.includes('/login') ||
    text.includes('please run login') ||
    text.includes('oauth') ||
    text.includes('unauthorized') ||
    text.includes('authenticate')
  );
}

function serializeMessages(request: ModelGenerationRequest): string {
  return JSON.stringify({ messages: request.messages });
}

/**
 * Claude (Max subscription) adapter over the `claude -p` headless CLI. It routes
 * through the subscription (never a metered API key) and meters at cost basis
 * `subscription` (NULL). The CLI is invoked locked-down — JSON output, no MCP
 * servers, every built-in tool denied, in a throwaway cwd — so it can only return
 * text. A revoked/expired token surfaces as a `ProviderError('auth')` and the
 * executor degrades to the next provider (never a fabricated reply).
 */
export class ClaudeProvider implements ModelProvider {
  readonly id = 'claude' as const;
  readonly costBasis = 'subscription' as const;
  private readonly models: Record<ModelTierRoute, string>;
  private readonly runner: CliRunner;
  private readonly credentialProbe: CredentialProbe;
  private readonly command: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly systemPromptFileLifecycle: ClaudeSystemPromptFileLifecycle;

  constructor(options: ClaudeProviderOptions = {}) {
    this.models = { ...DEFAULT_MODELS, ...options.models };
    this.runner = options.runner ?? defaultCliRunner;
    this.credentialProbe = options.credentialProbe ?? secretsPlaneProbe('claude');
    this.command = options.command ?? 'claude';
    this.cwd = options.cwd ?? tmpdir();
    this.env = minimalCliEnvironment(options.env ?? process.env, ['CLAUDE_CODE_OAUTH_TOKEN']);
    this.systemPromptFileLifecycle =
      options.systemPromptFileLifecycle ?? createSecureClaudeSystemPromptFile;
  }

  modelForRoute(route: ModelTierRoute): string {
    return this.models[route];
  }

  servesRoute(route: ModelTierRoute): boolean {
    // Subscriptions serve the economy/frontier tiers; the local tier is Ollama-only.
    return route === 'economy' || route === 'frontier';
  }

  probe(): Promise<ProviderAvailability> {
    return this.credentialProbe();
  }

  async generate(
    route: ModelTierRoute,
    request: ModelGenerationRequest
  ): Promise<ModelGenerationResult> {
    const model = this.modelForRoute(route);
    let systemPromptFile: ClaudeSystemPromptFile;
    try {
      systemPromptFile = await this.systemPromptFileLifecycle(request.system);
    } catch {
      throw new ProviderError(
        this.id,
        'failed to prepare temporary system prompt',
        'runtime',
        true
      );
    }

    const args = [
      '--print',
      '--output-format',
      'json',
      '--model',
      model,
      '--tools',
      '',
      '--safe-mode',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--no-chrome',
      '--permission-mode',
      'dontAsk',
      '--strict-mcp-config',
      '--system-prompt-file',
      systemPromptFile.path
    ];

    let result: CliResult | undefined;
    let launchFailed = false;
    let cleanupFailed = false;
    try {
      result = await this.runner(this.command, args, {
        input: serializeMessages(request),
        timeoutMs: request.timeoutMs,
        cwd: this.cwd,
        env: this.env
      });
    } catch {
      launchFailed = true;
    } finally {
      try {
        await systemPromptFile.cleanup();
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      throw new ProviderError(this.id, 'failed to remove temporary system prompt', 'runtime', true);
    }
    if (launchFailed || result === undefined) {
      throw new ProviderError(this.id, 'failed to launch claude CLI', 'unavailable', true);
    }
    if (result.timedOut) {
      throw new ProviderError(this.id, 'CLI timed out', 'timeout', true);
    }

    let envelope: ClaudeResultEnvelope;
    try {
      envelope = JSON.parse(result.stdout) as ClaudeResultEnvelope;
    } catch {
      throw new ProviderError(this.id, 'unparseable CLI output', 'protocol', false);
    }

    if (envelope.is_error === true) {
      const status = asCount(envelope.api_error_status);
      const isRateLimited = status === 429;
      // A logged-out or revoked subscription often reports no HTTP status (the
      // CLI never reaches the API), surfacing only a "Please run /login" style
      // message. Treat that as a non-retriable auth failure so the executor
      // degrades cleanly to the next provider instead of hammering a dead
      // credential as if it were a transient runtime error.
      const isAuth = status === 401 || status === 403 || looksLikeAuthFailure(envelope.result);
      throw new ProviderError(
        this.id,
        isAuth
          ? 'subscription auth rejected'
          : isRateLimited
            ? 'subscription rate limited'
            : `CLI reported an error${status ? ` (${status})` : ''}`,
        isAuth ? 'auth' : isRateLimited ? 'rate_limited' : 'runtime',
        isRateLimited || !isAuth
      );
    }

    const text = typeof envelope.result === 'string' ? envelope.result : '';
    return {
      text,
      toolCalls: [],
      tokensIn: asCount(envelope.usage?.input_tokens),
      tokensOut: asCount(envelope.usage?.output_tokens),
      cacheReadTokens: asCount(envelope.usage?.cache_read_input_tokens),
      cacheWriteTokens: asCount(envelope.usage?.cache_creation_input_tokens),
      provider: this.id,
      model,
      costBasis: this.costBasis,
      finishReason: 'stop'
    };
  }
}
