import type { ModelUsageRepository } from '../db/model-usage-repository';
import type { ModelExecutionSurface } from '../economics/model-execution-enablement';
import { ClaudeProvider, type ClaudeProviderOptions } from './claude-provider';
import { CodexProvider, type CodexProviderOptions } from './codex-provider';
import { GeminiProvider, type GeminiProviderOptions } from './gemini-provider';
import { ModelExecutor } from './model-executor';
import { ModelTurnCoordinator, type ModelTurnEnablementReader } from './model-turn-coordinator';
import { OllamaProvider, type OllamaProviderOptions } from './ollama-provider';
import { ProviderCatalog, type ProviderPreferences } from './provider-catalog';
import type { ProviderRateLimitCircuit } from './provider-rate-limit-circuit';

export interface ModelStackOptions {
  preferences?: ProviderPreferences;
  claude?: ClaudeProviderOptions;
  codex?: CodexProviderOptions;
  gemini?: GeminiProviderOptions;
  ollama?: OllamaProviderOptions;
  rateLimitCircuit?: ProviderRateLimitCircuit;
}

export type ProductionModelTurnCoordinatorOptions = Omit<ModelStackOptions, 'rateLimitCircuit'> & {
  usage: ModelUsageRepository;
  enablement: ModelTurnEnablementReader;
  surface: ModelExecutionSurface;
  clientId: string | null;
  rateLimitCircuit: ProviderRateLimitCircuit;
};

/**
 * Wires the four real provider adapters into a catalog in the briefing's fixed
 * preference order (Claude → Codex → Gemini for economy/frontier, Ollama for local
 * and as the universal backstop). Each adapter is constructed with its safe
 * defaults; overrides exist for tests and configuration.
 */
export function createProviderCatalog(options: ModelStackOptions = {}): ProviderCatalog {
  return new ProviderCatalog(
    [
      new ClaudeProvider(options.claude),
      new CodexProvider(options.codex),
      new GeminiProvider(options.gemini),
      new OllamaProvider(options.ollama)
    ],
    options.preferences
  );
}

/**
 * Low-level executor assembly retained for isolated tests and diagnostic tools.
 * It accepts caller-supplied provider authority and may omit the durable circuit,
 * so production model turns must use {@link createModelTurnCoordinator} instead.
 * Constructing it performs no I/O.
 */
export function createModelExecutor(
  usage: ModelUsageRepository,
  options: ModelStackOptions = {}
): ModelExecutor {
  return new ModelExecutor({
    catalog: createProviderCatalog(options),
    usage,
    ...(options.rateLimitCircuit === undefined
      ? {}
      : { rateLimitCircuit: options.rateLimitCircuit })
  });
}

/**
 * Production construction path. It binds the trusted surface/client boundary,
 * makes the durable subscription rate-limit circuit mandatory, and exposes only
 * the coordinator that derives provider authority from the enablement record.
 */
export function createModelTurnCoordinator(
  options: ProductionModelTurnCoordinatorOptions
): ModelTurnCoordinator {
  if (options.rateLimitCircuit === undefined) {
    throw new Error('A durable provider rate-limit circuit is required');
  }
  const executor = createModelExecutor(options.usage, {
    preferences: options.preferences,
    claude: options.claude,
    codex: options.codex,
    gemini: options.gemini,
    ollama: options.ollama,
    rateLimitCircuit: options.rateLimitCircuit
  });
  return new ModelTurnCoordinator({
    surface: options.surface,
    clientId: options.clientId,
    enablement: options.enablement,
    executor
  });
}
