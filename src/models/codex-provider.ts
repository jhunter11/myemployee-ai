import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';

import {
  CodexAppServerFailure,
  type CodexAppServerFailureKind,
  type CodexAppServerRunner,
  defaultCodexAppServerRunner,
  resolveDefaultCodexCommand
} from './codex-app-server-runtime';
import {
  type ModelGenerationRequest,
  type ModelGenerationResult,
  type ModelProvider,
  type ModelTierRoute,
  type ProviderAvailability,
  ProviderError
} from './contracts';
import { type CredentialProbe, secretsPlaneProbe } from './cli-runtime';

export interface CodexProviderOptions {
  models?: Partial<Record<ModelTierRoute, string>>;
  runner?: CodexAppServerRunner;
  credentialProbe?: CredentialProbe;
  command?: string;
  homedir?: () => string;
  /** Source environment; the runtime reduces this to an explicit allow-list. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_MODELS: Record<ModelTierRoute, string> = {
  local: 'gpt-5.6-terra',
  economy: 'gpt-5.6-terra',
  frontier: 'gpt-5.6-sol'
};

const PROVIDER_FAILURES: Record<
  CodexAppServerFailureKind,
  { message: string; retriable: boolean }
> = {
  auth: { message: 'subscription auth rejected', retriable: false },
  rate_limited: { message: 'subscription rate limited', retriable: true },
  timeout: { message: 'app-server timed out', retriable: true },
  unavailable: { message: 'app-server unavailable', retriable: true },
  protocol: { message: 'app-server protocol rejected', retriable: false },
  runtime: { message: 'app-server turn failed', retriable: true }
};

/**
 * ChatGPT-subscription adapter over the supported Codex app-server JSONL
 * protocol. The runtime receives a one-use copy of `~/.codex/auth.json`, with
 * user config/instructions/plugins/tools excluded, and never calls the private
 * ChatGPT backend directly.
 */
export class CodexProvider implements ModelProvider {
  readonly id = 'codex' as const;
  readonly costBasis = 'subscription' as const;
  private readonly models: Record<ModelTierRoute, string>;
  private readonly runner: CodexAppServerRunner;
  private readonly credentialProbe: CredentialProbe;
  private readonly command: string;
  private readonly sourceAuthPath: string;
  private readonly sourceEnv: NodeJS.ProcessEnv;

  constructor(options: CodexProviderOptions = {}) {
    this.models = { ...DEFAULT_MODELS, ...options.models };
    this.runner = options.runner ?? defaultCodexAppServerRunner;
    this.credentialProbe = options.credentialProbe ?? secretsPlaneProbe('codex');
    this.command = options.command ?? resolveDefaultCodexCommand();
    this.sourceAuthPath = join((options.homedir ?? osHomedir)(), '.codex', 'auth.json');
    this.sourceEnv = options.env ?? process.env;
  }

  modelForRoute(route: ModelTierRoute): string {
    return this.models[route];
  }

  servesRoute(route: ModelTierRoute): boolean {
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
    let result;
    try {
      result = await this.runner({
        command: this.command,
        sourceAuthPath: this.sourceAuthPath,
        sourceEnv: this.sourceEnv,
        model,
        system: request.system,
        messages: request.messages,
        maxOutputTokens: request.maxOutputTokens,
        timeoutMs: request.timeoutMs
      });
    } catch (error) {
      if (error instanceof CodexAppServerFailure) {
        const mapped = PROVIDER_FAILURES[error.kind];
        throw new ProviderError(this.id, mapped.message, error.kind, mapped.retriable);
      }
      throw new ProviderError(this.id, 'app-server unavailable', 'unavailable', true);
    }

    return {
      text: result.text,
      toolCalls: [],
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      provider: this.id,
      model,
      costBasis: this.costBasis,
      finishReason: 'stop'
    };
  }
}
