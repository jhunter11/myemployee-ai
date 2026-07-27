import { describe, expect, it } from 'vitest';

import {
  createModelExecutor,
  createModelTurnCoordinator,
  createProviderCatalog
} from '../../src/models/factory';
import { ModelTurnCoordinator } from '../../src/models/model-turn-coordinator';

describe('model stack factory', () => {
  it('wires all four real providers into the catalog', () => {
    const catalog = createProviderCatalog();
    expect(catalog.provider('claude')?.id).toBe('claude');
    expect(catalog.provider('codex')?.id).toBe('codex');
    expect(catalog.provider('gemini')?.id).toBe('gemini');
    expect(catalog.provider('ollama')?.id).toBe('ollama');
  });

  it('binds the cost basis per provider (subscription vs local)', () => {
    const catalog = createProviderCatalog();
    expect(catalog.provider('claude')?.costBasis).toBe('subscription');
    expect(catalog.provider('codex')?.costBasis).toBe('subscription');
    expect(catalog.provider('gemini')?.costBasis).toBe('subscription');
    expect(catalog.provider('ollama')?.costBasis).toBe('local');
  });

  it('keeps the low-level executor available for isolated tests without performing I/O', () => {
    // A throwing usage repository proves construction never touches it.
    const executor = createModelExecutor({
      record: () => {
        throw new Error('should not be called at construction');
      }
    } as never);
    expect(executor).toBeDefined();
  });

  it('exposes the safe coordinator as the production path and requires a rate-limit circuit', () => {
    const usage = {
      record: () => {
        throw new Error('should not be called at construction');
      }
    } as never;
    const enablement = {
      current: () => {
        throw new Error('should not be called at construction');
      }
    };
    const rateLimitCircuit = {
      claim: () => ({ allowed: true, halfOpen: false }),
      open: () => undefined,
      close: () => undefined,
      release: () => undefined
    } as never;

    expect(
      createModelTurnCoordinator({
        usage,
        enablement,
        surface: 'automation',
        clientId: 'acme_corp',
        rateLimitCircuit
      })
    ).toBeInstanceOf(ModelTurnCoordinator);

    expect(() =>
      createModelTurnCoordinator({
        usage,
        enablement,
        surface: 'automation',
        clientId: 'acme_corp',
        rateLimitCircuit: undefined
      } as never)
    ).toThrow(/rate-limit circuit is required/iu);
  });
});
