import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createMemorySystem,
  resolveMemoryBackendFromEnv
} from '../../../src/memory/system/factory';
import { createMemorySystemHarness, type MemorySystemHarness } from './memory-system-harness';

describe('memory system factory', () => {
  let harness: MemorySystemHarness;

  beforeEach(async () => {
    harness = await createMemorySystemHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('binds the flat backend by default', () => {
    const system = createMemorySystem({
      sqlite: harness.context.sqlite,
      access: harness.boundAccess
    });
    expect(system.id).toBe('flat');
    expect(system.capabilities.workingMemory).toBe(false);
  });

  it('binds the typed-hybrid backend on explicit opt-in', () => {
    const system = createMemorySystem({
      sqlite: harness.context.sqlite,
      access: harness.boundAccess,
      backend: 'typed_hybrid'
    });
    expect(system.id).toBe('typed_hybrid');
    expect(system.capabilities.consolidation).toBe(true);
  });

  it('resolves the backend from env, defaulting safely to flat', () => {
    expect(resolveMemoryBackendFromEnv({})).toBe('flat');
    expect(resolveMemoryBackendFromEnv({ JARVIS_MEMORY_BACKEND: 'typed_hybrid' })).toBe(
      'typed_hybrid'
    );
    expect(resolveMemoryBackendFromEnv({ JARVIS_MEMORY_BACKEND: 'graph' })).toBe('flat');
  });

  it('refuses to reach the experimental control through the environment', () => {
    // `flat_untyped` returns superseded and expired facts on purpose. Selecting it
    // must be a deliberate act in code, never something an env var can switch on
    // underneath a running agency.
    expect(resolveMemoryBackendFromEnv({ JARVIS_MEMORY_BACKEND: 'flat_untyped' })).toBe('flat');

    // ...but an explicit caller — the bench, the demo — still gets it.
    const system = createMemorySystem({
      sqlite: harness.context.sqlite,
      access: harness.boundAccess,
      backend: 'flat_untyped'
    });
    expect(system.id).toBe('flat_untyped');
  });

  it('honours the environment when no backend is passed explicitly', () => {
    const system = createMemorySystem({
      sqlite: harness.context.sqlite,
      access: harness.boundAccess,
      env: { JARVIS_MEMORY_BACKEND: 'ledger' }
    });
    expect(system.id).toBe('ledger');
  });
});
